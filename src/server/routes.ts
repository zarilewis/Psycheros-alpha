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
import { EntityTurn, type EntityYield, generateAndSetTitle } from "../entity/mod.ts";
import { createSSEEncoder, createSSEResponse } from "./sse.ts";
import {
  renderAppShell,
  renderChatView,
  renderConversationItem,
  renderConversationList,
  type MetricsMap,
} from "./templates.ts";
import { updateConversationTitle, deleteConversation, deleteConversations } from "./state-changes.ts";
import { generateUIUpdates, renderAsOobSwaps } from "./ui-updates.ts";
import { MAX_SSE_MESSAGE_SIZE, SSE_TRUNCATION_SUFFIX } from "../constants.ts";
import { getBroadcaster } from "./broadcaster.ts";

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
 * Determine if the client expects an HTML response.
 *
 * Checks in order:
 * 1. HX-Request header (HTMX clients)
 * 2. Accept header preferring text/html
 *
 * This allows non-HTMX clients to explicitly request HTML via Accept header.
 *
 * @param request - The HTTP request
 * @returns true if HTML response is preferred
 */
function prefersHtml(request: Request): boolean {
  // HTMX always sends this header
  if (request.headers.get("HX-Request") === "true") {
    return true;
  }

  // Check Accept header for HTML preference
  const accept = request.headers.get("Accept") || "";
  // Simple check: if text/html appears before application/json, prefer HTML
  const htmlIndex = accept.indexOf("text/html");
  const jsonIndex = accept.indexOf("application/json");

  if (htmlIndex !== -1 && (jsonIndex === -1 || htmlIndex < jsonIndex)) {
    return true;
  }

  return false;
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

  // Return HTML for HTMX requests or clients preferring HTML
  if (prefersHtml(request)) {
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

  // Build metrics map for assistant messages
  const metricsMap: MetricsMap = new Map();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const metrics = ctx.db.getMetricsByMessageId(msg.id);
      if (metrics) {
        metricsMap.set(msg.id, metrics);
      }
    }
  }

  const chatHtml = renderChatView(messages, metricsMap);

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

  // For HTMX requests or clients preferring HTML, return OOB swaps
  if (prefersHtml(request)) {
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
 * Handle DELETE /api/conversations/:id - Delete a single conversation
 *
 * Deletes the conversation and broadcasts UI update via SSE.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID to delete
 * @param _request - HTTP Request (unused)
 * @returns HTTP Response with JSON result
 */
export function handleDeleteConversation(
  ctx: RouteContext,
  conversationId: string,
  _request: Request
): Response {
  const result = deleteConversation(ctx.db, conversationId);

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

  // Broadcast UI update via SSE to all clients
  const uiUpdates = generateUIUpdates(result.affectedRegions, ctx.db);
  getBroadcaster().broadcastUpdates(uiUpdates, null); // null = broadcast to all

  return new Response(
    JSON.stringify({ success: true, deletedId: result.data?.deletedId }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

/**
 * Handle DELETE /api/conversations - Delete multiple conversations
 *
 * Expects body: { ids: string[] }
 * Deletes the conversations and broadcasts UI update via SSE.
 *
 * @param ctx - Route context
 * @param request - HTTP Request with body { ids: string[] }
 * @returns HTTP Response with JSON result
 */
export async function handleBatchDeleteConversations(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  // Parse request body
  let ids: string[];
  try {
    const body = await request.json();
    if (!body.ids || !Array.isArray(body.ids)) {
      throw new Error("Missing or invalid ids array");
    }
    ids = body.ids.filter((id: unknown) => typeof id === "string");
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

  const result = deleteConversations(ctx.db, ids);

  if (!result.success) {
    return new Response(
      JSON.stringify({ error: result.error }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Broadcast UI update via SSE to all clients
  const uiUpdates = generateUIUpdates(result.affectedRegions, ctx.db);
  getBroadcaster().broadcastUpdates(uiUpdates, null); // null = broadcast to all

  return new Response(
    JSON.stringify({
      success: true,
      deletedCount: result.data?.deletedCount,
      deletedIds: result.data?.deletedIds,
    }),
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

  // Check if this is the first message (for auto-titling in parallel)
  const existingMessages = ctx.db.getMessages(body.conversationId);
  const isFirstMessage = existingMessages.length === 0 && !conversation.title;

  // Create an AbortController to handle client disconnect
  const abortController = new AbortController();
  const { signal } = abortController;

  // Create a ReadableStream that will produce SSE events
  const stream = new ReadableStream<SSEEvent>({
    async start(controller) {
      try {
        // Start auto-title generation in parallel (runs concurrently with main response)
        const titlePromise = isFirstMessage
          ? generateAndSetTitle(body.conversationId, body.message, ctx.db)
          : null;

        // Create EntityTurn instance
        const turn = new EntityTurn(
          ctx.llm,
          ctx.db,
          ctx.tools,
          { projectRoot: ctx.projectRoot }
        );

        // Process the message and stream chunks
        for await (const chunk of turn.process(body.conversationId, body.message)) {
          if (signal.aborted) {
            console.log("Client disconnected, stopping stream");
            break;
          }
          controller.enqueue(convertToSSEEvent(chunk));
        }

        // Await title generation (it broadcasts its own updates via persistent SSE)
        if (titlePromise && !signal.aborted) {
          await titlePromise;
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
 * Truncate SSE data if it exceeds the maximum size.
 * Prevents memory issues and client disconnections from very large payloads.
 *
 * @param data - The data string to potentially truncate
 * @returns The original data or truncated version with suffix
 */
function truncateSSEData(data: string): string {
  if (data.length <= MAX_SSE_MESSAGE_SIZE) {
    return data;
  }

  const truncateAt = MAX_SSE_MESSAGE_SIZE - SSE_TRUNCATION_SUFFIX.length;
  return data.substring(0, truncateAt) + SSE_TRUNCATION_SUFFIX;
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
 * Large payloads (tool results, etc.) are truncated to prevent memory issues.
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
        data: truncateSSEData(JSON.stringify(chunk.toolCall)),
      };

    case "tool_result":
      return {
        type: "tool_result",
        data: truncateSSEData(JSON.stringify(chunk.result)),
      };

    case "dom_update":
      return {
        type: "dom_update",
        data: truncateSSEData(JSON.stringify(chunk.update)),
      };

    case "metrics":
      return {
        type: "metrics",
        data: JSON.stringify(chunk.metrics),
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
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/**
 * SSE headers for persistent event stream connections.
 */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Handle GET /api/events - Persistent SSE event stream
 *
 * Creates a persistent SSE connection that receives DOM updates from
 * background operations like auto-title generation. Unlike /api/chat,
 * this connection stays open independently of any specific request.
 *
 * @param _ctx - Route context (unused)
 * @param request - HTTP Request (may contain conversationId query param)
 * @returns HTTP Response with SSE stream
 */
export function handleEvents(_ctx: RouteContext, request: Request): Response {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  const broadcaster = getBroadcaster();
  const encoder = new TextEncoder();

  let clientId: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Create a wrapper controller that encodes strings to Uint8Array
      const stringController = {
        enqueue: (str: string) => controller.enqueue(encoder.encode(str)),
        close: () => controller.close(),
        error: (e: Error) => controller.error(e),
      };

      // Register this client with the broadcaster (using string-based controller)
      clientId = broadcaster.addClient(
        stringController as unknown as ReadableStreamDefaultController<string>,
        conversationId
      );

      // Send initial connected event
      const connectedEvent = `event: connected\ndata: ${JSON.stringify({
        clientId,
        conversationId,
      })}\n\n`;
      controller.enqueue(encoder.encode(connectedEvent));
    },
    cancel() {
      // Client disconnected - clean up
      if (clientId) {
        broadcaster.removeClient(clientId);
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
