/**
 * Tool-Specific Type Definitions
 *
 * Types for the tool execution system that extends the shared types
 * from src/types.ts.
 */

import type { DBClient } from "../db/mod.ts";
import type { ToolDefinition, ToolResult } from "../types.ts";
import type { EntityConfig } from "../entity/loop.ts";

// =============================================================================
// Tool Context Types
// =============================================================================

/**
 * Services available to tools for extended functionality.
 * Currently a placeholder for future expansion (LLM, HTTP, memory, etc.)
 *
 * Future services:
 * - llm?: LLMClient - For tools that need to make LLM calls
 * - http?: HttpClient - For tools with network access
 * - memory?: MemoryService - For RAG/embedding tools
 */
export type ToolServices = Record<string, unknown>;

/**
 * Context passed to every tool execution.
 * Provides access to app services and execution metadata.
 */
export interface ToolContext {
  /** The unique ID of this tool call (for result tracking) */
  toolCallId: string;
  /** The conversation this tool is executing within */
  conversationId: string;
  /** Database client for persistence operations */
  db: DBClient;
  /** Entity configuration (project root, etc.) */
  config: EntityConfig;
  /** Additional services for extended functionality */
  services: ToolServices;
}

// =============================================================================
// Tool Metadata Types
// =============================================================================

/**
 * Optional metadata for tool categorization and access control.
 */
export interface ToolMetadata {
  /** Category for grouping related tools */
  category?: "system" | "conversation" | "file" | "network" | "memory";
  /** Capability flags for access control (e.g., ["write", "dangerous"]) */
  capabilities?: string[];
  /** If true, tool execution should prompt user for confirmation */
  requiresConfirmation?: boolean;
}

// =============================================================================
// Tool Executor Types
// =============================================================================

/**
 * A function that executes a tool with the given arguments and context.
 * Arguments are parsed from the JSON string provided in the tool call.
 *
 * @param args - The parsed arguments object
 * @param ctx - The execution context with services and metadata
 * @returns A promise resolving to the tool execution result
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>;

// =============================================================================
// Tool Registration Types
// =============================================================================

/**
 * A complete tool registration entry containing both the definition
 * (sent to the LLM) and the executor (used to run the tool).
 */
export interface Tool {
  /** The tool definition that describes the tool to the LLM */
  definition: ToolDefinition;
  /** The function that executes the tool with context */
  execute: ToolExecutor;
  /** Optional metadata for categorization and access control */
  metadata?: ToolMetadata;
}

// =============================================================================
// Shell Tool Specific Types
// =============================================================================

/**
 * Arguments for the shell tool.
 */
export interface ShellToolArgs {
  /** The shell command to execute */
  command: string;
  /** Optional working directory for the command */
  workingDir?: string;
  /** Optional timeout in milliseconds (default: 30000) */
  timeout?: number;
}
