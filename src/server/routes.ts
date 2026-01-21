/**
 * Route Handlers
 *
 * HTTP route handlers for the SBy server. Handles serving the web UI,
 * API endpoints for conversation management, and SSE streaming for
 * chat responses.
 *
 * @module
 */

import type { SSEEvent } from "../types.ts";
import type { DBClient } from "../db/mod.ts";
import type { LLMClient } from "../llm/mod.ts";
import type { ToolRegistry } from "../tools/mod.ts";
import { EntityTurn, type EntityYield } from "../entity/mod.ts";
import { createSSEEncoder, createSSEResponse } from "./sse.ts";

/**
 * Context passed to route handlers containing dependencies.
 */
export interface RouteContext {
  /** Database client for persistence */
  db: DBClient;
  /** LLM client for chat completions */
  llm: LLMClient;
  /** Tool registry for tool execution */
  tools: ToolRegistry;
  /** Root directory of the project for file serving */
  projectRoot: string;
}

/**
 * MIME type mapping for static file serving.
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

/**
 * Get MIME type for a file path.
 *
 * @param path - File path
 * @returns MIME type string
 */
function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Normalize a file path by resolving "..", ".", and collapsing multiple slashes.
 *
 * This is critical for preventing path traversal attacks.
 *
 * @param path - The path to normalize
 * @returns The normalized path
 */
function normalizePath(path: string): string {
  // Split path into segments
  const segments = path.split("/");
  const result: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      // Go up one directory (but don't go above root)
      if (result.length > 0 && result[result.length - 1] !== "") {
        result.pop();
      }
    } else if (segment !== "." && segment !== "") {
      // Skip "." and empty segments (from "//")
      result.push(segment);
    }
  }

  // Reconstruct the path, preserving leading slash for absolute paths
  const normalized = (path.startsWith("/") ? "/" : "") + result.join("/");
  return normalized || "/";
}

/**
 * Handle GET / - Serve the web UI
 *
 * Serves the index.html file from the web/ directory.
 *
 * @param ctx - Route context
 * @returns HTTP Response with the index.html content
 */
export async function handleIndex(ctx: RouteContext): Promise<Response> {
  const indexPath = `${ctx.projectRoot}/web/index.html`;

  try {
    const content = await Deno.readTextFile(indexPath);
    return new Response(content, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Web UI not found. Please ensure web/index.html exists.", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

/**
 * Handle GET /api/conversations - List conversations
 *
 * Returns all conversations ordered by most recently updated.
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON array of conversations
 */
export function handleListConversations(ctx: RouteContext): Response {
  const conversations = ctx.db.listConversations();

  return new Response(JSON.stringify(conversations), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/conversations - Create new conversation
 *
 * Creates a new conversation with an optional title from the request body.
 *
 * @param ctx - Route context
 * @param request - HTTP Request (body may contain { title?: string })
 * @returns HTTP Response with the created conversation
 */
export async function handleCreateConversation(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  let title: string | undefined;

  // Try to parse body for optional title
  try {
    const body = await request.json();
    if (body && typeof body.title === "string") {
      title = body.title;
    }
  } catch {
    // No body or invalid JSON - that's fine, title is optional
  }

  const conversation = ctx.db.createConversation(title);

  return new Response(JSON.stringify(conversation), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle GET /api/conversations/:id/messages - Get messages
 *
 * Returns all messages for a specific conversation.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @returns HTTP Response with JSON array of messages
 */
export function handleGetMessages(
  ctx: RouteContext,
  conversationId: string
): Response {
  // Check if conversation exists
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    return new Response(
      JSON.stringify({ error: "Conversation not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const messages = ctx.db.getMessages(conversationId);

  return new Response(JSON.stringify(messages), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Chat request body schema.
 */
interface ChatRequestBody {
  conversationId: string;
  message: string;
}

/**
 * Handle POST /api/chat - Send message and stream response via SSE
 *
 * This is the main endpoint for chat interactions. It:
 * 1. Validates the request body
 * 2. Creates or uses an EntityTurn
 * 3. Processes the message
 * 4. Converts StreamChunks to SSEEvents
 * 5. Streams the response back to the client
 *
 * @param ctx - Route context
 * @param request - HTTP Request with body { conversationId: string, message: string }
 * @returns HTTP Response with SSE stream
 */
export async function handleChat(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  // Parse and validate request body
  let body: ChatRequestBody;
  try {
    body = await request.json();
    if (!body.conversationId || typeof body.conversationId !== "string") {
      throw new Error("Missing or invalid conversationId");
    }
    if (!body.message || typeof body.message !== "string") {
      throw new Error("Missing or invalid message");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Invalid request body";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Check if conversation exists
  const conversation = ctx.db.getConversation(body.conversationId);
  if (!conversation) {
    return new Response(
      JSON.stringify({ error: "Conversation not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Create an AbortController to handle client disconnect
  const abortController = new AbortController();
  const { signal } = abortController;

  // Create a ReadableStream that will produce SSE events
  const stream = new ReadableStream<SSEEvent>({
    async start(controller) {
      try {
        // Create EntityTurn instance
        const turn = new EntityTurn(
          ctx.llm,
          ctx.db,
          ctx.tools,
          { projectRoot: ctx.projectRoot }
        );

        // Process the message and stream chunks
        // process(conversationId, userMessage)
        for await (const chunk of turn.process(body.conversationId, body.message)) {
          // Check if client has disconnected
          if (signal.aborted) {
            console.log("Client disconnected, stopping stream");
            break;
          }
          const event = convertToSSEEvent(chunk);
          controller.enqueue(event);
        }
      } catch (error) {
        // Don't log or send error events if client disconnected
        if (signal.aborted) {
          return;
        }

        // If EntityTurn doesn't exist yet, send an error event
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error("Chat error:", errorMessage);

        // Send error as a status event
        controller.enqueue({
          type: "status",
          data: JSON.stringify({ error: errorMessage }),
        });

        // Send done event
        controller.enqueue({
          type: "done",
          data: "error",
        });
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Called when the client disconnects or the stream is cancelled
      abortController.abort();
    },
  });

  // Pipe through the SSE encoder and return the response
  const encodedStream = stream.pipeThrough(createSSEEncoder());
  return createSSEResponse(encodedStream);
}

/**
 * Convert an EntityTurn yield to an SSEEvent.
 *
 * Mapping:
 * - StreamChunk 'thinking' -> SSEEvent 'thinking', data is content
 * - StreamChunk 'content' -> SSEEvent 'content', data is content
 * - StreamChunk 'tool_call' -> SSEEvent 'tool_call', data is JSON of toolCall
 * - 'tool_result' -> SSEEvent 'tool_result', data is JSON of result
 * - StreamChunk 'done' -> SSEEvent 'done', data is finishReason
 *
 * @param chunk - The chunk from EntityTurn
 * @returns The corresponding SSEEvent
 */
function convertToSSEEvent(chunk: EntityYield): SSEEvent {
  switch (chunk.type) {
    case "thinking":
      return {
        type: "thinking",
        data: chunk.content,
      };

    case "content":
      return {
        type: "content",
        data: chunk.content,
      };

    case "tool_call":
      return {
        type: "tool_call",
        data: JSON.stringify(chunk.toolCall),
      };

    case "tool_result":
      return {
        type: "tool_result",
        data: JSON.stringify(chunk.result),
      };

    case "done":
      return {
        type: "done",
        data: chunk.finishReason,
      };
  }
}

/**
 * Handle static file requests from the web/ directory.
 *
 * @param ctx - Route context
 * @param path - The requested file path (relative to web/)
 * @returns HTTP Response with file content or 404
 */
export async function handleStaticFile(
  ctx: RouteContext,
  path: string
): Promise<Response> {
  // Build the full path and normalize it to resolve any ".." or "." segments
  const webRoot = `${ctx.projectRoot}/web`;

  // Normalize the path to resolve "..", ".", and "//" sequences
  // This handles URL-encoded traversal attempts since the URL is already decoded
  const normalizedPath = normalizePath(`${webRoot}${path}`);

  // Security check: ensure the resolved path is still within the web root
  // This prevents path traversal attacks like "/../../../etc/passwd"
  if (!normalizedPath.startsWith(webRoot + "/") && normalizedPath !== webRoot) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const filePath = normalizedPath;

  try {
    const content = await Deno.readFile(filePath);
    const mimeType = getMimeType(filePath);

    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

/**
 * Handle CORS preflight requests.
 *
 * @returns HTTP Response with CORS headers
 */
export function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
