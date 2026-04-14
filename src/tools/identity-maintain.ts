/**
 * Identity Maintenance Tools
 *
 * Tier 2: Full suite of tools for intentional identity reorganization.
 * Includes prepend, section updates, and section rewriting.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import {
  IdentityFileManager,
  type IdentityCategory,
} from "./identity-helpers.ts";

// =============================================================================
// Helper Constants
// =============================================================================

const CATEGORIES = ["self", "user", "relationship"] as const;

// =============================================================================
// maintain_identity Tool
// =============================================================================

/**
 * The maintain_identity tool allows comprehensive identity file maintenance.
 */
export const maintainIdentityTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "maintain_identity",
      description:
        "Comprehensive tool for maintaining my identity files. Use this for intentional reorganization - adding high-priority context (prepend), updating specific sections, or rewriting a section's content. For everyday additions, prefer the simpler append_to_* tools instead.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Which category of identity file to modify",
            enum: CATEGORIES,
          },
          filename: {
            type: "string",
            description:
              "The file to modify. Must match the category (e.g., for 'self' use my_identity.md, for 'user' use user_identity.md)",
          },
          operation: {
            type: "string",
            description:
              "The operation to perform: 'append' (add to end), 'prepend' (add to beginning), 'update_section' (append content under a heading), 'rewrite_section' (replace a section's content entirely)",
            enum: ["append", "prepend", "update_section", "rewrite_section"],
          },
          content: {
            type: "string",
            description: "The content to add or replace with",
          },
          section: {
            type: "string",
            description:
              "Required for update_section and rewrite_section: the heading name (without ##) of the section to modify",
          },
          reason: {
            type: "string",
            description:
              "Why I'm making this change. Optional but encouraged for significant modifications.",
          },
        },
        required: ["category", "filename", "operation", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const category = args.category as IdentityCategory;
    const filename = args.filename as string;
    const operation = args.operation as string;
    const content = args.content as string;
    const section = args.section as string | undefined;
    const reason = args.reason as string | undefined;

    // Validate required args
    if (!category || !CATEGORIES.includes(category as never)) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: 'category' must be one of: ${CATEGORIES.join(", ")}`,
        isError: true,
      };
    }

    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string",
        isError: true,
      };
    }

    if (!operation || typeof operation !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'operation' is required",
        isError: true,
      };
    }

    if (!content || typeof content !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'content' is required and must be a string",
        isError: true,
      };
    }

    // Validate operation-specific requirements
    if ((operation === "update_section" || operation === "rewrite_section") && !section) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: 'section' is required when operation is '${operation}'`,
        isError: true,
      };
    }

    // Create file manager
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.projectRoot
    );

    // Validate file first
    const validation = manager.validateFile(category, filename);
    if (validation) {
      return {
        toolCallId: ctx.toolCallId,
        content: validation.message,
        isError: true,
      };
    }

    // Perform the operation
    let result;

    switch (operation) {
      case "append":
        result = await manager.append(category, filename, content.trim(), reason);
        break;

      case "prepend":
        result = await manager.prepend(category, filename, content.trim(), reason);
        break;

      case "update_section":
        result = await manager.updateSection(
          category,
          filename,
          section!,
          content.trim(),
          reason
        );
        break;

      case "rewrite_section":
        result = await manager.rewriteSection(
          category,
          filename,
          section!,
          content.trim()
        );
        break;

      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Error: Unknown operation '${operation}'. Valid operations: append, prepend, update_section, rewrite_section`,
          isError: true,
        };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: result.message,
      isError: !result.success,
    };
  },
};

// =============================================================================
// list_identity_snapshots Tool
// =============================================================================

/**
 * The list_identity_snapshots tool allows viewing available snapshots for recovery.
 */
export const listIdentitySnapshotsTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "list_identity_snapshots",
      description:
        "View available snapshots of my identity files. Snapshots are created automatically by entity-core when identity files are written via MCP. I can use this to see what backups exist, or to find a previous version I might want to reference.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Filter by category (self, user, or relationship). Omit to see all categories.",
            enum: CATEGORIES,
          },
          filename: {
            type: "string",
            description:
              "Filter by filename (e.g., 'my_identity.md'). Omit to see all files.",
          },
        },
        required: [],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const category = args.category as IdentityCategory | undefined;
    const filename = args.filename as string | undefined;

    // Create file manager
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.projectRoot
    );

    try {
      const snapshots = await manager.listSnapshots(category, filename);

      if (snapshots.length === 0) {
        const filterDesc = category
          ? ` for ${category}${filename ? `/${filename}` : ""}`
          : "";
        return {
          toolCallId: ctx.toolCallId,
          content: `No snapshots found${filterDesc}. Snapshots are created automatically by entity-core when identity files are written.`,
          isError: false,
        };
      }

      // Format snapshot list
      const lines: string[] = ["Available identity file snapshots:\n"];

      let currentCategory = "";
      for (const snapshot of snapshots) {
        if (snapshot.category !== currentCategory) {
          currentCategory = snapshot.category;
          lines.push(`\n**${currentCategory}/**`);
        }
        lines.push(`  - ${snapshot.filename} (${snapshot.date})`);
      }

      lines.push(
        `\nTotal: ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"}`
      );

      return {
        toolCallId: ctx.toolCallId,
        content: lines.join("\n"),
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error listing snapshots: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
