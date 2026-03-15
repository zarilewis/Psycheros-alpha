/**
 * MCP Client Module
 *
 * Client for connecting to the entity-core MCP server.
 * Allows Psycheros harness to sync identity and memories with my core.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Granularity } from "../memory/types.ts";

/**
 * Extract text content from an MCP tool result.
 * Handles the union type that the SDK returns.
 */
function extractTextContent(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const r = result as Record<string, unknown>;
  if (!r.content || !Array.isArray(r.content)) {
    return null;
  }
  const firstBlock = r.content[0] as Record<string, unknown> | undefined;
  if (firstBlock && firstBlock.type === "text" && typeof firstBlock.text === "string") {
    return firstBlock.text;
  }
  return null;
}

/**
 * Identity file structure from entity-core.
 */
export interface IdentityFile {
  category: "self" | "user" | "relationship" | "custom";
  filename: string;
  content: string;
  version: number;
  lastModified: string;
  modifiedBy: string;
}

/**
 * All identity files grouped by category.
 */
export interface IdentityContent {
  self: IdentityFile[];
  user: IdentityFile[];
  relationship: IdentityFile[];
  custom: IdentityFile[];
}

/**
 * Memory entry for syncing with entity-core.
 */
export interface MemoryEntry {
  id: string;
  granularity: Granularity;
  date: string;
  content: string;
  chatIds: string[];
  sourceInstance: string;
  participatingInstances?: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Configuration for the MCP client.
 */
export interface MCPClientConfig {
  /** Command to run the MCP server */
  command: string;
  /** Arguments for the MCP server command */
  args?: string[];
  /** Environment variables for the MCP server */
  env?: Record<string, string>;
  /** This embodiment's ID */
  instanceId: string;
  /** Pull from MCP on startup */
  syncOnStartup?: boolean;
  /** Sync interval in milliseconds (0 = disabled) */
  syncInterval?: number;
  /** Fall back to local files if MCP is unavailable */
  offlineFallback?: boolean;
  /** Full path to deno executable (default: auto-detect) */
  denoPath?: string;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Partial<MCPClientConfig> = {
  syncOnStartup: true,
  syncInterval: 5 * 60 * 1000, // 5 minutes
  offlineFallback: true,
  denoPath: "/home/zari/.deno/bin/deno", // Full path to deno executable
};

/**
 * Local cache of identity content.
 */
interface LocalCache {
  identity: IdentityContent | null;
  lastSync: string | null;
}

/**
 * MCP Client for connecting to entity-core.
 */
export class MCPClient {
  private readonly config: MCPClientConfig;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private cache: LocalCache = {
    identity: null,
    lastSync: null,
  };
  private pendingIdentityChanges: Array<{
    category: "self" | "user" | "relationship" | "custom";
    filename: string;
    content: string;
  }> = [];
  private pendingMemoryChanges: MemoryEntry[] = [];
  private syncTimer: number | null = null;

  constructor(config: MCPClientConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as MCPClientConfig;
  }

  /**
   * Connect to the MCP server.
   */
  async connect(): Promise<boolean> {
    try {
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
      });

      this.client = new Client({
        name: "psycheros-harness",
        version: "0.1.0",
      });

      await this.client.connect(this.transport);

      console.log(`[MCP] Connected to entity-core as ${this.config.instanceId}`);

      // Pull initial state if configured
      if (this.config.syncOnStartup) {
        await this.pull();
      }

      // Start periodic sync if configured
      if (this.config.syncInterval && this.config.syncInterval > 0) {
        this.startPeriodicSync();
      }

      return true;
    } catch (error) {
      console.error("[MCP] Failed to connect:", error);

      // Clean up partially-created transport/client
      try { if (this.client) await this.client.close(); } catch { /* ignore */ }
      this.client = null;
      this.transport = null;

      if (this.config.offlineFallback) {
        console.log("[MCP] Falling back to local files mode");
        return false;
      }

      throw error;
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    // Stop periodic sync
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    // Push any pending changes
    if (this.pendingIdentityChanges.length > 0 || this.pendingMemoryChanges.length > 0) {
      await this.push();
    }

    // Close connection
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
    }

    console.log("[MCP] Disconnected from entity-core");
  }

  /**
   * Check if connected to MCP server.
   */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Pull identity and memories from entity-core.
   */
  async pull(): Promise<IdentityContent | null> {
    if (!this.client) {
      if (this.config.offlineFallback) {
        return this.cache.identity;
      }
      throw new Error("[MCP] Not connected to entity-core");
    }

    try {
      const result = await this.client.callTool({
        name: "sync_pull",
        arguments: {
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);

        if (response.success && response.identityFiles) {
          this.cache.identity = response.identityFiles;
          this.cache.lastSync = new Date().toISOString();

          console.log("[MCP] Pulled identity from entity-core");
          return this.cache.identity;
        }
      }

      return null;
    } catch (error) {
      console.error("[MCP] Pull failed:", error);

      if (this.config.offlineFallback) {
        return this.cache.identity;
      }

      throw error;
    }
  }

  /**
   * Push pending changes to entity-core.
   */
  async push(): Promise<boolean> {
    if (!this.client) {
      if (this.config.offlineFallback) {
        console.log("[MCP] Not connected, changes remain pending");
        return false;
      }
      throw new Error("[MCP] Not connected to entity-core");
    }

    if (this.pendingIdentityChanges.length === 0 && this.pendingMemoryChanges.length === 0) {
      return true; // Nothing to push
    }

    try {
      const result = await this.client.callTool({
        name: "sync_push",
        arguments: {
          instance: {
            id: this.config.instanceId,
            type: "psycheros",
            version: 1,
          },
          identityChanges: this.pendingIdentityChanges.map((change) => ({
            ...change,
            version: 1,
            lastModified: new Date().toISOString(),
            modifiedBy: this.config.instanceId,
          })),
          memoryChanges: this.pendingMemoryChanges.map((memory) => ({
            ...memory,
            version: 1,
          })),
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);

        if (response.success) {
          // Clear pending changes
          this.pendingIdentityChanges = [];
          this.pendingMemoryChanges = [];
          this.cache.lastSync = new Date().toISOString();

          console.log("[MCP] Pushed changes to entity-core");

          if (response.conflicts && response.conflicts.length > 0) {
            console.warn("[MCP] Conflicts detected:", response.conflicts);
          }

          return true;
        }
      }

      return false;
    } catch (error) {
      console.error("[MCP] Push failed:", error);
      throw error;
    }
  }

  /**
   * Load identity content (from cache or MCP).
   */
  async loadIdentity(): Promise<IdentityContent | null> {
    if (this.cache.identity) {
      return this.cache.identity;
    }

    return await this.pull();
  }

  /**
   * Write an identity file through MCP (source of truth).
   *
   * This is the primary method for writing identity files when MCP is enabled.
   * It pushes to entity-core, updates the local cache, and writes to local files
   * as an offline cache.
   *
   * @param category - The identity category (self, user, relationship, custom)
   * @param filename - The filename to write
   * @param content - The file content
   * @param localBasePath - Base path for local file storage (project root)
   */
  async writeIdentityFile(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    localBasePath: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const change = {
      category,
      filename,
      content,
      version: 1,
      lastModified: now,
      modifiedBy: this.config.instanceId,
    };

    // Try to push to entity-core if connected
    if (this.client) {
      try {
        const result = await this.client.callTool({
          name: "sync_push",
          arguments: {
            instance: {
              id: this.config.instanceId,
              type: "psycheros",
              version: 1,
            },
            identityChanges: [change],
            memoryChanges: [],
          },
        });

        const textContent = extractTextContent(result);
        if (textContent) {
          const response = JSON.parse(textContent);
          if (!response.success) {
            console.error("[MCP] Failed to push identity change:", response.error);
            // Queue for retry
            this.queueIdentityChange(category, filename, content);
          } else {
            console.log(`[MCP] Pushed ${category}/${filename} to entity-core`);
          }
        }
      } catch (error) {
        console.error("[MCP] Push failed, queuing change:", error);
        // Queue for later sync
        this.queueIdentityChange(category, filename, content);
      }
    } else {
      // Not connected - queue for later sync
      console.log(`[MCP] Not connected, queuing ${category}/${filename} for later sync`);
      this.queueIdentityChange(category, filename, content);
    }

    // Update local cache
    this.updateLocalCache(category, filename, content, now);

    // Write to local file (offline cache)
    try {
      const filePath = `${localBasePath}/identity/${category}/${filename}`;
      await Deno.writeTextFile(filePath, content);
      console.log(`[MCP] Wrote ${category}/${filename} to local cache`);
    } catch (error) {
      console.error(`[MCP] Failed to write local cache for ${category}/${filename}:`, error);
      // Don't fail - the MCP push/queue is more important
    }

    return true;
  }

  /**
   * Append content to an identity file via MCP.
   * Calls the identity_append tool on entity-core for server-side manipulation.
   */
  async appendIdentityFile(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    reason?: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; content?: string; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "identity_append",
        arguments: {
          category,
          filename,
          content,
          reason,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          // Update local cache
          await Deno.writeTextFile(`${localBasePath}/identity/${category}/${filename}`, response.content);
          this.updateLocalCache(category, filename, response.content, new Date().toISOString());
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_append failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Prepend content to an identity file via MCP.
   * Calls the identity_prepend tool on entity-core for server-side manipulation.
   */
  async prependIdentityFile(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    reason?: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; content?: string; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "identity_prepend",
        arguments: {
          category,
          filename,
          content,
          reason,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          await Deno.writeTextFile(`${localBasePath}/identity/${category}/${filename}`, response.content);
          this.updateLocalCache(category, filename, response.content, new Date().toISOString());
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_prepend failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Update a section in an identity file via MCP.
   * Calls the identity_update_section tool on entity-core for server-side manipulation.
   */
  async updateIdentitySection(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    section: string,
    content: string,
    reason?: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; content?: string; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "identity_update_section",
        arguments: {
          category,
          filename,
          section,
          content,
          reason,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          await Deno.writeTextFile(`${localBasePath}/identity/${category}/${filename}`, response.content);
          this.updateLocalCache(category, filename, response.content, new Date().toISOString());
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_update_section failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Delete a custom identity file via MCP.
   * Calls the identity_delete_custom tool on entity-core.
   * Only custom files can be deleted.
   */
  async deleteCustomFile(
    filename: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "identity_delete_custom",
        arguments: {
          filename,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          // Delete from local cache
          if (this.cache.identity?.custom) {
            this.cache.identity.custom = this.cache.identity.custom.filter(
              (f) => f.filename !== filename,
            );
          }
          // Delete local file
          try {
            await Deno.remove(`${localBasePath}/identity/custom/${filename}`);
          } catch {
            // File may not exist locally, that's fine
          }
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_delete_custom failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Update the local cache with a new/modified file.
   */
  private updateLocalCache(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    lastModified: string,
  ): void {
    if (!this.cache.identity) {
      // Initialize empty cache structure
      this.cache.identity = {
        self: [],
        user: [],
        relationship: [],
        custom: [],
      };
    }

    const files = this.cache.identity[category];
    const existingIndex = files.findIndex((f) => f.filename === filename);

    const fileEntry: IdentityFile = {
      category,
      filename,
      content,
      version: existingIndex >= 0 ? files[existingIndex].version + 1 : 1,
      lastModified,
      modifiedBy: this.config.instanceId,
    };

    if (existingIndex >= 0) {
      files[existingIndex] = fileEntry;
    } else {
      files.push(fileEntry);
    }
  }

  /**
   * Queue an identity file change for sync.
   */
  queueIdentityChange(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
  ): void {
    // Remove any existing pending change for this file
    this.pendingIdentityChanges = this.pendingIdentityChanges.filter(
      (c) => !(c.category === category && c.filename === filename),
    );

    // Add the new change
    this.pendingIdentityChanges.push({ category, filename, content });

    // Update local cache
    if (this.cache.identity) {
      const files = this.cache.identity[category];
      const existingIndex = files.findIndex((f) => f.filename === filename);

      if (existingIndex >= 0) {
        files[existingIndex].content = content;
      } else {
        files.push({
          filename,
          content,
          version: 1,
          lastModified: new Date().toISOString(),
          modifiedBy: this.config.instanceId,
          category,
        });
      }
    }
  }

  /**
   * Queue a memory entry for sync.
   */
  queueMemoryChange(memory: MemoryEntry): void {
    // Set instance info
    memory.sourceInstance = this.config.instanceId;
    if (!memory.participatingInstances) {
      memory.participatingInstances = [this.config.instanceId];
    }

    this.pendingMemoryChanges.push(memory);
  }

  /**
   * Create a memory entry via MCP.
   */
  async createMemory(
    granularity: Granularity,
    date: string,
    content: string,
    chatIds: string[] = [],
  ): Promise<boolean> {
    if (!this.client) {
      // Queue for later sync
      this.queueMemoryChange({
        id: `${granularity}-${date}`,
        granularity,
        date,
        content,
        chatIds,
        sourceInstance: this.config.instanceId,
        participatingInstances: [this.config.instanceId],
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return true;
    }

    try {
      const result = await this.client.callTool({
        name: "memory_create",
        arguments: {
          granularity,
          date,
          content,
          chatIds,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.success;
      }

      return false;
    } catch (error) {
      console.error("[MCP] Create memory failed:", error);

      // Queue for later sync
      this.queueMemoryChange({
        id: `${granularity}-${date}`,
        granularity,
        date,
        content,
        chatIds,
        sourceInstance: this.config.instanceId,
        participatingInstances: [this.config.instanceId],
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return true;
    }
  }

  /**
   * Search memories via MCP.
   */
  async searchMemories(
    query: string,
    options?: {
      minScore?: number;
      maxResults?: number;
    },
  ): Promise<Array<{
    granularity: string;
    date: string;
    score: number;
    excerpt: string;
  }>> {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot search memories");
      return [];
    }

    try {
      const result = await this.client.callTool({
        name: "memory_search",
        arguments: {
          query,
          instanceId: this.config.instanceId,
          minScore: options?.minScore,
          maxResults: options?.maxResults,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.results ?? [];
      }

      return [];
    } catch (error) {
      console.error("[MCP] Memory search failed:", error);
      return [];
    }
  }

  /**
   * Get pending changes count.
   */
  getPendingCount(): { identity: number; memories: number } {
    return {
      identity: this.pendingIdentityChanges.length,
      memories: this.pendingMemoryChanges.length,
    };
  }

  /**
   * Create a snapshot of all identity files via MCP.
   */
  async createSnapshot(): Promise<{
    success: boolean;
    snapshots?: Array<{
      id: string;
      category: string;
      filename: string;
      timestamp: string;
    }>;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "snapshot_create",
        arguments: {},
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        return JSON.parse(textContent);
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] snapshot_create failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * List available snapshots via MCP.
   */
  async listSnapshots(options?: {
    category?: string;
    filename?: string;
  }): Promise<{
    success: boolean;
    snapshots?: Array<{
      id: string;
      category: string;
      filename: string;
      timestamp: string;
      date: string;
      reason: string;
    }>;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "snapshot_list",
        arguments: {
          category: options?.category,
          filename: options?.filename,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        return JSON.parse(textContent);
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] snapshot_list failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get snapshot content via MCP.
   */
  async getSnapshotContent(snapshotId: string): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "snapshot_get",
        arguments: {
          snapshotId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && response.content) {
          return { success: true, content: response.content };
        }
        return { success: false, error: response.error || "Failed to get snapshot content" };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] getSnapshotContent failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Restore a snapshot via MCP.
   */
  async restoreSnapshot(snapshotId: string): Promise<{
    success: boolean;
    message?: string;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "snapshot_restore",
        arguments: {
          snapshotId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success) {
          // Pull to update local cache
          await this.pull();
        }
        return response;
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] snapshot_restore failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Start periodic sync.
   * Does a full sync: pull first (to get remote changes), then push (to send local changes).
   */
  private startPeriodicSync(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
    }

    this.syncTimer = setInterval(async () => {
      try {
        // Pull first to get any remote changes
        await this.pull();
        // Then push any pending local changes
        await this.push();
      } catch (error) {
        console.error("[MCP] Periodic sync failed:", error);
      }
    }, this.config.syncInterval!);
  }

  // ========================================
  // GRAPH METHODS
  // ========================================

  /**
   * Get graph statistics via MCP.
   */
  async getGraphStats(): Promise<{
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
    vectorSearchAvailable: boolean;
  } | null> {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot get graph stats");
      return null;
    }

    try {
      const result = await this.client.callTool({
        name: "graph_stats",
        arguments: {},
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        return JSON.parse(textContent);
      }
      return null;
    } catch (error) {
      console.error("[MCP] Graph stats failed:", error);
      return null;
    }
  }

  /**
   * Get all nodes via MCP.
   */
  async getGraphNodes(options?: {
    type?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    type: string;
    label: string;
    description: string;
    confidence: number;
    createdAt: string;
    updatedAt: string;
  }>> {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot get graph nodes");
      return [];
    }

    try {
      const result = await this.client.callTool({
        name: "graph_node_list",
        arguments: {
          type: options?.type,
          limit: options?.limit ?? 500,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.nodes ?? [];
      }
      return [];
    } catch (error) {
      console.error("[MCP] Get graph nodes failed:", error);
      return [];
    }
  }

  /**
   * Get edges via MCP.
   */
  async getGraphEdges(options?: {
    fromId?: string;
    toId?: string;
    type?: string;
  }): Promise<Array<{
    id: string;
    fromId: string;
    toId: string;
    type: string;
    customType?: string;
    weight: number;
  }>> {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot get graph edges");
      return [];
    }

    try {
      const result = await this.client.callTool({
        name: "graph_edge_get",
        arguments: {
          fromId: options?.fromId,
          toId: options?.toId,
          type: options?.type,
          onlyValid: true,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.edges ?? [];
      }
      return [];
    } catch (error) {
      console.error("[MCP] Get graph edges failed:", error);
      return [];
    }
  }

  /**
   * Create a graph node via MCP.
   */
  async createGraphNode(input: {
    type: string;
    label: string;
    description?: string;
    properties?: Record<string, unknown>;
    confidence?: number;
    sourceMemoryId?: string;
    embedding?: number[];
  }): Promise<{ success: boolean; nodeId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      // Auto-generate embedding if not provided
      let embedding = input.embedding;
      if (!embedding) {
        try {
          const { getEmbedder } = await import("../rag/embedder.ts");
          const embedder = getEmbedder();
          embedding = await embedder.embed(`${input.label} ${input.description || ""}`);
        } catch (e) {
          console.warn("[MCP] Failed to generate embedding for graph node:", e);
        }
      }

      const result = await this.client.callTool({
        name: "graph_node_create",
        arguments: {
          type: input.type,
          label: input.label,
          description: input.description,
          properties: input.properties ?? {},
          confidence: input.confidence ?? 0.5,
          sourceMemoryId: input.sourceMemoryId,
          embedding,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          nodeId: response.node?.id,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Create graph node failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Create a graph edge via MCP.
   */
  async createGraphEdge(input: {
    fromId: string;
    toId: string;
    type: string;
    customType?: string;
    weight?: number;
    evidence?: string;
  }): Promise<{ success: boolean; edgeId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "graph_edge_create",
        arguments: {
          fromId: input.fromId,
          toId: input.toId,
          type: input.type,
          customType: input.customType,
          weight: input.weight ?? 0.5,
          evidence: input.evidence,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          edgeId: response.edge?.id,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Create graph edge failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Delete a graph node via MCP.
   */
  async deleteGraphNode(nodeId: string, permanent = false): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "graph_node_delete",
        arguments: {
          id: nodeId,
          permanent,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Delete graph node failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Delete a graph edge via MCP.
   */
  async deleteGraphEdge(edgeId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "graph_edge_delete",
        arguments: {
          id: edgeId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Delete graph edge failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get a single graph node by ID via MCP.
   */
  async getGraphNode(nodeId: string): Promise<{
    id: string;
    type: string;
    label: string;
    description: string;
    confidence: number;
  } | null> {
    if (!this.client) {
      return null;
    }

    try {
      const result = await this.client.callTool({
        name: "graph_node_get",
        arguments: {
          id: nodeId,
        },
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return null;
      }

      const response = JSON.parse(textContent);
      return response.node ?? null;
    } catch (error) {
      console.error("[MCP] Get graph node failed:", error);
      return null;
    }
  }

  /**
   * Search graph nodes via MCP.
   */
  async searchGraphNodes(
    query: string,
    type?: string,
    limit?: number,
    minScore?: number
  ): Promise<Array<{
    id: string;
    type: string;
    label: string;
    description: string;
    confidence: number;
    createdAt: string;
    updatedAt: string;
    score: number;
  }>> {
    if (!this.client) {
      return [];
    }

    try {
      // Generate query embedding for semantic search
      let queryEmbedding: number[] | undefined;
      try {
        const { getEmbedder } = await import("../rag/embedder.ts");
        const embedder = getEmbedder();
        queryEmbedding = await embedder.embed(query);
      } catch (e) {
        console.warn("[MCP] Failed to generate query embedding, falling back to text search:", e);
      }

      const result = await this.client.callTool({
        name: "graph_node_search",
        arguments: {
          query,
          queryEmbedding,
          type,
          limit: limit ?? 10,
          minScore: minScore ?? 0.3,
        },
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return [];
      }

      const response = JSON.parse(textContent);
      return (response.results ?? []).map((r: { node: { id: string; type: string; label: string; description: string; confidence: number; createdAt: string; updatedAt: string }; score: number }) => ({
        id: r.node.id,
        type: r.node.type,
        label: r.node.label,
        description: r.node.description,
        confidence: r.node.confidence,
        createdAt: r.node.createdAt,
        updatedAt: r.node.updatedAt,
        score: r.score,
      }));
    } catch (error) {
      console.error("[MCP] Search graph nodes failed:", error);
      return [];
    }
  }

  /**
   * Traverse graph from a starting node.
   */
  async traverseGraph(
    startNodeId: string,
    direction?: "out" | "in" | "both",
    maxDepth?: number,
    edgeTypes?: string[]
  ): Promise<{
    startNode?: { id: string; label: string; type: string };
    results: Array<{
      node: { id: string; label: string; type: string; description?: string };
      path: string[];
      depth: number;
    }>;
  }> {
    if (!this.client) {
      return { startNode: undefined, results: [] };
    }

    try {
      const result = await this.client.callTool({
        name: "graph_traverse",
        arguments: {
          startNodeId,
          direction: direction ?? "both",
          maxDepth: maxDepth ?? 2,
          edgeTypes,
        },
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return { startNode: undefined, results: [] };
      }

      const response = JSON.parse(textContent);
      return {
        startNode: response.startNode ? {
          id: response.startNode.id,
          label: response.startNode.label,
          type: response.startNode.type,
        } : undefined,
        results: (response.results ?? []).map((r: { node: { id: string; label: string; type: string; description?: string }; path: string[]; depth: number }) => ({
          node: {
            id: r.node.id,
            label: r.node.label,
            type: r.node.type,
            description: r.node.description,
          },
          path: r.path,
          depth: r.depth,
        })),
      };
    } catch (error) {
      console.error("[MCP] Traverse graph failed:", error);
      return { startNode: undefined, results: [] };
    }
  }

  /**
   * Get a subgraph centered on a node.
   */
  async getGraphSubgraph(
    nodeId: string,
    depth?: number
  ): Promise<{
    node?: { id: string; label: string; type: string };
    nodes: Array<{ id: string; label: string; type: string; description?: string }>;
    edges: Array<{ id: string; fromId: string; toId: string; type: string; customType?: string; weight: number }>;
  }> {
    if (!this.client) {
      return { node: undefined, nodes: [], edges: [] };
    }

    try {
      const result = await this.client.callTool({
        name: "graph_subgraph",
        arguments: {
          nodeId,
          depth: depth ?? 2,
        },
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return { node: undefined, nodes: [], edges: [] };
      }

      const response = JSON.parse(textContent);
      return {
        node: response.node ? {
          id: response.node.id,
          label: response.node.label,
          type: response.node.type,
        } : undefined,
        nodes: (response.nodes ?? []).map((n: { id: string; label: string; type: string; description?: string }) => ({
          id: n.id,
          label: n.label,
          type: n.type,
          description: n.description,
        })),
        edges: (response.edges ?? []).map((e: { id: string; fromId: string; toId: string; type: string; customType?: string; weight: number }) => ({
          id: e.id,
          fromId: e.fromId,
          toId: e.toId,
          type: e.type,
          customType: e.customType,
          weight: e.weight ?? 0.5,
        })),
      };
    } catch (error) {
      console.error("[MCP] Get graph subgraph failed:", error);
      return { node: undefined, nodes: [], edges: [] };
    }
  }

  /**
   * Update a graph node via MCP.
   */
  async updateGraphNode(id: string, input: {
    label?: string;
    description?: string;
    properties?: Record<string, unknown>;
    confidence?: number;
    lastConfirmedAt?: string;
    embedding?: number[];
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      // Re-generate embedding if label or description changed
      let embedding = input.embedding;
      if (!embedding && (input.label || input.description)) {
        try {
          const { getEmbedder } = await import("../rag/embedder.ts");
          const embedder = getEmbedder();
          const text = `${input.label || ""} ${input.description || ""}`.trim();
          if (text) {
            embedding = await embedder.embed(text);
          }
        } catch (e) {
          console.warn("[MCP] Failed to generate embedding for node update:", e);
        }
      }

      const result = await this.client.callTool({
        name: "graph_node_update",
        arguments: {
          id,
          label: input.label,
          description: input.description,
          properties: input.properties,
          confidence: input.confidence,
          lastConfirmedAt: input.lastConfirmedAt,
          embedding,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Update graph node failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Update a graph edge via MCP.
   */
  async updateGraphEdge(id: string, input: {
    type?: string;
    customType?: string;
    properties?: Record<string, unknown>;
    weight?: number;
    evidence?: string;
    validUntil?: string;
    lastConfirmedAt?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.client.callTool({
        name: "graph_edge_update",
        arguments: {
          id,
          ...input,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Update graph edge failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Create multiple nodes and edges in a single transaction via MCP.
   * Auto-generates embeddings for each node.
   */
  async writeGraphTransaction(input: {
    nodes?: Array<{
      type: string;
      label: string;
      description?: string;
      properties?: Record<string, unknown>;
      confidence?: number;
      sourceMemoryId?: string;
      firstLearnedAt?: string;
    }>;
    edges?: Array<{
      fromLabel: string;
      toLabel: string;
      type: string;
      customType?: string;
      properties?: Record<string, unknown>;
      weight?: number;
      evidence?: string;
      occurredAt?: string;
      validUntil?: string;
    }>;
  }): Promise<{ success: boolean; nodesCreated: number; edgesCreated: number; error?: string }> {
    if (!this.client) {
      return { success: false, nodesCreated: 0, edgesCreated: 0, error: "MCP not connected" };
    }

    try {
      // Generate embeddings for all nodes
      const nodesWithEmbeddings = [];
      if (input.nodes) {
        let embedder: { embed: (text: string) => Promise<number[]> } | null = null;
        try {
          const { getEmbedder } = await import("../rag/embedder.ts");
          embedder = getEmbedder();
        } catch (e) {
          console.warn("[MCP] Failed to load embedder for batch:", e);
        }

        for (const node of input.nodes) {
          let embedding: number[] | undefined;
          if (embedder) {
            try {
              embedding = await embedder.embed(`${node.label} ${node.description || ""}`);
            } catch (e) {
              console.warn(`[MCP] Failed to embed node "${node.label}":`, e);
            }
          }
          nodesWithEmbeddings.push({ ...node, embedding });
        }
      }

      const result = await this.client.callTool({
        name: "graph_write_transaction",
        arguments: {
          nodes: nodesWithEmbeddings.length > 0 ? nodesWithEmbeddings : undefined,
          edges: input.edges,
          instanceId: this.config.instanceId,
        },
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          nodesCreated: response.nodesCreated ?? 0,
          edgesCreated: response.edgesCreated ?? 0,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, nodesCreated: 0, edgesCreated: 0, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Write graph transaction failed:", error);
      return { success: false, nodesCreated: 0, edgesCreated: 0, error: String(error) };
    }
  }
}

/**
 * Create an MCP client instance.
 */
export function createMCPClient(config: MCPClientConfig): MCPClient {
  return new MCPClient(config);
}
