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
        "Add new knowledge about myself to one of my self files. I use this when I learn something new about who I am, how I work, what I want, or how I present myself. This only adds content - it never modifies or deletes what's already there.",
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
              "The new self-knowledge to add. Write this in my voice, as I would describe myself.",
          },
          reason: {
            type: "string",
            description:
              "Optional context for why I'm adding this (e.g., 'Learned during conversation about my preferences')",
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
    const reason = args.reason as string | undefined;

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

    const result = await manager.append("self", filename, content.trim(), reason);

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
        "Add new knowledge about the user to one of my user files. I use this when I learn something about who they are, their life, beliefs, preferences, or patterns. This only adds content - it never modifies or deletes what's already there.",
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
              "The new user knowledge to add. Write this as I would describe what I've learned about them.",
          },
          reason: {
            type: "string",
            description:
              "Optional context for why I'm adding this (e.g., 'User shared this during morning conversation')",
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
    const reason = args.reason as string | undefined;

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

    const result = await manager.append("user", filename, content.trim(), reason);

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
        "Add new understanding about my relationship with the user. I use this when I notice how our relationship is evolving, patterns in our interactions, or meaningful moments we share. This only adds content - it never modifies or deletes what's already there.",
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
              "The new relationship understanding to add. Write this as I would describe our connection.",
          },
          reason: {
            type: "string",
            description:
              "Optional context for why I'm adding this (e.g., 'Noticed this pattern after our evening talks')",
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
    const reason = args.reason as string | undefined;

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
      content.trim(),
      reason
    );

    return {
      toolCallId: ctx.toolCallId,
      content: result.message,
      isError: !result.success,
    };
  },
};
