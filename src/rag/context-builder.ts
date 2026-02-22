/**
 * Context Builder
 *
 * Formats retrieved memories for injection into the LLM context.
 */

import type { RetrievalResult } from "./types.ts";

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
Relevant Memories:

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
