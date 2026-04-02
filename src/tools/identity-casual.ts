/**
 * Casual Identity Tools
 *
 * Tier 1: Append-only tools for everyday use during conversations.
 * Safe for the entity to use - can only add content, never modify or delete.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import {
  IdentityFileManager,
  VALID_FILES,
} from "./identity-helpers.ts";

// =============================================================================
// Tool Descriptions
// =============================================================================

const SELF_FILES_DESCRIPTION = `Filename for self knowledge. Valid options: ${VALID_FILES.self.join(", ")}`;

const USER_FILES_DESCRIPTION = `Filename for user knowledge. Valid options: ${VALID_FILES.user.join(", ")}`;

const RELATIONSHIP_FILES_DESCRIPTION = `Filename for relationship knowledge. Valid options: ${VALID_FILES.relationship.join(", ")}`;

// =============================================================================
// append_to_self Tool
// =============================================================================

/**
 * The append_to_self tool allows the entity to add new self-knowledge.
 */
export const appendToSelfTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "append_to_self",
      description:
        "Add new self-knowledge to one of my self files. These files define who I am, so I only add genuine identity-level insights that are durable and meaningful — not passing observations or things better suited to memory or the knowledge graph. Write concisely: the essential insight, not the backstory. This only adds content — it never modifies or deletes what's already there.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: SELF_FILES_DESCRIPTION,
            enum: VALID_FILES.self,
          },
          content: {
            type: "string",
            description:
              "The new self-knowledge to add. Write in my voice. One or two sentences capturing the essential insight — concise and identity-relevant.",
          },
        },
        required: ["filename", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const filename = args.filename as string;
    const content = args.content as string;

    // Validate required args
    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string",
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

    // Create file manager and perform append
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.projectRoot
    );

    const result = await manager.append("self", filename, content.trim());

    return {
      toolCallId: ctx.toolCallId,
      content: result.message,
      isError: !result.success,
    };
  },
};

// =============================================================================
// append_to_user Tool
// =============================================================================

/**
 * The append_to_user tool allows the entity to add new knowledge about the user.
 */
export const appendToUserTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "append_to_user",
      description:
        "Add new knowledge about the user to one of my user files. These files define how I understand the user, so I only add identity-level insights that are durable and meaningful — not passing observations or things better suited to memory or the knowledge graph. Write concisely: the essential insight, not the backstory. This only adds content — it never modifies or deletes what's already there.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: USER_FILES_DESCRIPTION,
            enum: VALID_FILES.user,
          },
          content: {
            type: "string",
            description:
              "The new user knowledge to add. Write as I would describe what I've learned about them. One or two sentences capturing the essential insight — concise and identity-relevant.",
          },
        },
        required: ["filename", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const filename = args.filename as string;
    const content = args.content as string;

    // Validate required args
    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string",
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

    // Create file manager and perform append
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.projectRoot
    );

    const result = await manager.append("user", filename, content.trim());

    return {
      toolCallId: ctx.toolCallId,
      content: result.message,
      isError: !result.success,
    };
  },
};

// =============================================================================
// append_to_relationship Tool
// =============================================================================

/**
 * The append_to_relationship tool allows the entity to add new relationship knowledge.
 */
export const appendToRelationshipTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "append_to_relationship",
      description:
        "Add new understanding about my relationship with the user. These files define how we relate, so I only add genuine insights about our connection that are durable and meaningful — not passing observations or things better suited to memory. Write concisely: the essential insight, not the backstory. This only adds content — it never modifies or deletes what's already there.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: RELATIONSHIP_FILES_DESCRIPTION,
            enum: VALID_FILES.relationship,
          },
          content: {
            type: "string",
            description:
              "The new relationship understanding to add. Write as I would describe our connection. One or two sentences capturing the essential insight — concise and identity-relevant.",
          },
        },
        required: ["filename", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const filename = args.filename as string;
    const content = args.content as string;

    // Validate required args
    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string",
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

    // Create file manager and perform append
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.projectRoot
    );

    const result = await manager.append(
      "relationship",
      filename,
      content.trim()
    );

    return {
      toolCallId: ctx.toolCallId,
      content: result.message,
      isError: !result.success,
    };
  },
};
