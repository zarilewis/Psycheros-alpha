/**
 * Vector Database Helpers
 *
 * Utilities for working with sqlite-vec extension for efficient
 * vector similarity search in SQLite.
 */

import type { Database } from "@db/sqlite";
import { join, dirname, fromFileUrl } from "@std/path";

// Track extension loading state
let extensionLoaded = false;

/**
 * Get the path to the sqlite-vec extension file.
 * Looks for vec0.so in the lib/ directory relative to this module.
 */
function getExtensionPath(): string | null {
  try {
    // Get the directory containing this module
    const moduleDir = dirname(fromFileUrl(import.meta.url));
    // Go up to project root (src/db -> src -> root) then into lib
    const extPath = join(moduleDir, "..", "..", "lib", "vec0.so");
    return extPath;
  } catch {
    return null;
  }
}

/**
 * Check if the sqlite-vec extension is loaded.
 *
 * @returns true if the extension is loaded
 */
export function isVectorModuleAvailable(): boolean {
  return extensionLoaded;
}

/**
 * Ensure the sqlite-vec extension is loaded.
 * This is now synchronous since we load from file instead of npm package.
 *
 * @returns Promise that resolves to true if extension loaded successfully
 */
export async function ensureVectorModule(): Promise<boolean> {
  // Extension loading is now done in loadVectorExtension
  // This function exists for backwards compatibility
  return extensionLoaded;
}

/**
 * Load the sqlite-vec extension into a database connection.
 * Must be called before using vec0 virtual tables.
 *
 * @param db - The SQLite database instance
 * @returns true if extension loaded successfully, false otherwise
 */
export function loadVectorExtension(db: Database): boolean {
  if (extensionLoaded) {
    return true;
  }

  try {
    db.enableLoadExtension = true;

    // Try loading from local file first
    const extPath = getExtensionPath();
    if (extPath) {
      try {
        db.exec(`SELECT load_extension('${extPath}')`);
        extensionLoaded = true;
        db.enableLoadExtension = false;
        return true;
      } catch {
        // File load failed, fall through to in-memory fallback
      }
    }

    // Native extension not available — fall back to in-memory cosine similarity
    console.warn("[Vector] sqlite-vec extension not available.");
    console.warn("[Vector] Vector search will fall back to in-memory calculation.");
    db.enableLoadExtension = false;
    return false;
  } catch (error) {
    console.warn(
      "[Vector] Failed to load sqlite-vec extension:",
      error instanceof Error ? error.message : String(error)
    );
    db.enableLoadExtension = false;
    return false;
  }
}

/**
 * Serialize a vector (array of numbers) to Uint8Array for storage.
 * Converts to Float32Array internally for proper binary representation.
 *
 * @param vec - Array of numbers (embedding vector)
 * @returns Uint8Array suitable for BLOB storage
 */
export function serializeVector(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

/**
 * Deserialize a Uint8Array back to a number array.
 *
 * @param data - Binary data from database BLOB
 * @returns Array of numbers (embedding vector)
 */
export function deserializeVector(data: Uint8Array | ArrayBuffer): number[] {
  const buffer = data instanceof Uint8Array ? data.buffer : data;
  return Array.from(new Float32Array(buffer));
}

/**
 * Create a vector virtual table for similarity search.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the virtual table to create
 * @param dimensions - Dimension of the vectors (e.g., 384 for all-MiniLM-L6-v2)
 * @param options - Optional configuration
 */
export function createVectorTable(
  db: Database,
  tableName: string,
  dimensions: number,
  options: {
    /** Distance metric: 'cosine', 'L2', or 'ip' (inner product) */
    distanceMetric?: "cosine" | "L2" | "ip";
    /** Additional columns to include */
    additionalColumns?: string;
  } = {}
): void {
  const { distanceMetric = "cosine", additionalColumns = "" } = options;

  const columns = additionalColumns ? `${additionalColumns},\n  ` : "";

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
      ${columns}embedding FLOAT[${dimensions}]${distanceMetric !== "cosine" ? ` distance_metric=${distanceMetric}` : ""}
    )
  `);
}

/**
 * Insert a vector into a vec0 virtual table.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the vector table
 * @param rowid - The row ID (should match the source record)
 * @param embedding - The embedding vector
 */
export function insertVector(
  db: Database,
  tableName: string,
  rowid: number,
  embedding: number[]
): void {
  const serialized = serializeVector(embedding);
  db.exec(
    `INSERT INTO ${tableName}(rowid, embedding) VALUES (?, ?)`,
    [rowid, serialized]
  );
}

/**
 * Delete a vector from a vec0 virtual table.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the vector table
 * @param rowid - The row ID to delete
 */
export function deleteVector(db: Database, tableName: string, rowid: number): void {
  db.exec(`DELETE FROM ${tableName} WHERE rowid = ?`, [rowid]);
}

/**
 * Result from a vector similarity search.
 */
export interface VectorSearchRow {
  /** Row ID matching source record */
  rowid: number;
  /** Distance/similarity score (lower is more similar for cosine) */
  distance: number;
}

/**
 * Search for similar vectors using the vec0 MATCH operator.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the vector table
 * @param queryEmbedding - The query vector
 * @param limit - Maximum number of results
 * @returns Array of search results with rowid and distance
 */
export function searchSimilarVectors(
  db: Database,
  tableName: string,
  queryEmbedding: number[],
  limit: number
): VectorSearchRow[] {
  const serialized = serializeVector(queryEmbedding);

  const stmt = db.prepare(
    `SELECT rowid, distance
     FROM ${tableName}
     WHERE embedding MATCH ?
     ORDER BY distance
     LIMIT ?`
  );

  const rows = stmt.all<VectorSearchRow>(serialized, limit);
  stmt.finalize();

  return rows;
}

/**
 * Check if sqlite-vec extension is loaded by querying vec_version.
 *
 * @param db - The SQLite database instance
 * @returns The version string or null if not loaded
 */
export function getVecVersion(db: Database): string | null {
  try {
    const stmt = db.prepare("SELECT vec_version() as version");
    const row = stmt.get<{ version: string }>();
    stmt.finalize();
    return row?.version ?? null;
  } catch {
    return null;
  }
}
