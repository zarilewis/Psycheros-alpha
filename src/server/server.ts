/**
 * SBy HTTP Server
 *
 * Main HTTP server for the SBy daemon. Handles routing, static file serving,
 * API endpoints, and SSE streaming for chat responses.
 *
 * @module
 */

import { DBClient } from "../db/mod.ts";
import { createDefaultClient, type LLMClient } from "../llm/mod.ts";
import { createDefaultRegistry, type ToolRegistry } from "../tools/mod.ts";
import { createIndexer, createRetriever, type Retriever, type RAGConfig, DEFAULT_RAG_CONFIG } from "../rag/mod.ts";
import { join } from "@std/path";
import {
  handleBatchDeleteConversations,
  handleChat,
  handleChatFragment,
  handleConversationListFragment,
  handleConversationView,
  handleCORS,
  handleCreateConversation,
  handleDeleteConversation,
  handleEvents,
  handleGetMessages,
  handleIndex,
  handleListConversations,
  handleSettingsFileEditorFragment,
  handleSettingsFileListFragment,
  handleSettingsFragment,
  handleSaveSettingsFile,
  handleStaticFile,
  handleUpdateTitle,
  type RouteContext,
} from "./routes.ts";
import { getBroadcaster } from "./broadcaster.ts";

/**
 * Server configuration options.
 */
export interface ServerConfig {
  /** Port to listen on */
  port: number;
  /** Hostname to bind to (default: "localhost") */
  hostname?: string;
  /** Root directory of the project for file serving */
  projectRoot: string;
  /** Optional database path (default: {projectRoot}/.sby/sby.db) */
  dbPath?: string;
  /** List of tool names the entity is allowed to use (empty = no tools) */
  allowedTools?: string[];
  /** RAG configuration options */
  ragConfig?: Partial<RAGConfig>;
}

/**
 * HTTP server for the SBy daemon.
 *
 * Manages the database, LLM client, tool registry, and handles
 * incoming HTTP requests with routing to appropriate handlers.
 *
 * @example
 * ```typescript
 * const server = new Server({
 *   port: 8080,
 *   projectRoot: "/path/to/project",
 * });
 *
 * await server.start();
 *
 * // Later...
 * server.stop();
 * ```
 */
/** Keepalive interval in milliseconds (30 seconds) */
const KEEPALIVE_INTERVAL_MS = 30_000;

export class Server {
  private db: DBClient;
  private llm: LLMClient;
  private tools: ToolRegistry;
  private ragRetriever: Retriever | null = null;
  private ragConfig: RAGConfig;
  private abortController: AbortController;
  private config: ServerConfig;
  private keepaliveInterval: number | null = null;

  /**
   * Create a new Server instance.
   *
   * @param config - Server configuration
   */
  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize database
    const dbPath = config.dbPath || `${config.projectRoot}/.sby/sby.db`;
    this.db = new DBClient(dbPath);

    // Initialize LLM client with defaults
    this.llm = createDefaultClient();

    // Initialize tool registry with only allowed tools
    this.tools = createDefaultRegistry(config.allowedTools ?? []);

    // Initialize RAG configuration
    this.ragConfig = {
      ...DEFAULT_RAG_CONFIG,
      ...config.ragConfig,
      memoriesDir: join(config.projectRoot, config.ragConfig?.memoriesDir ?? DEFAULT_RAG_CONFIG.memoriesDir),
    };

    // Initialize RAG retriever if enabled
    if (this.ragConfig.enabled) {
      this.ragRetriever = createRetriever(this.db.getRawDb(), this.ragConfig);
    }

    // Create abort controller for graceful shutdown
    this.abortController = new AbortController();
  }

  /**
   * Start the server.
   *
   * Begins listening for HTTP requests on the configured port.
   * Also starts the keepalive timer for persistent SSE connections.
   * If RAG is enabled, indexes memories on startup.
   */
  async start(): Promise<void> {
    const hostname = this.config.hostname || "localhost";
    const port = this.config.port;

    console.log(`Starting SBy server on http://${hostname}:${port}`);

    // Index memories on startup if RAG is enabled
    if (this.ragConfig.enabled && this.ragRetriever) {
      try {
        const indexer = createIndexer(this.db.getRawDb(), this.ragConfig.memoriesDir);
        await indexer.indexAll();
      } catch (error) {
        console.error(
          "[RAG] Failed to index memories on startup:",
          error instanceof Error ? error.message : String(error)
        );
        // Continue without RAG if indexing fails
        this.ragRetriever = null;
      }
    }

    // Start keepalive timer for persistent SSE connections
    const broadcaster = getBroadcaster();
    this.keepaliveInterval = setInterval(() => {
      broadcaster.sendKeepalive();
    }, KEEPALIVE_INTERVAL_MS);

    await Deno.serve(
      {
        port,
        hostname,
        signal: this.abortController.signal,
        onListen: ({ hostname, port }) => {
          console.log(`SBy server listening on http://${hostname}:${port}`);
        },
      },
      (request) => this.handleRequest(request)
    ).finished;
  }

  /**
   * Stop the server gracefully.
   *
   * Aborts the server, clears the keepalive timer, and closes the database connection.
   */
  stop(): void {
    console.log("Stopping SBy server...");

    // Clear keepalive timer
    if (this.keepaliveInterval !== null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    this.abortController.abort();
    this.db.close();
    console.log("SBy server stopped.");
  }

  /**
   * Get the route context for handlers.
   */
  private getContext(): RouteContext {
    return {
      db: this.db,
      llm: this.llm,
      tools: this.tools,
      projectRoot: this.config.projectRoot,
      ragRetriever: this.ragRetriever ?? undefined,
      ragConfig: this.ragConfig,
    };
  }

  /**
   * Route incoming requests to the appropriate handler.
   *
   * @param request - The incoming HTTP request
   * @returns HTTP Response
   */
  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const ctx = this.getContext();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleCORS();
    }

    try {
      // API Routes
      if (path.startsWith("/api/")) {
        return await this.handleAPIRoute(ctx, request, method, path);
      }

      // Static file and UI routes
      return await this.handleStaticRoute(ctx, method, path);
    } catch (error) {
      console.error("Request error:", error);
      const message = error instanceof Error ? error.message : "Internal server error";
      return new Response(
        JSON.stringify({ error: message }),
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
   * Handle API routes.
   */
  private async handleAPIRoute(
    ctx: RouteContext,
    request: Request,
    method: string,
    path: string
  ): Promise<Response> {
    // POST /api/chat - Stream chat response
    if (method === "POST" && path === "/api/chat") {
      return await handleChat(ctx, request);
    }

    // GET /api/events - Persistent SSE event stream
    if (method === "GET" && path === "/api/events") {
      return handleEvents(ctx, request);
    }

    // GET /api/conversations - List conversations (JSON)
    if (method === "GET" && path === "/api/conversations") {
      return handleListConversations(ctx);
    }

    // POST /api/conversations - Create conversation
    if (method === "POST" && path === "/api/conversations") {
      return await handleCreateConversation(ctx, request);
    }

    // GET /api/conversations/:id/messages - Get messages
    const messagesMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (method === "GET" && messagesMatch) {
      const conversationId = messagesMatch[1];
      return handleGetMessages(ctx, conversationId);
    }

    // PATCH /api/conversations/:id/title - Update title
    const titleMatch = path.match(/^\/api\/conversations\/([^/]+)\/title$/);
    if (method === "PATCH" && titleMatch) {
      const conversationId = titleMatch[1];
      return await handleUpdateTitle(ctx, conversationId, request);
    }

    // DELETE /api/conversations - Batch delete conversations
    if (method === "DELETE" && path === "/api/conversations") {
      return await handleBatchDeleteConversations(ctx, request);
    }

    // DELETE /api/conversations/:id - Delete single conversation
    const deleteMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const conversationId = deleteMatch[1];
      return handleDeleteConversation(ctx, conversationId, request);
    }

    // POST /api/settings/file/:directory/:filename - Save settings file
    const settingsFileMatch = path.match(/^\/api\/settings\/file\/([^/]+)\/([^/]+)$/);
    if (method === "POST" && settingsFileMatch) {
      const directory = settingsFileMatch[1];
      const filename = settingsFileMatch[2];
      return await handleSaveSettingsFile(ctx, directory, filename, request);
    }

    // 404 for unknown API routes
    return new Response(
      JSON.stringify({ error: "API endpoint not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  /**
   * Handle static file and UI routes.
   */
  private async handleStaticRoute(
    ctx: RouteContext,
    method: string,
    path: string
  ): Promise<Response> {
    // Only allow GET for static files
    if (method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // GET / - Serve app shell
    if (path === "/" || path === "/index.html") {
      return handleIndex(ctx);
    }

    // GET /c/:id - Serve conversation page (always full app shell)
    const convMatch = path.match(/^\/c\/([^/]+)$/);
    if (convMatch) {
      return handleConversationView(ctx, convMatch[1]);
    }

    // Fragment routes (HTML partials for HTMX)
    // GET /fragments/chat/:id - Chat view fragment
    const chatFragmentMatch = path.match(/^\/fragments\/chat\/([^/]+)$/);
    if (chatFragmentMatch) {
      return handleChatFragment(ctx, chatFragmentMatch[1]);
    }

    // GET /fragments/conv-list - Conversation list fragment
    if (path === "/fragments/conv-list") {
      return handleConversationListFragment(ctx);
    }

    // GET /fragments/settings/core-prompts - Settings page fragment
    if (path === "/fragments/settings/core-prompts") {
      return handleSettingsFragment(ctx);
    }

    // GET /fragments/settings/core-prompts/:directory - File list fragment
    const settingsDirMatch = path.match(/^\/fragments\/settings\/core-prompts\/([^/]+)$/);
    if (settingsDirMatch) {
      return await handleSettingsFileListFragment(ctx, settingsDirMatch[1]);
    }

    // GET /fragments/settings/file/:directory/:filename - File editor fragment
    const settingsFileMatch = path.match(/^\/fragments\/settings\/file\/([^/]+)\/([^/]+)$/);
    if (settingsFileMatch) {
      return await handleSettingsFileEditorFragment(ctx, settingsFileMatch[1], settingsFileMatch[2]);
    }

    // Serve static files from web/ directory
    return await handleStaticFile(ctx, path);
  }
}
