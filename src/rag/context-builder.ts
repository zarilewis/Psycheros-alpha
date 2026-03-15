/**
 * Context Builder
 *
 * Formats retrieved memories and graph context for injection into the LLM context.
 */

import type { RetrievalResult } from "./types.ts";
import type { MCPClient } from "../mcp-client/mod.ts";

/**
 * Format retrieved memory chunks into a context section.
 *
 * @param results - The retrieval results to format
 * @returns Formatted string for inclusion in system message
 */
export function formatMemories(results: RetrievalResult[]): string {
  if (results.length === 0) {
    return "";
  }

  const sections = results.map((result, index) => {
    const score = (result.score * 100).toFixed(0);
    const source = result.chunk.sourceFile;
    return `[${index + 1}] (from ${source}, ${score}% relevant)\n${result.chunk.content}`;
  });

  return `

---
Relevant Memories via RAG:

${sections.join("\n\n")}`;
}

/**
 * Build a RAG context section from retrieved results.
 * Returns empty string if no results.
 *
 * @param results - The retrieval results
 * @returns Formatted context string or empty string
 */
export function buildRAGContext(results: RetrievalResult[]): string {
  return formatMemories(results);
}

/**
 * Options for building graph context.
 */
export interface BuildGraphContextOptions {
  /** Maximum nodes to include */
  maxNodes?: number;
  /** Minimum similarity score for node search (0-1) */
  minScore?: number;
  /** Include connected nodes via traversal */
  includeRelated?: boolean;
  /** Maximum traversal depth when including related nodes */
  traversalDepth?: number;
}

/**
 * Result of building graph context.
 */
export interface GraphContextResult {
  /** Formatted context string */
  context: string;
  /** Number of nodes included */
  nodeCount: number;
  /** Number of edges/relationships included */
  edgeCount: number;
}

/**
 * Build a knowledge graph context section from a query.
 * Searches for relevant nodes and optionally traverses to find connected concepts.
 *
 * @param query - The search query
 * @param mcpClient - The MCP client for entity-core connection
 * @param options - Build options
 * @returns Formatted graph context or empty result if no matches
 */
export async function buildGraphContext(
  query: string,
  mcpClient: MCPClient,
  options: BuildGraphContextOptions = {}
): Promise<GraphContextResult> {
  const {
    maxNodes = 10,
    minScore = 0.3,
    includeRelated = true,
    traversalDepth = 1,
  } = options;

  const emptyResult = { context: "", nodeCount: 0, edgeCount: 0 };

  try {
    // Search for nodes matching the query
    const searchResults = await mcpClient.searchGraphNodes(
      query,
      undefined, // no type filter
      maxNodes,
      minScore
    );

    if (searchResults.length === 0) {
      return emptyResult;
    }

    // Collect all nodes and edges
    const nodesById = new Map<string, typeof searchResults[0]>();
    const allEdges: Array<{
      id: string;
      fromId: string;
      toId: string;
      type: string;
      customType?: string;
      weight: number;
    }> = [];

    // Add search results to nodes
    for (const node of searchResults) {
      nodesById.set(node.id, node);
    }

    // Optionally traverse to find related nodes
    if (includeRelated) {
      for (const node of searchResults.slice(0, 3)) { // Limit traversal to top 3
        const subgraph = await mcpClient.getGraphSubgraph(node.id, traversalDepth);

        // Add related nodes
        for (const relatedNode of subgraph.nodes) {
          if (!nodesById.has(relatedNode.id)) {
            nodesById.set(relatedNode.id, {
              id: relatedNode.id,
              type: relatedNode.type,
              label: relatedNode.label,
              description: relatedNode.description || "",
              confidence: 0.5,
              createdAt: "",
              updatedAt: "",
              score: 0, // Related nodes don't have search scores
            });
          }
        }

        // Add edges
        for (const edge of subgraph.edges) {
          if (!allEdges.find(e => e.id === edge.id)) {
            allEdges.push(edge);
          }
        }
      }
    }

    // Include connected nodes referenced by edges but not yet in results
    for (const edge of allEdges) {
      for (const refId of [edge.fromId, edge.toId]) {
        if (!nodesById.has(refId)) {
          try {
            const node = await mcpClient.getGraphNode(refId);
            if (node) {
              nodesById.set(node.id, {
                id: node.id,
                type: node.type,
                label: node.label,
                description: node.description || "",
                confidence: node.confidence,
                createdAt: "",
                updatedAt: "",
                score: 0,
              });
            }
          } catch {
            // Skip if lookup fails
          }
        }
      }
    }

    // Format the context
    const nodesArray = Array.from(nodesById.values());
    const context = formatGraphContext(nodesArray, allEdges);

    return {
      context,
      nodeCount: nodesArray.length,
      edgeCount: allEdges.length,
    };
  } catch (error) {
    console.error("[RAG] Failed to build graph context:", error);
    return emptyResult;
  }
}

/**
 * Format graph nodes and edges into a context section.
 */
function formatGraphContext(
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    description: string;
    confidence: number;
    score: number;
  }>,
  edges: Array<{
    fromId: string;
    toId: string;
    type: string;
    customType?: string;
    weight: number;
  }>
): string {
  if (nodes.length === 0) {
    return "";
  }

  // Build a map for quick label lookup
  const nodeLabels = new Map<string, string>();
  for (const node of nodes) {
    nodeLabels.set(node.id, node.label);
  }

  // Format nodes
  const nodeSections = nodes.map((node, index) => {
    const parts = [`[${index + 1}] ${node.label} (${node.type})`];
    if (node.description) {
      parts.push(`    ${node.description}`);
    }
    const confidence = (node.confidence * 100).toFixed(0);
    parts.push(`    Confidence: ${confidence}%`);
    if (node.score > 0) {
      const relevance = (node.score * 100).toFixed(0);
      parts.push(`    Relevance: ${relevance}%`);
    }
    return parts.join("\n");
  });

  // Format edges as relationships
  const relationships: string[] = [];
  for (const edge of edges) {
    const fromLabel = nodeLabels.get(edge.fromId) || "Unknown";
    const toLabel = nodeLabels.get(edge.toId) || "Unknown";
    const relType = edge.customType || edge.type;
    const weight = (edge.weight * 100).toFixed(0);
    relationships.push(`  ${fromLabel} --[${relType}]--> ${toLabel} (${weight}%)`);
  }

  let context = `

---
Relevant Knowledge from Graph:

## Entities
${nodeSections.join("\n")}`;

  if (relationships.length > 0) {
    context += `

## Relationships
${relationships.join("\n")}`;
  }

  return context;
}
