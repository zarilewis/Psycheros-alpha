/**
 * Custom Identity File Tool
 *
 * Allows the entity to create, modify, and delete custom identity files.
 * Custom files are freeform files in identity/custom/ for topics that
 * don't fit the predefined self/user/relationship structure.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { IdentityFileManager } from "./identity-helpers.ts";

// =============================================================================
// custom_file Tool
// =============================================================================

export const customFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "custom_file",
      description:
        "Create, modify, or delete a custom identity file. Custom files are freeform files in identity/custom/ that load into my context every turn alongside my other identity files. I use these for topics that don't fit the predefined self/user/relationship structure. The same selectivity applies — only store identity-level, durable knowledge.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "The operation to perform: 'create' (new file), 'append' (add to existing), 'replace' (overwrite, creates snapshot), 'delete' (remove file)",
            enum: ["create", "append", "replace", "delete"],
          },
          filename: {
            type: "string",
            description:
              "The custom filename with .md extension. Use only letters, numbers, and underscores (e.g., my_project.md).",
          },
          content: {
            type: "string",
            description:
              "Content for create, append, or replace operations. Write concisely — these files load every turn. For create, content is auto-wrapped in XML tags. For replace, provide the complete file content including XML tags.",
          },
        },
        required: ["operation", "filename"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const operation = args.operation as string;
    const filename = args.filename as string;
    const content = args.content as string | undefined;

    // Validate operation
    if (!operation || !["create", "append", "replace", "delete"].includes(operation)) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: Invalid operation '${operation}'. Valid operations: create, append, replace, delete`,
        isError: true,
      };
    }

    // Validate filename
    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string",
        isError: true,
      };
    }

    // Validate content is present for non-delete operations
    if (operation !== "delete" && (!content || typeof content !== "string")) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'content' is required for create, append, and replace operations",
        isError: true,
      };
    }

    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.projectRoot
    );

    switch (operation) {
      case "create": {
        // Auto-wrap content in XML tags based on filename
        const tagName = filename.replace(/\.md$/, "");
        const wrappedContent = `<${tagName}>\n${content!.trim()}\n</${tagName}>\n`;

        const result = await manager.create("custom", filename, wrappedContent);
        return { toolCallId: ctx.toolCallId, content: result.message, isError: !result.success };
      }

      case "append": {
        const result = await manager.append("custom", filename, content!.trim());
        return { toolCallId: ctx.toolCallId, content: result.message, isError: !result.success };
      }

      case "replace": {
        const result = await manager.replace(
          "custom",
          filename,
          content!.trim(),
          "Entity-initiated replace"
        );
        return { toolCallId: ctx.toolCallId, content: result.message, isError: !result.success };
      }

      case "delete": {
        const result = await manager.deleteCustomFile(filename);
        return { toolCallId: ctx.toolCallId, content: result.message, isError: !result.success };
      }

      default: {
        return {
          toolCallId: ctx.toolCallId,
          content: `Error: Unhandled operation '${operation}'`,
          isError: true,
        };
      }
    }
  },
};
