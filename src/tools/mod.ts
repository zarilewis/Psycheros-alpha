/**
 * Tools Module
 *
 * This module provides the tool execution system for the SBy entity.
 * Tools enable the entity to perform actions like executing shell commands,
 * file operations, and other system interactions.
 *
 * @module
 *
 * @example
 * ```typescript
 * import { createDefaultRegistry } from "./tools/mod.ts";
 *
 * const registry = createDefaultRegistry();
 *
 * // Get definitions for LLM
 * const definitions = registry.getDefinitions();
 *
 * // Execute a tool call from LLM response
 * const result = await registry.execute({
 *   id: "call_123",
 *   type: "function",
 *   function: {
 *     name: "shell",
 *     arguments: JSON.stringify({ command: "echo hello" })
 *   }
 * });
 * ```
 */

// Re-export types
export type { Tool, ToolExecutor, ShellToolArgs } from "./types.ts";

// Re-export registry
export { ToolRegistry, createDefaultRegistry } from "./registry.ts";

// Re-export individual tools
export { shellTool } from "./shell.ts";
