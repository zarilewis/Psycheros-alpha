/**
 * Memory Retriever
 *
 * Retrieves relevant memory chunks using sqlite-vec for vector similarity search.
 * Falls back to in-memory cosine similarity if sqlite-vec is not available.
 */

import type { Database } from "@db/sqlite";
import type { Retriever, RetrievalResult, Chunk, RAGConfig, ChunkMetadata } from "./types.ts";
import { DEFAULT_RAG_CONFIG } from "./types.ts";
import { getEmbedder } from "./embedder.ts";
import { getVecVersion, serializeVector, deserializeVector } from "../db/vector.ts";

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
 * Row type for vector search join result.
 */
interface VectorSearchRow {
  id: string;
  content: string;
  source_file: string;
  token_count: number;
  metadata: string | null;
  created_at: string;
  distance: number;
}

/**
 * Convert buffer to embedding array.
 * Handles both ArrayBuffer and Uint8Array from database.
 */
function bufferToEmbedding(buffer: ArrayBuffer | Uint8Array | null): number[] | null {
  if (!buffer) return null;
  return deserializeVector(buffer);
}

/**
 * Calculate cosine similarity between two vectors.
 * Used as fallback when sqlite-vec is not available.
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
 * Check if sqlite-vec is available.
 */
function isVectorExtensionAvailable(db: Database): boolean {
  return getVecVersion(db) !== null;
}

/**
 * Memory retriever using sqlite-vec for efficient vector similarity search.
 */
export class MemoryRetriever implements Retriever {
  private readonly db: Database;
  private readonly config: RAGConfig;
  private readonly useVectorExt: boolean;

  constructor(db: Database, config: Partial<RAGConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_RAG_CONFIG, ...config };
    this.useVectorExt = isVectorExtensionAvailable(db);
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

    // Use sqlite-vec if available, otherwise fall back to in-memory
    if (this.useVectorExt) {
      return this.retrieveWithVectorExt(queryEmbedding, config);
    } else {
      return Promise.resolve(this.retrieveInMemory(queryEmbedding, config));
    }
  }

  /**
   * Retrieve using sqlite-vec extension for efficient vector search.
   */
  private retrieveWithVectorExt(
    queryEmbedding: number[],
    config: RAGConfig
  ): RetrievalResult[] {
    const serialized = serializeVector(queryEmbedding);
    const limit = config.maxChunks * 2;

    // Use subquery to apply LIMIT directly to vec0 query (required by sqlite-vec)
    const stmt = this.db.prepare(
      `SELECT m.id, m.content, m.source_file, m.token_count, m.metadata, m.created_at, v.distance
       FROM (
         SELECT rowid, distance
         FROM vec_memory_chunks
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?
       ) v
       JOIN memory_chunks m ON m.rowid = v.rowid
       ORDER BY v.distance`
    );

    const rows = stmt.all<VectorSearchRow>(serialized, limit);
    stmt.finalize();

    const instanceBoost = config.instanceBoost ?? 0.1;
    const results: RetrievalResult[] = [];

    for (const row of rows) {
      // sqlite-vec cosine distance: 1 - similarity, so convert back
      const similarity = 1 - row.distance;
      let score = similarity;

      // Apply instance boost if configured
      const metadata = row.metadata ? JSON.parse(row.metadata) as ChunkMetadata : undefined;
      if (config.currentInstance && metadata?.sourceInstance === config.currentInstance) {
        score = Math.min(score + instanceBoost, 1.0);
      }

      if (score >= config.minScore) {
        results.push({
          chunk: {
            id: row.id,
            content: row.content,
            sourceFile: row.source_file,
            tokenCount: row.token_count,
            metadata,
            createdAt: new Date(row.created_at),
          },
          score,
        });
      }
    }

    // Apply token budget
    return this.applyTokenBudget(results, config);
  }

  /**
   * Retrieve using in-memory cosine similarity (fallback).
   */
  private retrieveInMemory(
    queryEmbedding: number[],
    config: RAGConfig
  ): RetrievalResult[] {
    // Load all chunks with embeddings
    const chunks = this.loadAllChunks();

    if (chunks.length === 0) {
      return [];
    }

    // Calculate similarity scores with instance boost
    const results: RetrievalResult[] = [];
    const instanceBoost = config.instanceBoost ?? 0.1;

    for (const chunk of chunks) {
      if (!chunk.embedding) continue;

      let score = cosineSimilarity(queryEmbedding, chunk.embedding);

      // Apply instance boost if configured
      if (config.currentInstance && chunk.metadata?.sourceInstance === config.currentInstance) {
        score = Math.min(score + instanceBoost, 1.0); // Cap at 1.0
      }

      // Filter by minimum score
      if (score >= config.minScore) {
        results.push({ chunk, score });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return this.applyTokenBudget(results, config);
  }

  /**
   * Apply token budget to results.
   */
  private applyTokenBudget(results: RetrievalResult[], config: RAGConfig): RetrievalResult[] {
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
      `[RAG] Retrieved ${selectedResults.length} chunks (score >= ${config.minScore})${this.useVectorExt ? " [sqlite-vec]" : " [in-memory]"}`
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
