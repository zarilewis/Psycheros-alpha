/**
 * Psycheros Database Schema
 *
 * Defines the SQLite database schema and initialization function
 * for persisting conversations and messages.
 */

import type { Database } from "@db/sqlite";
import { loadVectorExtension, getVecVersion } from "./vector.ts";

/**
 * SQL schema for the Psycheros database.
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
  -- Note: embedding BLOB is kept for backward compatibility but vec_memory_chunks is used for search
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

  -- Message Embeddings Table
  -- Stores embeddings for chat messages for conversational RAG
  CREATE TABLE IF NOT EXISTS message_embeddings (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_message_embeddings_message
    ON message_embeddings(message_id);

  CREATE INDEX IF NOT EXISTS idx_message_embeddings_conversation
    ON message_embeddings(conversation_id);

  -- Memory Summarization Tables
  -- Track memory summarization state
  CREATE TABLE IF NOT EXISTS memory_summaries (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    granularity TEXT NOT NULL CHECK (granularity IN ('daily', 'weekly', 'monthly', 'yearly')),
    file_path TEXT NOT NULL,
    chat_ids TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_summaries_date
    ON memory_summaries(date);

  CREATE INDEX IF NOT EXISTS idx_memory_summaries_granularity
    ON memory_summaries(granularity);

  -- Track which chats have been summarized (to avoid re-summarizing)
  CREATE TABLE IF NOT EXISTS summarized_chats (
    chat_id TEXT NOT NULL,
    message_date TEXT NOT NULL,
    summary_id TEXT NOT NULL,
    summarized_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_date),
    FOREIGN KEY (summary_id) REFERENCES memory_summaries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_summarized_chats_chat
    ON summarized_chats(chat_id);

  CREATE INDEX IF NOT EXISTS idx_summarized_chats_date
    ON summarized_chats(message_date);

  -- Lorebook Tables
  -- Lorebooks are collections of world info entries
  CREATE TABLE IF NOT EXISTS lorebooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lorebooks_enabled
    ON lorebooks(enabled);

  -- Lorebook entries contain the actual trigger/content pairs
  CREATE TABLE IF NOT EXISTS lorebook_entries (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    triggers TEXT NOT NULL,
    trigger_mode TEXT DEFAULT 'substring',
    case_sensitive INTEGER DEFAULT 0,
    sticky INTEGER DEFAULT 0,
    sticky_duration INTEGER DEFAULT 0,
    non_recursable INTEGER DEFAULT 0,
    prevent_recursion INTEGER DEFAULT 0,
    re_trigger_resets_timer INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    scan_depth INTEGER DEFAULT 5,
    max_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES lorebooks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lorebook_entries_book
    ON lorebook_entries(book_id);

  CREATE INDEX IF NOT EXISTS idx_lorebook_entries_enabled
    ON lorebook_entries(enabled);

  -- Lorebook state tracks sticky entries per conversation
  CREATE TABLE IF NOT EXISTS lorebook_state (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    turns_remaining INTEGER NOT NULL,
    triggered_at_message INTEGER NOT NULL,
    triggered_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES lorebook_entries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lorebook_state_conversation
    ON lorebook_state(conversation_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_lorebook_state_conversation_entry
    ON lorebook_state(conversation_id, entry_id);

  -- Context Inspector Snapshots
  -- Persists the full LLM context for each conversation turn
  CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 1,
    timestamp TEXT NOT NULL,
    user_message TEXT NOT NULL,
    system_message TEXT NOT NULL,
    self_content TEXT,
    user_content TEXT,
    relationship_content TEXT,
    memories_content TEXT,
    chat_history_content TEXT,
    lorebook_content TEXT,
    graph_content TEXT,
    messages_json TEXT NOT NULL,
    tool_definitions_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation
    ON context_snapshots(conversation_id, turn_index DESC);
`;

/**
 * Embedding dimension for all-MiniLM-L6-v2 model.
 */
export const EMBEDDING_DIMENSION = 384;

/**
 * Initializes the database schema by executing the schema SQL.
 * This is idempotent - safe to call multiple times.
 *
 * @param db - The SQLite database instance
 */
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA);
  runMigrations(db);
  initializeVectorTables(db);
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

  // Migration: Add memory summarization tables if missing
  const hasMemorySummaryTables = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_summaries'")
    .get();

  if (!hasMemorySummaryTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_summaries (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        granularity TEXT NOT NULL CHECK (granularity IN ('daily', 'weekly', 'monthly', 'yearly')),
        file_path TEXT NOT NULL,
        chat_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_summaries_date
        ON memory_summaries(date);

      CREATE INDEX IF NOT EXISTS idx_memory_summaries_granularity
        ON memory_summaries(granularity);

      CREATE TABLE IF NOT EXISTS summarized_chats (
        chat_id TEXT NOT NULL,
        message_date TEXT NOT NULL,
        summary_id TEXT NOT NULL,
        summarized_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_date),
        FOREIGN KEY (summary_id) REFERENCES memory_summaries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_summarized_chats_chat
        ON summarized_chats(chat_id);

      CREATE INDEX IF NOT EXISTS idx_summarized_chats_date
        ON summarized_chats(message_date);
    `);
  }

  // Migration: Add message embeddings table if missing
  const hasMessageEmbeddings = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_embeddings'")
    .get();

  if (!hasMessageEmbeddings) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_message_embeddings_message
        ON message_embeddings(message_id);

      CREATE INDEX IF NOT EXISTS idx_message_embeddings_conversation
        ON message_embeddings(conversation_id);
    `);
  }

  // Migration: Add edited_at column to messages if missing
  const hasEditedAt = db
    .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'edited_at'")
    .get();

  if (!hasEditedAt) {
    db.exec("ALTER TABLE messages ADD COLUMN edited_at TEXT");
    console.log("[DB] Added edited_at column to messages table");
  }

  // Migration: Add lorebook tables if missing
  const hasLorebookTables = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lorebooks'")
    .get();

  if (!hasLorebookTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lorebooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lorebooks_enabled
        ON lorebooks(enabled);

      CREATE TABLE IF NOT EXISTS lorebook_entries (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        triggers TEXT NOT NULL,
        trigger_mode TEXT DEFAULT 'substring',
        case_sensitive INTEGER DEFAULT 0,
        sticky INTEGER DEFAULT 0,
        sticky_duration INTEGER DEFAULT 0,
        non_recursable INTEGER DEFAULT 0,
        prevent_recursion INTEGER DEFAULT 0,
        re_trigger_resets_timer INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        scan_depth INTEGER DEFAULT 5,
        max_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (book_id) REFERENCES lorebooks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lorebook_entries_book
        ON lorebook_entries(book_id);

      CREATE INDEX IF NOT EXISTS idx_lorebook_entries_enabled
        ON lorebook_entries(enabled);

      CREATE TABLE IF NOT EXISTS lorebook_state (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        turns_remaining INTEGER NOT NULL,
        triggered_at_message INTEGER NOT NULL,
        triggered_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES lorebook_entries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lorebook_state_conversation
        ON lorebook_state(conversation_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_lorebook_state_conversation_entry
        ON lorebook_state(conversation_id, entry_id);
    `);
    console.log("[DB] Created lorebook tables");
  }

  // Migration: Add context_snapshots table if missing
  const hasContextSnapshots = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_snapshots'")
    .get();

  if (!hasContextSnapshots) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS context_snapshots (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 1,
        timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL,
        system_message TEXT NOT NULL,
        self_content TEXT,
        user_content TEXT,
        relationship_content TEXT,
        memories_content TEXT,
        chat_history_content TEXT,
        lorebook_content TEXT,
        graph_content TEXT,
        messages_json TEXT NOT NULL,
        tool_definitions_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation
        ON context_snapshots(conversation_id, turn_index DESC);
    `);
    console.log("[DB] Created context_snapshots table");
  }

  // Migration: Add cron_job_runs table if missing
  const hasCronJobRuns = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_job_runs'")
    .get();

  if (!hasCronJobRuns) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        result TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cron_job_runs_job
        ON cron_job_runs(job_id, completed_at DESC);
    `);
    console.log("[DB] Created cron_job_runs table");
  }
}

/**
 * Initialize sqlite-vec virtual tables for vector similarity search.
 * Called after schema initialization.
 */
function initializeVectorTables(db: Database): void {
  try {
    // Load the sqlite-vec extension
    loadVectorExtension(db);

    // Check if extension loaded successfully
    const version = getVecVersion(db);
    if (version) {
      console.log(`[DB] sqlite-vec extension loaded (version ${version})`);
    }

    // Create vec_memory_chunks virtual table for memory RAG
    const hasMemoryVecTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_memory_chunks'")
      .get();

    if (!hasMemoryVecTable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_chunks USING vec0(
          embedding FLOAT[${EMBEDDING_DIMENSION}] distance=cosine
        )
      `);
      console.log("[DB] Created vec_memory_chunks virtual table");
    }

    // Create vec_messages virtual table for chat RAG
    const hasMessageVecTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_messages'")
      .get();

    if (!hasMessageVecTable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
          embedding FLOAT[${EMBEDDING_DIMENSION}] distance=cosine
        )
      `);
      console.log("[DB] Created vec_messages virtual table");
    }

    // Verify and repair vector table sync
    verifyVectorTableSync(db);
  } catch (error) {
    // Log warning but don't fail - vector search is optional
    console.warn(
      "[DB] Failed to initialize sqlite-vec extension. Vector search will fall back to in-memory calculation.",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Verify that virtual tables are in sync with main tables.
 * If out of sync, clear the tracking tables to force a full reindex.
 */
function verifyVectorTableSync(db: Database): void {
  // Check memory_chunks vs vec_memory_chunks
  const memoryChunksCount = db
    .prepare("SELECT COUNT(*) as count FROM memory_chunks")
    .get<{ count: number }>()?.count ?? 0;

  const vecMemoryCount = db
    .prepare("SELECT COUNT(*) as count FROM vec_memory_chunks")
    .get<{ count: number }>()?.count ?? 0;

  if (memoryChunksCount !== vecMemoryCount) {
    console.warn(
      `[DB] Vector table mismatch: memory_chunks=${memoryChunksCount}, vec_memory_chunks=${vecMemoryCount}. Rebuilding vec_memory_chunks.`
    );
    db.exec("DELETE FROM vec_memory_chunks");

    const memRows = db
      .prepare("SELECT rowid, embedding FROM memory_chunks WHERE embedding IS NOT NULL")
      .all<{ rowid: number; embedding: Uint8Array }>();

    let memRebuilt = 0;
    for (const row of memRows) {
      try {
        db.exec(
          "INSERT INTO vec_memory_chunks(rowid, embedding) VALUES (?, ?)",
          [row.rowid, row.embedding]
        );
        memRebuilt++;
      } catch {
        // Skip rows that fail
      }
    }
    console.log(`[DB] Rebuilt vec_memory_chunks: ${memRebuilt}/${memRows.length} rows restored`);
  }

  // Check message_embeddings vs vec_messages
  const messageEmbeddingsCount = db
    .prepare("SELECT COUNT(*) as count FROM message_embeddings")
    .get<{ count: number }>()?.count ?? 0;

  const vecMessagesCount = db
    .prepare("SELECT COUNT(*) as count FROM vec_messages")
    .get<{ count: number }>()?.count ?? 0;

  if (messageEmbeddingsCount !== vecMessagesCount) {
    console.warn(
      `[DB] Vector table mismatch: message_embeddings=${messageEmbeddingsCount}, vec_messages=${vecMessagesCount}. Rebuilding vec_messages from message_embeddings.`
    );
    // Rebuild vec_messages from message_embeddings instead of destroying both
    db.exec("DELETE FROM vec_messages");

    const rows = db
      .prepare("SELECT rowid, embedding FROM message_embeddings WHERE embedding IS NOT NULL")
      .all<{ rowid: number; embedding: Uint8Array }>();

    let rebuilt = 0;
    for (const row of rows) {
      try {
        db.exec(
          "INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)",
          [row.rowid, row.embedding]
        );
        rebuilt++;
      } catch {
        // Skip rows that fail (corrupted embeddings, etc.)
      }
    }
    console.log(`[DB] Rebuilt vec_messages: ${rebuilt}/${rows.length} rows restored`);
  }
}
