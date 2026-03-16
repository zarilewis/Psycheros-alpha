/**
 * Route Handlers
 *
 * HTTP route handlers for the Psycheros server. Handles serving the web UI,
 * API endpoints for conversation management, and SSE streaming for
 * chat responses.
 *
 * @module
 */

import type { SSEEvent, TurnMetrics } from "../types.ts";
import type { DBClient } from "../db/mod.ts";
import type { LLMClient, LLMSettings } from "../llm/mod.ts";
import { maskApiKey, getDefaultSettings } from "../llm/mod.ts";
import type { ToolRegistry } from "../tools/mod.ts";
import type { Retriever, RAGConfig } from "../rag/mod.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { LorebookManager } from "../lorebook/mod.ts";
import { EntityTurn, type EntityYield, generateAndSetTitle } from "../entity/mod.ts";
import { createSSEEncoder, createSSEResponse } from "./sse.ts";
import {
  renderAppShell,
  renderChatView,
  renderConversationItem,
  renderConversationList,
  renderCorePromptsSettings,
  renderFileList,
  renderFileEditor,
  renderSaveSuccess,
  renderSaveError,
  renderSnapshotsView,
  renderSnapshotPreview,
  renderLorebooksView,
  renderLorebookDetailView,
  renderEntryEditor,
  renderGraphView,
  renderAppearanceSettings,
  renderLLMSettings,
  renderSettingsHub,
  escapeHtml,
  type MetricsMap,
} from "./templates.ts";
import { updateConversationTitle, deleteConversation, deleteConversations, updateMessageContent } from "./state-changes.ts";
import { generateUIUpdates, renderAsOobSwaps } from "./ui-updates.ts";
import { MAX_SSE_MESSAGE_SIZE, SSE_TRUNCATION_SUFFIX } from "../constants.ts";
import { getBroadcaster } from "./broadcaster.ts";
import { runConsolidation, needsConsolidation } from "../memory/mod.ts";

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
  /** Optional RAG retriever for memory search */
  ragRetriever?: Retriever;
  /** Optional chat RAG for searching conversation history */
  chatRAG?: ConversationRAG;
  /** RAG configuration */
  ragConfig?: Partial<RAGConfig>;
  /** Whether memory summarization is enabled */
  memoryEnabled?: boolean;
  /** Optional MCP client for syncing with entity-core */
  mcpClient?: MCPClient;
  /** Optional lorebook manager for world info */
  lorebookManager?: LorebookManager;
  /** Get current LLM settings */
  getLLMSettings: () => LLMSettings;
  /** Update LLM settings and hot-reload */
  updateLLMSettings: (settings: LLMSettings) => Promise<void>;
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
 * Allowed image MIME types for background uploads.
 */
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Maximum file size for background uploads (5MB).
 */
const MAX_BACKGROUND_SIZE = 5 * 1024 * 1024;

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
 * Handle GET /api/conversations/:id/context - Get context snapshots
 *
 * Returns all persisted context snapshots for a conversation,
 * or just the latest if latest=true.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @param latest - If true, return only the most recent snapshot
 * @returns HTTP Response with snapshot data
 */
export function handleGetContextSnapshots(
  ctx: RouteContext,
  conversationId: string,
  latest: boolean
): Response {
  if (latest) {
    const snapshot = ctx.db.getLatestContextSnapshot(conversationId);
    if (!snapshot) {
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(JSON.stringify(snapshot), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const snapshots = ctx.db.getContextSnapshots(conversationId);
  return new Response(JSON.stringify(snapshots), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle PUT /api/messages/:id - Update message content
 *
 * Updates a message's content, regenerates embedding, and returns updated HTML.
 *
 * @param ctx - Route context
 * @param messageId - The message ID
 * @param request - HTTP Request with body { content: string, conversationId: string }
 * @returns HTTP Response with updated message HTML for HTMX swap
 */
export async function handleUpdateMessage(
  ctx: RouteContext,
  messageId: string,
  request: Request
): Promise<Response> {
  // Parse request body
  let content: string;
  let conversationId: string;
  try {
    const body = await request.json();
    if (!body.content || typeof body.content !== "string") {
      throw new Error("Missing or invalid content");
    }
    if (!body.conversationId || typeof body.conversationId !== "string") {
      throw new Error("Missing or invalid conversationId");
    }
    content = body.content;
    conversationId = body.conversationId;
  } catch (error) {
    console.error("[Routes] handleUpdateMessage parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Perform the state change
  const result = updateMessageContent(ctx.db, conversationId, messageId, content);

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

  // Get the updated message
  const messages = ctx.db.getMessages(conversationId);
  const updatedMsg = messages.find((m) => m.id === messageId);

  if (!updatedMsg) {
    return new Response(
      JSON.stringify({ error: "Updated message not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Regenerate embedding in RAG (non-blocking)
  if (ctx.chatRAG && (updatedMsg.role === "user" || updatedMsg.role === "assistant")) {
    ctx.chatRAG.updateMessageEmbedding(
      messageId,
      conversationId,
      updatedMsg.role,
      updatedMsg.content
    ).catch((error) => {
      console.error(
        `[Routes] Failed to update embedding for message ${messageId}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  // Get metrics for assistant messages
  let metrics: TurnMetrics | undefined = undefined;
  if (updatedMsg.role === "assistant") {
    const dbMetrics = ctx.db.getMetricsByMessageId(messageId);
    metrics = dbMetrics ?? undefined;
  }

  // Render updated message HTML for HTMX swap
  const { renderMessage } = await import("./templates.ts");
  const html = renderMessage(updatedMsg, metrics);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
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
    console.error("[Routes] handleUpdateTitle parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
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
    console.error("[Routes] handleBatchDeleteConversations parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
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
    console.error("[Routes] handleChat parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
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
          {
            projectRoot: ctx.projectRoot,
            ragRetriever: ctx.ragRetriever,
            chatRAG: ctx.chatRAG,
            mcpClient: ctx.mcpClient,
            lorebookManager: ctx.lorebookManager,
          }
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

        // Extract structured error info for logging
        const errorCode = (error as { code?: string })?.code || "UNKNOWN";
        const statusCode = (error as { statusCode?: number })?.statusCode;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[Routes] Chat streaming error — code=${errorCode}` +
          (statusCode ? `, http=${statusCode}` : "") +
          `: ${errorMsg}`,
        );

        // Build a user-facing message that includes the error category
        // without leaking sensitive internal details
        let userMessage: string;
        switch (errorCode) {
          case "CONNECT_TIMEOUT":
            userMessage = "The AI service is unreachable or failed to respond. It may be temporarily unavailable — please try again.";
            break;
          case "STREAM_STALL_TIMEOUT":
            userMessage = "The AI response stalled mid-stream. The service may be overloaded — please try again.";
            break;
          case "NETWORK_ERROR":
            userMessage = "Could not reach the AI service. Please check your connection and try again.";
            break;
          case "MALFORMED_STREAM":
            userMessage = "Received corrupted data from the AI service. Please try again.";
            break;
          default:
            if (statusCode && statusCode >= 500) {
              userMessage = `The AI service returned an error (HTTP ${statusCode}). Please try again later.`;
            } else if (statusCode === 429) {
              userMessage = "Rate limited by the AI service. Please wait a moment and try again.";
            } else if (statusCode === 401 || statusCode === 403) {
              userMessage = "Authentication error with the AI service. Check your API key configuration.";
            } else {
              userMessage = "An error occurred while processing your message.";
            }
            break;
        }

        // Send error as a status event with descriptive message and code
        controller.enqueue({
          type: "status",
          data: JSON.stringify({ error: userMessage, errorCode }),
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

    case "status":
      return {
        type: "status",
        data: JSON.stringify(chunk.status),
      };

    case "metrics":
      return {
        type: "metrics",
        data: JSON.stringify(chunk.metrics),
      };

    case "context":
      return {
        type: "context",
        data: JSON.stringify(chunk.context),
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
        "Cache-Control": "no-cache",
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
 * Handle health check requests.
 */
export function handleHealth(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

// =============================================================================
// Settings Routes
// =============================================================================

/**
 * Valid prompt directories for file operations.
 */
const VALID_PROMPT_DIRS = ["self", "user", "relationship", "custom"];

/**
 * Security check for directory parameter.
 * Prevents path traversal attacks.
 */
function isValidDirectory(dir: string): boolean {
  return VALID_PROMPT_DIRS.includes(dir);
}

/**
 * Security check for filename parameter.
 * Only allows .md files with safe names.
 * For custom files, only allows single words (letters, numbers, underscores).
 */
function isValidFilename(filename: string, isCustom: boolean = false): boolean {
  // Must end with .md
  if (!filename.endsWith(".md")) return false;
  // No path separators
  if (filename.includes("/") || filename.includes("\\")) return false;
  // No parent directory references
  if (filename.includes("..")) return false;
  // Must be a reasonable filename
  const baseName = filename.slice(0, -3); // Remove .md
  if (isCustom) {
    // Custom files: single word only (letters, numbers, underscores - no spaces or hyphens)
    return /^[a-zA-Z0-9_]+$/.test(baseName);
  }
  // Standard files: alphanumeric, underscores, hyphens (no spaces)
  return /^[a-zA-Z0-9_-]+$/.test(baseName);
}

/**
 * Handle GET /fragments/settings - Settings hub page fragment.
 * Returns the settings hub view listing all settings categories.
 *
 * @param _ctx - Route context
 * @returns HTTP Response with settings hub HTML fragment
 */
export function handleSettingsHubFragment(_ctx: RouteContext): Response {
  const html = renderSettingsHub();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/core-prompts - Settings page fragment.
 * Returns the core prompts settings view with tabs.
 *
 * @param _ctx - Route context
 * @returns HTTP Response with settings HTML fragment
 */
export function handleSettingsFragment(_ctx: RouteContext): Response {
  const html = renderCorePromptsSettings("self");
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/core-prompts/:directory - File list fragment.
 * Returns the list of files for the selected directory.
 *
 * @param ctx - Route context
 * @param directory - The prompt directory (self, user, relationship)
 * @returns HTTP Response with file list HTML fragment
 */
export async function handleSettingsFileListFragment(
  ctx: RouteContext,
  directory: string
): Promise<Response> {
  // Validate directory
  if (!isValidDirectory(directory)) {
    return new Response("Invalid directory", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    // List .md files in the directory
    const dirPath = `${ctx.projectRoot}/identity/${directory}`;
    const files: string[] = [];

    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        files.push(entry.name);
      }
    }

    // Sort files alphabetically
    files.sort();

    const html = renderFileList(directory as "self" | "user" | "relationship" | "custom", files);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // For custom directory, create it and return empty list
      if (directory === "custom") {
        const customDir = `${ctx.projectRoot}/identity/custom`;
        await Deno.mkdir(customDir, { recursive: true });
        const html = renderFileList("custom", []);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
      return new Response("Directory not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

/**
 * Handle GET /fragments/settings/file/:directory/:filename - File editor fragment.
 * Returns the file editor with textarea for editing the file.
 *
 * @param ctx - Route context
 * @param directory - The prompt directory (self, user, relationship)
 * @param filename - The filename to edit
 * @returns HTTP Response with editor HTML fragment
 */
export async function handleSettingsFileEditorFragment(
  ctx: RouteContext,
  directory: string,
  filename: string
): Promise<Response> {
  // Validate parameters
  if (!isValidDirectory(directory)) {
    return new Response("Invalid directory", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const isCustom = directory === "custom";
  if (!isValidFilename(filename, isCustom)) {
    return new Response("Invalid filename", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    // Read file content
    const filePath = `${ctx.projectRoot}/identity/${directory}/${filename}`;
    const content = await Deno.readTextFile(filePath);

    const html = renderFileEditor(directory as "self" | "user" | "relationship" | "custom", filename, content);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("File not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

/**
 * Handle POST /api/settings/file/:directory/:filename - Save file changes.
 * Saves the file content and returns a status message.
 *
 * @param ctx - Route context
 * @param directory - The prompt directory (self, user, relationship)
 * @param filename - The filename to save
 * @param request - HTTP Request with form body containing content
 * @returns HTTP Response with status HTML fragment
 */
export async function handleSaveSettingsFile(
  ctx: RouteContext,
  directory: string,
  filename: string,
  request: Request
): Promise<Response> {
  // Validate parameters
  if (!isValidDirectory(directory)) {
    return new Response(renderSaveError("Invalid directory"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const isCustom = directory === "custom";
  if (!isValidFilename(filename, isCustom)) {
    return new Response(renderSaveError("Invalid filename"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    // Parse form data
    const formData = await request.formData();
    const content = formData.get("content");

    if (typeof content !== "string") {
      return new Response(renderSaveError("Missing content"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Write file - MCP is source of truth when connected
    if (ctx.mcpClient) {
      // Use MCP client to write (pushes to entity-core, updates cache, writes local)
      await ctx.mcpClient.writeIdentityFile(
        directory as "self" | "user" | "relationship" | "custom",
        filename,
        content,
        ctx.projectRoot,
      );
    } else {
      // Fallback to direct file write when MCP is not enabled
      const filePath = `${ctx.projectRoot}/identity/${directory}/${filename}`;
      await Deno.writeTextFile(filePath, content);
    }

    return new Response(renderSaveSuccess(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveSettingsFile error:", error);
    return new Response(renderSaveError("Failed to save file"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle POST /api/settings/custom/create - Create a new custom file.
 * Creates an empty file with the given filename.
 *
 * @param ctx - Route context
 * @param request - HTTP Request with body { filename: string }
 * @returns HTTP Response redirecting to the editor for the new file
 */
export async function handleCreateCustomFile(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  try {
    // Parse request body
    const body = await request.json();
    const filename = body.filename;

    if (typeof filename !== "string" || !filename.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid filename" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Ensure filename ends with .md
    const fullFilename = filename.endsWith(".md") ? filename : `${filename}.md`;

    // Validate filename (custom files: single word only)
    if (!isValidFilename(fullFilename, true)) {
      return new Response(
        JSON.stringify({ error: "Invalid filename. Use only letters, numbers, and underscores (no spaces)." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Ensure custom directory exists
    const customDir = `${ctx.projectRoot}/identity/custom`;
    await Deno.mkdir(customDir, { recursive: true });

    // Create file with XML tags based on filename
    const filePath = `${customDir}/${fullFilename}`;
    const tagName = fullFilename.replace(/\.md$/, "");
    const initialContent = `<${tagName}>

</${tagName}>
`;
    await Deno.writeTextFile(filePath, initialContent);

    // If MCP is connected, sync the new file
    if (ctx.mcpClient) {
      await ctx.mcpClient.writeIdentityFile(
        "custom",
        fullFilename,
        initialContent,
        ctx.projectRoot,
      );
    }

    return new Response(
      JSON.stringify({ success: true, filename: fullFilename }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[Routes] handleCreateCustomFile error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create file" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Handle DELETE /api/settings/file/custom/:filename - Delete a custom file.
 * Only custom files can be deleted.
 *
 * @param ctx - Route context
 * @param filename - The filename to delete
 * @returns HTTP Response with JSON result
 */
export async function handleDeleteCustomFile(
  ctx: RouteContext,
  filename: string
): Promise<Response> {
  // Decode filename from URL
  const decodedFilename = decodeURIComponent(filename);

  // Validate filename (custom files allow spaces)
  if (!isValidFilename(decodedFilename, true)) {
    return new Response(
      JSON.stringify({ error: "Invalid filename" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    // If MCP is connected, use MCP to delete (which also handles local)
    if (ctx.mcpClient) {
      const result = await ctx.mcpClient.deleteCustomFile(decodedFilename, ctx.projectRoot);
      if (result.success) {
        return new Response(
          JSON.stringify({ success: true, message: result.message }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(
        JSON.stringify({ error: result.message || "Failed to delete file" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Fallback: direct file delete when MCP is not enabled
    const filePath = `${ctx.projectRoot}/identity/custom/${decodedFilename}`;
    await Deno.remove(filePath);

    return new Response(
      JSON.stringify({ success: true, message: "File deleted" }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(
        JSON.stringify({ error: "File not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    console.error("[Routes] handleDeleteCustomFile error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to delete file" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// =============================================================================
// Memory Consolidation Routes
// =============================================================================

/**
 * Handle POST /api/memory/consolidate/:granularity - Trigger memory consolidation
 *
 * Manually triggers consolidation for testing/debugging purposes.
 * Granularity can be "weekly", "monthly", or "yearly".
 *
 * @param ctx - Route context
 * @param granularity - The consolidation granularity
 * @returns HTTP Response with JSON result
 */
export async function handleMemoryConsolidate(
  ctx: RouteContext,
  granularity: string
): Promise<Response> {
  // Validate granularity
  if (granularity !== "weekly" && granularity !== "monthly" && granularity !== "yearly") {
    return new Response(
      JSON.stringify({ error: `Invalid granularity: ${granularity}. Must be weekly, monthly, or yearly.` }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Check if memory is enabled
  if (!ctx.memoryEnabled) {
    return new Response(
      JSON.stringify({ error: "Memory summarization is disabled" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    // Check if consolidation is needed
    const needed = await needsConsolidation(granularity, ctx.db, ctx.projectRoot);

    if (!needed) {
      return new Response(
        JSON.stringify({
          success: true,
          message: `No ${granularity} consolidation needed - no unconsolidated source files from a completed period`,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Run consolidation
    const result = await runConsolidation(granularity, ctx.db, ctx.projectRoot);

    if (result.success) {
      return new Response(
        JSON.stringify({
          success: true,
          message: `${granularity} consolidation completed`,
          memoryFile: result.memoryFile,
          archivedFiles: result.archivedFiles,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || "Consolidation failed",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  } catch (error) {
    console.error("[Routes] handleMemoryConsolidate error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Consolidation failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

// =============================================================================
// MCP Sync Routes
// =============================================================================

/**
 * Handle POST /api/mcp/sync - Manually trigger MCP sync
 *
 * Triggers an immediate pull + push with entity-core.
 * Useful for testing or when you need to sync immediately.
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON result
 */
export async function handleMcpSync(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "MCP is not enabled. Set PSYCHEROS_MCP_ENABLED=true to use entity-core sync.",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    // Check if connected
    if (!ctx.mcpClient.isConnected()) {
      return new Response(
        JSON.stringify({
          success: false,
          connected: false,
          message: "MCP client is not connected to entity-core",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Pull latest from entity-core
    const identity = await ctx.mcpClient.pull();

    // Push any pending changes
    const pushSuccess = await ctx.mcpClient.push();

    // Get pending counts
    const pending = ctx.mcpClient.getPendingCount();

    const result: {
      success: boolean;
      connected: boolean;
      pulled?: {
        self: number;
        user: number;
        relationship: number;
      };
      pushed: boolean;
      pending: {
        identity: number;
        memories: number;
      };
    } = {
      success: true,
      connected: true,
      pushed: pushSuccess,
      pending,
    };

    if (identity) {
      result.pulled = {
        self: identity.self.length,
        user: identity.user.length,
        relationship: identity.relationship.length,
      };
    }

    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleMcpSync error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "MCP sync failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

// =============================================================================
// Snapshot Routes
// =============================================================================

/**
 * Handle GET /api/snapshots - List all snapshots
 *
 * Returns snapshots grouped by category with metadata.
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON result
 */
export async function handleListSnapshots(
  ctx: RouteContext
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Snapshots require entity-core connection. Please enable MCP." }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const result = await ctx.mcpClient.listSnapshots();

  if (!result.success) {
    return new Response(
      JSON.stringify({ success: false, error: result.error }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle GET /api/snapshots/:id - Get snapshot content
 *
 * @param ctx - Route context
 * @param snapshotId - The snapshot ID (category/filename_timestamp)
 * @returns HTTP Response with JSON result
 */
export async function handleGetSnapshot(
  ctx: RouteContext,
  snapshotId: string
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Snapshots require entity-core connection. Please enable MCP." }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const decodedId = decodeURIComponent(snapshotId);
  const result = await ctx.mcpClient.getSnapshotContent(decodedId);

  if (!result.success) {
    return new Response(
      JSON.stringify({ success: false, error: result.error }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/snapshots/:id/restore - Restore snapshot
 *
 * @param ctx - Route context
 * @param snapshotId - The snapshot ID to restore
 * @returns HTTP Response with JSON result
 */
export async function handleRestoreSnapshot(
  ctx: RouteContext,
  snapshotId: string
): Promise<Response> {
  // Decode URL-encoded snapshot ID (e.g., custom%2Fmy_facets -> custom/my_facets)
  const decodedId = decodeURIComponent(snapshotId);

  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="snapshot-error">Snapshots require entity-core connection. Please enable MCP.</div>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      }
    );
  }

  const result = await ctx.mcpClient.restoreSnapshot(decodedId);

  if (!result.success) {
    const errorHtml = `<div class="snapshot-error">Restore failed: ${escapeHtml(result.error || "Unknown error")}</div>`;
    return new Response(errorHtml, {
      status: 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  // Sync restored file to local disk so Core Prompts UI shows updated content.
  // pull() (called inside restoreSnapshot) updates the in-memory cache, but the
  // Core Prompts UI reads identity files from disk at projectRoot/identity/.
  const idMatch = decodedId.match(/^(.+)\/(.+)_\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  if (idMatch) {
    const [, cat, filenamePart] = idMatch;
    const fname = `${filenamePart}.md`;
    const identity = await ctx.mcpClient.loadIdentity();
    const files = identity?.[cat as "self" | "user" | "relationship" | "custom"];
    const restored = files?.find((f: { filename: string }) => f.filename === fname);
    if (restored) {
      try {
        const localPath = `${ctx.projectRoot}/identity/${cat}/${fname}`;
        await Deno.mkdir(`${ctx.projectRoot}/identity/${cat}`, { recursive: true });
        await Deno.writeTextFile(localPath, restored.content);
      } catch (error) {
        console.error("[Snapshot] Failed to sync restored file to local disk:", error);
      }
    }
  }

  // Fetch updated list and return HTML
  const listResult = await ctx.mcpClient.listSnapshots();
  const html = renderSnapshotsView(listResult.snapshots || []);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle POST /api/snapshots/create - Create manual snapshot
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON result
 */
export async function handleCreateSnapshot(
  ctx: RouteContext
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Snapshots require entity-core connection. Please enable MCP.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const result = await ctx.mcpClient.createSnapshot();

  if (!result.success) {
    const html = `<div class="snapshot-error">Failed to create snapshot: ${result.error}</div>`;
    return new Response(html, {
      status: 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  // Fetch updated list and return HTML
  const listResult = await ctx.mcpClient.listSnapshots();
  const html = renderSnapshotsView(listResult.snapshots || []);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/snapshots - Snapshot list fragment
 *
 * @param ctx - Route context
 * @returns HTTP Response with HTML fragment
 */
export async function handleSnapshotsFragment(
  ctx: RouteContext
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    const html = `<div class="snapshot-error">Snapshots require entity-core connection. Please enable MCP.</div>`;
    return new Response(html, {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  const result = await ctx.mcpClient.listSnapshots();
  const html = renderSnapshotsView(result.snapshots || []);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/snapshots/:id - Snapshot preview fragment
 *
 * @param ctx - Route context
 * @param snapshotId - The snapshot ID to preview
 * @returns HTTP Response with HTML fragment
 */
export async function handleSnapshotPreviewFragment(
  ctx: RouteContext,
  snapshotId: string
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="snapshot-error">Snapshots require entity-core connection. Please enable MCP.</div>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      }
    );
  }

  // Decode URL-encoded snapshot ID (e.g., self%2Ffilename -> self/filename)
  const decodedId = decodeURIComponent(snapshotId);
  const result = await ctx.mcpClient.getSnapshotContent(decodedId);

  if (!result.success || !result.content) {
    return new Response(
      `<div class="snapshot-error">Failed to load snapshot: ${escapeHtml(result.error || "Unknown error")}</div>`,
      {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      }
    );
  }

  // Parse snapshot ID to get category and filename
  const match = decodedId.match(/^(.+)\/(.+)_\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  if (!match) {
    return new Response(
      `<div class="snapshot-error">Invalid snapshot ID</div>`,
      {
        status: 400,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      }
    );
  }

  const [, category, filenamePart] = match;
  const filename = `${filenamePart}.md`;

  // Import SnapshotCategory from the types file - use string type
  type SnapshotCategoryType = "self" | "user" | "relationship" | "custom";

  const html = renderSnapshotPreview(
    category as SnapshotCategoryType,
    filename,
    result.content,
    decodedId
  );

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Lorebook Routes
// =============================================================================

/**
 * Handle GET /api/lorebooks - List all lorebooks
 */
export function handleListLorebooks(ctx: RouteContext): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const lorebooks = ctx.lorebookManager.listLorebooks();
  return new Response(JSON.stringify(lorebooks), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/lorebooks - Create a new lorebook
 */
export async function handleCreateLorebook(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let name: string;
    let description: string | undefined;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      name = formData.get("name") as string;
      description = formData.get("description") as string || undefined;
    } else {
      const body = await request.json();
      name = body.name;
      description = body.description;
    }

    if (!name || typeof name !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid name" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    ctx.lorebookManager.createLorebook({
      name,
      description,
      enabled: true,
    });

    // Return updated list for HTMX
    const lorebooks = ctx.lorebookManager.listLorebooks();
    const html = renderLorebooksView(lorebooks);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleCreateLorebook error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create lorebook" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle GET /api/lorebooks/:id - Get a lorebook with entries
 */
export function handleGetLorebook(
  ctx: RouteContext,
  lorebookId: string
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
  if (!lorebook) {
    return new Response(
      JSON.stringify({ error: "Lorebook not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const entries = ctx.lorebookManager.listEntries(lorebookId);

  return new Response(JSON.stringify({ ...lorebook, entries }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle PUT /api/lorebooks/:id - Update a lorebook
 */
export async function handleUpdateLorebook(
  ctx: RouteContext,
  lorebookId: string,
  request: Request
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const body = await request.json();
    const lorebook = ctx.lorebookManager.updateLorebook(lorebookId, body);

    if (!lorebook) {
      return new Response(
        JSON.stringify({ error: "Lorebook not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return new Response(JSON.stringify(lorebook), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleUpdateLorebook error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update lorebook" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle DELETE /api/lorebooks/:id - Delete a lorebook
 */
export function handleDeleteLorebook(
  ctx: RouteContext,
  lorebookId: string
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const deleted = ctx.lorebookManager.deleteLorebook(lorebookId);
  if (!deleted) {
    return new Response(
      JSON.stringify({ error: "Lorebook not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Return updated list for HTMX
  const lorebooks = ctx.lorebookManager.listLorebooks();
  const html = renderLorebooksView(lorebooks);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /api/lorebooks/:id/entries - List entries for a lorebook
 */
export function handleListLorebookEntries(
  ctx: RouteContext,
  lorebookId: string
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const entries = ctx.lorebookManager.listEntries(lorebookId);
  return new Response(JSON.stringify(entries), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/lorebooks/:id/entries - Create an entry
 */
export async function handleCreateLorebookEntry(
  ctx: RouteContext,
  lorebookId: string,
  request: Request
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let name: string;
    let content: string;
    let triggers: string[];
    let triggerMode: string | undefined;
    let caseSensitive: boolean = false;
    let sticky: boolean = false;
    let stickyDuration: number = 0;
    let nonRecursable: boolean = false;
    let preventRecursion: boolean = false;
    let reTriggerResetsTimer: boolean = true;
    let enabled: boolean = true;
    let priority: number = 0;
    let scanDepth: number = 5;
    let maxTokens: number = 0;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      name = formData.get("name") as string;
      content = formData.get("content") as string;
      triggers = (formData.get("triggers") as string)
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      triggerMode = formData.get("triggerMode") as string || undefined;
      caseSensitive = formData.has("caseSensitive");
      sticky = formData.has("sticky");
      nonRecursable = formData.has("nonRecursable");
      preventRecursion = formData.has("preventRecursion");
      reTriggerResetsTimer = formData.has("reTriggerResetsTimer");
      enabled = formData.has("enabled");
      stickyDuration = parseInt(formData.get("stickyDuration") as string) || 0;
      priority = parseInt(formData.get("priority") as string) || 0;
      scanDepth = parseInt(formData.get("scanDepth") as string) || 5;
      maxTokens = parseInt(formData.get("maxTokens") as string) || 0;
    } else {
      const body = await request.json();
      name = body.name;
      content = body.content;
      triggers = body.triggers;
      triggerMode = body.triggerMode;
      caseSensitive = body.caseSensitive ?? false;
      sticky = body.sticky ?? false;
      stickyDuration = body.stickyDuration ?? 0;
      nonRecursable = body.nonRecursable ?? false;
      preventRecursion = body.preventRecursion ?? false;
      reTriggerResetsTimer = body.reTriggerResetsTimer ?? true;
      enabled = body.enabled ?? true;
      priority = body.priority ?? 0;
      scanDepth = body.scanDepth ?? 5;
      maxTokens = body.maxTokens ?? 0;
    }

    if (!name || typeof name !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid name" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    if (!content || typeof content !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid content" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    if (!triggers || !Array.isArray(triggers) || triggers.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid triggers array" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    ctx.lorebookManager.createEntry(lorebookId, {
      name,
      content,
      triggers,
      triggerMode: triggerMode as "substring" | "word" | "exact" | "regex" | undefined,
      caseSensitive,
      sticky,
      stickyDuration,
      nonRecursable,
      preventRecursion,
      reTriggerResetsTimer,
      enabled,
      priority,
      scanDepth,
      maxTokens,
    });

    // Return updated view for HTMX
    const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
    const entries = ctx.lorebookManager.listEntries(lorebookId);
    if (!lorebook) {
      return new Response(
        JSON.stringify({ error: "Lorebook not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    const html = renderLorebookDetailView(lorebook, entries);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleCreateLorebookEntry error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create entry" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle PUT /api/lorebooks/:bookId/entries/:entryId - Update an entry
 */
export async function handleUpdateLorebookEntry(
  ctx: RouteContext,
  _lorebookId: string,
  entryId: string,
  request: Request
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let updateData: Record<string, unknown> = {};

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      if (formData.get("name")) updateData.name = formData.get("name");
      if (formData.get("content")) updateData.content = formData.get("content");
      if (formData.get("triggers")) {
        updateData.triggers = (formData.get("triggers") as string)
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }
      if (formData.get("triggerMode")) updateData.triggerMode = formData.get("triggerMode");
      updateData.caseSensitive = formData.has("caseSensitive");
      updateData.sticky = formData.has("sticky");
      updateData.nonRecursable = formData.has("nonRecursable");
      updateData.preventRecursion = formData.has("preventRecursion");
      updateData.reTriggerResetsTimer = formData.has("reTriggerResetsTimer");
      updateData.enabled = formData.has("enabled");
      if (formData.get("stickyDuration")) updateData.stickyDuration = parseInt(formData.get("stickyDuration") as string);
      if (formData.get("priority")) updateData.priority = parseInt(formData.get("priority") as string);
      if (formData.get("scanDepth")) updateData.scanDepth = parseInt(formData.get("scanDepth") as string);
      if (formData.get("maxTokens")) updateData.maxTokens = parseInt(formData.get("maxTokens") as string);
    } else {
      const body = await request.json();
      updateData = body;
    }

    const entry = ctx.lorebookManager.updateEntry(entryId, updateData);

    if (!entry) {
      return new Response(
        JSON.stringify({ error: "Entry not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Return updated view for HTMX
    const lorebook = ctx.lorebookManager.getLorebook(entry.bookId);
    const entries = ctx.lorebookManager.listEntries(entry.bookId);
    if (!lorebook) {
      return new Response(
        JSON.stringify({ error: "Lorebook not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    const html = renderLorebookDetailView(lorebook, entries);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleUpdateLorebookEntry error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update entry" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle DELETE /api/lorebooks/:bookId/entries/:entryId - Delete an entry
 */
export function handleDeleteLorebookEntry(
  ctx: RouteContext,
  lorebookId: string,
  entryId: string
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const deleted = ctx.lorebookManager.deleteEntry(entryId);
  if (!deleted) {
    return new Response(
      JSON.stringify({ error: "Entry not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Return updated view for HTMX
  const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
  const entries = ctx.lorebookManager.listEntries(lorebookId);
  if (!lorebook) {
    return new Response(
      JSON.stringify({ error: "Lorebook not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
  const html = renderLorebookDetailView(lorebook, entries);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle DELETE /api/lorebooks/state/:conversationId - Reset sticky state
 */
export function handleResetLorebookState(
  ctx: RouteContext,
  conversationId: string
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  ctx.lorebookManager.resetState(conversationId);

  return new Response(
    JSON.stringify({ success: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// =============================================================================
// Lorebook Fragment Handlers
// =============================================================================

/**
 * Handle GET /fragments/settings/lorebooks - Lorebooks list view
 */
export function handleLorebooksFragment(ctx: RouteContext): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      '<div class="error">Lorebook system not available</div>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const lorebooks = ctx.lorebookManager.listLorebooks();
  const html = renderLorebooksView(lorebooks);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/lorebooks/:id - Single lorebook view
 */
export function handleLorebookDetailFragment(
  ctx: RouteContext,
  lorebookId: string
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      '<div class="error">Lorebook system not available</div>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
  if (!lorebook) {
    return new Response(
      '<div class="error">Lorebook not found</div>',
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const entries = ctx.lorebookManager.listEntries(lorebookId);
  const html = renderLorebookDetailView(lorebook, entries);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/lorebooks/:bookId/entries/:entryId/edit - Entry editor
 */
export function handleLorebookEntryEditFragment(
  ctx: RouteContext,
  _bookId: string,
  entryId: string
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      '<div class="error">Lorebook system not available</div>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const entry = ctx.lorebookManager.getEntry(entryId);
  if (!entry) {
    return new Response(
      '<div class="error">Entry not found</div>',
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const html = renderEntryEditor(entry);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// =============================================================================
// Knowledge Graph Routes
// =============================================================================

/**
 * Handle GET /graph - Knowledge Graph visualization page
 *
 * @param ctx - Route context
 * @returns HTTP Response with graph visualization HTML
 */
export async function handleGraphView(ctx: RouteContext): Promise<Response> {
  // Graph data is in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="error">Knowledge Graph requires entity-core connection. Please enable MCP.</div>`,
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  // Get initial stats
  const stats = await ctx.mcpClient.getGraphStats();
  const html = renderGraphView(stats);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /api/graph/data - Get full graph data for visualization
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON graph data
 */
export async function handleGetGraphData(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ error: "Knowledge Graph requires entity-core connection" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const [nodes, edges, stats] = await Promise.all([
      ctx.mcpClient.getGraphNodes({ limit: 500 }),
      ctx.mcpClient.getGraphEdges(),
      ctx.mcpClient.getGraphStats(),
    ]);

    return new Response(
      JSON.stringify({ nodes, edges, stats }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("[Graph] Failed to get graph data:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch graph data" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle POST /api/graph/nodes - Create a graph node
 *
 * @param ctx - Route context
 * @param request - HTTP request with node data
 * @returns HTTP Response with result
 */
export async function handleCreateGraphNode(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Knowledge Graph requires entity-core connection" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.createGraphNode(body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to create node:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to create node" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle POST /api/graph/edges - Create a graph edge
 *
 * @param ctx - Route context
 * @param request - HTTP request with edge data
 * @returns HTTP Response with result
 */
export async function handleCreateGraphEdge(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Knowledge Graph requires entity-core connection" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.createGraphEdge(body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to create edge:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to create edge" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle DELETE /api/graph/nodes/:id - Delete a graph node
 *
 * @param ctx - Route context
 * @param nodeId - Node ID to delete
 * @returns HTTP Response with result
 */
export async function handleDeleteGraphNode(
  ctx: RouteContext,
  nodeId: string
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Knowledge Graph requires entity-core connection" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const result = await ctx.mcpClient.deleteGraphNode(nodeId);
  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle DELETE /api/graph/edges/:id - Delete a graph edge
 *
 * @param ctx - Route context
 * @param edgeId - Edge ID to delete
 * @returns HTTP Response with result
 */
export async function handleDeleteGraphEdge(
  ctx: RouteContext,
  edgeId: string
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Knowledge Graph requires entity-core connection" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const result = await ctx.mcpClient.deleteGraphEdge(edgeId);
  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle PUT /api/graph/nodes/:id - Update a graph node
 */
export async function handleUpdateGraphNode(
  ctx: RouteContext,
  request: Request,
  nodeId: string
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Knowledge Graph requires entity-core connection" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.updateGraphNode(nodeId, body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to update node:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to update node" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle PUT /api/graph/edges/:id - Update a graph edge
 */
export async function handleUpdateGraphEdge(
  ctx: RouteContext,
  request: Request,
  edgeId: string
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "Knowledge Graph requires entity-core connection" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.updateGraphEdge(edgeId, body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to update edge:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to update edge" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

// =============================================================================
// Appearance Settings Routes
// =============================================================================

/**
 * Handle GET /fragments/settings/appearance - Appearance settings fragment
 *
 * @param _ctx - Route context
 * @returns HTTP Response with appearance settings HTML fragment
 */
export function handleAppearanceSettingsFragment(_ctx: RouteContext): Response {
  const html = renderAppearanceSettings();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Background Image Upload Routes
// =============================================================================

/**
 * Handle GET /api/backgrounds - List uploaded background images
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON array of backgrounds
 */
export async function handleListBackgrounds(ctx: RouteContext): Promise<Response> {
  const backgroundsDir = `${ctx.projectRoot}/web/backgrounds`;
  const backgrounds: Array<{ filename: string; url: string }> = [];

  try {
    for await (const entry of Deno.readDir(backgroundsDir)) {
      if (entry.isFile && /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.name)) {
        backgrounds.push({
          filename: entry.name,
          url: `/backgrounds/${entry.name}`,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  return new Response(JSON.stringify({ backgrounds }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/backgrounds - Upload a background image
 *
 * @param ctx - Route context
 * @param request - HTTP Request with multipart form data
 * @returns HTTP Response with JSON result
 */
export async function handleUploadBackground(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("background");

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return new Response(
        JSON.stringify({ error: "Invalid file type. Allowed: JPEG, PNG, GIF, WebP" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Validate file size
    if (file.size > MAX_BACKGROUND_SIZE) {
      return new Response(
        JSON.stringify({ error: "File too large. Maximum size: 5MB" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Ensure backgrounds directory exists (inside web/ for static serving)
    const backgroundsDir = `${ctx.projectRoot}/web/backgrounds`;
    await Deno.mkdir(backgroundsDir, { recursive: true });

    // Generate unique filename
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const ext = file.name.split(".").pop()?.toLowerCase() || "png";
    const filename = `bg-${timestamp}-${randomSuffix}.${ext}`;

    // Write file
    const filePath = `${backgroundsDir}/${filename}`;
    const arrayBuffer = await file.arrayBuffer();
    await Deno.writeFile(filePath, new Uint8Array(arrayBuffer));

    return new Response(
      JSON.stringify({
        success: true,
        filename,
        url: `/backgrounds/${filename}`,
      }),
      {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("[Routes] handleUploadBackground error:", error);
    return new Response(
      JSON.stringify({ error: "Upload failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

/**
 * Handle DELETE /api/backgrounds/:filename - Delete a background image
 *
 * @param ctx - Route context
 * @param filename - The filename to delete
 * @returns HTTP Response with JSON result
 */
export async function handleDeleteBackground(
  ctx: RouteContext,
  filename: string
): Promise<Response> {
  // Sanitize filename - only allow safe characters
  const decodedFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9_.-]+$/.test(decodedFilename)) {
    return new Response(
      JSON.stringify({ error: "Invalid filename" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Only allow image files
  if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(decodedFilename)) {
    return new Response(
      JSON.stringify({ error: "Invalid file type" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const filePath = `${ctx.projectRoot}/web/backgrounds/${decodedFilename}`;
    await Deno.remove(filePath);

    return new Response(
      JSON.stringify({ success: true, message: "Background deleted" }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(
        JSON.stringify({ error: "File not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    console.error("[Routes] handleDeleteBackground error:", error);
    return new Response(
      JSON.stringify({ error: "Delete failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

// =============================================================================
// LLM Settings Routes
// =============================================================================

/**
 * Handle GET /api/llm-settings - Return current LLM settings (API key masked).
 */
export function handleGetLLMSettings(ctx: RouteContext): Response {
  const settings = ctx.getLLMSettings();
  const response = {
    ...settings,
    apiKey: maskApiKey(settings.apiKey),
  };
  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/llm-settings - Save and apply LLM settings.
 * If the API key field contains the masked value, it keeps the existing key.
 */
export async function handleSaveLLMSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<LLMSettings>;
    const current = ctx.getLLMSettings();

    const updated: LLMSettings = {
      baseUrl: body.baseUrl ?? current.baseUrl,
      apiKey: (body.apiKey && !body.apiKey.includes("••••")) ? body.apiKey : current.apiKey,
      model: body.model ?? current.model,
      workerModel: body.workerModel ?? current.workerModel,
      temperature: body.temperature ?? current.temperature,
      topP: body.topP ?? current.topP,
      topK: body.topK ?? current.topK,
      frequencyPenalty: body.frequencyPenalty ?? current.frequencyPenalty,
      presencePenalty: body.presencePenalty ?? current.presencePenalty,
      maxTokens: body.maxTokens ?? current.maxTokens,
      contextLength: body.contextLength ?? current.contextLength,
      thinkingEnabled: body.thinkingEnabled ?? current.thinkingEnabled,
    };

    await ctx.updateLLMSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveLLMSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/llm-settings/reset - Reset to env-based defaults.
 * Deletes any saved overrides and reloads from environment variables.
 */
export async function handleResetLLMSettings(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const defaults = getDefaultSettings();
    await ctx.updateLLMSettings(defaults);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleResetLLMSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to reset settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/llm-settings/test - Test the API connection.
 * Sends a minimal request and reports success/failure with latency.
 */
export async function handleTestLLMConnection(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    // Allow testing with provided settings before saving
    let settings = ctx.getLLMSettings();
    try {
      const body = await request.json() as Partial<LLMSettings> | undefined;
      if (body) {
        const current = ctx.getLLMSettings();
        settings = {
          ...current,
          ...body,
          apiKey: (body.apiKey && !body.apiKey.includes("••••")) ? body.apiKey : current.apiKey,
        };
      }
    } catch {
      // No body or invalid JSON - use current settings
    }

    const startTime = performance.now();

    const response = await fetch(settings.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        stream: false,
      }),
    });

    const latency = Math.round(performance.now() - startTime);

    if (response.ok) {
      return new Response(
        JSON.stringify({ success: true, latency }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } else {
      let errorMsg = `HTTP ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody.error?.message) {
          errorMsg = errBody.error.message;
        }
      } catch {
        errorMsg = `${errorMsg}: ${response.statusText}`;
      }
      return new Response(
        JSON.stringify({ success: false, error: errorMsg, latency }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  } catch (error) {
    console.error("[Routes] handleTestLLMConnection error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Connection failed" }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /fragments/settings/llm - LLM settings UI fragment.
 */
export function handleLLMSettingsFragment(ctx: RouteContext): Response {
  const html = renderLLMSettings(ctx.getLLMSettings());
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
