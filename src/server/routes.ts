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
import type { WebSearchSettings } from "../llm/mod.ts";
import type { DiscordSettings, HomeSettings } from "../llm/mod.ts";
import { maskApiKey, getDefaultSettings, getDefaultWebSearchSettings, maskWebSearchSettings, getDefaultDiscordSettings, maskDiscordSettings } from "../llm/mod.ts";
import type { ToolRegistry } from "../tools/mod.ts";
import type { ToolsSettings } from "../tools/mod.ts";
import { AVAILABLE_TOOLS, TOOL_CATEGORIES, loadCustomTools } from "../tools/mod.ts";
import type { Retriever, RAGConfig } from "../rag/mod.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { LorebookManager } from "../lorebook/mod.ts";
import type { VaultManager } from "../vault/mod.ts";
import type { MemoryIndexer } from "../rag/indexer.ts";
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
  renderMemoriesView,
  renderMemoryList,
  renderMemoryEditor,
  renderConsolidationTab,
  renderConsolidationRunning,
  renderConsolidationComplete,
  renderSnapshotsView,
  renderSnapshotPreview,
  renderLorebooksView,
  renderLorebookDetailView,
  renderEntryEditor,
  renderAppearanceSettings,
  renderLLMSettings,
  renderSettingsHub,
  renderGeneralSettings,
  renderWebSearchSettings,
  renderConnectionsSettings,
  renderConnectionsDiscordSettings,
  renderHomeSettings,
  renderToolsSettings,
  renderEntityCoreHub,
  renderEntityCoreOverview,
  renderEntityCoreGraph,
  renderEntityCoreMaintenance,
  renderEntityCoreSnapshots,
  renderEntityCoreSnapshotPreview,
  renderECConsolidationRunning,
  renderECConsolidationComplete,
  type GeneralSettings,
  type EntityCoreOverviewData,
  escapeHtml,
  type MetricsMap,
} from "./templates.ts";
import { updateConversationTitle, deleteConversation, deleteConversations, updateMessageContent } from "./state-changes.ts";
import { generateUIUpdates, renderAsOobSwaps } from "./ui-updates.ts";
import { MAX_SSE_MESSAGE_SIZE, SSE_TRUNCATION_SUFFIX } from "../constants.ts";
import { getBroadcaster } from "./broadcaster.ts";
import { readMemoryFile, writeMemoryFile, listMemoryFiles } from "../memory/file-writer.ts";
import {
  loadOrGenerateKeys,
  saveSubscription,
  deleteSubscription as deletePushSubscription,
} from "../push/mod.ts";
import { renderMarkdown } from "./markdown.ts";

/**
 * Context passed to route handlers containing dependencies.
 */
export interface RouteContext {
  /** Database client for persistence */
  db: DBClient;
  /** LLM client for chat completions */
  llm: LLMClient;
  /** Tool registry getter for tool execution */
  tools: () => ToolRegistry;
  /** Root directory of the project for file serving */
  projectRoot: string;
  /** Pulse engine for autonomous entity prompts */
  pulseEngine?: import("../pulse/mod.ts").PulseEngine;
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
  /** Optional vault manager for document storage */
  vaultManager?: VaultManager;
  /** Optional memory indexer for reindexing after edits */
  memoryIndexer?: MemoryIndexer;
  /** Get current LLM settings */
  getLLMSettings: () => LLMSettings;
  /** Update LLM settings and hot-reload */
  updateLLMSettings: (settings: LLMSettings) => Promise<void>;
  /** Get current web search settings */
  getWebSearchSettings: () => WebSearchSettings;
  /** Update web search settings and hot-reload tool registry */
  updateWebSearchSettings: (settings: WebSearchSettings) => Promise<void>;
  /** Get current Discord settings */
  getDiscordSettings: () => DiscordSettings;
  /** Update Discord settings and hot-reload tool registry */
  updateDiscordSettings: (settings: DiscordSettings) => Promise<void>;
  /** Get current Home settings */
  getHomeSettings: () => HomeSettings;
  /** Update Home settings and hot-reload tool registry */
  updateHomeSettings: (settings: HomeSettings) => Promise<void>;
  /** Get current tools settings */
  getToolSettings: () => ToolsSettings;
  /** Update tools settings and hot-reload tool registry */
  updateToolSettings: (settings: ToolsSettings) => Promise<void>;
  /** Custom tools loaded from custom-tools/ directory */
  customTools: Record<string, import("../tools/types.ts").Tool>;
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
export async function handleChatFragment(
  ctx: RouteContext,
  conversationId: string
): Promise<Response> {
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

  const displayNames = await loadGeneralSettings(ctx.projectRoot);
  const chatHtml = renderChatView(messages, metricsMap, displayNames);

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

  // Build set of conversation IDs that have active pulses
  const allPulses = ctx.db.listPulses({ enabled: true });
  const pulseConversationIds = new Set<string>();
  for (const pulse of allPulses) {
    if (pulse.conversationId) {
      pulseConversationIds.add(pulse.conversationId);
    }
  }

  const html = renderConversationList(conversations, pulseConversationIds);

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
  const displayNames = await loadGeneralSettings(ctx.projectRoot);
  const html = renderMessage(updatedMsg, metrics, displayNames);

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
 * Chat retry request body schema.
 * Re-attempts the last failed turn without re-persisting the user message.
 */
interface RetryChatRequestBody {
  conversationId: string;
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

        // Update pulse engine's last user message timestamp (for inactivity triggers)
        if (ctx.pulseEngine) {
          ctx.pulseEngine.updateLastUserMessage();
        }

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
            memoryIndexer: ctx.memoryIndexer,
            lorebookManager: ctx.lorebookManager,
            vaultManager: ctx.vaultManager,
            webSearchSettings: ctx.getWebSearchSettings(),
            discordSettings: ctx.getDiscordSettings(),
            homeSettings: ctx.getHomeSettings(),
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
 * Handle POST /api/chat/retry - Retry a failed turn without re-persisting the user message
 *
 * When a turn fails (e.g. rate limit), the user message is already in the DB.
 * This endpoint re-attempts the LLM call using the already-persisted user message
 * without creating a duplicate.
 */
export async function handleChatRetry(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  let body: RetryChatRequestBody;
  try {
    body = await request.json();
    if (!body.conversationId || typeof body.conversationId !== "string") {
      throw new Error("Missing or invalid conversationId");
    }
  } catch (error) {
    console.error("[Routes] handleChatRetry parse error:", error);
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

  // Retrieve the last user message from the conversation
  const allMessages = ctx.db.getMessages(body.conversationId);
  const lastUserMessage = [...allMessages].reverse().find((m) => m.role === "user");

  if (!lastUserMessage) {
    return new Response(
      JSON.stringify({ error: "No user message found to retry" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const userMessage = lastUserMessage.content;

  const abortController = new AbortController();
  const { signal } = abortController;

  const stream = new ReadableStream<SSEEvent>({
    async start(controller) {
      try {
        if (ctx.pulseEngine) {
          ctx.pulseEngine.updateLastUserMessage();
        }

        const turn = new EntityTurn(
          ctx.llm,
          ctx.db,
          ctx.tools,
          {
            projectRoot: ctx.projectRoot,
            ragRetriever: ctx.ragRetriever,
            chatRAG: ctx.chatRAG,
            mcpClient: ctx.mcpClient,
            memoryIndexer: ctx.memoryIndexer,
            lorebookManager: ctx.lorebookManager,
            vaultManager: ctx.vaultManager,
            webSearchSettings: ctx.getWebSearchSettings(),
            discordSettings: ctx.getDiscordSettings(),
            homeSettings: ctx.getHomeSettings(),
          }
        );

        // Process with retry mode: skip user message persistence
        for await (const chunk of turn.process(body.conversationId, userMessage, { retry: true })) {
          if (signal.aborted) break;
          controller.enqueue(convertToSSEEvent(chunk));
        }
      } catch (error) {
        if (signal.aborted) return;

        const errorCode = (error as { code?: string })?.code || "UNKNOWN";
        const statusCode = (error as { statusCode?: number })?.statusCode;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[Routes] Chat retry streaming error — code=${errorCode}` +
          (statusCode ? `, http=${statusCode}` : "") +
          `: ${errorMsg}`,
        );

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

        controller.enqueue({
          type: "status",
          data: JSON.stringify({ error: userMessage, errorCode }),
        });
        controller.enqueue({ type: "done", data: "error" });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

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

    case "message_id":
      return {
        type: "message_id",
        data: JSON.stringify({ role: chunk.role, id: chunk.id }),
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
// Memories Settings Routes
// =============================================================================

/**
 * Valid memory granularities for route parameters.
 */
const VALID_MEMORY_GRANULARITIES = ["daily", "weekly", "monthly", "yearly", "significant"];

/**
 * Date validation regex (same as entity-core).
 */
const DATE_REGEX = /^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/;

/**
 * Handle GET /fragments/settings/memories - Memories view fragment.
 */
export function handleMemoriesFragment(_ctx: RouteContext): Response {
  const html = renderMemoriesView("daily");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/memories/:granularity - Memory list fragment.
 */
export async function handleMemoriesListFragment(
  ctx: RouteContext,
  granularity: string,
): Promise<Response> {
  if (!VALID_MEMORY_GRANULARITIES.includes(granularity)) {
    return new Response("Invalid granularity", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const files = await listMemoryFiles(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      ctx.projectRoot,
    );

    const html = renderMemoryList(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      files,
    );

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleMemoriesListFragment error:", error);
    return new Response(renderSaveError("Failed to list memories"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle GET /fragments/settings/memories/:granularity/:date - Memory editor fragment.
 */
export async function handleMemoriesEditorFragment(
  ctx: RouteContext,
  granularity: string,
  date: string,
): Promise<Response> {
  if (!VALID_MEMORY_GRANULARITIES.includes(granularity)) {
    return new Response("Invalid granularity", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Significant memories use slug-based filenames (e.g., 2026-04-06_first-conversation.md)
  // Other granularities use date-based filenames (e.g., 2026-04-06.md)
  let filePath: string;
  if (granularity === "significant") {
    const filename = `${date}.md`;
    if (!isValidFilename(filename)) {
      return new Response("Invalid filename", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }
    filePath = `significant/${filename}`;
  } else {
    // Sanitize date to prevent path traversal
    const sanitizedDate = date.replace(/[^0-9W\-]/g, "");
    if (!DATE_REGEX.test(sanitizedDate)) {
      return new Response("Invalid date format", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }
    filePath = `${granularity}/${sanitizedDate}.md`;
    date = sanitizedDate;
  }

  try {
    let content: string | null = null;
    let metadata: { sourceInstance?: string; createdAt?: string; updatedAt?: string; version?: number; editedBy?: string } | undefined;

    // For MCP lookup, significant memories use the date portion of the filename
    const mcpDate = granularity === "significant" ? date.split("_")[0] : date;

    // Try MCP first for richer metadata
    if (ctx.mcpClient?.isConnected()) {
      const entry = await ctx.mcpClient.readMemory(
        granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
        mcpDate,
      );
      if (entry) {
        content = entry.content;
        metadata = {
          sourceInstance: entry.sourceInstance,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          version: entry.version,
        };
      }
    }

    // Fall back to local file
    if (content === null) {
      content = await readMemoryFile(filePath, ctx.projectRoot);
    }

    if (content === null) {
      return new Response("Memory not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const html = renderMemoryEditor(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      date,
      content,
      metadata,
    );

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleMemoriesEditorFragment error:", error);
    return new Response(renderSaveError("Failed to load memory"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle POST /api/memories/:granularity/:date - Save edited memory.
 */
export async function handleSaveMemory(
  ctx: RouteContext,
  granularity: string,
  date: string,
  request: Request,
): Promise<Response> {
  if (!VALID_MEMORY_GRANULARITIES.includes(granularity)) {
    return new Response(renderSaveError("Invalid granularity"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Significant memories use slug-based filenames (e.g., 2026-04-06_first-conversation.md)
  let filePath: string;
  let mcpDate: string;
  if (granularity === "significant") {
    const filename = `${date}.md`;
    if (!isValidFilename(filename)) {
      return new Response(renderSaveError("Invalid filename"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    filePath = `significant/${filename}`;
    mcpDate = date.split("_")[0];
  } else {
    // Sanitize date
    const sanitizedDate = date.replace(/[^0-9W\-]/g, "");
    if (!DATE_REGEX.test(sanitizedDate)) {
      return new Response(renderSaveError("Invalid date format"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    filePath = `${granularity}/${sanitizedDate}.md`;
    mcpDate = sanitizedDate;
  }

  try {
    // Parse form data
    const formData = await request.formData();
    const content = formData.get("content") as string | null;

    if (!content || content.trim().length === 0) {
      return new Response(renderSaveError("Content cannot be empty"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Write local file
    const fullPath = `${ctx.projectRoot}/memories/${filePath}`;

    // Ensure directory exists
    await Deno.mkdir(`${ctx.projectRoot}/memories/${granularity}`, { recursive: true });
    await Deno.writeTextFile(fullPath, content);

    // Push to entity-core via MCP (overwrite path)
    if (ctx.mcpClient?.isConnected()) {
      try {
        await ctx.mcpClient.updateMemory(
          granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
          mcpDate,
          content,
        );
      } catch (error) {
        console.error("[Routes] MCP memory_update failed (local save succeeded):", error instanceof Error ? error.message : String(error));
      }
    }

    // Reindex the specific file in RAG
    if (ctx.memoryIndexer) {
      try {
        await ctx.memoryIndexer.reindexFile(filePath);
      } catch (error) {
        console.error("[Routes] Memory reindex failed (non-fatal):", error instanceof Error ? error.message : String(error));
      }
    }

    return new Response(renderSaveSuccess(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleSaveMemory error:", error);
    return new Response(renderSaveError("Failed to save memory"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Convert a title to a URL-safe filename slug.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

/**
 * Handle POST /api/memories/significant/create - Create a new significant memory.
 */
export async function handleCreateSignificantMemory(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const title = formData.get("title") as string | null;
    const date = formData.get("date") as string | null;
    const content = formData.get("content") as string | null;

    if (!date || !DATE_REGEX.test(date)) {
      return new Response(renderSaveError("Invalid date format"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (!content || content.trim().length === 0) {
      return new Response(renderSaveError("Content cannot be empty"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Derive slug from title, or auto-generate from first line of content
    const displayTitle = title || content.trim().split("\n")[0];
    const slug = (title && title.trim().length > 0)
      ? slugify(title)
      : slugify(content.trim().split("\n")[0].replace(/^[-*#>\s]+/, ""));

    if (!slug) {
      return new Response(renderSaveError("Could not generate filename from title"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Generate filename: {date}_{slug}.md with conflict resolution
    const significantDir = `${ctx.projectRoot}/memories/significant`;
    const base = `${date}_${slug}`;
    let fileName = `${base}.md`;
    try {
      const existing = [...Deno.readDirSync(significantDir)]
        .map((e) => e.name);
      if (existing.includes(fileName)) {
        let n = 2;
        while (existing.includes(`${base}-${n}.md`)) n++;
        fileName = `${base}-${n}.md`;
      }
    } catch {
      // Directory may not exist yet
    }

    const formattedContent = `# ${displayTitle}

${content.trim()}
`;

    // Write local file using writeMemoryFile (handles DB tracking for non-significant;
    // significant skips DB tracking per file-writer.ts)
    const memory = {
      path: `significant/${fileName}`,
      content: formattedContent,
      chatIds: [],
      granularity: "significant" as const,
      date,
    };

    await writeMemoryFile(memory, ctx.db, ctx.projectRoot);

    // Push to entity-core via MCP
    if (ctx.mcpClient?.isConnected()) {
      try {
        await ctx.mcpClient.createMemory("significant", date, formattedContent);
      } catch (error) {
        console.error("[Routes] MCP memory_create for significant failed (local save succeeded):", error instanceof Error ? error.message : String(error));
      }
    }

    // Reindex
    if (ctx.memoryIndexer) {
      try {
        await ctx.memoryIndexer.reindexFile(`significant/${fileName}`);
      } catch (error) {
        console.error("[Routes] Memory reindex failed (non-fatal):", error instanceof Error ? error.message : String(error));
      }
    }

    // Return redirect to refresh the significant tab
    return new Response("", {
      status: 200,
      headers: {
        "HX-Redirect": "/fragments/settings/memories/significant",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("[Routes] handleCreateSignificantMemory error:", error);
    return new Response(renderSaveError("Failed to create significant memory"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

// =============================================================================
// Memory Consolidation Routes
// =============================================================================

/**
 * Handle POST /api/memory/consolidate/:granularity - Trigger memory consolidation
 *
 * Manually triggers consolidation for testing/debugging purposes.
 * Delegates to entity-core via MCP.
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

  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ error: "Consolidation requires MCP connection to entity-core" }),
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
    const result = await ctx.mcpClient.consolidateMemories({
      granularity: granularity as "weekly" | "monthly" | "yearly",
    });

    return new Response(
      JSON.stringify(result),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
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

// In-memory guard to prevent double-runs
let consolidationRunning = false;

/**
 * Handle GET /fragments/settings/memories/consolidation - Consolidation status tab.
 * Consolidation status is now managed by entity-core. If MCP is connected, show
 * the UI with a catch-up button that delegates to entity-core.
 */
export async function handleConsolidationFragment(ctx: RouteContext): Promise<Response> {
  try {
    // Consolidation runs in entity-core; if MCP is available, show the UI.
    // Since we can't check entity-core's consolidation status without calling it,
    // assume all may need consolidation and let the user trigger it.
    const mcpAvailable = !!ctx.mcpClient;
    const html = renderConsolidationTab({
      weekly: mcpAvailable,
      monthly: mcpAvailable,
      yearly: mcpAvailable,
    });
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleConsolidationFragment error:", error);
    return new Response(renderSaveError("Failed to check consolidation status"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle POST /api/memories/consolidation/run - Run catch-up consolidation.
 * Delegates to entity-core via MCP.
 */
export async function handleConsolidationRun(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(renderSaveError("Consolidation requires MCP connection to entity-core"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (consolidationRunning) {
    return new Response(renderSaveError("Consolidation is already running"), {
      status: 409,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  consolidationRunning = true;

  // Return the loading state immediately
  const html = renderConsolidationRunning();
  const response = new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  // Fire consolidation in background via MCP
  runConsolidationInBackground(ctx);

  return response;
}

/**
 * Run all consolidations in the background via MCP and broadcast results via SSE.
 */
function runConsolidationInBackground(ctx: RouteContext): void {
  const mcpClient = ctx.mcpClient;

  if (!mcpClient) {
    consolidationRunning = false;
    return;
  }

  mcpClient.consolidateMemories({ all: true })
    .then((result) => {
      const displayResults = result.consolidations.map((c) => ({
        granularity: c.granularity,
        success: c.success,
        error: c.error,
      }));

      const html = renderConsolidationComplete(displayResults);
      getBroadcaster().broadcastUpdate({
        target: "#consolidation-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .catch((error) => {
      console.error("[Routes] Background consolidation failed:", error);
      const html = renderConsolidationComplete([
        { granularity: "consolidation", success: false, error: error instanceof Error ? error.message : String(error) },
      ]);
      getBroadcaster().broadcastUpdate({
        target: "#consolidation-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .finally(() => {
      consolidationRunning = false;
    });
}

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
  const backgroundsDir = `${ctx.projectRoot}/.psycheros/backgrounds`;
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

    // Ensure backgrounds directory exists (inside .psycheros/ for persistence across container rebuilds)
    const backgroundsDir = `${ctx.projectRoot}/.psycheros/backgrounds`;
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
    const filePath = `${ctx.projectRoot}/.psycheros/backgrounds/${decodedFilename}`;
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

/**
 * Handle GET /backgrounds/:filename - Serve an uploaded background image.
 *
 * Files are stored in .psycheros/backgrounds/ (outside web/) for persistence
 * across Docker container rebuilds.
 *
 * @param ctx - Route context
 * @param filename - The filename to serve
 * @returns HTTP Response with file content or 404
 */
export async function handleServeBackground(
  ctx: RouteContext,
  filename: string
): Promise<Response> {
  // Sanitize filename
  const decodedFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9_.-]+$/.test(decodedFilename)) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Only allow image files
  if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(decodedFilename)) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const filePath = `${ctx.projectRoot}/.psycheros/backgrounds/${decodedFilename}`;

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

// =============================================================================
// Web Search Settings API Routes
// =============================================================================

/**
 * Handle GET /api/web-search-settings - Return current web search settings (API keys masked).
 */
export function handleGetWebSearchSettings(ctx: RouteContext): Response {
  const settings = maskWebSearchSettings(ctx.getWebSearchSettings());
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/web-search-settings - Save and apply web search settings.
 * If an API key field contains the masked value, it keeps the existing key.
 */
export async function handleSaveWebSearchSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<WebSearchSettings>;
    const current = ctx.getWebSearchSettings();

    const updated: WebSearchSettings = {
      provider: body.provider === "disabled" ? "disabled" : (body.provider ?? current.provider),
      tavilyApiKey: (body.tavilyApiKey && !body.tavilyApiKey.includes("••••"))
        ? body.tavilyApiKey
        : current.tavilyApiKey,
      braveApiKey: (body.braveApiKey && !body.braveApiKey.includes("••••"))
        ? body.braveApiKey
        : current.braveApiKey,
    };

    await ctx.updateWebSearchSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveWebSearchSettings error:", error);
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
 * Handle POST /api/web-search-settings/reset - Reset to env-based defaults.
 */
export async function handleResetWebSearchSettings(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const defaults = getDefaultWebSearchSettings();
    await ctx.updateWebSearchSettings(defaults);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleResetWebSearchSettings error:", error);
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
 * Handle GET /fragments/settings/web-search - Web search settings UI fragment.
 */
export function handleWebSearchSettingsFragment(ctx: RouteContext): Response {
  const html = renderWebSearchSettings(maskWebSearchSettings(ctx.getWebSearchSettings()));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Discord Settings API Routes
// =============================================================================

/**
 * Handle GET /api/discord-settings - Get current Discord settings (masked).
 */
export function handleGetDiscordSettings(ctx: RouteContext): Response {
  const settings = maskDiscordSettings(ctx.getDiscordSettings());
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/discord-settings - Save and apply Discord settings.
 * If the bot token field contains the masked value, it keeps the existing token.
 */
export async function handleSaveDiscordSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<DiscordSettings>;
    const current = ctx.getDiscordSettings();

    const updated: DiscordSettings = {
      enabled: body.enabled ?? current.enabled,
      botToken: (body.botToken && !body.botToken.includes("••••"))
        ? body.botToken
        : current.botToken,
      defaultChannelId: body.defaultChannelId ?? current.defaultChannelId,
    };

    await ctx.updateDiscordSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveDiscordSettings error:", error);
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
 * Handle POST /api/discord-settings/reset - Reset to env-based defaults.
 */
export async function handleResetDiscordSettings(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const defaults = getDefaultDiscordSettings();
    await ctx.updateDiscordSettings(defaults);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleResetDiscordSettings error:", error);
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
 * Handle GET /fragments/settings/connections - External connections hub fragment.
 */
export function handleConnectionsSettingsFragment(ctx: RouteContext): Response {
  const html = renderConnectionsSettings(
    maskDiscordSettings(ctx.getDiscordSettings()),
    ctx.getHomeSettings(),
  );
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/connections/discord - Discord settings fragment.
 */
export function handleConnectionsDiscordFragment(ctx: RouteContext): Response {
  const html = renderConnectionsDiscordSettings(maskDiscordSettings(ctx.getDiscordSettings()));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/connections/home - Home automation settings fragment.
 */
export function handleConnectionsHomeFragment(ctx: RouteContext): Response {
  const html = renderHomeSettings(ctx.getHomeSettings());
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Home Settings API Routes
// =============================================================================

/**
 * Handle GET /api/home-settings - Return current home settings.
 */
export function handleGetHomeSettings(ctx: RouteContext): Response {
  const settings = ctx.getHomeSettings();
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/home-settings - Save home settings.
 */
export async function handleSaveHomeSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<HomeSettings>;

    if (!body.devices || !Array.isArray(body.devices)) {
      return new Response(
        JSON.stringify({ error: "Invalid settings: 'devices' array is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    const updated: HomeSettings = { devices: body.devices };
    await ctx.updateHomeSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (_error) {
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }
}

// =============================================================================
// Tools Settings API Routes
// =============================================================================

/**
 * Handle GET /api/tools-settings - Return current tools settings with all tool metadata.
 */
export function handleGetToolsSettings(ctx: RouteContext): Response {
  const settings = ctx.getToolSettings();
  const overrides = settings.toolOverrides;

  // Build tool entries from built-in catalog
  const allTools: Record<string, { name: string; description: string; category: string; parameters?: Record<string, unknown> }> = {};

  for (const [name, tool] of Object.entries(AVAILABLE_TOOLS)) {
    const cat = TOOL_CATEGORIES.find((c) => c.toolNames.includes(name));
    allTools[name] = {
      name,
      description: tool.definition.function.description,
      category: cat?.id ?? "other",
      parameters: tool.definition.function.parameters as Record<string, unknown> | undefined,
    };
  }

  // Add custom tools
  for (const [name, tool] of Object.entries(ctx.customTools)) {
    allTools[name] = {
      name,
      description: tool.definition.function.description,
      category: "custom",
      parameters: tool.definition.function.parameters as Record<string, unknown> | undefined,
    };
  }

  return new Response(JSON.stringify({
    toolOverrides: overrides,
    categories: TOOL_CATEGORIES,
    tools: allTools,
    customToolNames: Object.keys(ctx.customTools),
  }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/tools-settings - Save and apply tools settings.
 */
export async function handleSaveToolsSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<ToolsSettings>;

    if (!body.toolOverrides || typeof body.toolOverrides !== "object") {
      return new Response(
        JSON.stringify({ error: "toolOverrides is required and must be an object" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const updated: ToolsSettings = {
      toolOverrides: body.toolOverrides,
    };

    await ctx.updateToolSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveToolsSettings error:", error);
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
 * Handle GET /fragments/settings/tools - Tools settings UI fragment.
 */
export function handleToolsSettingsFragment(ctx: RouteContext): Response {
  const settings = ctx.getToolSettings();
  const html = renderToolsSettings(settings, AVAILABLE_TOOLS, ctx.customTools);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle POST /api/custom-tools/upload - Upload a custom tool .js file.
 */
export async function handleUploadCustomTool(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("tool");

    if (!file || !(file instanceof File)) {
      return jsonResp({ success: false, error: "No file provided" }, 400);
    }

    if (!file.name.endsWith(".js")) {
      return jsonResp({ success: false, error: "Only .js files are accepted" }, 400);
    }

    if (file.size > 100 * 1024) {
      return jsonResp({ success: false, error: "File too large (max 100KB)" }, 400);
    }

    const customDir = `${ctx.projectRoot}/custom-tools`;
    try {
      await Deno.mkdir(customDir, { recursive: true });
    } catch {
      // directory may already exist
    }

    const destPath = `${customDir}/${file.name}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(destPath, bytes);

    // Reload custom tools to pick up the new file
    const newTools = await loadCustomTools(ctx.projectRoot);
    ctx.customTools = newTools;

    // Detect the tool name from the newly loaded tools
    const toolName = Object.keys(newTools).length > 0
      ? Object.keys(newTools)[Object.keys(newTools).length - 1]
      : file.name;

    return jsonResp({ success: true, toolName });
  } catch (error) {
    console.error("[Routes] handleUploadCustomTool error:", error);
    const msg = error instanceof Error ? error.message : "Upload failed";
    return jsonResp({ success: false, error: msg }, 500);
  }
}

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// =============================================================================
// General Settings API Routes
// =============================================================================

const GENERAL_SETTINGS_PATH = ".psycheros/general-settings.json";

async function loadGeneralSettings(projectRoot: string): Promise<GeneralSettings> {
  try {
    const text = await Deno.readTextFile(`${projectRoot}/${GENERAL_SETTINGS_PATH}`);
    const saved = JSON.parse(text) as Partial<GeneralSettings>;
    return {
      entityName: saved.entityName || "Assistant",
      userName: saved.userName || "You",
      timezone: saved.timezone ?? "",
    };
  } catch {
    return { entityName: "Assistant", userName: "You", timezone: "" };
  }
}

/**
 * Handle GET /api/general-settings - Return current general settings as JSON.
 */
export async function handleGetGeneralSettings(ctx: RouteContext): Promise<Response> {
  const settings = await loadGeneralSettings(ctx.projectRoot);
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/general-settings - Save general settings.
 */
export async function handleSaveGeneralSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<GeneralSettings>;
    const current = await loadGeneralSettings(ctx.projectRoot);

    const updated: GeneralSettings = {
      entityName: body.entityName || current.entityName,
      userName: body.userName || current.userName,
      timezone: body.timezone !== undefined ? body.timezone : current.timezone,
    };

    const settingsDir = `${ctx.projectRoot}/.psycheros`;
    await Deno.mkdir(settingsDir, { recursive: true });
    await Deno.writeTextFile(
      `${settingsDir}/general-settings.json`,
      JSON.stringify(updated, null, 2) + "\n",
    );

    // Propagate timezone to env var so server-side formatters pick it up
    if (updated.timezone) {
      Deno.env.set("PSYCHEROS_DISPLAY_TZ", updated.timezone);
    } else {
      Deno.env.delete("PSYCHEROS_DISPLAY_TZ");
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveGeneralSettings error:", error);
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
 * Handle GET /fragments/settings/general - Render the General Settings page.
 */
export async function handleGeneralSettingsFragment(ctx: RouteContext): Promise<Response> {
  const settings = await loadGeneralSettings(ctx.projectRoot);
  const html = renderGeneralSettings(settings);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Appearance Settings API Routes
// =============================================================================

const APPEARANCE_SETTINGS_PATH = ".psycheros/appearance-settings.json";

interface AppearanceSettings {
  preset: string | null;
  customAccent: string | null;
  bgImage: string | null;
  bgBlur: number;
  bgOverlayOpacity: number;
  glassEnabled: boolean;
}

const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  preset: "phosphor",
  customAccent: null,
  bgImage: null,
  bgBlur: 0,
  bgOverlayOpacity: 0,
  glassEnabled: false,
};

async function loadAppearanceSettings(projectRoot: string): Promise<AppearanceSettings> {
  try {
    const text = await Deno.readTextFile(`${projectRoot}/${APPEARANCE_SETTINGS_PATH}`);
    const saved = JSON.parse(text) as Partial<AppearanceSettings>;
    return { ...DEFAULT_APPEARANCE_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_APPEARANCE_SETTINGS };
  }
}

/**
 * Handle GET /api/appearance-settings - Return current appearance settings as JSON.
 */
export async function handleGetAppearanceSettings(ctx: RouteContext): Promise<Response> {
  const settings = await loadAppearanceSettings(ctx.projectRoot);
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/appearance-settings - Save appearance settings.
 */
export async function handleSaveAppearanceSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<AppearanceSettings>;
    const current = await loadAppearanceSettings(ctx.projectRoot);

    const updated: AppearanceSettings = {
      preset: body.preset !== undefined ? body.preset : current.preset,
      customAccent: body.customAccent !== undefined ? body.customAccent : current.customAccent,
      bgImage: body.bgImage !== undefined ? body.bgImage : current.bgImage,
      bgBlur: body.bgBlur !== undefined ? body.bgBlur : current.bgBlur,
      bgOverlayOpacity: body.bgOverlayOpacity !== undefined ? body.bgOverlayOpacity : current.bgOverlayOpacity,
      glassEnabled: body.glassEnabled !== undefined ? body.glassEnabled : current.glassEnabled,
    };

    const settingsDir = `${ctx.projectRoot}/.psycheros`;
    await Deno.mkdir(settingsDir, { recursive: true });
    await Deno.writeTextFile(
      `${settingsDir}/appearance-settings.json`,
      JSON.stringify(updated, null, 2) + "\n",
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveAppearanceSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save appearance settings" }),
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

// =============================================================================
// Vault API Routes
// =============================================================================

/** JSON response helper */
function vaultJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

/** HTML fragment response helper */
function vaultHtml(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /api/vault - List vault documents.
 */
export function handleListVault(ctx: RouteContext): Response {
  if (!ctx.vaultManager) return vaultJson({ error: "Vault not available" }, 503);

  const docs = ctx.vaultManager.listDocuments();
  return vaultJson({ documents: docs });
}

/**
 * Handle POST /api/vault - Upload a vault document.
 */
export async function handleUploadVault(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  if (!ctx.vaultManager) return vaultJson({ error: "Vault not available" }, 503);

  const isHtmx = request.headers.get("HX-Request") === "true";

  try {
    const formData = await request.formData();
    const file = formData.get("document");

    if (!file || !(file instanceof File)) {
      return isHtmx
        ? vaultHtml(renderVaultView(ctx, "No file provided", "error"))
        : vaultJson({ error: "No file provided" }, 400);
    }

    const _title = formData.get("title") as string || file.name;
    const scope = (formData.get("scope") as "global" | "chat") || "global";
    const conversationId = formData.get("conversation_id") as string | undefined;

    const doc = await ctx.vaultManager.createFromUpload(file, {
      scope,
      conversationId,
      title: typeof _title === "string" ? _title : undefined,
    });

    if (isHtmx) {
      return vaultHtml(renderVaultView(ctx));
    }

    return vaultJson({ success: true, document: doc }, 201);
  } catch (error) {
    console.error("[Routes] handleUploadVault error:", error);
    const msg = error instanceof Error ? error.message : "Upload failed";
    return isHtmx
      ? vaultHtml(renderVaultView(ctx, msg, "error"))
      : vaultJson({ error: msg }, 500);
  }
}

/**
 * Handle GET /api/vault/:id - Get vault document metadata.
 */
export function handleGetVault(ctx: RouteContext, id: string): Response {
  if (!ctx.vaultManager) return vaultJson({ error: "Vault not available" }, 503);

  const doc = ctx.vaultManager.getDocument(id);
  if (!doc) return vaultJson({ error: "Document not found" }, 404);
  return vaultJson(doc);
}

/**
 * Handle PUT /api/vault/:id - Update vault document metadata.
 * Accepts both JSON (API) and form-encoded (HTMX) payloads.
 */
export async function handleUpdateVault(
  ctx: RouteContext,
  id: string,
  request: Request
): Promise<Response> {
  if (!ctx.vaultManager) return vaultJson({ error: "Vault not available" }, 503);

  const isHtmx = request.headers.get("HX-Request") === "true";

  try {
    const updates: { title?: string; content?: string } = {};

    if (isHtmx) {
      const formData = await request.formData();
      const title = formData.get("title") as string;
      const content = formData.get("content") as string;
      if (title) updates.title = title;
      if (content !== null) updates.content = content;
    } else {
      const body = await request.json() as Record<string, unknown>;
      if (body.title) updates.title = String(body.title);
      if (body.content !== undefined) updates.content = String(body.content);
    }

    const doc = await ctx.vaultManager.updateDocument(id, updates);
    if (!doc) {
      return isHtmx
        ? new Response(renderSaveError("Document not found"), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        : vaultJson({ error: "Document not found" }, 404);
    }

    return isHtmx
      ? new Response(renderSaveSuccess(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      : vaultJson(doc);
  } catch (error) {
    console.error("[Routes] handleUpdateVault error:", error);
    const msg = error instanceof Error ? error.message : "Update failed";
    return isHtmx
      ? new Response(renderSaveError(msg), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      : vaultJson({ error: msg }, 500);
  }
}

/**
 * Handle DELETE /api/vault/:id - Delete a vault document.
 */
export function handleDeleteVault(ctx: RouteContext, id: string): Response {
  if (!ctx.vaultManager) return vaultJson({ error: "Vault not available" }, 503);

  const success = ctx.vaultManager.deleteDocument(id);
  if (!success) return vaultJson({ error: "Document not found" }, 404);
  return vaultJson({ success: true });
}

/**
 * Handle POST /api/vault/search - Search vault documents.
 */
export async function handleSearchVault(
  ctx: RouteContext,
  request: Request
): Promise<Response> {
  if (!ctx.vaultManager) return vaultJson({ error: "Vault not available" }, 503);

  try {
    const body = await request.json() as { query: string; conversation_id?: string; max_results?: number };

    if (!body.query) {
      return vaultJson({ error: "Query is required" }, 400);
    }

    const results = await ctx.vaultManager.search(body.query, {
      conversationId: body.conversation_id,
      maxChunks: body.max_results ?? 5,
    });

    return vaultJson({ results });
  } catch (error) {
    console.error("[Routes] handleSearchVault error:", error);
    return vaultJson({ error: "Search failed" }, 500);
  }
}

/**
 * Handle GET /fragments/settings/vault - Vault management view.
 */
export function handleVaultFragment(ctx: RouteContext): Response {
  return vaultHtml(renderVaultView(ctx));
}

/**
 * Handle GET /fragments/settings/vault/:id - Vault document detail view.
 */
export async function handleVaultDetailFragment(
  ctx: RouteContext,
  id: string
): Promise<Response> {
  return vaultHtml(await renderVaultDetailView(ctx, id));
}

// =============================================================================
// Vault View Templates (inline to avoid large template.ts changes)
// =============================================================================

function renderVaultView(
  ctx: RouteContext,
  statusMsg?: string,
  statusType?: "success" | "error"
): string {
  const docs = ctx.vaultManager?.listDocuments() ?? [];

  const statusHtml = statusMsg
    ? `<div class="settings-status visible ${statusType}">${escapeHtml(statusMsg)}</div>`
    : "";

  const docCards = docs.length === 0
    ? `<div class="vault-empty">No documents in the Data Vault. Upload a file or the entity can create documents using vault_write.</div>`
    : docs.map((d) => {
      const scopeBadge = d.scope === "global"
        ? `<span class="vault-scope-badge vault-scope-badge--global">Global</span>`
        : `<span class="vault-scope-badge vault-scope-badge--chat">Chat</span>`;
      const sourceLabel = d.source === "entity" ? "entity" : "upload";
      const sizeKB = (d.fileSize / 1024).toFixed(1);
      const date = new Date(d.updatedAt).toLocaleDateString([], { timeZone: Deno.env.get("PSYCHEROS_DISPLAY_TZ") || Deno.env.get("TZ") || undefined });

      return `<div class="vault-card" hx-target="#chat" hx-swap="innerHTML">
        <div class="vault-card-header">
          <span class="vault-card-title">${escapeHtml(d.title)}</span>
          <div class="vault-card-meta">
            ${scopeBadge}
            <span class="vault-type-badge">${d.fileType.toUpperCase()}</span>
            <span class="vault-source-badge">${sourceLabel}</span>
          </div>
        </div>
        <div class="vault-card-body">
          <span>${d.chunkCount} chunks</span>
          <span>${sizeKB} KB</span>
          <span>${date}</span>
        </div>
        <div class="vault-card-actions">
          <a class="btn btn--sm" hx-get="/fragments/settings/vault/${d.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            View/Edit
          </a>
          <button class="btn btn--sm btn--danger"
            hx-delete="/api/vault/${d.id}"
            hx-confirm="Delete this document?"
            hx-target="#chat"
            hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) htmx.ajax('GET','/fragments/settings/vault',{target:'#chat',swap:'innerHTML'})"
            onclick="event.stopPropagation()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete
          </button>
        </div>
      </div>`;
    }).join("\n");

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn"
        hx-get="/fragments/settings"
        hx-target="#chat"
        hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span>Settings</span>
      </a>
      <div>
        <h1 class="settings-title">Data Vault</h1>
        <p class="settings-desc">Store and search documents for context-aware responses</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    ${statusHtml}
    <div class="vault-upload">
      <form hx-post="/api/vault" hx-encoding="multipart/form-data" hx-target="#chat" hx-swap="innerHTML">
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Document</label>
            <input type="file" name="document" accept=".md,.txt,.pdf,.docx,.xlsx" required />
          </div>
          <div class="form-group">
            <label>Title (optional)</label>
            <input type="text" name="title" placeholder="Auto-detected from filename" />
          </div>
          <div class="form-group form-group--small">
            <label>Scope</label>
            <select name="scope">
              <option value="global">Global</option>
              <option value="chat">Per-Chat</option>
            </select>
          </div>
          <div class="form-group" style="flex:0;align-items:flex-end">
            <button type="submit" class="btn btn--primary">Upload</button>
          </div>
        </div>
      </form>
    </div>
    <div class="vault-list">
      ${docCards}
    </div>
  </div>
</div>`;
}

async function renderVaultDetailView(ctx: RouteContext, id: string): Promise<string> {
  const doc = ctx.vaultManager?.getDocument(id);

  if (!doc) {
    return `<div class="settings-view">
      <div class="settings-header">
        <div class="settings-header-row">
          <a class="settings-back-btn"
            hx-get="/fragments/settings/vault"
            hx-target="#chat"
            hx-swap="innerHTML">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            <span>Vault</span>
          </a>
        </div>
      </div>
      <div class="settings-content">
        <div class="settings-empty">Document not found.</div>
      </div>
    </div>`;
  }

  const isEditable = doc.source === "entity";
  let contentText = "";
  let loadError = "";
  try {
    if (isEditable || doc.fileType === "md" || doc.fileType === "txt") {
      contentText = Deno.readTextFileSync(doc.filePath);
    } else {
      // For binary formats, extract text via processor
      const { extractText } = await import("../vault/processor.ts");
      contentText = await extractText(doc.filePath, doc.fileType);
    }
  } catch (err) {
    console.error(`[Vault] Failed to load content for "${doc.title}":`, err);
    loadError = "Could not load file content. The file may not exist or may be corrupted.";
  }

  const renderedContent = contentText ? renderMarkdown(contentText) : "";
  const canView = doc.fileType === "md" || doc.fileType === "txt" || isEditable;
  const showLoadError = loadError
    ? `<div class="settings-status visible error" style="margin-bottom:var(--sp-3)">${escapeHtml(loadError)}</div>`
    : "";

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn"
        hx-get="/fragments/settings/vault"
        hx-target="#chat"
        hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span>Vault</span>
      </a>
      <div>
        <h1 class="settings-title">${escapeHtml(doc.title)}</h1>
        <p class="settings-desc">
          ${doc.fileType.toUpperCase()} | ${doc.scope} | ${doc.chunkCount} chunks | ${(doc.fileSize / 1024).toFixed(1)} KB | ${doc.source}
        </p>
      </div>
    </div>
  </div>
  <div class="settings-content">
    ${showLoadError}
    <div class="settings-editor">
      <div class="settings-editor-header">
        <span class="settings-editor-filename">${escapeHtml(doc.filename)}</span>
        ${canView ? `
        <div class="vault-view-toggle" style="margin-left:auto;display:flex;gap:var(--sp-1)">
          <button type="button" class="btn btn--sm vault-toggle-btn vault-toggle-btn--active" onclick="this.classList.add('vault-toggle-btn--active');this.nextElementSibling.classList.remove('vault-toggle-btn--active');document.getElementById('vault-view-mode').style.display='';document.getElementById('vault-edit-mode').style.display='none'">View</button>
          <button type="button" class="btn btn--sm vault-toggle-btn" onclick="this.classList.add('vault-toggle-btn--active');this.previousElementSibling.classList.remove('vault-toggle-btn--active');document.getElementById('vault-edit-mode').style.display='';document.getElementById('vault-view-mode').style.display='none'">Edit</button>
        </div>` : ""}
      </div>
      <div id="vault-view-mode" class="vault-view-content" style="${canView ? '' : 'display:none'}">
        ${contentText ? `<div class="assistant-text">${renderedContent}</div>` : '<div class="vault-empty">No content to display.</div>'}
      </div>
      <div id="vault-edit-mode" class="vault-edit-content" style="display:none">
        <form hx-put="/api/vault/${doc.id}" hx-target="#vault-editor-status" hx-swap="innerHTML">
          <div class="form-group" style="margin-bottom:var(--sp-3)">
            <label>Title</label>
            <input type="text" name="title" value="${escapeHtml(doc.title)}" />
          </div>
          <div class="form-group">
            <label>Content</label>
            <textarea name="content" class="settings-textarea" rows="20">${escapeHtml(contentText)}</textarea>
          </div>
          <div class="settings-editor-actions">
            <button type="submit" class="btn btn--primary">Save Changes</button>
            <a class="btn btn--ghost" hx-get="/fragments/settings/vault" hx-target="#chat" hx-swap="innerHTML">Cancel</a>
          </div>
          <div id="vault-editor-status" class="settings-editor-status"></div>
        </form>
      </div>
    </div>
  </div>
</div>`;
}

// =============================================================================
// Push Notification Routes
// =============================================================================

/**
 * POST /api/push/subscribe - Store a push subscription.
 * Expects JSON body: { endpoint: string, keys: { p256dh: string, auth: string } }
 */
export async function handlePushSubscribe(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as {
      endpoint?: string;
      keys?: { p256dh: string; auth: string };
    };

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return new Response(
        JSON.stringify({ error: "Invalid subscription: endpoint and keys (p256dh, auth) are required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    const db = ctx.db.getRawDb();
    const keysJson = JSON.stringify(body.keys);
    saveSubscription(db, body.endpoint, keysJson);

    console.log(`[Push] Subscription stored: ${body.endpoint.substring(0, 60)}...`);

    // Return VAPID public key so client can verify
    const vapidKeys = await loadOrGenerateKeys(ctx.projectRoot);

    return new Response(
      JSON.stringify({ success: true, publicKey: vapidKeys.publicKey }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  } catch (error) {
    console.error("[Push] Subscribe error:", error instanceof Error ? error.message : String(error));
    return new Response(
      JSON.stringify({ error: "Failed to store subscription" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }
}

/**
 * POST /api/push/unsubscribe - Remove a push subscription.
 * Expects JSON body: { endpoint: string }
 */
export async function handlePushUnsubscribe(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { endpoint?: string };

    if (!body.endpoint) {
      return new Response(
        JSON.stringify({ error: "endpoint is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    const db = ctx.db.getRawDb();
    deletePushSubscription(db, body.endpoint);

    console.log(`[Push] Subscription removed: ${body.endpoint.substring(0, 60)}...`);

    return new Response(
      JSON.stringify({ success: true }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  } catch (error) {
    console.error("[Push] Unsubscribe error:", error instanceof Error ? error.message : String(error));
    return new Response(
      JSON.stringify({ error: "Failed to remove subscription" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }
}

/**
 * GET /api/push/vapid-key - Return the VAPID public key.
 * The client needs this to call pushManager.subscribe().
 */
export async function handlePushVapidKey(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const vapidKeys = await loadOrGenerateKeys(ctx.projectRoot);
    return new Response(
      JSON.stringify({ publicKey: vapidKeys.publicKey }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  } catch (error) {
    console.error("[Push] VAPID key error:", error instanceof Error ? error.message : String(error));
    return new Response(
      JSON.stringify({ error: "Failed to get VAPID key" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }
}

// =============================================================================
// Entity Core Routes
// =============================================================================

/**
 * Handle GET /fragments/settings/entity-core — Entity Core hub with tab navigation.
 */
export function handleEntityCoreFragment(_ctx: RouteContext): Response {
  const html = renderEntityCoreHub();
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/overview — Overview tab.
 */
export async function handleEntityCoreOverview(ctx: RouteContext): Promise<Response> {
  const connected = ctx.mcpClient?.isConnected() ?? false;

  let stats = null;
  let pendingIdentity = 0;
  let pendingMemories = 0;
  let lastSyncTime = null;

  if (connected && ctx.mcpClient) {
    stats = await ctx.mcpClient.getGraphStats();
    const pending = ctx.mcpClient.getPendingCount();
    pendingIdentity = pending.identity;
    pendingMemories = pending.memories;
    lastSyncTime = ctx.mcpClient.getLastSyncTime();
  }

  const data: EntityCoreOverviewData = {
    connected,
    stats,
    pendingIdentity,
    pendingMemories,
    lastSyncTime,
  };

  const html = renderEntityCoreOverview(data);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/graph — Knowledge Graph tab.
 */
export async function handleEntityCoreGraph(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="error">Knowledge Graph requires entity-core connection.</div>`,
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const stats = await ctx.mcpClient.getGraphStats();
  const html = renderEntityCoreGraph(stats);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/maintenance — Maintenance tab.
 */
export function handleEntityCoreMaintenance(ctx: RouteContext): Response {
  const mcpAvailable = !!ctx.mcpClient;
  const html = renderEntityCoreMaintenance(mcpAvailable);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/snapshots — Snapshots tab.
 */
export async function handleEntityCoreSnapshots(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="error">Snapshots require entity-core connection.</div>`,
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const result = await ctx.mcpClient.listSnapshots();
  const snapshots = result.snapshots ?? [];
  const html = renderEntityCoreSnapshots(snapshots);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/entity-core/snapshots/:id — Snapshot preview.
 */
export async function handleEntityCoreSnapshotPreview(ctx: RouteContext, snapshotId: string): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="error">Snapshots require entity-core connection.</div>`,
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const result = await ctx.mcpClient.getSnapshotContent(snapshotId);
  if (!result.success || !result.content) {
    return new Response(
      `<div class="error">${escapeHtml(result.error || "Snapshot not found")}</div>`,
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  // Parse metadata from snapshot header
  const lines = result.content.split("\n");
  let category = "self";
  let filename = "unknown";
  for (const line of lines.slice(0, 10)) {
    const catMatch = line.match(/^# Snapshot: (.+)\/(.+)$/);
    if (catMatch) {
      category = catMatch[1];
      filename = catMatch[2];
    }
  }

  const html = renderEntityCoreSnapshotPreview(category, filename, result.content, snapshotId);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle POST /api/entity-core/consolidation/run — Run consolidation from Entity Core context.
 */
let ecConsolidationRunning = false;

export async function handleEntityCoreConsolidationRun(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(renderSaveError("Consolidation requires MCP connection to entity-core"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (ecConsolidationRunning) {
    return new Response(renderSaveError("Consolidation is already running"), {
      status: 409,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  ecConsolidationRunning = true;

  const html = renderECConsolidationRunning();
  const response = new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  // Fire consolidation in background
  const mcpClient = ctx.mcpClient;
  mcpClient.consolidateMemories({ all: true })
    .then((result) => {
      const displayResults = result.consolidations.map((c) => ({
        granularity: c.granularity,
        success: c.success,
        error: c.error,
      }));

      const html = renderECConsolidationComplete(displayResults);
      getBroadcaster().broadcastUpdate({
        target: "#ec-consolidation-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .catch((error) => {
      console.error("[Routes] EC consolidation failed:", error);
      const html = renderECConsolidationComplete([
        { granularity: "consolidation", success: false, error: error instanceof Error ? error.message : String(error) },
      ]);
      getBroadcaster().broadcastUpdate({
        target: "#ec-consolidation-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .finally(() => {
      ecConsolidationRunning = false;
    });

  return response;
}

/**
 * Handle POST /api/entity-core/sync — Manual sync (pull then push).
 */
export async function handleEntityCoreSync(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(JSON.stringify({ success: false, error: "MCP not connected" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    await ctx.mcpClient.pull();
    await ctx.mcpClient.push();
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Handle POST /api/entity-core/actions/embed-memories — Run embed-existing-memories script.
 */
export async function handleEmbedMemories(_ctx: RouteContext, body: Record<string, unknown>): Promise<Response> {
  const dryRun = body.dryRun === true;
  const verbose = body.verbose === true;

  const entityCoreRoot = Deno.env.get("PSYCHEROS_ENTITY_CORE_PATH") ||
    new URL("../../entity-core", import.meta.url).pathname;

  const args = [
    "run", "-A",
    `${entityCoreRoot}/scripts/embed-existing-memories.ts`,
  ];
  if (dryRun) args.push("--dry-run");
  if (verbose) args.push("--verbose");

  try {
    const cmd = new Deno.Command("deno", {
      args,
      env: {
        ENTITY_CORE_DATA_DIR: Deno.env.get("PSYCHEROS_ENTITY_CORE_DATA_DIR") || `${entityCoreRoot}/data`,
      },
      stdout: "piped",
      stderr: "piped",
    });

    const process = cmd.spawn();
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const status = await process.status;

    const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");
    const success = status.success;

    return new Response(JSON.stringify({ success, exitCode: status.code, output }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      exitCode: -1,
      output: `Failed to spawn script: ${error instanceof Error ? error.message : String(error)}`,
    }), { headers: { "Content-Type": "application/json" } });
  }
}
