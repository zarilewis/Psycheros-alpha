/**
 * Vault Entity Tools
 *
 * Tools that allow the entity to create, list, and search vault documents.
 * The entity can write persistent reference documents and search them.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { VaultManager } from "../vault/mod.ts";

/**
 * Helper to get the VaultManager from the tool context.
 */
function getVaultManager(ctx: ToolContext): VaultManager | null {
  const config = ctx.config as unknown as Record<string, unknown>;
  const vm = config.vaultManager;
  return vm instanceof VaultManager ? vm : null;
}

/**
 * The vault_write tool allows the entity to create or update a vault document.
 *
 * I use this to store reference documents, notes, or any persistent content
 * I want to search later. Documents can be global (always available) or
 * scoped to the current chat.
 */
export const vaultWriteTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "vault_write",
      description:
        "Create or update a document in my Data Vault. I use this to store reference material, notes, or any content I want to persist and search later. Documents can be global (always available) or scoped to the current chat.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A descriptive title for the document",
          },
          content: {
            type: "string",
            description:
              "The full content of the document in markdown format",
          },
          scope: {
            type: "string",
            enum: ["global", "chat"],
            description:
              "Document scope: 'global' (available in all chats) or 'chat' (only this conversation). Default: 'chat'",
          },
        },
        required: ["title", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const vaultManager = getVaultManager(ctx);
    if (!vaultManager) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: Data Vault is not available",
        isError: true,
      };
    }

    const title = args.title;
    const content = args.content;
    const scope = (args.scope as "global" | "chat") || "chat";

    if (typeof title !== "string" || title.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'title' is required and must be non-empty",
        isError: true,
      };
    }

    if (typeof content !== "string" || content.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'content' is required and must be non-empty",
        isError: true,
      };
    }

    try {
      // Check if a document with this title already exists in this scope
      const existing = vaultManager.listDocuments({ scope }).find(
        (d) => d.title === title.trim() && d.source === "entity"
      );

      let result;
      if (existing) {
        result = await vaultManager.updateDocument(existing.id, {
          title: title.trim(),
          content: content.trim(),
        });
        return {
          toolCallId: ctx.toolCallId,
          content: `Updated vault document "${title.trim()}" (${result?.chunkCount ?? 0} chunks)`,
          isError: false,
        };
      }

      result = await vaultManager.createFromContent(title.trim(), content.trim(), {
        scope,
        conversationId: scope === "chat" ? ctx.conversationId : undefined,
      });

      return {
        toolCallId: ctx.toolCallId,
        content: `Created vault document "${title.trim()}" (${result.chunkCount} chunks, ${scope} scope)`,
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Vault] vault_write failed:", errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: ${errorMessage}`,
        isError: true,
      };
    }
  },
};

/**
 * The vault_list tool allows the entity to list its vault documents.
 *
 * I use this to see what documents I have stored in my Data Vault.
 */
export const vaultListTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "vault_list",
      description:
        "List documents in my Data Vault. I use this to see what reference documents I have stored.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["global", "chat", "all"],
            description:
              "Filter by scope: 'global', 'chat', or 'all'. Default: 'all'",
          },
        },
      },
    },
  },

  // deno-lint-ignore require-await
  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const vaultManager = getVaultManager(ctx);
    if (!vaultManager) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: Data Vault is not available",
        isError: true,
      };
    }

    const scope = (args.scope as "global" | "chat" | "all") || "all";

    try {
      const docs = vaultManager.listDocuments({
        scope,
        conversationId: ctx.conversationId,
      });

      if (docs.length === 0) {
        return {
          toolCallId: ctx.toolCallId,
          content: "No documents found in the Data Vault.",
          isError: false,
        };
      }

      const lines = docs.map((d, i) => {
        const scopeLabel = d.scope === "global" ? "[global]" : "[chat]";
        const sourceLabel = d.source === "entity" ? "entity" : "upload";
        return `${i + 1}. "${d.title}" ${scopeLabel} (${sourceLabel}, ${d.chunkCount} chunks, ${d.fileType})`;
      });

      return {
        toolCallId: ctx.toolCallId,
        content: `Data Vault (${docs.length} documents):\n${lines.join("\n")}`,
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Vault] vault_list failed:", errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: ${errorMessage}`,
        isError: true,
      };
    }
  },
};

/**
 * The vault_search tool allows the entity to search its vault documents.
 *
 * I use this to find relevant information from my stored reference documents.
 */
export const vaultSearchTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "vault_search",
      description:
        "Search my Data Vault for relevant content. I use this to find information from my stored reference documents.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query to find relevant content",
          },
          max_results: {
            type: "number",
            description:
              "Maximum number of results to return. Default: 5",
          },
        },
        required: ["query"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const vaultManager = getVaultManager(ctx);
    if (!vaultManager) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: Data Vault is not available",
        isError: true,
      };
    }

    const query = args.query;
    const maxResults = typeof args.max_results === "number"
      ? args.max_results
      : 5;

    if (typeof query !== "string" || query.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'query' is required and must be non-empty",
        isError: true,
      };
    }

    try {
      const results = await vaultManager.search(query, {
        conversationId: ctx.conversationId,
        maxChunks: maxResults,
        minScore: 0.3,
      });

      if (results.length === 0) {
        return {
          toolCallId: ctx.toolCallId,
          content: "No relevant content found in the Data Vault.",
          isError: false,
        };
      }

      const parts = results.map((r, i) => {
        const pct = Math.round(r.score * 100);
        return `[${i + 1}] "${r.documentTitle}" (${pct}% relevant):\n${r.chunk.content}`;
      });

      return {
        toolCallId: ctx.toolCallId,
        content: `Found ${results.length} results:\n\n${parts.join("\n\n---\n\n")}`,
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Vault] vault_search failed:", errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
