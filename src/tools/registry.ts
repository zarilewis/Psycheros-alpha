/**
 * Tool Registry
 *
 * Manages registration and execution of tools available to the entity.
 * Provides a central registry for looking up tool definitions and executors.
 */

import type { ToolCall, ToolDefinition, ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { shellTool } from "./shell.ts";
import { updateTitleTool } from "./update_title.ts";
import { getMetricsTool } from "./get_metrics.ts";
import { createSignificantMemoryTool } from "./create-significant-memory.ts";
import { syncMcpTool } from "./sync-mcp.ts";
// Identity tools
import { appendToSelfTool } from "./identity-casual.ts";
import { appendToUserTool } from "./identity-casual.ts";
import { appendToRelationshipTool } from "./identity-casual.ts";
import { maintainIdentityTool } from "./identity-maintain.ts";
import { listIdentitySnapshotsTool } from "./identity-maintain.ts";
// Graph read tools
import {
  graphSearchNodesTool,
  graphGetNodeTool,
  graphGetEdgesTool,
  graphTraverseTool,
  graphGetSubgraphTool,
  graphStatsTool,
} from "./graph-read.ts";
// Graph write tools
import {
  graphCreateNodeTool,
  graphCreateEdgeTool,
  graphUpdateNodeTool,
  graphUpdateEdgeTool,
  graphDeleteNodeTool,
  graphDeleteEdgeTool,
  graphWriteBatchTool,
} from "./graph-write.ts";

// =============================================================================
// Available Tools Catalog
// =============================================================================

/**
 * All tools that can be enabled via the PSYCHEROS_TOOLS environment variable.
 * Each tool is keyed by its name (lowercase).
 */
const AVAILABLE_TOOLS: Record<string, Tool> = {
  shell: shellTool,
  update_title: updateTitleTool,
  get_metrics: getMetricsTool,
  create_significant_memory: createSignificantMemoryTool,
  sync_mcp: syncMcpTool,
  // Tier 1: Casual identity tools (append-only, safe for everyday use)
  append_to_self: appendToSelfTool,
  append_to_user: appendToUserTool,
  append_to_relationship: appendToRelationshipTool,
  // Tier 2: Maintenance tools (full suite for intentional reorganization)
  maintain_identity: maintainIdentityTool,
  list_identity_snapshots: listIdentitySnapshotsTool,
  // Graph read tools (query the knowledge graph)
  graph_search_nodes: graphSearchNodesTool,
  graph_get_node: graphGetNodeTool,
  graph_get_edges: graphGetEdgesTool,
  graph_traverse: graphTraverseTool,
  graph_get_subgraph: graphGetSubgraphTool,
  graph_stats: graphStatsTool,
  // Graph write tools (build and maintain the knowledge graph)
  graph_create_node: graphCreateNodeTool,
  graph_create_edge: graphCreateEdgeTool,
  graph_update_node: graphUpdateNodeTool,
  graph_update_edge: graphUpdateEdgeTool,
  graph_delete_node: graphDeleteNodeTool,
  graph_delete_edge: graphDeleteEdgeTool,
  graph_write_batch: graphWriteBatchTool,
};

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
   * Execute a tool call with the given context.
   *
   * Parses the arguments from the tool call's JSON string,
   * finds the tool by name, and executes it with context.
   *
   * @param toolCall - The tool call to execute
   * @param baseContext - The execution context (without toolCallId, which is added automatically)
   * @returns The result of the tool execution
   */
  async execute(
    toolCall: ToolCall,
    baseContext: Omit<ToolContext, "toolCallId">
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const tool = this.tools.get(toolName);

    // Build complete context with toolCallId
    const ctx: ToolContext = {
      ...baseContext,
      toolCallId: toolCall.id,
    };

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

    // Execute the tool with context
    try {
      const result = await tool.execute(args, ctx);
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
   * @param baseContext - The execution context (toolCallId added per-call)
   * @returns Array of tool results in the same order as input
   */
  executeAll(
    toolCalls: ToolCall[],
    baseContext: Omit<ToolContext, "toolCallId">
  ): Promise<ToolResult[]> {
    return Promise.all(
      toolCalls.map((toolCall) => this.execute(toolCall, baseContext))
    );
  }
}

/**
 * Create a registry with only the specified tools enabled.
 *
 * @param allowedTools - Array of tool names to enable. Special values:
 *   - ["all"] or including "all": enable all available tools (default)
 *   - ["none"] or empty array: no tools enabled
 *   - ["tool1", "tool2"]: enable specific tools only
 * @returns A new ToolRegistry with only allowed tools registered
 *
 * @example
 * ```typescript
 * // Enable all tools (default)
 * const registry = createDefaultRegistry(["all"]);
 *
 * // Enable only shell tool
 * const registry = createDefaultRegistry(["shell"]);
 *
 * // No tools enabled
 * const registry = createDefaultRegistry(["none"]);
 * ```
 */
export function createDefaultRegistry(allowedTools: string[] = ["all"]): ToolRegistry {
  const registry = new ToolRegistry();

  // Normalize tool names to lowercase for matching
  const normalizedAllowed = new Set(allowedTools.map((t) => t.toLowerCase()));

  // Handle special "none" value
  if (normalizedAllowed.has("none")) {
    return registry;
  }

  // If "all" is specified, enable all available tools
  if (normalizedAllowed.has("all")) {
    for (const tool of Object.values(AVAILABLE_TOOLS)) {
      registry.register(tool);
    }
    return registry;
  }

  // Register only specified tools
  for (const toolName of normalizedAllowed) {
    const tool = AVAILABLE_TOOLS[toolName];
    if (tool) {
      registry.register(tool);
    } else {
      console.warn(
        `Warning: Unknown tool '${toolName}' in PSYCHEROS_TOOLS. ` +
          `Available tools: ${Object.keys(AVAILABLE_TOOLS).join(", ")}`
      );
    }
  }

  return registry;
}
