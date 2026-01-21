/**
 * Tool-Specific Type Definitions
 *
 * Types for the tool execution system that extends the shared types
 * from src/types.ts.
 */

import type { ToolDefinition, ToolResult } from "../types.ts";

// =============================================================================
// Tool Executor Types
// =============================================================================

/**
 * A function that executes a tool with the given arguments.
 * Arguments are parsed from the JSON string provided in the tool call.
 *
 * @param args - The parsed arguments object
 * @returns A promise resolving to the tool execution result
 */
export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult>;

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
  /** The function that executes the tool */
  execute: ToolExecutor;
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
