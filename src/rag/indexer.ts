/**
 * Memory Indexer
 *
 * Scans the memories/ directory, chunks content, generates embeddings,
 * and stores everything in the database for retrieval.
 */

import { join, relative } from "@std/path";
import type { Database } from "@db/sqlite";
import type { Indexer, Chunk } from "./types.ts";
import { getEmbedder } from "./embedder.ts";
import { getChunker } from "./chunker.ts";
import { serializeVector, getVecVersion } from "../db/vector.ts";

/**
 * Hash content using SHA-256.
 */
async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert embedding array to Uint8Array for storage.
 */
function embeddingToUint8Array(embedding: number[]): Uint8Array {
  return serializeVector(embedding);
}

/**
 * Check if sqlite-vec is available.
 */
function isVectorExtensionAvailable(db: Database): boolean {
  return getVecVersion(db) !== null;
}

/**
 * Row type for indexed_memories table.
 */
interface IndexedMemoryRow {
  path: string;
  content_hash: string;
  chunk_count: number;
  indexed_at: string;
}

/**
 * Memory indexer that scans files and stores chunks with embeddings.
 */
export class MemoryIndexer implements Indexer {
  private readonly db: Database;
  private readonly memoriesDir: string;
  private readonly useVectorExt: boolean;

  constructor(db: Database, memoriesDir: string) {
    this.db = db;
    this.memoriesDir = memoriesDir;
    this.useVectorExt = isVectorExtensionAvailable(db);
  }

  /**
   * Index all memory files in the memories directory.
   */
  async indexAll(): Promise<void> {
    console.log("[RAG] Starting memory indexing...");

    // Get embedder and ensure it's initialized
    const embedder = getEmbedder();
    await embedder.initialize();

    const chunker = getChunker();

    // Find all markdown files
    const files = await this.findMarkdownFiles();
    console.log(`[RAG] Found ${files.length} memory files`);

    let newChunks = 0;
    let skippedFiles = 0;

    for (const filePath of files) {
      const relativePath = relative(this.memoriesDir, filePath);

      // Check if file needs reindexing
      const needsReindex = await this.needsReindex(filePath);
      if (!needsReindex) {
        skippedFiles++;
        continue;
      }

      console.log(`[RAG] Indexing: ${relativePath}`);

      // Remove old chunks for this file
      this.removeFile(relativePath);

      // Read and chunk file
      const content = await Deno.readTextFile(filePath);
      const chunks = chunker.chunk(content, relativePath);

      // Generate embeddings and store chunks
      for (const chunk of chunks) {
        const embedding = await embedder.embed(chunk.content);
        this.storeChunk(chunk, embedding);
        newChunks++;
      }

      // Mark file as indexed
      const contentHash = await hashContent(content);
      this.markFileIndexed(relativePath, contentHash, chunks.length);
    }

    console.log(
      `[RAG] Indexing complete: ${newChunks} new chunks, ${skippedFiles} files unchanged`
    );
  }

  /**
   * Reindex a single memory file.
   * Efficient — only processes the one changed file.
   */
  async reindexFile(relativePath: string): Promise<void> {
    const filePath = join(this.memoriesDir, relativePath);

    console.log(`[RAG] Reindexing: ${relativePath}`);

    // Remove old chunks for this file
    this.removeFile(relativePath);

    // Read and chunk file
    const content = await Deno.readTextFile(filePath);
    const chunker = getChunker();
    const embedder = getEmbedder();
    await embedder.initialize();

    const chunks = chunker.chunk(content, relativePath);

    // Generate embeddings and store chunks
    for (const chunk of chunks) {
      const embedding = await embedder.embed(chunk.content);
      this.storeChunk(chunk, embedding);
    }

    // Mark file as indexed
    const contentHash = await hashContent(content);
    this.markFileIndexed(relativePath, contentHash, chunks.length);

    console.log(`[RAG] Reindexed ${relativePath}: ${chunks.length} chunks`);
  }

  /**
   * Check if a file needs to be reindexed.
   */
  async needsReindex(filePath: string): Promise<boolean> {
    const relativePath = relative(this.memoriesDir, filePath);

    // Get current file hash
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      // File doesn't exist or can't be read
      return false;
    }

    const currentHash = await hashContent(content);

    // Check against stored hash
    const stmt = this.db.prepare(
      "SELECT content_hash FROM indexed_memories WHERE path = ?"
    );
    const row = stmt.get<IndexedMemoryRow>(relativePath);
    stmt.finalize();

    if (!row) {
      // File not indexed yet
      return true;
    }

    // Compare hashes
    return row.content_hash !== currentHash;
  }

  /**
   * Remove all indexed data for a file.
   * Also removes from vec_memory_chunks if sqlite-vec is available.
   */
  removeFile(relativePath: string): void {
    // Get rowids before deleting (for vector table cleanup)
    if (this.useVectorExt) {
      const stmt = this.db.prepare("SELECT rowid FROM memory_chunks WHERE source_file = ?");
      const rows = stmt.all<{ rowid: number }>(relativePath);
      stmt.finalize();

      for (const row of rows) {
        this.db.exec("DELETE FROM vec_memory_chunks WHERE rowid = ?", [row.rowid]);
      }
    }

    // Delete chunks
    this.db.exec("DELETE FROM memory_chunks WHERE source_file = ?", [relativePath]);

    // Delete index record
    this.db.exec("DELETE FROM indexed_memories WHERE path = ?", [relativePath]);
  }

  /**
   * Find all markdown files in the memories directory, including subdirectories.
   * Scans: daily/, weekly/, monthly/, yearly/, significant/
   * Excludes: archive/ (consolidated files shouldn't be re-indexed)
   */
  private async findMarkdownFiles(): Promise<string[]> {
    const files: string[] = [];
    const allowedDirs = ["daily", "weekly", "monthly", "yearly", "significant"];

    try {
      // Scan each allowed subdirectory
      for (const subdir of allowedDirs) {
        const subdirPath = join(this.memoriesDir, subdir);
        try {
          for await (const entry of Deno.readDir(subdirPath)) {
            if (entry.isFile && entry.name.endsWith(".md") && entry.name !== ".gitkeep") {
              files.push(join(subdirPath, entry.name));
            }
          }
        } catch (error) {
          // Subdirectory doesn't exist yet, skip it
          if (!(error instanceof Deno.errors.NotFound)) {
            console.warn(`[RAG] Warning: Could not read ${subdirPath}:`, error);
          }
        }
      }

      // Also check for any .md files directly in memories/ root (legacy support)
      for await (const entry of Deno.readDir(this.memoriesDir)) {
        if (entry.isFile && entry.name.endsWith(".md")) {
          files.push(join(this.memoriesDir, entry.name));
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.log(`[RAG] Memories directory not found: ${this.memoriesDir}`);
        return [];
      }
      throw error;
    }

    return files;
  }

  /**
   * Store a chunk with its embedding in the database.
   * Also inserts into vec_memory_chunks if sqlite-vec is available.
   */
  private storeChunk(chunk: Chunk, embedding: number[]): void {
    const metadataJson = chunk.metadata ? JSON.stringify(chunk.metadata) : null;
    const embeddingData = embeddingToUint8Array(embedding);

    this.db.exec(
      `INSERT INTO memory_chunks (id, content, source_file, token_count, metadata, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        chunk.id,
        chunk.content,
        chunk.sourceFile,
        chunk.tokenCount,
        metadataJson,
        embeddingData,
        chunk.createdAt.toISOString(),
      ]
    );

    // Also insert into vector table if available
    if (this.useVectorExt) {
      // Get the numeric rowid from the insert
      const rowidStmt = this.db.prepare("SELECT rowid FROM memory_chunks WHERE id = ?");
      const row = rowidStmt.get<{ rowid: number }>(chunk.id);
      rowidStmt.finalize();

      if (row) {
        this.db.exec(
          `INSERT INTO vec_memory_chunks(rowid, embedding) VALUES (?, ?)`,
          [row.rowid, embeddingData]
        );
      }
    }
  }

  /**
   * Mark a file as indexed.
   */
  private markFileIndexed(
    relativePath: string,
    contentHash: string,
    chunkCount: number
  ): void {
    this.db.exec(
      `INSERT OR REPLACE INTO indexed_memories (path, content_hash, chunk_count, indexed_at)
       VALUES (?, ?, ?, ?)`,
      [relativePath, contentHash, chunkCount, new Date().toISOString()]
    );
  }

  /**
   * Get statistics about indexed memories.
   */
  getStats(): { fileCount: number; chunkCount: number } {
    const fileStmt = this.db.prepare("SELECT COUNT(*) as count FROM indexed_memories");
    const fileRow = fileStmt.get<{ count: number }>();
    fileStmt.finalize();

    const chunkStmt = this.db.prepare("SELECT COUNT(*) as count FROM memory_chunks");
    const chunkRow = chunkStmt.get<{ count: number }>();
    chunkStmt.finalize();

    return {
      fileCount: fileRow?.count ?? 0,
      chunkCount: chunkRow?.count ?? 0,
    };
  }
}

/**
 * Create a memory indexer instance.
 */
export function createIndexer(db: Database, memoriesDir: string): MemoryIndexer {
  return new MemoryIndexer(db, memoriesDir);
}
