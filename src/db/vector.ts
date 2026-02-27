/**
 * Vector Database Helpers
 *
 * Utilities for working with sqlite-vec extension for efficient
 * vector similarity search in SQLite.
 */

import type { Database } from "@db/sqlite";

// Dynamically import sqlite-vec to handle loading failures gracefully
let sqliteVecModule: { load: (db: Database) => void } | null = null;
let loadAttempted = false;
let loadError: string | null = null;

async function loadSqliteVecModule(): Promise<{ load: (db: Database) => void } | null> {
  if (loadAttempted) {
    return sqliteVecModule;
  }
  loadAttempted = true;

  try {
    // Dynamic import to handle cases where native modules fail to load
    const module = await import("sqlite-vec");
    sqliteVecModule = module as { load: (db: Database) => void };
    return sqliteVecModule;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    console.warn("[Vector] Failed to load sqlite-vec module:", loadError);
    console.warn("[Vector] Vector search will fall back to in-memory calculation.");
    return null;
  }
}

// Attempt to load the module on startup
loadSqliteVecModule();

/**
 * Check if the sqlite-vec module was loaded successfully.
 * Call ensureVectorModule() first to attempt loading.
 *
 * @returns true if the module is available
 */
export function isVectorModuleAvailable(): boolean {
  return sqliteVecModule !== null;
}

/**
 * Ensure the sqlite-vec module is loaded.
 * Call this before using vector functionality if you need to wait for the module to load.
 *
 * @returns Promise that resolves to true if module loaded successfully
 */
export async function ensureVectorModule(): Promise<boolean> {
  const module = await loadSqliteVecModule();
  return module !== null;
}

/**
 * Load the sqlite-vec extension into a database connection.
 * Must be called before using vec0 virtual tables.
 *
 * @param db - The SQLite database instance
 * @returns true if extension loaded successfully, false otherwise
 */
export function loadVectorExtension(db: Database): boolean {
  if (!sqliteVecModule) {
    return false;
  }

  try {
    db.enableLoadExtension = true;
    sqliteVecModule.load(db);
    db.enableLoadExtension = false;
    return true;
  } catch (error) {
    console.warn(
      "[Vector] Failed to load sqlite-vec extension:",
      error instanceof Error ? error.message : String(error)
    );
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
