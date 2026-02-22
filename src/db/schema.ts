/**
 * SBy Database Schema
 *
 * Defines the SQLite database schema and initialization function
 * for persisting conversations and messages.
 */

import type { Database } from "@db/sqlite";

/**
 * SQL schema for the SBy database.
 * Creates tables for conversations and messages with proper indexes.
 */
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    reasoning_content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id);

  CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON messages(conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
    ON conversations(updated_at);

  CREATE TABLE IF NOT EXISTS turn_metrics (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    request_started_at TEXT NOT NULL,
    ttfb INTEGER,
    ttfc INTEGER,
    max_chunk_gap INTEGER,
    slow_chunk_count INTEGER NOT NULL DEFAULT 0,
    total_duration INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    finish_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_turn_metrics_conversation
    ON turn_metrics(conversation_id, created_at DESC);

  -- RAG Memory Tables
  -- Track indexed memory files for change detection
  CREATE TABLE IF NOT EXISTS indexed_memories (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  -- Store memory chunks with their embeddings
  CREATE TABLE IF NOT EXISTS memory_chunks (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source_file TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    metadata TEXT,
    embedding BLOB,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_chunks_source
    ON memory_chunks(source_file);
`;

/**
 * Initializes the database schema by executing the schema SQL.
 * This is idempotent - safe to call multiple times.
 *
 * @param db - The SQLite database instance
 */
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA);
  runMigrations(db);
}

/**
 * Run schema migrations for backward compatibility.
 * Each migration checks if it's needed before applying.
 */
function runMigrations(db: Database): void {
  // Migration: Add message_id column to turn_metrics if missing
  const hasMessageId = db
    .prepare("SELECT 1 FROM pragma_table_info('turn_metrics') WHERE name = 'message_id'")
    .get();

  if (!hasMessageId) {
    db.exec("ALTER TABLE turn_metrics ADD COLUMN message_id TEXT REFERENCES messages(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS idx_turn_metrics_message ON turn_metrics(message_id)");
  }

  // Migration: Add RAG tables if missing
  const hasRagTables = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'indexed_memories'")
    .get();

  if (!hasRagTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_memories (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_file TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        metadata TEXT,
        embedding BLOB,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunks_source
        ON memory_chunks(source_file);
    `);
  }
}
