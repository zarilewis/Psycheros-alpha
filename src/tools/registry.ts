/**
 * Tool Registry
 *
 * Manages registration and execution of tools available to the entity.
 * Provides a central registry for looking up tool definitions and executors.
 */

import type { ToolCall, ToolDefinition, ToolResult } from "../types.ts";
import type { Tool } from "./types.ts";
import { shellTool } from "./shell.ts";

/**
 * Registry for managing available tools.
 *
 * The registry stores tools by name and provides methods for:
 * - Registering new tools
 * - Getting all tool definitions (for LLM requests)
 * - Executing tool calls
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a tool in the registry.
   *
   * @param tool - The tool to register
   * @throws Error if a tool with the same name is already registered
   */
  register(tool: Tool): void {
    const name = tool.definition.function.name;

    if (this.tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered`);
    }

    this.tools.set(name, tool);
  }

  /**
   * Get all tool definitions for sending to the LLM.
   *
   * @returns Array of tool definitions
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  /**
   * Execute a tool call.
   *
   * Parses the arguments from the tool call's JSON string,
   * finds the tool by name, and executes it.
   *
   * @param toolCall - The tool call to execute
   * @returns The result of the tool execution
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const tool = this.tools.get(toolName);

    // Handle unknown tool
    if (!tool) {
      const availableTools = Array.from(this.tools.keys()).join(", ") || "(none)";
      return {
        toolCallId: toolCall.id,
        content: `Error: Unknown tool '${toolName}'. Available tools: ${availableTools}`,
        isError: true,
      };
    }

    // Parse arguments from JSON string
    let args: Record<string, unknown>;
    try {
      const argsString = toolCall.function.arguments;
      args = argsString.trim() === "" ? {} : JSON.parse(argsString);

      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("Arguments must be a JSON object");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: toolCall.id,
        content: `Error parsing tool arguments: ${errorMessage}`,
        isError: true,
      };
    }

    // Pass toolCallId to executor via args (convention: _toolCallId).
    // This allows tools to include the ID in their result without
    // requiring a separate parameter in the Tool interface.
    args._toolCallId = toolCall.id;

    // Execute the tool
    try {
      const result = await tool.execute(args);
      // Ensure the result has the correct toolCallId
      return {
        ...result,
        toolCallId: toolCall.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: toolCall.id,
        content: `Error executing tool '${toolName}': ${errorMessage}`,
        isError: true,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel.
   *
   * @param toolCalls - Array of tool calls to execute
   * @returns Array of tool results in the same order as input
   */
  executeAll(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(toolCalls.map((toolCall) => this.execute(toolCall)));
  }
}

/**
 * Create a registry with the default set of tools.
 *
 * Currently includes:
 * - shell: Execute shell commands
 *
 * @returns A new ToolRegistry with default tools registered
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Register default tools
  registry.register(shellTool);

  return registry;
}
