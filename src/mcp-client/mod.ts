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
  category: "self" | "user" | "relationship";
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
    category: "self" | "user" | "relationship";
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
   * @param category - The identity category (self, user, relationship)
   * @param filename - The filename to write
   * @param content - The file content
   * @param localBasePath - Base path for local file storage (project root)
   */
  async writeIdentityFile(
    category: "self" | "user" | "relationship",
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
      const filePath = `${localBasePath}/${category}/${filename}`;
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
    category: "self" | "user" | "relationship",
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
          await Deno.writeTextFile(`${localBasePath}/${category}/${filename}`, response.content);
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
    category: "self" | "user" | "relationship",
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
          await Deno.writeTextFile(`${localBasePath}/${category}/${filename}`, response.content);
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
    category: "self" | "user" | "relationship",
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
          await Deno.writeTextFile(`${localBasePath}/${category}/${filename}`, response.content);
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
   * Update the local cache with a new/modified file.
   */
  private updateLocalCache(
    category: "self" | "user" | "relationship",
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
    category: "self" | "user" | "relationship",
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
}

/**
 * Create an MCP client instance.
 */
export function createMCPClient(config: MCPClientConfig): MCPClient {
  return new MCPClient(config);
}
