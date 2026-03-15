/**
 * Graph Read Tools
 *
 * Read-only tools for querying the knowledge graph.
 * The entity uses these to search and traverse, and get context from the graph
 * but cannot modify it.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

// =============================================================================
// Tool Definitions
// =============================================================================

const graphSearchNodesDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_search_nodes",
    description:
      "Search my knowledge graph for relevant nodes. I use this to find people, topics, emotions, and other concepts I've learned about. Returns nodes with their types, labels, descriptions, and relevance scores.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query (e.g., 'work stress', 'hobbies', 'family')",
        },
        type: {
          type: "string",
          description: "Optional filter by node type (person, emotion, topic, event, preference, place, goal, health, boundary, tradition, insight)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
      },
      required: ["query"],
    },
  },
};

const graphGetNodeDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_get_node",
    description:
      "Get a specific node from my knowledge graph by its ID. Returns full node details including type, label, description, and confidence.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The node ID to retrieve",
        },
      },
      required: ["id"],
    },
  },
};

const graphGetEdgesDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_get_edges",
    description:
      "Get relationships (edges) from my knowledge graph. Can filter by source/target nodes or relationship type. Returns edges with their types, weights, and evidence.",
    parameters: {
      type: "object",
      properties: {
        fromId: {
          type: "string",
          description: "Optional filter by source node ID",
        },
        toId: {
          type: "string",
          description: "Optional filter by target node ID",
        },
        type: {
          type: "string",
          description: "Optional filter by relationship type (feels_about, close_to, mentions, helps_with, worsens, etc.)",
        },
      },
      required: [],
    },
  },
};

const graphTraverseDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_traverse",
    description:
      "Traverse my knowledge graph starting from a node. I use this to find related concepts and understand how things connect. Returns connected nodes with their relationship paths.",
    parameters: {
      type: "object",
      properties: {
        startNodeId: {
          type: "string",
          description: "The node ID to start traversal from",
        },
        direction: {
          type: "string",
          enum: ["out", "in", "both"],
          description: "Direction to traverse: out (from node), in (to node), or both (default: both)",
        },
        maxDepth: {
          type: "number",
          description: "Maximum depth to traverse (default: 2, max: 5)",
        },
        edgeTypes: {
          type: "array",
          items: { type: "string" },
          description: "Optional filter by edge types to follow",
        },
      },
      required: ["startNodeId"],
    },
  },
};

const graphGetSubgraphDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_get_subgraph",
    description:
      "Extract a subgraph centered on a node. I use this to get the full context around a concept, including all connected nodes and edges.",
    parameters: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "The node ID to center the subgraph on",
        },
      },
      required: ["nodeId"],
    },
  },
};

const graphStatsDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_stats",
    description:
      "Get statistics about my knowledge graph. Returns total nodes, edges, breakdown by type, and vector search availability.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// =============================================================================
// Tool Implementations
// =============================================================================

interface GraphSearchNodesArgs {
  query: string;
  type?: string;
  limit?: number;
}

async function executeGraphSearchNodes(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { query, type, limit = 10 } = args as unknown as GraphSearchNodesArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot search my knowledge graph - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const results = await ctx.config.mcpClient.searchGraphNodes(query, type, limit);

    if (results.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: `I searched my knowledge graph for "${query}" but found no matching nodes.`,
        isError: false,
      };
    }

    const formatted = results.map((r) => {
      const relevance = Math.round(r.score * 100);
      return `- **${r.label}** (${r.type}) [${relevance}% relevant]\n  ${r.description || "No description"}`;
    }).join("\n\n");

    return {
      toolCallId: ctx.toolCallId,
      content: `I found ${results.length} nodes matching "${query}":\n\n${formatted}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to search knowledge graph: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface GraphGetNodeArgs {
  id: string;
}

async function executeGraphGetNode(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { id } = args as unknown as GraphGetNodeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot get node from my knowledge graph - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const node = await ctx.config.mcpClient.getGraphNode(id);

    if (!node) {
      return {
        toolCallId: ctx.toolCallId,
        content: `I could not find a node with ID "${id}" in my knowledge graph.`,
        isError: false,
      };
    }

    const confidence = Math.round(node.confidence * 100);
    return {
      toolCallId: ctx.toolCallId,
      content: `**${node.label}** (${node.type}) [${confidence}% confidence]\n\n${node.description || "No description"}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to get node: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface GraphGetEdgesArgs {
  fromId?: string;
  toId?: string;
  type?: string;
}

async function executeGraphGetEdges(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { fromId, toId, type } = args as GraphGetEdgesArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot get edges from my knowledge graph - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const edges = await ctx.config.mcpClient.getGraphEdges({ fromId, toId, type });

    if (edges.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: "I found no relationships matching those criteria.",
        isError: false,
      };
    }

    const formatted = edges.map((e) => {
      const weight = Math.round(e.weight * 100);
      const relType = e.customType || e.type;
      return `- ${e.fromId} --[${relType}]--> ${e.toId} [${weight}%]`;
    }).join("\n");

    return {
      toolCallId: ctx.toolCallId,
      content: `I found ${edges.length} relationships:\n\n${formatted}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to get edges: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface GraphTraverseArgs {
  startNodeId: string;
  direction?: "out" | "in" | "both";
  maxDepth?: number;
  edgeTypes?: string[];
}

async function executeGraphTraverse(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { startNodeId, direction = "both", maxDepth = 2, edgeTypes } = args as unknown as GraphTraverseArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot traverse my knowledge graph - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const result = await ctx.config.mcpClient.traverseGraph(startNodeId, direction, maxDepth, edgeTypes);

    if (result.results.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: `I found no connected nodes starting from "${startNodeId}".`,
        isError: false,
      };
    }

    const formatted = result.results.map((r) => {
      const depth = "  ".repeat(r.depth);
      return `${depth}- **${r.node.label}** (${r.node.type}) at depth ${r.depth}`;
    }).join("\n");

    const startLabel = result.startNode?.label || startNodeId;
    return {
      toolCallId: ctx.toolCallId,
      content: `Starting from **${startLabel}**, I found ${result.results.length} connected nodes:\n\n${formatted}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to traverse graph: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface GraphGetSubgraphArgs {
  nodeId: string;
}

async function executeGraphGetSubgraph(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { nodeId } = args as unknown as GraphGetSubgraphArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot get subgraph from my knowledge graph - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const subgraph = await ctx.config.mcpClient.getGraphSubgraph(nodeId);

    if (!subgraph.nodes || subgraph.nodes.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: `I could not find a subgraph around node "${nodeId}".`,
        isError: false,
      };
    }

    const nodesFormatted = subgraph.nodes.map((n) => {
      return `- **${n.label}** (${n.type})`;
    }).join("\n");

    const edgesFormatted = subgraph.edges && subgraph.edges.length > 0
      ? "\n\nRelationships:\n" + subgraph.edges.map((e) => {
          const relType = e.customType || e.type;
          const fromNode = subgraph.nodes.find((n) => n.id === e.fromId);
          const toNode = subgraph.nodes.find((n) => n.id === e.toId);
          return `- **${fromNode?.label || e.fromId}** → *${relType}* → **${toNode?.label || e.toId}**`;
        }).join("\n")
      : "";

    return {
      toolCallId: ctx.toolCallId,
      content: `Subgraph with ${subgraph.nodes.length} nodes:\n\n${nodesFormatted}${edgesFormatted}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to get subgraph: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function executeGraphStats(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot get graph stats - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const stats = await ctx.config.mcpClient.getGraphStats();

    if (!stats) {
      return {
        toolCallId: ctx.toolCallId,
        content: "I could not retrieve graph statistics.",
        isError: false,
      };
    }

    const byType = Object.entries(stats.nodesByType || {})
      .map(([type, count]) => `- ${type}: ${count}`)
      .join("\n");

    const byEdge = Object.entries(stats.edgesByType || {})
      .map(([type, count]) => `- ${type}: ${count}`)
      .join("\n");

    return {
      toolCallId: ctx.toolCallId,
      content: `**Knowledge Graph Statistics**

Total nodes: ${stats.totalNodes || 0}
Total edges: ${stats.totalEdges || 0}

Nodes by type:
${byType || "- No nodes yet"}

Edges by type:
${byEdge || "- No edges yet"}

Vector search: ${stats.vectorSearchAvailable ? "Available" : "Not available"}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to get graph stats: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

// =============================================================================
// Tool Exports
// =============================================================================

export const graphSearchNodesTool: Tool = {
  definition: graphSearchNodesDef,
  execute: executeGraphSearchNodes,
};

export const graphGetNodeTool: Tool = {
  definition: graphGetNodeDef,
  execute: executeGraphGetNode,
};

export const graphGetEdgesTool: Tool = {
  definition: graphGetEdgesDef,
  execute: executeGraphGetEdges,
};

export const graphTraverseTool: Tool = {
  definition: graphTraverseDef,
  execute: executeGraphTraverse,
};

export const graphGetSubgraphTool: Tool = {
  definition: graphGetSubgraphDef,
  execute: executeGraphGetSubgraph,
};

export const graphStatsTool: Tool = {
  definition: graphStatsDef,
  execute: executeGraphStats,
};

// All graph read tools
export const graphReadTools: Tool[] = [
  graphSearchNodesTool,
  graphGetNodeTool,
  graphGetEdgesTool,
  graphTraverseTool,
  graphGetSubgraphTool,
  graphStatsTool,
];
