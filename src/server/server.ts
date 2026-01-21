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
import {
  handleChat,
  handleConversationView,
  handleCORS,
  handleCreateConversation,
  handleGetMessages,
  handleIndex,
  handleListConversations,
  handleStaticFile,
  type RouteContext,
} from "./routes.ts";

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
export class Server {
  private db: DBClient;
  private llm: LLMClient;
  private tools: ToolRegistry;
  private abortController: AbortController;
  private config: ServerConfig;

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

    // Initialize tool registry with default tools
    this.tools = createDefaultRegistry();

    // Create abort controller for graceful shutdown
    this.abortController = new AbortController();
  }

  /**
   * Start the server.
   *
   * Begins listening for HTTP requests on the configured port.
   */
  async start(): Promise<void> {
    const hostname = this.config.hostname || "localhost";
    const port = this.config.port;

    console.log(`Starting SBy server on http://${hostname}:${port}`);

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
   * Aborts the server and closes the database connection.
   */
  stop(): void {
    console.log("Stopping SBy server...");
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

    // GET /api/conversations - List conversations
    if (method === "GET" && path === "/api/conversations") {
      return handleListConversations(ctx, request);
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

    // GET /c/:id - Serve conversation chat view (HTMX partial)
    const convMatch = path.match(/^\/c\/([^/]+)$/);
    if (convMatch) {
      return handleConversationView(ctx, convMatch[1]);
    }

    // Serve static files from web/ directory
    return await handleStaticFile(ctx, path);
  }
}
