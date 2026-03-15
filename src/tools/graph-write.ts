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
      "Create a relationship between two nodes in my knowledge graph. I use this to connect concepts like 'user loves hiking' or 'meditation helps_with anxiety'. IMPORTANT: Use first-person perspective.",
    parameters: {
      type: "object",
      properties: {
        fromId: {
          type: "string",
          description: "Source node ID (use graph_search_nodes to find IDs)",
        },
        toId: {
          type: "string",
          description: "Target node ID",
        },
        type: {
          type: "string",
          description: "Relationship type: feels_about, close_to, mentions, helps_with, worsens, loves, dislikes, avoids, seeks, family_of, friend_of, reminds_of, or any custom type",
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
      required: ["fromId", "toId", "type"],
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
    const existing = await ctx.config.mcpClient.searchGraphNodes(label, type, 5, 0.8);
    const duplicate = existing.find(
      (n) => n.label.toLowerCase() === label.toLowerCase() && n.type === type
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
  fromId: string;
  toId: string;
  type: string;
  weight?: number;
  evidence?: string;
}

async function executeGraphCreateEdge(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { fromId, toId, type, weight, evidence } = args as unknown as CreateEdgeArgs;

  if (!ctx.config.mcpClient) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I cannot create a graph edge - MCP connection to entity-core is not available.",
      isError: true,
    };
  }

  try {
    const result = await ctx.config.mcpClient.createGraphEdge({
      fromId,
      toId,
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
  graphWriteBatchTool,
];
