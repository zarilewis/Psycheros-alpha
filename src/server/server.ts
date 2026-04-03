/**
 * Psycheros HTTP Server
 *
 * Main HTTP server for the Psycheros daemon. Handles routing, static file serving,
 * API endpoints, and SSE streaming for chat responses.
 *
 * @module
 */

import { DBClient } from "../db/mod.ts";
import { createDefaultClient, type LLMClient, type LLMSettings, type WebSearchSettings, type DiscordSettings, loadSettings, saveSettings, loadWebSearchSettings, saveWebSearchSettings, loadDiscordSettings, saveDiscordSettings } from "../llm/mod.ts";
import { createDefaultRegistry, AVAILABLE_TOOLS, loadToolsSettings, saveToolsSettings, getEnabledToolNames, loadCustomTools, ToolRegistry, type ToolsSettings } from "../tools/mod.ts";
import { createIndexer, createRetriever, getConversationRAG, type Retriever, type RAGConfig, DEFAULT_RAG_CONFIG } from "../rag/mod.ts";
import type { MemoryIndexer } from "../rag/indexer.ts";
import { catchUpSummarization, repairOrphanedSummaries } from "../memory/mod.ts";
import { initTracker, registerJob, registerTrigger, tracked } from "./cron-tracker.ts";

import type { MCPClient } from "../mcp-client/mod.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import { LorebookManager } from "../lorebook/mod.ts";
import { VaultManager } from "../vault/mod.ts";
import { PulseEngine } from "../pulse/mod.ts";
import { join } from "@std/path";
import { MAX_REQUEST_BODY_SIZE, MAX_UPLOAD_BODY_SIZE } from "../constants.ts";
import {
  handleBatchDeleteConversations,
  handleChat,
  handleChatFragment,
  handleConversationListFragment,
  handleConversationView,
  handleCORS,
  handleHealth,
  handleCreateConversation,
  handleCreateCustomFile,
  handleDeleteConversation,
  handleDeleteCustomFile,
  handleEvents,
  handleGetMessages,
  handleGetContextSnapshots,
  handleUpdateMessage,
  handleIndex,
  handleListConversations,
  handleMemoryConsolidate,
  handleMcpSync,
  handleSettingsFileEditorFragment,
  handleSettingsFileListFragment,
  handleSettingsFragment,
  handleSettingsHubFragment,
  handleSaveSettingsFile,
  handleStaticFile,
  handleUpdateTitle,
  handleMemoriesFragment,
  handleMemoriesListFragment,
  handleMemoriesEditorFragment,
  handleSaveMemory,
  handleCreateSignificantMemory,
  handleConsolidationFragment,
  handleConsolidationRun,
  handleListSnapshots,
  handleGetSnapshot,
  handleCreateSnapshot,
  handleRestoreSnapshot,
  handleSnapshotsFragment,
  handleSnapshotPreviewFragment,
  handleListLorebooks,
  handleCreateLorebook,
  handleGetLorebook,
  handleUpdateLorebook,
  handleDeleteLorebook,
  handleListLorebookEntries,
  handleCreateLorebookEntry,
  handleUpdateLorebookEntry,
  handleDeleteLorebookEntry,
  handleResetLorebookState,
  handleLorebooksFragment,
  handleLorebookDetailFragment,
  handleLorebookEntryEditFragment,
  handleGraphView,
  handleGetGraphData,
  handleCreateGraphNode,
  handleCreateGraphEdge,
  handleDeleteGraphNode,
  handleDeleteGraphEdge,
  handleUpdateGraphNode,
  handleUpdateGraphEdge,
  handleAppearanceSettingsFragment,
  handleGetLLMSettings,
  handleSaveLLMSettings,
  handleTestLLMConnection,
  handleLLMSettingsFragment,
  handleGetGeneralSettings,
  handleSaveGeneralSettings,
  handleGeneralSettingsFragment,
  handleGetAppearanceSettings,
  handleSaveAppearanceSettings,
  handleListBackgrounds,
  handleUploadBackground,
  handleDeleteBackground,
  handleListVault,
  handleUploadVault,
  handleGetVault,
  handleUpdateVault,
  handleDeleteVault,
  handleSearchVault,
  handleVaultFragment,
  handleVaultDetailFragment,
  handleGetWebSearchSettings,
  handleSaveWebSearchSettings,
  handleWebSearchSettingsFragment,
  handleGetDiscordSettings,
  handleSaveDiscordSettings,
  handleConnectionsSettingsFragment,
  handleGetToolsSettings,
  handleSaveToolsSettings,
  handleToolsSettingsFragment,
  handlePushSubscribe,
  handlePushUnsubscribe,
  handlePushVapidKey,
  type RouteContext,
} from "./routes.ts";
import {
  handlePulseFragment,
  handlePulseNewFragment,
  handlePulseEditFragment,
  handlePulseLogFragment,
  handlePulseListFragment,
  handleListPulses,
  handleCreatePulse,
  handleGetPulse,
  handleUpdatePulse,
  handleDeletePulse,
  handleTriggerPulse,
  handleStopPulse,
  handleGetRunningPulse,
  handleWebhookTrigger,
  handleListPulseRuns,
  handleListPulseRunsForPulse,
  handleGetPulseRun,
} from "../pulse/routes.ts";
import { getBroadcaster } from "./broadcaster.ts";
import {
  handleAdminFragment,
  handleAdminLogsFragment,
  handleAdminDiagnosticsFragment,
  handleAdminJobsFragment,
  handleAdminActionsFragment,
  handleAdminLogsAPI,
  handleAdminLogEntriesAPI,
  handleAdminDiagnosticsAPI,
  handleAdminJobsAPI,
  handleAdminJobRowsFragment,
  handleAdminJobTriggerAPI,
  handleAdminBatchPopulate,
} from "./admin-routes.ts";
import { setServerStartTime } from "./diagnostics.ts";

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
  /** Optional database path (default: {projectRoot}/.psycheros/psycheros.db) */
  dbPath?: string;
  /** List of tool names the entity is allowed to use (empty = no tools) */
  allowedTools?: string[];
  /** RAG configuration options */
  ragConfig?: Partial<RAGConfig>;
  /** Whether memory summarization is enabled (default: true) */
  memoryEnabled?: boolean;
  /** Optional MCP client for syncing with entity-core */
  mcpClient?: MCPClient;
}

/**
 * HTTP server for the Psycheros daemon.
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
  private chatRAG: ConversationRAG | null = null;
  private ragConfig: RAGConfig;
  private memoryIndexer: MemoryIndexer | null = null;
  private abortController: AbortController;
  private config: ServerConfig;
  private keepaliveInterval: number | null = null;
  private mcpClient: MCPClient | null = null;
  private lorebookManager: LorebookManager;
  private vaultManager: VaultManager;
  private llmSettings: LLMSettings;
  private webSearchSettings: WebSearchSettings;
  private discordSettings: DiscordSettings;
  private toolSettings: ToolsSettings;
  private customTools: Record<string, import("../tools/types.ts").Tool>;
  private pulseEngine: PulseEngine | null = null;

  /**
   * Create a new Server instance.
   *
   * @param config - Server configuration
   */
  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize database
    const dbPath = config.dbPath || `${config.projectRoot}/.psycheros/psycheros.db`;
    this.db = new DBClient(dbPath);

    // Initialize LLM client with defaults (will be reloaded from settings in init())
    this.llm = createDefaultClient();
    this.llmSettings = {
      baseUrl: Deno.env.get("ZAI_BASE_URL") || "https://api.z.ai/api/coding/paas/v4/chat/completions",
      apiKey: Deno.env.get("ZAI_API_KEY") || "",
      model: Deno.env.get("ZAI_MODEL") || "glm-4.7",
      workerModel: Deno.env.get("ZAI_WORKER_MODEL") || "GLM-4.5-Air",
      temperature: 0.7,
      topP: 1,
      topK: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 4096,
      contextLength: 128000,
      thinkingEnabled: true,
    };

    // Initialize web search settings (will be reloaded from settings in init())
    this.webSearchSettings = {
      provider: "disabled",
      tavilyApiKey: "",
      braveApiKey: "",
    };

    // Initialize Discord settings (will be reloaded from settings in init())
    this.discordSettings = {
      botToken: "",
      defaultChannelId: "",
      enabled: false,
    };

    // Initialize tool settings (will be reloaded from settings in init())
    this.toolSettings = { toolOverrides: {} };

    // Initialize custom tools (will be loaded in init())
    this.customTools = {};

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

      // Initialize chat RAG for conversation history search
      this.chatRAG = getConversationRAG(this.db.getRawDb());
    }

    // Store MCP client if provided
    this.mcpClient = config.mcpClient ?? null;

    // Initialize lorebook manager
    this.lorebookManager = new LorebookManager(this.db);

    // Initialize vault manager
    this.vaultManager = new VaultManager(this.db, config.projectRoot);

    // Create abort controller for graceful shutdown
    this.abortController = new AbortController();
  }

  /**
   * Initialize async dependencies (must be called before start()).
   */
  async init(): Promise<void> {
    this.llmSettings = await loadSettings(this.config.projectRoot);
    this.webSearchSettings = await loadWebSearchSettings(this.config.projectRoot);
    this.discordSettings = await loadDiscordSettings(this.config.projectRoot);
    this.toolSettings = await loadToolsSettings(this.config.projectRoot);
    this.customTools = await loadCustomTools(this.config.projectRoot);
    this.reloadLLMClient();
    this.reloadToolRegistry();

    // Load general settings to set PSYCHEROS_DISPLAY_TZ for server-side timestamp formatting
    try {
      const settingsText = await Deno.readTextFile(`${this.config.projectRoot}/.psycheros/general-settings.json`);
      const settings = JSON.parse(settingsText) as { timezone?: string };
      if (settings.timezone) {
        Deno.env.set("PSYCHEROS_DISPLAY_TZ", settings.timezone);
      }
    } catch {
      // No settings file yet — use system default
    }
  }

  /**
   * Get the current LLM settings.
   */
  getLLMSettings(): LLMSettings {
    return this.llmSettings;
  }

  /**
   * Update LLM settings, persist to disk, and hot-reload the client.
   */
  async updateLLMSettings(settings: LLMSettings): Promise<void> {
    this.llmSettings = settings;
    await saveSettings(this.config.projectRoot, settings);
    this.reloadLLMClient();
  }

  /**
   * Get the current web search settings.
   */
  getWebSearchSettings(): WebSearchSettings {
    return this.webSearchSettings;
  }

  /**
   * Update web search settings, persist to disk, and reload tool registry.
   */
  async updateWebSearchSettings(settings: WebSearchSettings): Promise<void> {
    this.webSearchSettings = settings;
    await saveWebSearchSettings(this.config.projectRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Get the current Discord settings.
   */
  getDiscordSettings(): DiscordSettings {
    return this.discordSettings;
  }

  /**
   * Update Discord settings, persist to disk, and reload tool registry.
   */
  async updateDiscordSettings(settings: DiscordSettings): Promise<void> {
    this.discordSettings = settings;
    await saveDiscordSettings(this.config.projectRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Get the current tools settings.
   */
  getToolSettings(): ToolsSettings {
    return this.toolSettings;
  }

  /**
   * Update tools settings, persist to disk, and reload tool registry.
   */
  async updateToolSettings(settings: ToolsSettings): Promise<void> {
    this.toolSettings = settings;
    await saveToolsSettings(this.config.projectRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Re-create the LLM client from current settings.
   */
  private reloadLLMClient(): void {
    this.llm = createDefaultClient({
      baseUrl: this.llmSettings.baseUrl,
      apiKey: this.llmSettings.apiKey,
      model: this.llmSettings.model,
      thinkingEnabled: this.llmSettings.thinkingEnabled,
      temperature: this.llmSettings.temperature,
      topP: this.llmSettings.topP,
      topK: this.llmSettings.topK,
      frequencyPenalty: this.llmSettings.frequencyPenalty,
      presencePenalty: this.llmSettings.presencePenalty,
      maxTokens: this.llmSettings.maxTokens,
    });
  }

  /**
   * Re-create the tool registry from current allowed tools.
   * Merges built-in tools with custom tools and resolves enabled list
   * from env var, user overrides, and auto-enabled tools.
   */
  private reloadToolRegistry(): void {
    // Build merged catalog: built-in + custom
    const allTools: Record<string, import("../tools/types.ts").Tool> = {
      ...AVAILABLE_TOOLS,
      ...this.customTools,
    };
    const allNames = Object.keys(allTools);

    // Determine auto-enabled tools (e.g. web_search when provider is configured)
    const autoEnabled: string[] = [];
    if (this.webSearchSettings.provider === "tavily" || this.webSearchSettings.provider === "brave") {
      autoEnabled.push("web_search");
    }
    if (this.discordSettings.enabled && this.discordSettings.botToken) {
      autoEnabled.push("send_discord_dm");
    }

    // Resolve the final enabled list
    const enabledNames = getEnabledToolNames(
      this.toolSettings,
      allNames,
      this.config.allowedTools ?? [],
      autoEnabled,
    );

    // Build registry from resolved list
    const enabledSet = new Set(enabledNames.map((n) => n.toLowerCase()));
    const registry = new ToolRegistry();
    for (const [name, tool] of Object.entries(allTools)) {
      if (enabledSet.has(name.toLowerCase())) {
        registry.register(tool);
      }
    }
    this.tools = registry;
  }

  /**
   * Start the server.
   *
   * Begins listening for HTTP requests on the configured port.
   * Also starts the keepalive timer for persistent SSE connections.
   * If RAG is enabled, indexes memories on startup.
   */
  async start(): Promise<void> {
    setServerStartTime(new Date());
    const hostname = this.config.hostname || "localhost";
    const port = this.config.port;

    console.log(`Starting Psycheros server on http://${hostname}:${port}`);

    // Ensure identity directories exist
    const identityDirs = ["self", "user", "relationship", "custom"];
    for (const dir of identityDirs) {
      try {
        const identityDir = join(this.config.projectRoot, "identity", dir);
        await Deno.mkdir(identityDir, { recursive: true });
      } catch {
        // Directory already exists, ignore
      }
    }

    // Index memories on startup if RAG is enabled
    if (this.ragConfig.enabled && this.ragRetriever) {
      try {
        const indexer = createIndexer(this.db.getRawDb(), this.ragConfig.memoriesDir);
        await indexer.indexAll();
        this.memoryIndexer = indexer;
      } catch (error) {
        console.error(
          "[RAG] Failed to index memories on startup:",
          error instanceof Error ? error.message : String(error)
        );
        // Continue without RAG if indexing fails
        this.ragRetriever = null;
      }
    }

    // Initialize cron tracker with DB for persistent execution history
    initTracker(this.db);

    // Set up memory summarization cron job and catch-up on startup
    if (this.config.memoryEnabled !== false) {
      // MCP sync callback — pushes generated memories to entity-core
      const syncMemoryToMCP = this.mcpClient
        ? (memory: import("../memory/mod.ts").MemoryFile) => {
            const granularity = memory.granularity as "daily" | "weekly" | "monthly" | "yearly";
            this.mcpClient!.createMemory(granularity, memory.date, memory.content, memory.chatIds).catch((error) => {
              console.error("[Memory] MCP sync failed:", error instanceof Error ? error.message : String(error));
            });
          }
        : undefined;

      // Repair orphaned DB records then catch up on missed summarizations.
      // Repair must complete first so cleared records become eligible for regeneration.
      (async () => {
        try {
          await repairOrphanedSummaries(this.db, this.config.projectRoot);
        } catch (error) {
          console.error("[Memory] Integrity check failed:", error instanceof Error ? error.message : String(error));
        }
        try {
          await catchUpSummarization(this.db, this.config.projectRoot, syncMemoryToMCP);
        } catch (error) {
          console.error("[Memory] Startup catch-up failed:", error instanceof Error ? error.message : String(error));
        }
      })();

      // Set up daily cron job at configured hour (default 4 AM)
      const memoryHour = parseInt(Deno.env.get("PSYCHEROS_MEMORY_HOUR") || "4");
      const cronPattern = `0 ${memoryHour} * * *`;

      // Shared handler for daily summarization (used by both cron and manual trigger)
      const dailySummarizationHandler = async (): Promise<string> => {
        const count = await catchUpSummarization(this.db, this.config.projectRoot, syncMemoryToMCP);
        return count > 0 ? `Summarized ${count} day(s)` : "No unsummarized dates found";
      };

      registerJob("memory-daily", "Daily Memory Summarization", cronPattern, "Summarize conversations into daily memory files");
      Deno.cron("memory-daily-summarization", cronPattern, tracked("memory-daily", dailySummarizationHandler));

      // Note: Weekly, monthly, and yearly consolidation now runs in entity-core
      // via its own cron jobs, not here.

      // Daily identity snapshot - runs at configured hour (default 3 AM)
      const snapshotHour = parseInt(Deno.env.get("PSYCHEROS_SNAPSHOT_HOUR") || "3");
      const snapshotHandler = async (): Promise<string> => {
        // Snapshots must go through MCP so they land in entity-core's data directory
        // (the canonical location the UI reads from). If MCP is unavailable, skip —
        // creating local-only snapshots would be invisible to the UI.
        if (!this.mcpClient) {
          return "Skipped: MCP not connected (snapshots require entity-core)";
        }
        const result = await this.mcpClient.createSnapshot();
        if (result.success) {
          const count = result.snapshots?.length ?? 0;
          return `Created ${count} snapshots via MCP (cleanup handled by entity-core)`;
        }
        return `Failed: ${result.error || "Unknown error"}`;
      };

      registerJob("identity-snapshot", "Daily Identity Snapshot", `0 ${snapshotHour} * * *`, "Snapshot identity files and clean up old snapshots", true);
      registerTrigger("identity-snapshot", snapshotHandler);
      Deno.cron("identity-daily-snapshot", `0 ${snapshotHour} * * *`, tracked("identity-snapshot", snapshotHandler));
    }

    // Start keepalive timer for persistent SSE connections
    const broadcaster = getBroadcaster();
    this.keepaliveInterval = setInterval(() => {
      broadcaster.sendKeepalive();
    }, KEEPALIVE_INTERVAL_MS);

    // Initialize Pulse engine for autonomous entity prompts
    this.pulseEngine = new PulseEngine(
      this.db,
      this.llm,
      () => this.tools,
      {
        projectRoot: this.config.projectRoot,
        ragRetriever: this.ragRetriever ?? undefined,
        chatRAG: this.chatRAG ?? undefined,
        mcpClient: this.mcpClient ?? undefined,
        lorebookManager: this.lorebookManager,
        vaultManager: this.vaultManager,
        webSearchSettings: () => this.webSearchSettings,
        discordSettings: () => this.discordSettings,
      }
    );
    this.pulseEngine.start();

    await Deno.serve(
      {
        port,
        hostname,
        signal: this.abortController.signal,
        onListen: ({ hostname, port }) => {
          console.log(`Psycheros server listening on http://${hostname}:${port}`);
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
    console.log("Stopping Psycheros server...");

    // Stop pulse engine
    if (this.pulseEngine) {
      this.pulseEngine.stop();
    }

    // Clear keepalive timer
    if (this.keepaliveInterval !== null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    this.abortController.abort();
    this.db.close();
    console.log("Psycheros server stopped.");
  }

  /**
   * Get the route context for handlers.
   */
  private getContext(): RouteContext {
    return {
      db: this.db,
      llm: this.llm,
      tools: () => this.tools,
      projectRoot: this.config.projectRoot,
      ragRetriever: this.ragRetriever ?? undefined,
      chatRAG: this.chatRAG ?? undefined,
      ragConfig: this.ragConfig,
      memoryEnabled: this.config.memoryEnabled ?? true,
      mcpClient: this.mcpClient ?? undefined,
      lorebookManager: this.lorebookManager,
      vaultManager: this.vaultManager,
      memoryIndexer: this.memoryIndexer ?? undefined,
      pulseEngine: this.pulseEngine ?? undefined,
      getLLMSettings: () => this.llmSettings,
      updateLLMSettings: (settings) => this.updateLLMSettings(settings),
      getWebSearchSettings: () => this.webSearchSettings,
      updateWebSearchSettings: (settings) => this.updateWebSearchSettings(settings),
      getDiscordSettings: () => this.discordSettings,
      updateDiscordSettings: (settings) => this.updateDiscordSettings(settings),
      getToolSettings: () => this.toolSettings,
      updateToolSettings: (settings) => this.updateToolSettings(settings),
      customTools: this.customTools,
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

    // Health check (lightweight, no middleware)
    if (method === "GET" && path === "/health") {
      return handleHealth();
    }

    // Enforce request body size limits
    if (method !== "GET" && method !== "OPTIONS" && method !== "HEAD") {
      const contentLength = request.headers.get("content-length");
      if (contentLength) {
        const size = parseInt(contentLength);
        const limit = path === "/api/backgrounds" ? MAX_UPLOAD_BODY_SIZE : MAX_REQUEST_BODY_SIZE;
        if (size > limit) {
          return new Response(
            JSON.stringify({ error: `Request body too large (max ${Math.round(limit / 1024 / 1024)}MB)` }),
            {
              status: 413,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }
      }
    }

    try {
      // API Routes
      if (path.startsWith("/api/")) {
        return await this.handleAPIRoute(ctx, request, method, path);
      }

      // Static file and UI routes
      return await this.handleStaticRoute(ctx, method, path);
    } catch (error) {
      console.error("[Server] Request error:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
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

    // GET /api/conversations/:id/context/latest - Get latest context snapshot
    const contextLatestMatch = path.match(/^\/api\/conversations\/([^/]+)\/context\/latest$/);
    if (method === "GET" && contextLatestMatch) {
      return handleGetContextSnapshots(ctx, contextLatestMatch[1], true);
    }

    // GET /api/conversations/:id/context - Get all context snapshots
    const contextAllMatch = path.match(/^\/api\/conversations\/([^/]+)\/context$/);
    if (method === "GET" && contextAllMatch) {
      return handleGetContextSnapshots(ctx, contextAllMatch[1], false);
    }

    // GET /api/conversations/:id/messages - Get messages
    const messagesMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (method === "GET" && messagesMatch) {
      const conversationId = messagesMatch[1];
      return handleGetMessages(ctx, conversationId);
    }

    // PUT /api/messages/:id - Update message content
    const updateMessageMatch = path.match(/^\/api\/messages\/([^/]+)$/);
    if (method === "PUT" && updateMessageMatch) {
      const messageId = updateMessageMatch[1];
      return await handleUpdateMessage(ctx, messageId, request);
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

    // POST /api/settings/custom/create - Create custom file
    if (method === "POST" && path === "/api/settings/custom/create") {
      return await handleCreateCustomFile(ctx, request);
    }

    // DELETE /api/settings/file/custom/:filename - Delete custom file
    const deleteCustomMatch = path.match(/^\/api\/settings\/file\/custom\/([^/]+)$/);
    if (method === "DELETE" && deleteCustomMatch) {
      return await handleDeleteCustomFile(ctx, deleteCustomMatch[1]);
    }

    // POST /api/memory/consolidate/:granularity - Trigger memory consolidation
    const memoryConsolidateMatch = path.match(/^\/api\/memory\/consolidate\/(weekly|monthly|yearly)$/);
    if (method === "POST" && memoryConsolidateMatch) {
      const granularity = memoryConsolidateMatch[1];
      return await handleMemoryConsolidate(ctx, granularity);
    }

    // POST /api/memories/consolidation/run - Run catch-up consolidation
    if (method === "POST" && path === "/api/memories/consolidation/run") {
      return await handleConsolidationRun(ctx);
    }

    // ========================================
    // Memories API Routes
    // ========================================

    // POST /api/memories/significant/create - Create new significant memory
    // Must be before the :granularity/:date catch-all
    if (method === "POST" && path === "/api/memories/significant/create") {
      return await handleCreateSignificantMemory(ctx, request);
    }

    // POST /api/memories/:granularity/:date - Save edited memory
    const saveMemoryMatch = path.match(/^\/api\/memories\/(daily|weekly|monthly|yearly|significant)\/([^/]+)$/);
    if (method === "POST" && saveMemoryMatch) {
      const granularity = saveMemoryMatch[1];
      const date = saveMemoryMatch[2];
      return await handleSaveMemory(ctx, granularity, date, request);
    }

    // POST /api/mcp/sync - Manually trigger MCP sync
    if (method === "POST" && path === "/api/mcp/sync") {
      return await handleMcpSync(ctx);
    }

    // GET /api/snapshots - List all snapshots
    if (method === "GET" && path === "/api/snapshots") {
      return await handleListSnapshots(ctx);
    }

    // POST /api/snapshots/create - Create manual snapshot
    if (method === "POST" && path === "/api/snapshots/create") {
      return await handleCreateSnapshot(ctx);
    }

    // GET /api/snapshots/:id - Get snapshot content
    const snapshotMatch = path.match(/^\/api\/snapshots\/(.+)$/);
    if (method === "GET" && snapshotMatch) {
      return await handleGetSnapshot(ctx, snapshotMatch[1]);
    }

    // POST /api/snapshots/:id/restore - Restore snapshot
    const snapshotRestoreMatch = path.match(/^\/api\/snapshots\/(.+)\/restore$/);
    if (method === "POST" && snapshotRestoreMatch) {
      return await handleRestoreSnapshot(ctx, snapshotRestoreMatch[1]);
    }

    // Lorebook Routes
    // GET /api/lorebooks - List lorebooks
    if (method === "GET" && path === "/api/lorebooks") {
      return handleListLorebooks(ctx);
    }

    // POST /api/lorebooks - Create lorebook
    if (method === "POST" && path === "/api/lorebooks") {
      return await handleCreateLorebook(ctx, request);
    }

    // Lorebook entry routes - must match before :id routes
    // GET /api/lorebooks/:id/entries - List entries
    const lorebookEntriesMatch = path.match(/^\/api\/lorebooks\/([^/]+)\/entries$/);
    if (lorebookEntriesMatch) {
      const lorebookId = lorebookEntriesMatch[1];
      if (method === "GET") {
        return handleListLorebookEntries(ctx, lorebookId);
      }
      if (method === "POST") {
        return await handleCreateLorebookEntry(ctx, lorebookId, request);
      }
    }

    // Entry-specific routes
    const lorebookEntryMatch = path.match(/^\/api\/lorebooks\/([^/]+)\/entries\/([^/]+)$/);
    if (lorebookEntryMatch) {
      const lorebookId = lorebookEntryMatch[1];
      const entryId = lorebookEntryMatch[2];
      if (method === "PUT") {
        return await handleUpdateLorebookEntry(ctx, lorebookId, entryId, request);
      }
      if (method === "DELETE") {
        return handleDeleteLorebookEntry(ctx, lorebookId, entryId);
      }
    }

    // GET /api/lorebooks/:id - Get lorebook
    // PUT /api/lorebooks/:id - Update lorebook
    // DELETE /api/lorebooks/:id - Delete lorebook
    const lorebookMatch = path.match(/^\/api\/lorebooks\/([^/]+)$/);
    if (lorebookMatch) {
      const lorebookId = lorebookMatch[1];
      if (method === "GET") {
        return handleGetLorebook(ctx, lorebookId);
      }
      if (method === "PUT") {
        return await handleUpdateLorebook(ctx, lorebookId, request);
      }
      if (method === "DELETE") {
        return handleDeleteLorebook(ctx, lorebookId);
      }
    }

    // DELETE /api/lorebooks/state/:conversationId - Reset sticky state
    const lorebookStateMatch = path.match(/^\/api\/lorebooks\/state\/([^/]+)$/);
    if (method === "DELETE" && lorebookStateMatch) {
      return handleResetLorebookState(ctx, lorebookStateMatch[1]);
    }

    // ========================================
    // Knowledge Graph API Routes
    // ========================================

    // GET /api/graph - Get full graph data
    if (method === "GET" && path === "/api/graph") {
      return await handleGetGraphData(ctx);
    }

    // POST /api/graph/nodes - Create node
    if (method === "POST" && path === "/api/graph/nodes") {
      return await handleCreateGraphNode(ctx, request);
    }

    // POST /api/graph/edges - Create edge
    if (method === "POST" && path === "/api/graph/edges") {
      return await handleCreateGraphEdge(ctx, request);
    }

    // PUT/DELETE /api/graph/nodes/:id - Update or delete node
    const graphNodeMatch = path.match(/^\/api\/graph\/nodes\/([^/]+)$/);
    if (graphNodeMatch) {
      if (method === "PUT") {
        return await handleUpdateGraphNode(ctx, request, graphNodeMatch[1]);
      }
      if (method === "DELETE") {
        return await handleDeleteGraphNode(ctx, graphNodeMatch[1]);
      }
    }

    // PUT/DELETE /api/graph/edges/:id - Update or delete edge
    const graphEdgeMatch = path.match(/^\/api\/graph\/edges\/([^/]+)$/);
    if (graphEdgeMatch) {
      if (method === "PUT") {
        return await handleUpdateGraphEdge(ctx, request, graphEdgeMatch[1]);
      }
      if (method === "DELETE") {
        return await handleDeleteGraphEdge(ctx, graphEdgeMatch[1]);
      }
    }

    // ========================================
    // Background Image API Routes
    // ========================================

    // GET /api/backgrounds - List background images
    // POST /api/backgrounds - Upload background image
    if (path === "/api/backgrounds") {
      if (method === "GET") {
        return await handleListBackgrounds(ctx);
      }
      if (method === "POST") {
        return await handleUploadBackground(ctx, request);
      }
    }

    // DELETE /api/backgrounds/:filename - Delete background image
    const backgroundDeleteMatch = path.match(/^\/api\/backgrounds\/([^/]+)$/);
    if (method === "DELETE" && backgroundDeleteMatch) {
      const filename = backgroundDeleteMatch[1];
      return await handleDeleteBackground(ctx, filename);
    }

    // ========================================
    // LLM Settings API Routes
    // ========================================

    // ========================================
    // General Settings API Routes
    // ========================================

    // GET /api/general-settings - Get current general settings
    if (method === "GET" && path === "/api/general-settings") {
      return await handleGetGeneralSettings(ctx);
    }

    // POST /api/general-settings - Save general settings
    if (method === "POST" && path === "/api/general-settings") {
      return await handleSaveGeneralSettings(ctx, request);
    }

    // ========================================
    // Appearance Settings API Routes
    // ========================================

    // GET /api/appearance-settings - Get current appearance settings
    if (method === "GET" && path === "/api/appearance-settings") {
      return await handleGetAppearanceSettings(ctx);
    }

    // POST /api/appearance-settings - Save appearance settings
    if (method === "POST" && path === "/api/appearance-settings") {
      return await handleSaveAppearanceSettings(ctx, request);
    }

    // ========================================
    // LLM Settings API Routes
    // ========================================

    // GET /api/llm-settings - Get current settings
    if (method === "GET" && path === "/api/llm-settings") {
      return handleGetLLMSettings(ctx);
    }

    // POST /api/llm-settings - Save settings
    if (method === "POST" && path === "/api/llm-settings") {
      return await handleSaveLLMSettings(ctx, request);
    }

    // POST /api/llm-settings/reset - Reset to defaults
    if (method === "POST" && path === "/api/llm-settings/reset") {
      const { handleResetLLMSettings } = await import("./routes.ts");
      return await handleResetLLMSettings(ctx);
    }

    // POST /api/llm-settings/test - Test connection
    if (method === "POST" && path === "/api/llm-settings/test") {
      return await handleTestLLMConnection(ctx, request);
    }

    // ========================================
    // Web Search Settings API Routes
    // ========================================

    // GET /api/web-search-settings - Get current web search settings
    if (method === "GET" && path === "/api/web-search-settings") {
      return handleGetWebSearchSettings(ctx);
    }

    // POST /api/web-search-settings - Save web search settings
    if (method === "POST" && path === "/api/web-search-settings") {
      return await handleSaveWebSearchSettings(ctx, request);
    }

    // POST /api/web-search-settings/reset - Reset to defaults
    if (method === "POST" && path === "/api/web-search-settings/reset") {
      const { handleResetWebSearchSettings } = await import("./routes.ts");
      return await handleResetWebSearchSettings(ctx);
    }

    // ========================================
    // Discord Settings API Routes
    // ========================================

    // GET /api/discord-settings - Get current Discord settings
    if (method === "GET" && path === "/api/discord-settings") {
      return handleGetDiscordSettings(ctx);
    }

    // POST /api/discord-settings - Save Discord settings
    if (method === "POST" && path === "/api/discord-settings") {
      return await handleSaveDiscordSettings(ctx, request);
    }

    // POST /api/discord-settings/reset - Reset to defaults
    if (method === "POST" && path === "/api/discord-settings/reset") {
      const { handleResetDiscordSettings } = await import("./routes.ts");
      return await handleResetDiscordSettings(ctx);
    }

    // ========================================
    // Tools Settings API Routes
    // ========================================

    // GET /api/tools-settings - Get current tools settings
    if (method === "GET" && path === "/api/tools-settings") {
      return handleGetToolsSettings(ctx);
    }

    // POST /api/tools-settings - Save tools settings
    if (method === "POST" && path === "/api/tools-settings") {
      return await handleSaveToolsSettings(ctx, request);
    }

    // ========================================
    // Admin API Routes
    // ========================================

    // GET /api/admin/logs - JSON log entries with filtering
    if (method === "GET" && path === "/api/admin/logs") {
      return handleAdminLogsAPI(ctx, new URL(request.url));
    }

    // GET /api/admin/logs/entries - HTML partial of log entries
    if (method === "GET" && path === "/api/admin/logs/entries") {
      return handleAdminLogEntriesAPI(ctx, new URL(request.url));
    }

    // GET /api/admin/diagnostics - JSON diagnostics snapshot
    if (method === "GET" && path === "/api/admin/diagnostics") {
      return await handleAdminDiagnosticsAPI(ctx);
    }

    // GET /api/admin/jobs - JSON scheduled jobs status
    if (method === "GET" && path === "/api/admin/jobs") {
      return handleAdminJobsAPI(ctx);
    }

    // GET /api/admin/jobs/rows - HTML partial of job table rows
    if (method === "GET" && path === "/api/admin/jobs/rows") {
      return handleAdminJobRowsFragment(ctx);
    }

    // POST /api/admin/jobs/:id/trigger - Manually trigger a scheduled job
    if (method === "POST" && path.startsWith("/api/admin/jobs/") && path.endsWith("/trigger")) {
      const jobId = path.slice("/api/admin/jobs/".length, -"/trigger".length);
      return await handleAdminJobTriggerAPI(ctx, jobId);
    }

    // POST /api/admin/actions/batch-populate - Run batch-populate-graph script
    if (method === "POST" && path === "/api/admin/actions/batch-populate") {
      const body = await request.json().catch(() => ({}));
      return await handleAdminBatchPopulate(ctx, body);
    }

    // ========================================
    // Pulse API Routes
    // ========================================

    // GET /api/pulses - List all pulses
    if (method === "GET" && path === "/api/pulses") {
      return handleListPulses(ctx);
    }

    // POST /api/pulses - Create pulse
    if (method === "POST" && path === "/api/pulses") {
      return await handleCreatePulse(ctx, request);
    }

    // GET /api/pulses/runs - List pulse runs
    if (method === "GET" && path === "/api/pulses/runs") {
      return handleListPulseRuns(ctx, new URL(request.url));
    }

    // POST /api/webhook/pulse/:id - Webhook trigger
    const webhookPulseMatch = path.match(/^\/api\/webhook\/pulse\/([^/]+)$/);
    if (method === "POST" && webhookPulseMatch) {
      return await handleWebhookTrigger(ctx, webhookPulseMatch[1], request);
    }

    // Pulse-specific routes
    const pulseMatch = path.match(/^\/api\/pulses\/([^/]+)$/);
    if (pulseMatch) {
      const pulseId = pulseMatch[1];
      if (method === "GET") {
        return handleGetPulse(ctx, pulseId);
      }
      if (method === "PUT") {
        return await handleUpdatePulse(ctx, pulseId, request);
      }
      if (method === "DELETE") {
        return handleDeletePulse(ctx, pulseId);
      }
    }

    // POST /api/pulses/:id/trigger - Manual trigger
    const pulseTriggerMatch = path.match(/^\/api\/pulses\/([^/]+)\/trigger$/);
    if (method === "POST" && pulseTriggerMatch) {
      return await handleTriggerPulse(ctx, pulseTriggerMatch[1], request);
    }

    // POST /api/pulses/:id/stop - Abort a running Pulse
    const pulseStopMatch = path.match(/^\/api\/pulses\/([^/]+)\/stop$/);
    if (method === "POST" && pulseStopMatch) {
      return await handleStopPulse(ctx, pulseStopMatch[1], request);
    }

    // GET /api/pulses/running/:conversationId - Get running Pulse for conversation
    const pulseRunningMatch = path.match(/^\/api\/pulses\/running\/([^/]+)$/);
    if (method === "GET" && pulseRunningMatch) {
      return handleGetRunningPulse(ctx, pulseRunningMatch[1], request);
    }

    // GET /api/pulses/:id/runs - Runs for a specific pulse
    const pulseRunsMatch = path.match(/^\/api\/pulses\/([^/]+)\/runs$/);
    if (method === "GET" && pulseRunsMatch) {
      return handleListPulseRunsForPulse(ctx, pulseRunsMatch[1], new URL(request.url));
    }

    // GET /api/pulses/runs/:runId - Single run details
    const pulseRunMatch = path.match(/^\/api\/pulses\/runs\/([^/]+)$/);
    if (method === "GET" && pulseRunMatch) {
      return handleGetPulseRun(ctx, pulseRunMatch[1]);
    }

    // ========================================
    // Vault API Routes
    // ========================================

    // GET /api/vault - List vault documents
    // POST /api/vault - Upload vault document
    if (path === "/api/vault") {
      if (method === "GET") {
        return handleListVault(ctx);
      }
      if (method === "POST") {
        return await handleUploadVault(ctx, request);
      }
    }

    // POST /api/vault/search - Search vault
    if (method === "POST" && path === "/api/vault/search") {
      return await handleSearchVault(ctx, request);
    }

    // Vault document CRUD
    const vaultMatch = path.match(/^\/api\/vault\/([^/]+)$/);
    if (vaultMatch) {
      const vaultId = vaultMatch[1];
      if (method === "GET") {
        return handleGetVault(ctx, vaultId);
      }
      if (method === "PUT") {
        return await handleUpdateVault(ctx, vaultId, request);
      }
      if (method === "DELETE") {
        return handleDeleteVault(ctx, vaultId);
      }
    }

    // ========================================
    // Push Notification API Routes
    // ========================================

    // GET /api/push/vapid-key - Get VAPID public key
    if (method === "GET" && path === "/api/push/vapid-key") {
      return await handlePushVapidKey(ctx);
    }

    // POST /api/push/subscribe - Store push subscription
    if (method === "POST" && path === "/api/push/subscribe") {
      return await handlePushSubscribe(ctx, request);
    }

    // POST /api/push/unsubscribe - Remove push subscription
    if (method === "POST" && path === "/api/push/unsubscribe") {
      return await handlePushUnsubscribe(ctx, request);
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

    // GET /fragments/settings - Settings hub page fragment
    if (path === "/fragments/settings") {
      return handleSettingsHubFragment(ctx);
    }

    // GET /fragments/settings/general - General settings fragment
    if (path === "/fragments/settings/general") {
      return await handleGeneralSettingsFragment(ctx);
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

    // GET /fragments/settings/snapshots - Snapshots list fragment
    if (path === "/fragments/settings/snapshots") {
      return await handleSnapshotsFragment(ctx);
    }

    // GET /fragments/settings/snapshots/:id - Snapshot preview fragment
    const snapshotPreviewMatch = path.match(/^\/fragments\/settings\/snapshots\/(.+)$/);
    if (snapshotPreviewMatch) {
      return await handleSnapshotPreviewFragment(ctx, snapshotPreviewMatch[1]);
    }

    // Lorebook Fragment Routes
    // GET /fragments/settings/lorebooks - Lorebooks list fragment
    if (path === "/fragments/settings/lorebooks") {
      return handleLorebooksFragment(ctx);
    }

    // GET /fragments/settings/lorebooks/:id - Single lorebook view
    const lorebookDetailMatch = path.match(/^\/fragments\/settings\/lorebooks\/([^/]+)$/);
    if (lorebookDetailMatch) {
      return handleLorebookDetailFragment(ctx, lorebookDetailMatch[1]);
    }

    // GET /fragments/settings/lorebooks/:bookId/entries/:entryId/edit - Entry editor
    const lorebookEntryEditMatch = path.match(/^\/fragments\/settings\/lorebooks\/([^/]+)\/entries\/([^/]+)\/edit$/);
    if (lorebookEntryEditMatch) {
      return handleLorebookEntryEditFragment(ctx, lorebookEntryEditMatch[1], lorebookEntryEditMatch[2]);
    }

    // ========================================
    // Knowledge Graph Fragment Routes
    // ========================================

    // GET /fragments/settings/graph - Graph visualization fragment
    if (path === "/fragments/settings/graph") {
      return await handleGraphView(ctx);
    }

    // ========================================
    // Memories Fragment Routes
    // ========================================

    // GET /fragments/settings/memories - Memories tabbed view
    if (path === "/fragments/settings/memories") {
      return handleMemoriesFragment(ctx);
    }

    // GET /fragments/settings/memories/consolidation - Consolidation catch-up tab
    if (path === "/fragments/settings/memories/consolidation") {
      return await handleConsolidationFragment(ctx);
    }

    // GET /fragments/settings/memories/:granularity - Memory file list
    const memoriesListMatch = path.match(/^\/fragments\/settings\/memories\/([^/]+)$/);
    if (memoriesListMatch) {
      return await handleMemoriesListFragment(ctx, memoriesListMatch[1]);
    }

    // GET /fragments/settings/memories/:granularity/:date - Memory editor
    const memoriesEditorMatch = path.match(/^\/fragments\/settings\/memories\/([^/]+)\/([^/]+)$/);
    if (memoriesEditorMatch) {
      return await handleMemoriesEditorFragment(ctx, memoriesEditorMatch[1], memoriesEditorMatch[2]);
    }

    // ========================================
    // Appearance Settings Routes
    // ========================================

    // GET /fragments/settings/appearance - Appearance settings fragment
    if (path === "/fragments/settings/appearance") {
      return handleAppearanceSettingsFragment(ctx);
    }

    // ========================================
    // Vault Fragment Routes
    // ========================================

    // GET /fragments/settings/vault - Vault management fragment
    if (path === "/fragments/settings/vault") {
      return handleVaultFragment(ctx);
    }

    // GET /fragments/settings/vault/:id - Vault document detail fragment
    const vaultDetailMatch = path.match(/^\/fragments\/settings\/vault\/([^/]+)$/);
    if (vaultDetailMatch) {
      return await handleVaultDetailFragment(ctx, vaultDetailMatch[1]);
    }

    // ========================================
    // LLM Settings Fragment Route
    // ========================================

    // GET /fragments/settings/llm - LLM settings UI fragment
    if (path === "/fragments/settings/llm") {
      return handleLLMSettingsFragment(ctx);
    }

    // GET /fragments/settings/web-search - Web search settings UI fragment
    if (path === "/fragments/settings/web-search") {
      return handleWebSearchSettingsFragment(ctx);
    }

    // GET /fragments/settings/connections - External connections settings fragment
    if (path === "/fragments/settings/connections") {
      return handleConnectionsSettingsFragment(ctx);
    }

    // GET /fragments/settings/tools - Tools settings UI fragment
    if (path === "/fragments/settings/tools") {
      return handleToolsSettingsFragment(ctx);
    }

    // ========================================
    // Pulse Fragment Routes
    // ========================================

    // GET /fragments/settings/pulse - Main Pulse tabbed view
    if (path === "/fragments/settings/pulse") {
      return handlePulseFragment(ctx);
    }

    // GET /fragments/settings/pulse/new - New Pulse editor
    if (path === "/fragments/settings/pulse/new") {
      return handlePulseNewFragment(ctx);
    }

    // GET /fragments/settings/pulse/log - Execution log
    if (path === "/fragments/settings/pulse/log") {
      return handlePulseLogFragment(ctx, new URL(`http://localhost${path}`));
    }

    // GET /fragments/settings/pulse/list - Prompt list partial
    if (path === "/fragments/settings/pulse/list") {
      return handlePulseListFragment(ctx);
    }

    // GET /fragments/settings/pulse/:id/edit - Edit Pulse editor
    const pulseEditMatch = path.match(/^\/fragments\/settings\/pulse\/([^/]+)\/edit$/);
    if (pulseEditMatch) {
      return handlePulseEditFragment(ctx, pulseEditMatch[1]);
    }

    // ========================================
    // Admin Panel Fragment Routes
    // ========================================

    // GET /fragments/admin - Admin hub
    if (path === "/fragments/admin") {
      return handleAdminFragment(ctx);
    }

    // GET /fragments/admin/logs - Log viewer
    if (path === "/fragments/admin/logs") {
      return handleAdminLogsFragment(ctx);
    }

    // GET /fragments/admin/diagnostics - Diagnostics dashboard
    if (path === "/fragments/admin/diagnostics") {
      return await handleAdminDiagnosticsFragment(ctx);
    }

    // GET /fragments/admin/jobs - Scheduled jobs dashboard
    if (path === "/fragments/admin/jobs") {
      return handleAdminJobsFragment(ctx);
    }

    // GET /fragments/admin/actions - Actions panel
    if (path === "/fragments/admin/actions") {
      return handleAdminActionsFragment(ctx);
    }

    // GET /backgrounds/:filename - Serve background image files
    if (path.startsWith("/backgrounds/")) {
      const filename = path.replace("/backgrounds/", "");
      return await handleStaticFile(ctx, `/backgrounds/${filename}`);
    }

    // Serve static files from web/ directory
    return await handleStaticFile(ctx, path);
  }
}
