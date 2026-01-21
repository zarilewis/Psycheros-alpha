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
import {
  renderAppShell,
  renderChatView,
  renderConversationItem,
  renderConversationList,
} from "./templates.ts";
import { updateConversationTitle } from "./state-changes.ts";
import { generateUIUpdates, renderAsOobSwaps } from "./ui-updates.ts";

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
 * Renders the app shell using server-side templates.
 *
 * @param _ctx - Route context (unused, kept for consistency)
 * @returns HTTP Response with the app shell HTML
 */
export function handleIndex(_ctx: RouteContext): Response {
  const html = renderAppShell();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /api/conversations - List conversations
 *
 * Returns all conversations as JSON, ordered by most recently updated.
 * For HTML partial, use /fragments/conv-list instead.
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
 * Returns HTML when HX-Request header is present, JSON otherwise.
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

  // Return HTML for HTMX requests
  if (request.headers.get("HX-Request") === "true") {
    const html = renderConversationItem(conversation, true);
    return new Response(html, {
      status: 201,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return new Response(JSON.stringify(conversation), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle GET /c/:id - Get conversation page
 *
 * Always returns the full app shell. The frontend JavaScript
 * detects the URL and loads the conversation content via the
 * fragment endpoint.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @returns HTTP Response with full app shell HTML
 */
export function handleConversationView(
  ctx: RouteContext,
  conversationId: string
): Response {
  // Check if conversation exists
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    return new Response("Conversation not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Always return the full app shell
  // Frontend JS will load the conversation content via /fragments/chat/:id
  const html = renderAppShell();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Fragment Routes (HTML partials for HTMX)
// =============================================================================

/**
 * Handle GET /fragments/chat/:id - Get chat view fragment
 *
 * Returns just the chat HTML partial (messages + input area).
 * Used by HTMX for in-app navigation and by JS for initial load.
 * Includes an out-of-band swap for the header title.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @returns HTTP Response with chat HTML fragment
 */
export function handleChatFragment(
  ctx: RouteContext,
  conversationId: string
): Response {
  // Check if conversation exists
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    return new Response("Conversation not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const messages = ctx.db.getMessages(conversationId);
  const chatHtml = renderChatView(messages);

  // Generate OOB swaps for header title using unified helper
  const uiUpdates = generateUIUpdates(["header-title"], ctx.db, conversationId);
  const oobHtml = renderAsOobSwaps(uiUpdates);

  return new Response(chatHtml + oobHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/conv-list - Get conversation list fragment
 *
 * Returns just the conversation list HTML partial.
 * Used by HTMX for sidebar updates.
 *
 * @param ctx - Route context
 * @returns HTTP Response with conversation list HTML fragment
 */
export function handleConversationListFragment(ctx: RouteContext): Response {
  const conversations = ctx.db.listConversations();
  const html = renderConversationList(conversations);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
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
 * Handle PATCH /api/conversations/:id/title - Update conversation title
 *
 * Updates the title and returns OOB swaps for reactive UI updates.
 * Uses the unified state change pattern.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @param request - HTTP Request with body { title: string }
 * @returns HTTP Response with OOB swap HTML for HTMX, or JSON for non-HTMX
 */
export async function handleUpdateTitle(
  ctx: RouteContext,
  conversationId: string,
  request: Request
): Promise<Response> {
  // Parse request body
  let title: string;
  try {
    const body = await request.json();
    if (!body.title || typeof body.title !== "string") {
      throw new Error("Missing or invalid title");
    }
    title = body.title;
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

  // Use the unified state change function
  const result = updateConversationTitle(ctx.db, conversationId, title);

  if (!result.success) {
    return new Response(
      JSON.stringify({ error: result.error }),
      {
        status: result.error?.includes("not found") ? 404 : 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // For HTMX requests, return OOB swaps for reactive updates
  if (request.headers.get("HX-Request") === "true") {
    const uiUpdates = generateUIUpdates(result.affectedRegions, ctx.db, conversationId);
    const oobHtml = renderAsOobSwaps(uiUpdates);

    return new Response(oobHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // For regular requests, return JSON
  return new Response(
    JSON.stringify({ success: true, title: result.data?.title }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
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

    case "dom_update":
      return {
        type: "dom_update",
        data: JSON.stringify(chunk.update),
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
