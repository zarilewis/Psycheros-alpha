/**
 * Memory Retriever
 *
 * Retrieves relevant memory chunks using cosine similarity search.
 */

import type { Database } from "@db/sqlite";
import type { Retriever, RetrievalResult, Chunk, RAGConfig, ChunkMetadata } from "./types.ts";
import { DEFAULT_RAG_CONFIG } from "./types.ts";
import { getEmbedder } from "./embedder.ts";

/**
 * Row type for memory_chunks table.
 */
interface MemoryChunkRow {
  id: string;
  content: string;
  source_file: string;
  token_count: number;
  metadata: string | null;
  embedding: Uint8Array | null;
  created_at: string;
}

/**
 * Convert buffer to embedding array.
 * Handles both ArrayBuffer and Uint8Array from database.
 */
function bufferToEmbedding(buffer: ArrayBuffer | Uint8Array | null): number[] | null {
  if (!buffer) return null;
  // If it's a Uint8Array, get the underlying ArrayBuffer
  const arrayBuffer = buffer instanceof Uint8Array ? buffer.buffer : buffer;
  const view = new Float32Array(arrayBuffer);
  return Array.from(view);
}

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same dimension");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Memory retriever using cosine similarity search.
 */
export class MemoryRetriever implements Retriever {
  private readonly db: Database;
  private readonly config: RAGConfig;

  constructor(db: Database, config: Partial<RAGConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_RAG_CONFIG, ...config };
  }

  /**
   * Retrieve relevant chunks for a query.
   *
   * @param query - The query text
   * @param configOverride - Optional config overrides
   * @returns Array of retrieval results sorted by relevance
   */
  async retrieve(
    query: string,
    configOverride: Partial<RAGConfig> = {}
  ): Promise<RetrievalResult[]> {
    const config = { ...this.config, ...configOverride };

    if (!config.enabled) {
      return [];
    }

    // Get embedder and generate query embedding
    const embedder = getEmbedder();
    await embedder.initialize();
    const queryEmbedding = await embedder.embed(query);

    // Load all chunks with embeddings
    const chunks = this.loadAllChunks();

    if (chunks.length === 0) {
      return [];
    }

    // Calculate similarity scores
    const results: RetrievalResult[] = [];
    for (const chunk of chunks) {
      if (!chunk.embedding) continue;

      const score = cosineSimilarity(queryEmbedding, chunk.embedding);

      // Filter by minimum score
      if (score >= config.minScore) {
        results.push({ chunk, score });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Apply token budget
    const selectedResults: RetrievalResult[] = [];
    let totalTokens = 0;

    for (const result of results) {
      if (selectedResults.length >= config.maxChunks) {
        break;
      }

      if (totalTokens + result.chunk.tokenCount <= config.maxTokens) {
        selectedResults.push(result);
        totalTokens += result.chunk.tokenCount;
      }
    }

    console.log(
      `[RAG] Retrieved ${selectedResults.length} chunks (score >= ${config.minScore})`
    );

    return selectedResults;
  }

  /**
   * Load all chunks from the database.
   */
  private loadAllChunks(): (Chunk & { embedding: number[] | null })[] {
    const stmt = this.db.prepare(
      `SELECT id, content, source_file, token_count, metadata, embedding, created_at
       FROM memory_chunks`
    );

    const rows = stmt.all<MemoryChunkRow>();
    stmt.finalize();

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      sourceFile: row.source_file,
      tokenCount: row.token_count,
      metadata: row.metadata ? JSON.parse(row.metadata) as ChunkMetadata : undefined,
      createdAt: new Date(row.created_at),
      embedding: bufferToEmbedding(row.embedding),
    }));
  }
}

/**
 * Create a memory retriever instance.
 */
export function createRetriever(
  db: Database,
  config: Partial<RAGConfig> = {}
): MemoryRetriever {
  return new MemoryRetriever(db, config);
}
