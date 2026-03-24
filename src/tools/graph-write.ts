/**
 * Graph Write Tools
 *
 * Tools that let me build and maintain my knowledge graph during conversation.
 * I use these to remember people, concepts, emotions, and how they connect.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

// =============================================================================
// Tool Definitions
// =============================================================================

const graphCreateNodeDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_create_node",
    description:
      "Create a node in my knowledge graph. I use this to remember people, emotions, events, preferences, and other concepts. If a node with the same label and type already exists, I get the existing one back instead of creating a duplicate. IMPORTANT: Use first-person perspective - 'me' (type: self) for self-references, 'user' for the person I interact with.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Node type: person, emotion, event, topic, preference, place, goal, health, boundary, tradition, insight, or any custom type",
        },
        label: {
          type: "string",
          description: "Human-readable label (e.g., 'Tyler', 'anxiety', 'hiking')",
        },
        description: {
          type: "string",
          description: "Detailed description of what this node represents",
        },
        confidence: {
          type: "number",
          description: "How certain I am about this knowledge (0-1, default: 0.5)",
        },
      },
      required: ["type", "label"],
    },
  },
};

const graphCreateEdgeDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_create_edge",
    description:
      "Create a relationship between two nodes in my knowledge graph. I use this to connect concepts like 'user loves hiking' or 'meditation helps_with anxiety'. I can use either node IDs or node labels — if I use labels, the tool will look up the IDs for me. IMPORTANT: Use first-person perspective.",
    parameters: {
      type: "object",
      properties: {
        fromId: {
          type: "string",
          description: "Source node ID (if I know it)",
        },
        toId: {
          type: "string",
          description: "Target node ID (if I know it)",
        },
        fromLabel: {
          type: "string",
          description: "Source node label (e.g., 'Tyler') — used to look up the node ID if fromId is not provided",
        },
        toLabel: {
          type: "string",
          description: "Target node label (e.g., 'Thea') — used to look up the node ID if toId is not provided",
        },
        type: {
          type: "string",
          description: "Relationship type — any natural language string (e.g., loves, works_at, values, respects, proud_of, family_of, close_to, interested_in, caused, reminds_of, mentioned_in)",
        },
        weight: {
          type: "number",
          description: "Relationship strength (0-1, default: 0.5)",
        },
        evidence: {
          type: "string",
          description: "Why I believe this relationship exists",
        },
      },
      required: ["type"],
    },
  },
};

const graphUpdateNodeDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_update_node",
    description:
      "Update a node in my knowledge graph. I use this to refine descriptions, adjust confidence, or add properties as I learn more.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The node ID to update",
        },
        label: {
          type: "string",
          description: "Updated label",
        },
        description: {
          type: "string",
          description: "Updated description",
        },
        confidence: {
          type: "number",
          description: "Updated confidence (0-1)",
        },
      },
      required: ["id"],
    },
  },
};

const graphUpdateEdgeDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_update_edge",
    description:
      "Update a relationship in my knowledge graph. I use this to change weights, add evidence, or mark relationships as ended.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The edge ID to update",
        },
        type: {
          type: "string",
          description: "Updated relationship type",
        },
        weight: {
          type: "number",
          description: "Updated weight (0-1)",
        },
        evidence: {
          type: "string",
          description: "Updated evidence for this relationship",
        },
        validUntil: {
          type: "string",
          description: "ISO date when this relationship ends (if applicable)",
        },
      },
      required: ["id"],
    },
  },
};

const graphDeleteNodeDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_delete_node",
    description:
      "Remove a node from my knowledge graph. I use this to clean up test data, remove outdated concepts, or fix mistakes. This is a soft delete — the node is marked as deleted but can be recovered if needed. Any edges connected to this node will also be removed.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The node ID to delete",
        },
      },
      required: ["id"],
    },
  },
};

const graphDeleteEdgeDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_delete_edge",
    description:
      "Remove a relationship from my knowledge graph. I use this to clean up incorrect or outdated connections between concepts.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The edge ID to delete",
        },
      },
      required: ["id"],
    },
  },
};

const graphWriteBatchDef: Tool["definition"] = {
  type: "function",
  function: {
    name: "graph_write_batch",
    description:
      "Create multiple nodes and edges at once. I use this when I learn several related facts and want to record them together. Edges can reference existing nodes by label (like 'me' or 'user'). IMPORTANT: Use first-person perspective.",
    parameters: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["type", "label"],
          },
          description: "Nodes to create",
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fromLabel: { type: "string", description: "Source node label (new or existing)" },
              toLabel: { type: "string", description: "Target node label (new or existing)" },
              type: { type: "string" },
              weight: { type: "number" },
              evidence: { type: "string" },
            },
            required: ["fromLabel", "toLabel", "type"],
          },
          description: "Edges to create (reference nodes by label)",
        },
      },
      required: [],
    },
  },
};

// =============================================================================
// Tool Implementations
// =============================================================================

interface CreateNodeArgs {
  type: string;
  label: string;
  description?: string;
  confidence?: number;
}

async function executeGraphCreateNode(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { type, label, description, confidence } = args as unknown as CreateNodeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot create a graph node - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    // Check for existing node with same label and type (duplicate prevention)
    // Use list endpoint (direct DB query) — semantic search misses nodes without embeddings
    // (e.g., canonical "me"/"user" nodes created server-side by ensureCanonicalNodes)
    const existingByType = await ctx.config.mcpClient.getGraphNodes({ type, limit: 100 });
    const duplicate = existingByType.find(
      (n) => n.label.toLowerCase() === label.toLowerCase()
    );

    if (duplicate) {
      const conf = Math.round(duplicate.confidence * 100);
      return {
        toolCallId: ctx.toolCallId,
        content: `I already have a "${duplicate.label}" (${duplicate.type}) node [${conf}% confidence]. ID: ${duplicate.id}\n\n${duplicate.description || "No description yet."}`,
        isError: false,
      };
    }

    const result = await ctx.config.mcpClient.createGraphNode({
      type,
      label,
      description,
      confidence,
    });

    if (!result.success) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to create node: ${result.error}`,
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `I created a new "${label}" (${type}) node in my knowledge graph. ID: ${result.nodeId}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to create graph node: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface CreateEdgeArgs {
  fromId?: string;
  toId?: string;
  fromLabel?: string;
  toLabel?: string;
  type: string;
  weight?: number;
  evidence?: string;
}

async function executeGraphCreateEdge(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { fromId, toId, fromLabel, toLabel, type, weight, evidence } = args as unknown as CreateEdgeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot create a graph edge - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    // Fetch node list once if we need to resolve any labels
    const needsLabelLookup = (!fromId && fromLabel) || (!toId && toLabel);
    const allNodes = needsLabelLookup
      ? await ctx.config.mcpClient.getGraphNodes({ limit: 500 })
      : [];

    // Resolve source node: use ID if provided, otherwise look up by label
    let resolvedFromId = fromId;
    if (!resolvedFromId && fromLabel) {
      const match = allNodes.find(
        (n) => n.label.toLowerCase() === fromLabel.toLowerCase()
      );
      if (match) {
        resolvedFromId = match.id;
      } else {
        return {
          toolCallId: ctx.toolCallId,
          content: `I couldn't find a node with label "${fromLabel}". I should use graph_search_nodes to find the correct node first, or create it with graph_create_node.`,
          isError: true,
        };
      }
    }

    // Resolve target node: use ID if provided, otherwise look up by label
    let resolvedToId = toId;
    if (!resolvedToId && toLabel) {
      const match = allNodes.find(
        (n) => n.label.toLowerCase() === toLabel.toLowerCase()
      );
      if (match) {
        resolvedToId = match.id;
      } else {
        return {
          toolCallId: ctx.toolCallId,
          content: `I couldn't find a node with label "${toLabel}". I should use graph_search_nodes to find the correct node first, or create it with graph_create_node.`,
          isError: true,
        };
      }
    }

    // Validate we have both IDs
    if (!resolvedFromId || !resolvedToId) {
      const missing = [];
      if (!resolvedFromId) missing.push("fromId or fromLabel");
      if (!resolvedToId) missing.push("toId or toLabel");
      return {
        toolCallId: ctx.toolCallId,
        content: `I need to specify the source and target nodes. Missing: ${missing.join(", ")}. I can use either node IDs (fromId/toId) or node labels (fromLabel/toLabel).`,
        isError: true,
      };
    }

    const result = await ctx.config.mcpClient.createGraphEdge({
      fromId: resolvedFromId,
      toId: resolvedToId,
      type,
      weight,
      evidence,
    });

    if (!result.success) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to create edge: ${result.error}`,
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `I created a "${type}" relationship in my knowledge graph. Edge ID: ${result.edgeId}`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to create graph edge: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface UpdateNodeArgs {
  id: string;
  label?: string;
  description?: string;
  confidence?: number;
}

async function executeGraphUpdateNode(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { id, label, description, confidence } = args as unknown as UpdateNodeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot update a graph node - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const result = await ctx.config.mcpClient.updateGraphNode(id, {
      label,
      description,
      confidence,
      lastConfirmedAt: new Date().toISOString(),
    });

    if (!result.success) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to update node: ${result.error}`,
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `I updated node ${id} in my knowledge graph.`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to update graph node: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface UpdateEdgeArgs {
  id: string;
  type?: string;
  weight?: number;
  evidence?: string;
  validUntil?: string;
}

async function executeGraphUpdateEdge(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { id, type, weight, evidence, validUntil } = args as unknown as UpdateEdgeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot update a graph edge - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const result = await ctx.config.mcpClient.updateGraphEdge(id, {
      type,
      weight,
      evidence,
      validUntil,
      lastConfirmedAt: new Date().toISOString(),
    });

    if (!result.success) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to update edge: ${result.error}`,
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `I updated edge ${id} in my knowledge graph.`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to update graph edge: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface DeleteNodeArgs {
  id: string;
}

async function executeGraphDeleteNode(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { id } = args as unknown as DeleteNodeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot delete a graph node - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    // Look up the node first so we can show its label in the confirmation
    const node = await ctx.config.mcpClient.getGraphNode(id);
    if (!node) {
      return {
        toolCallId: ctx.toolCallId,
        content: `I could not find a node with ID "${id}" in my knowledge graph.`,
        isError: false,
      };
    }

    const result = await ctx.config.mcpClient.deleteGraphNode(id);

    if (!result.success) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to delete node: ${result.error}`,
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `I removed "${node.label}" (${node.type}) from my knowledge graph.`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to delete graph node: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface DeleteEdgeArgs {
  id: string;
}

async function executeGraphDeleteEdge(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { id } = args as unknown as DeleteEdgeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot delete a graph edge - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const result = await ctx.config.mcpClient.deleteGraphEdge(id);

    if (!result.success) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to delete edge: ${result.error}`,
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `I removed edge ${id} from my knowledge graph.`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to delete graph edge: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

interface WriteBatchArgs {
  nodes?: Array<{
    type: string;
    label: string;
    description?: string;
    confidence?: number;
  }>;
  edges?: Array<{
    fromLabel: string;
    toLabel: string;
    type: string;
    weight?: number;
    evidence?: string;
  }>;
}

async function executeGraphWriteBatch(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { nodes, edges } = args as unknown as WriteBatchArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot write to my knowledge graph - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const result = await ctx.config.mcpClient.writeGraphTransaction({ nodes, edges });

    if (!result.success) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Batch write failed: ${result.error}`,
        isError: true,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: `I recorded ${result.nodesCreated} node(s) and ${result.edgesCreated} edge(s) in my knowledge graph.`,
      isError: false,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to write graph batch: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

// =============================================================================
// Tool Exports
// =============================================================================

export const graphCreateNodeTool: Tool = {
  definition: graphCreateNodeDef,
  execute: executeGraphCreateNode,
};

export const graphCreateEdgeTool: Tool = {
  definition: graphCreateEdgeDef,
  execute: executeGraphCreateEdge,
};

export const graphUpdateNodeTool: Tool = {
  definition: graphUpdateNodeDef,
  execute: executeGraphUpdateNode,
};

export const graphUpdateEdgeTool: Tool = {
  definition: graphUpdateEdgeDef,
  execute: executeGraphUpdateEdge,
};

export const graphDeleteNodeTool: Tool = {
  definition: graphDeleteNodeDef,
  execute: executeGraphDeleteNode,
};

export const graphDeleteEdgeTool: Tool = {
  definition: graphDeleteEdgeDef,
  execute: executeGraphDeleteEdge,
};

export const graphWriteBatchTool: Tool = {
  definition: graphWriteBatchDef,
  execute: executeGraphWriteBatch,
};

// All graph write tools
export const graphWriteTools: Tool[] = [
  graphCreateNodeTool,
  graphCreateEdgeTool,
  graphUpdateNodeTool,
  graphUpdateEdgeTool,
  graphDeleteNodeTool,
  graphDeleteEdgeTool,
  graphWriteBatchTool,
];
