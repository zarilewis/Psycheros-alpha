/**
 * Psycheros Database Client
 *
 * Provides a clean interface for database operations including
 * conversation and message management.
 */

import { Database } from "@db/sqlite";
import { initializeSchema } from "./schema.ts";
import { getVecVersion } from "./vector.ts";
import type { Conversation, Message, ToolCall, TurnMetrics, ContextSnapshotRecord } from "../types.ts";

/**
 * Valid message roles that can be stored in the database.
 */
const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Row type for conversations as stored in SQLite.
 */
interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Row type for messages as stored in SQLite.
 */
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  reasoning_content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  created_at: string;
  edited_at: string | null;
}

/**
 * Row type for turn_metrics as stored in SQLite.
 */
interface TurnMetricsRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  request_started_at: string;
  ttfb: number | null;
  ttfc: number | null;
  max_chunk_gap: number | null;
  slow_chunk_count: number;
  total_duration: number | null;
  chunk_count: number;
  finish_reason: string | null;
  created_at: string;
}

/**
 * Row type for context_snapshots as stored in SQLite.
 */
interface ContextSnapshotRow {
  id: string;
  conversation_id: string;
  turn_index: number;
  iteration: number;
  timestamp: string;
  user_message: string;
  system_message: string;
  base_instructions_content: string | null;
  self_content: string | null;
  user_content: string | null;
  relationship_content: string | null;
  memories_content: string | null;
  chat_history_content: string | null;
  lorebook_content: string | null;
  graph_content: string | null;
  vault_content: string | null;
  messages_json: string;
  tool_definitions_json: string;
  metrics_json: string;
  created_at: string;
}

/**
 * Input type for creating a new message (without auto-generated fields).
 */
type MessageInput = Omit<Message, "id" | "createdAt">;

/**
 * Database client for Psycheros persistence operations.
 */
export class DBClient {
  private db: Database;

  /**
   * Creates a new database client.
   *
   * @param dbPath - Path to the SQLite database file
   * @throws Error if database initialization fails
   */
  constructor(dbPath: string) {
    // Ensure parent directory exists
    this.ensureDirectory(dbPath);

    // Open or create the database
    this.db = new Database(dbPath);

    try {
      // Enable foreign key constraints (off by default in SQLite)
      this.db.exec("PRAGMA foreign_keys = ON");

      // Initialize schema (idempotent)
      initializeSchema(this.db);
    } catch (error) {
      // Clean up on initialization failure
      this.db.close();
      throw error;
    }
  }

  /**
   * Ensures the parent directory for the database file exists.
   */
  private ensureDirectory(dbPath: string): void {
    const lastSlash = dbPath.lastIndexOf("/");
    if (lastSlash > 0) {
      const dir = dbPath.substring(0, lastSlash);
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch (error) {
        // Directory might already exist, which is fine
        if (!(error instanceof Deno.errors.AlreadyExists)) {
          throw error;
        }
      }
    }
  }

  // ===========================================================================
  // Conversation Operations
  // ===========================================================================

  /**
   * Creates a new conversation.
   *
   * @param title - Optional title for the conversation
   * @returns The created conversation
   */
  createConversation(title?: string): Conversation {
    const id = crypto.randomUUID();
    const now = new Date();
    const nowISO = now.toISOString();

    this.db.exec(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [id, title ?? null, nowISO, nowISO]
    );

    // Return title as undefined (matching Conversation type) when not provided.
    // The DB stores null, but Conversation.title is optional (undefined when absent).
    return {
      id,
      title: title ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Retrieves a conversation by ID.
   *
   * @param id - The conversation ID
   * @returns The conversation or null if not found
   */
  getConversation(id: string): Conversation | null {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       WHERE id = ?`
    );

    const row = stmt.get<ConversationRow>(id);
    stmt.finalize();

    if (!row) {
      return null;
    }

    return this.rowToConversation(row);
  }

  /**
   * Lists all conversations, ordered by most recently updated.
   *
   * @returns Array of conversations
   */
  listConversations(): Conversation[] {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`
    );

    const rows = stmt.all<ConversationRow>();
    stmt.finalize();

    return rows.map((row) => this.rowToConversation(row));
  }

  /**
   * Updates the title of a conversation.
   *
   * @param id - The conversation ID
   * @param title - The new title (or undefined to clear)
   * @returns The updated conversation or null if not found
   */
  updateConversationTitle(id: string, title: string | undefined): Conversation | null {
    const now = new Date();
    const nowISO = now.toISOString();

    // Check if conversation exists first
    const conversation = this.getConversation(id);
    if (!conversation) {
      return null;
    }

    this.db.exec(
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
      [title ?? null, nowISO, id]
    );

    return {
      ...conversation,
      title,
      updatedAt: now,
    };
  }

  /**
   * Deletes a conversation and all associated data.
   *
   * Manually deletes related records first to handle databases
   * created before CASCADE constraints were added.
   *
   * @param id - The conversation ID to delete
   * @returns true if a conversation was deleted, false if not found
   */
  deleteConversation(id: string): boolean {
    this.db.exec("BEGIN TRANSACTION");

    try {
      // Clean up vec_messages (vec0 virtual table has no CASCADE support)
      this.cleanupVecMessages(id);

      // Manually cascade: delete metrics first (references both conversations and messages)
      this.db.exec(
        `DELETE FROM turn_metrics WHERE conversation_id = ?`,
        [id]
      );

      // Delete message embeddings (before messages, to avoid FK issues)
      this.db.exec(
        `DELETE FROM message_embeddings WHERE conversation_id = ?`,
        [id]
      );

      // Delete messages
      this.db.exec(
        `DELETE FROM messages WHERE conversation_id = ?`,
        [id]
      );

      // Delete the conversation
      const result = this.db.exec(
        `DELETE FROM conversations WHERE id = ?`,
        [id]
      );

      this.db.exec("COMMIT");
      return result > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Deletes multiple conversations and all associated data.
   *
   * Manually deletes related records first to handle databases
   * created before CASCADE constraints were added.
   *
   * @param ids - Array of conversation IDs to delete
   * @returns Number of conversations actually deleted
   */
  deleteConversations(ids: string[]): number {
    if (ids.length === 0) {
      return 0;
    }

    this.db.exec("BEGIN TRANSACTION");

    try {
      let deletedCount = 0;

      for (const id of ids) {
        // Clean up vec_messages (vec0 virtual table has no CASCADE support)
        this.cleanupVecMessages(id);

        // Manually cascade: delete metrics first
        this.db.exec(
          `DELETE FROM turn_metrics WHERE conversation_id = ?`,
          [id]
        );

        // Delete message embeddings (before messages, to avoid FK issues)
        this.db.exec(
          `DELETE FROM message_embeddings WHERE conversation_id = ?`,
          [id]
        );

        // Delete messages
        this.db.exec(
          `DELETE FROM messages WHERE conversation_id = ?`,
          [id]
        );

        // Delete the conversation
        const result = this.db.exec(
          `DELETE FROM conversations WHERE id = ?`,
          [id]
        );
        deletedCount += result;
      }

      this.db.exec("COMMIT");
      return deletedCount;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Remove vec_messages entries for a conversation's message_embeddings.
   * vec0 virtual tables don't support CASCADE, so this must be done manually.
   */
  private cleanupVecMessages(conversationId: string): void {
    // Only needed if sqlite-vec is loaded
    if (!getVecVersion(this.db)) return;

    const stmt = this.db.prepare(
      "SELECT rowid FROM message_embeddings WHERE conversation_id = ?"
    );
    const rows = stmt.all<{ rowid: number }>(conversationId);
    stmt.finalize();

    for (const row of rows) {
      this.db.exec("DELETE FROM vec_messages WHERE rowid = ?", [row.rowid]);
    }
  }

  /**
   * Converts a database row to a Conversation object.
   */
  private rowToConversation(row: ConversationRow): Conversation {
    return {
      id: row.id,
      title: row.title ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  /**
   * Adds a message to a conversation.
   *
   * Uses a transaction to ensure both the message insert and
   * conversation timestamp update succeed or fail together.
   *
   * @param conversationId - The conversation ID
   * @param message - The message data (without id and createdAt)
   * @param messageId - Optional pre-generated ID (useful for linking to metrics)
   * @returns The created message with generated fields
   * @throws Error if conversation doesn't exist or insert fails
   */
  addMessage(conversationId: string, message: MessageInput, messageId?: string): Message {
    // Defense-in-depth: validate role at runtime even though TypeScript
    // enforces it at compile time and the DB schema has a CHECK constraint.
    // This catches bugs from type assertions or corrupted data.
    if (!VALID_ROLES.has(message.role)) {
      throw new Error(`Invalid message role: ${message.role}`);
    }

    const id = messageId ?? crypto.randomUUID();
    const now = new Date();
    const nowISO = now.toISOString();

    // Serialize tool_calls to JSON if present
    const toolCallsJson = message.toolCalls
      ? JSON.stringify(message.toolCalls)
      : null;

    // Use transaction to ensure atomicity
    this.db.exec("BEGIN TRANSACTION");

    try {
      // Verify conversation exists
      const checkStmt = this.db.prepare(
        "SELECT 1 FROM conversations WHERE id = ?"
      );
      const exists = checkStmt.get(conversationId);
      checkStmt.finalize();

      if (!exists) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      this.db.exec(
        `INSERT INTO messages
         (id, conversation_id, role, content, reasoning_content, tool_call_id, tool_calls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          conversationId,
          message.role,
          message.content,
          message.reasoningContent ?? null,
          message.toolCallId ?? null,
          toolCallsJson,
          nowISO,
        ]
      );

      // Update conversation's updated_at timestamp
      this.db.exec(
        `UPDATE conversations SET updated_at = ? WHERE id = ?`,
        [nowISO, conversationId]
      );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      id,
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      createdAt: now,
    };
  }

  /**
   * Retrieves all messages for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns Array of messages ordered by creation time
   */
  getMessages(conversationId: string): Message[] {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, role, content, reasoning_content,
              tool_call_id, tool_calls, created_at, edited_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    );

    const rows = stmt.all<MessageRow>(conversationId);
    stmt.finalize();

    return rows.map((row) => this.rowToMessage(row));
  }

  /**
   * Converts a database row to a Message object.
   *
   * @throws Error if the row contains invalid data (corrupted role or tool_calls)
   */
  private rowToMessage(row: MessageRow): Message {
    // Validate role from database
    if (!VALID_ROLES.has(row.role)) {
      throw new Error(
        `Corrupted data: invalid role "${row.role}" for message ${row.id}`
      );
    }

    // Parse tool_calls JSON if present
    let toolCalls: ToolCall[] | undefined;
    if (row.tool_calls) {
      try {
        toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
      } catch (error) {
        throw new Error(
          `Corrupted data: invalid tool_calls JSON for message ${row.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      id: row.id,
      role: row.role as Message["role"],
      content: row.content,
      reasoningContent: row.reasoning_content ?? undefined,
      toolCallId: row.tool_call_id ?? undefined,
      toolCalls,
      createdAt: new Date(row.created_at),
      editedAt: row.edited_at ? new Date(row.edited_at) : undefined,
    };
  }

  /**
   * Updates a message's content.
   *
   * @param id - The message ID
   * @param content - The new content
   * @returns The updated message or null if not found
   */
  updateMessage(id: string, content: string): Message | null {
    const now = new Date();
    const nowISO = now.toISOString();

    this.db.exec("BEGIN TRANSACTION");

    try {
      // Check if message exists
      const checkStmt = this.db.prepare("SELECT conversation_id FROM messages WHERE id = ?");
      const existing = checkStmt.get<{ conversation_id: string }>(id);
      checkStmt.finalize();

      if (!existing) {
        this.db.exec("ROLLBACK");
        return null;
      }

      // Update the message
      this.db.exec(
        `UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`,
        [content, nowISO, id]
      );

      // Update conversation's updated_at timestamp
      this.db.exec(
        `UPDATE conversations SET updated_at = ? WHERE id = ?`,
        [nowISO, existing.conversation_id]
      );

      this.db.exec("COMMIT");

      // Return the updated message by re-fetching it
      const getUpdatedStmt = this.db.prepare(
        `SELECT id, conversation_id, role, content, reasoning_content,
                tool_call_id, tool_calls, created_at, edited_at
         FROM messages WHERE id = ?`
      );
      const updatedRow = getUpdatedStmt.get<MessageRow>(id);
      getUpdatedStmt.finalize();

      if (!updatedRow) {
        // Should not happen, but handle gracefully
        return null;
      }

      return this.rowToMessage(updatedRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ===========================================================================
  // Metrics Operations
  // ===========================================================================

  /**
   * Adds turn metrics to the database.
   *
   * Non-fatal on error - logs warning and returns false.
   * Metrics are nice-to-have, not critical for operation.
   *
   * @param metrics - The metrics to persist
   * @returns true if successful, false on error
   */
  addTurnMetrics(metrics: TurnMetrics): boolean {
    try {
      this.db.exec(
        `INSERT INTO turn_metrics
         (id, conversation_id, message_id, request_started_at, ttfb, ttfc, max_chunk_gap,
          slow_chunk_count, total_duration, chunk_count, finish_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          metrics.id,
          metrics.conversationId,
          metrics.messageId ?? null,
          metrics.requestStartedAt,
          metrics.ttfb,
          metrics.ttfc,
          metrics.maxChunkGap,
          metrics.slowChunkCount,
          metrics.totalDuration,
          metrics.chunkCount,
          metrics.finishReason,
          metrics.createdAt,
        ]
      );
      return true;
    } catch (error) {
      console.warn(
        "Failed to persist turn metrics:",
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Retrieves recent turn metrics for a conversation.
   *
   * @param conversationId - The conversation ID
   * @param limit - Maximum number of metrics to return (default 10)
   * @returns Array of metrics, newest first
   */
  getTurnMetrics(conversationId: string, limit = 10): TurnMetrics[] {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, message_id, request_started_at, ttfb, ttfc,
              max_chunk_gap, slow_chunk_count, total_duration, chunk_count,
              finish_reason, created_at
       FROM turn_metrics
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );

    const rows = stmt.all<TurnMetricsRow>(conversationId, limit);
    stmt.finalize();

    return rows.map((row) => this.rowToTurnMetrics(row));
  }

  /**
   * Retrieves metrics for a specific message.
   *
   * @param messageId - The message ID
   * @returns The metrics or null if none exist
   */
  getMetricsByMessageId(messageId: string): TurnMetrics | null {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, message_id, request_started_at, ttfb, ttfc,
              max_chunk_gap, slow_chunk_count, total_duration, chunk_count,
              finish_reason, created_at
       FROM turn_metrics
       WHERE message_id = ?`
    );

    const row = stmt.get<TurnMetricsRow>(messageId);
    stmt.finalize();

    return row ? this.rowToTurnMetrics(row) : null;
  }

  /**
   * Retrieves the most recent turn metrics for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns The latest metrics or null if none exist
   */
  getLatestTurnMetrics(conversationId: string): TurnMetrics | null {
    const metrics = this.getTurnMetrics(conversationId, 1);
    return metrics.length > 0 ? metrics[0] : null;
  }

  /**
   * Converts a database row to a TurnMetrics object.
   */
  private rowToTurnMetrics(row: TurnMetricsRow): TurnMetrics {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id ?? undefined,
      requestStartedAt: row.request_started_at,
      ttfb: row.ttfb,
      ttfc: row.ttfc,
      maxChunkGap: row.max_chunk_gap,
      slowChunkCount: row.slow_chunk_count,
      totalDuration: row.total_duration,
      chunkCount: row.chunk_count,
      finishReason: row.finish_reason,
      createdAt: row.created_at,
    };
  }

  // ===========================================================================
  // Date-based Message Operations (for Memory Summarization)
  // ===========================================================================

  /**
   * Retrieves all messages for a specific date.
   *
   * @param date - The date to query (Date object or ISO date string YYYY-MM-DD)
   * @returns Array of messages with conversation IDs, ordered by creation time
   */
  getMessagesByDate(date: Date | string): Array<Message & { conversationId: string }> {
    // Normalize date to YYYY-MM-DD format
    let dateStr: string;
    if (typeof date === "string") {
      dateStr = date;
    } else {
      dateStr = date.toISOString().split("T")[0];
    }

    const stmt = this.db.prepare(
      `SELECT id, conversation_id, role, content, reasoning_content,
              tool_call_id, tool_calls, created_at
       FROM messages
       WHERE date(created_at) = ?
       ORDER BY created_at ASC`
    );

    const rows = stmt.all<MessageRow>(dateStr);
    stmt.finalize();

    return rows.map((row) => ({
      ...this.rowToMessage(row),
      conversationId: row.conversation_id,
    }));
  }

  /**
   * Gets the date of the most recent message across all conversations.
   * Used for day-change detection.
   *
   * @returns The date of the most recent message, or null if no messages exist
   */
  getLastMessageDate(): Date | null {
    const stmt = this.db.prepare(
      `SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1`
    );

    const row = stmt.get<{ created_at: string }>();
    stmt.finalize();

    return row ? new Date(row.created_at) : null;
  }

  /**
   * Gets all unique conversation IDs that had messages on a specific date.
   *
   * @param date - The date to query (Date object or ISO date string YYYY-MM-DD)
   * @returns Array of conversation IDs
   */
  getConversationIdsByDate(date: Date | string): string[] {
    // Normalize date to YYYY-MM-DD format
    let dateStr: string;
    if (typeof date === "string") {
      dateStr = date;
    } else {
      dateStr = date.toISOString().split("T")[0];
    }

    const stmt = this.db.prepare(
      `SELECT DISTINCT conversation_id FROM messages WHERE date(created_at) = ?`
    );

    const rows = stmt.all<{ conversation_id: string }>(dateStr);
    stmt.finalize();

    return rows.map((row) => row.conversation_id);
  }

  /**
   * Gets all dates that have messages but no memory summary.
   * Used by the catch-up summarization to find missed days.
   *
   * @returns Array of dates in YYYY-MM-DD format, oldest first
   */
  getUnsummarizedDates(): string[] {
    const stmt = this.db.prepare(
      `SELECT DISTINCT DATE(m.created_at) as date
       FROM messages m
       LEFT JOIN summarized_chats sc
         ON sc.chat_id = m.conversation_id
         AND sc.message_date = DATE(m.created_at)
       WHERE sc.message_date IS NULL
       ORDER BY date ASC`
    );

    const rows = stmt.all<{ date: string }>();
    stmt.finalize();

    return rows.map((row) => row.date);
  }

  // ===========================================================================
  // Memory Summary Operations
  // ===========================================================================

  /**
   * Gets an existing memory summary record.
   *
   * @param date - The date being summarized
   * @param granularity - The granularity level
   * @returns The summary record or null if not found
   */
  getMemorySummary(
    date: string,
    granularity: "daily" | "weekly" | "monthly" | "yearly"
  ): { id: string; filePath: string; chatIds: string[] } | null {
    const stmt = this.db.prepare(
      `SELECT id, file_path, chat_ids FROM memory_summaries
       WHERE date = ? AND granularity = ?`
    );
    const row = stmt.get<{ id: string; file_path: string; chat_ids: string }>(date, granularity);
    stmt.finalize();
    if (!row) return null;
    return { id: row.id, filePath: row.file_path, chatIds: JSON.parse(row.chat_ids) };
  }

  /**
   * Creates a new memory summary record.
   *
   * @param date - The date being summarized
   * @param granularity - The granularity level
   * @param filePath - Path to the memory file
   * @param chatIds - Array of chat IDs included in the summary
   * @returns The summary ID
   */
  createMemorySummary(
    date: string,
    granularity: "daily" | "weekly" | "monthly" | "yearly",
    filePath: string,
    chatIds: string[]
  ): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.exec(
      `INSERT INTO memory_summaries (id, date, granularity, file_path, chat_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, date, granularity, filePath, JSON.stringify(chatIds), now]
    );

    return id;
  }

  /**
   * Creates a memory summary record or returns existing ID if one already exists.
   * Prevents duplicate records for the same (date, granularity) pair.
   *
   * @param date - The date being summarized
   * @param granularity - The granularity level
   * @param filePath - Path to the memory file
   * @param chatIds - Array of chat IDs included in the summary
   * @returns The summary ID (existing or newly created)
   */
  upsertMemorySummary(
    date: string,
    granularity: "daily" | "weekly" | "monthly" | "yearly",
    filePath: string,
    chatIds: string[]
  ): string {
    // Check for existing record first
    const existing = this.getMemorySummary(date, granularity);
    if (existing) {
      console.log(`[DB] Memory summary already exists for ${date} (${granularity}), reusing ID ${existing.id}`);
      return existing.id;
    }
    // Insert new
    return this.createMemorySummary(date, granularity, filePath, chatIds);
  }

  /**
   * Records that a chat has been summarized.
   *
   * @param chatId - The chat ID
   * @param messageDate - The date of the messages
   * @param summaryId - The summary ID
   */
  markChatSummarized(chatId: string, messageDate: string, summaryId: string): void {
    const now = new Date().toISOString();
    this.db.exec(
      `INSERT OR REPLACE INTO summarized_chats (chat_id, message_date, summary_id, summarized_at)
       VALUES (?, ?, ?, ?)`,
      [chatId, messageDate, summaryId, now]
    );
  }

  /**
   * Checks if a chat has already been summarized for a specific date.
   *
   * @param chatId - The chat ID
   * @param messageDate - The date of the messages
   * @returns True if the chat has been summarized for this date
   */
  isChatSummarized(chatId: string, messageDate: string): boolean {
    const stmt = this.db.prepare(
      `SELECT 1 FROM summarized_chats WHERE chat_id = ? AND message_date = ?`
    );
    const result = stmt.get(chatId, messageDate);
    stmt.finalize();
    return !!result;
  }

  /**
   * Gets the most recent memory summary for a granularity level.
   *
   * @param granularity - The granularity level
   * @returns The most recent summary date, or null if none exist
   */
  getLastSummaryDate(granularity: "daily" | "weekly" | "monthly" | "yearly"): string | null {
    const stmt = this.db.prepare(
      `SELECT date FROM memory_summaries WHERE granularity = ? ORDER BY date DESC LIMIT 1`
    );
    const row = stmt.get<{ date: string }>(granularity);
    stmt.finalize();
    return row?.date ?? null;
  }

  /**
   * Find memory summary records where the file no longer exists on disk.
   * Used by the startup integrity check to detect lost files.
   *
   * @param projectRoot - Root directory of the project
   * @returns Array of orphaned records
   */
  findOrphanedSummaries(
    projectRoot: string
  ): Array<{ id: string; date: string; granularity: string; filePath: string }> {
    const stmt = this.db.prepare(
      `SELECT id, date, granularity, file_path FROM memory_summaries ORDER BY date ASC`
    );
    const rows = stmt.all<{ id: string; date: string; granularity: string; file_path: string }>();
    stmt.finalize();

    const orphaned: Array<{ id: string; date: string; granularity: string; filePath: string }> = [];
    for (const row of rows) {
      const fullPath = `${projectRoot}/${row.file_path}`;
      try {
        Deno.statSync(fullPath);
      } catch {
        orphaned.push({
          id: row.id,
          date: row.date,
          granularity: row.granularity,
          filePath: row.file_path,
        });
      }
    }

    return orphaned;
  }

  /**
   * Delete a memory summary record and its associated summarized_chats entries.
   * Used by the integrity check to clear orphaned records for regeneration.
   *
   * @param summaryId - The summary record ID to delete
   */
  deleteMemorySummary(summaryId: string): void {
    // Delete associated summarized_chats first (FK constraint)
    this.db.exec(
      `DELETE FROM summarized_chats WHERE summary_id = ?`,
      [summaryId]
    );
    this.db.exec(
      `DELETE FROM memory_summaries WHERE id = ?`,
      [summaryId]
    );
  }

  // ===========================================================================
  // Context Snapshot Operations
  // ===========================================================================

  /**
   * Maximum number of context snapshots to retain per conversation.
   */
  private static readonly MAX_SNAPSHOTS_PER_CONVERSATION = 50;

  /**
   * Persists a context snapshot to the database.
   * Non-fatal — logs warnings on failure. Prunes old snapshots beyond the cap.
   *
   * @param snapshot - The snapshot record to persist
   * @returns True if the snapshot was persisted successfully
   */
  addContextSnapshot(snapshot: Omit<ContextSnapshotRecord, "id" | "createdAt">): boolean {
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.exec(
        `INSERT INTO context_snapshots
         (id, conversation_id, turn_index, iteration, timestamp, user_message,
          system_message, base_instructions_content, self_content, user_content,
          relationship_content, memories_content, chat_history_content,
          lorebook_content, graph_content, vault_content,
          messages_json, tool_definitions_json, metrics_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          snapshot.conversationId,
          snapshot.turnIndex,
          snapshot.iteration,
          snapshot.timestamp,
          snapshot.userMessage,
          snapshot.systemMessage,
          snapshot.baseInstructionsContent ?? null,
          snapshot.selfContent ?? null,
          snapshot.userContent ?? null,
          snapshot.relationshipContent ?? null,
          snapshot.memoriesContent ?? null,
          snapshot.chatHistoryContent ?? null,
          snapshot.lorebookContent ?? null,
          snapshot.graphContent ?? null,
          snapshot.vaultContent ?? null,
          snapshot.messagesJson,
          snapshot.toolDefinitionsJson,
          snapshot.metricsJson,
          now,
        ]
      );

      // Prune old snapshots beyond the cap
      this.db.exec(
        `DELETE FROM context_snapshots
         WHERE conversation_id = ?
           AND id NOT IN (
             SELECT id FROM context_snapshots
             WHERE conversation_id = ?
             ORDER BY turn_index DESC, iteration DESC
             LIMIT ?
           )`,
        [
          snapshot.conversationId,
          snapshot.conversationId,
          DBClient.MAX_SNAPSHOTS_PER_CONVERSATION,
        ]
      );

      return true;
    } catch (error) {
      console.warn(
        "Failed to persist context snapshot:",
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Retrieves all context snapshots for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns Array of snapshots, ordered by turn index ascending
   */
  getContextSnapshots(conversationId: string): ContextSnapshotRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, turn_index, iteration, timestamp, user_message,
              system_message, base_instructions_content, self_content, user_content,
              relationship_content, memories_content, chat_history_content,
              lorebook_content, graph_content, vault_content,
              messages_json, tool_definitions_json, metrics_json, created_at
       FROM context_snapshots
       WHERE conversation_id = ?
       ORDER BY turn_index ASC, iteration ASC`
    );

    const rows = stmt.all<ContextSnapshotRow>(conversationId);
    stmt.finalize();

    return rows.map((row) => this.rowToContextSnapshot(row));
  }

  /**
   * Retrieves the most recent context snapshot for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns The latest snapshot or null if none exist
   */
  getLatestContextSnapshot(conversationId: string): ContextSnapshotRecord | null {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, turn_index, iteration, timestamp, user_message,
              system_message, base_instructions_content, self_content, user_content,
              relationship_content, memories_content, chat_history_content,
              lorebook_content, graph_content, vault_content,
              messages_json, tool_definitions_json, metrics_json, created_at
       FROM context_snapshots
       WHERE conversation_id = ?
       ORDER BY turn_index DESC, iteration DESC
       LIMIT 1`
    );

    const row = stmt.get<ContextSnapshotRow>(conversationId);
    stmt.finalize();

    return row ? this.rowToContextSnapshot(row) : null;
  }

  /**
   * Converts a database row to a ContextSnapshotRecord.
   */
  private rowToContextSnapshot(row: ContextSnapshotRow): ContextSnapshotRecord {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      turnIndex: row.turn_index,
      iteration: row.iteration,
      timestamp: row.timestamp,
      userMessage: row.user_message,
      systemMessage: row.system_message,
      baseInstructionsContent: row.base_instructions_content ?? undefined,
      selfContent: row.self_content ?? undefined,
      userContent: row.user_content ?? undefined,
      relationshipContent: row.relationship_content ?? undefined,
      memoriesContent: row.memories_content ?? undefined,
      chatHistoryContent: row.chat_history_content ?? undefined,
      lorebookContent: row.lorebook_content ?? undefined,
      graphContent: row.graph_content ?? undefined,
      vaultContent: row.vault_content ?? undefined,
      messagesJson: row.messages_json,
      toolDefinitionsJson: row.tool_definitions_json,
      metricsJson: row.metrics_json,
      createdAt: row.created_at,
    };
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Closes the database connection.
   * Should be called when the client is no longer needed.
   */
  close(): void {
    this.db.close();
  }

  // ===========================================================================
  // Raw Database Access
  // ===========================================================================

  /**
   * Get the raw database connection for advanced operations.
   * Use with caution - bypasses the client's abstraction layer.
   *
   * @returns The raw SQLite database instance
   */
  getRawDb(): Database {
    return this.db;
  }

  // ===========================================================================
  // Cron Job Run Operations
  // ===========================================================================

  /**
   * Record a cron job execution.
   */
  addJobRun(
    jobId: string,
    startedAt: string,
    completedAt: string,
    durationMs: number,
    status: "success" | "error",
    result: string | null,
    error: string | null,
  ): void {
    this.db.exec(
      `INSERT INTO cron_job_runs (job_id, started_at, completed_at, duration_ms, status, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [jobId, startedAt, completedAt, durationMs, status, result, error]
    );

    // Keep only last 100 runs per job to prevent unbounded growth
    this.db.exec(
      `DELETE FROM cron_job_runs WHERE job_id = ? AND id NOT IN (
         SELECT id FROM cron_job_runs WHERE job_id = ? ORDER BY completed_at DESC LIMIT 100
       )`,
      [jobId, jobId]
    );
  }

  /**
   * Get the most recent run for each job ID.
   * Used to hydrate the cron tracker on startup.
   */
  getLatestJobRuns(): Array<{
    jobId: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    status: "success" | "error";
    result: string | null;
    error: string | null;
    successCount: number;
    errorCount: number;
  }> {
    const stmt = this.db.prepare(
      `SELECT
         job_id,
         started_at,
         completed_at,
         duration_ms,
         status,
         result,
         error,
         (SELECT COUNT(*) FROM cron_job_runs r2 WHERE r2.job_id = r1.job_id AND r2.status = 'success') as success_count,
         (SELECT COUNT(*) FROM cron_job_runs r2 WHERE r2.job_id = r1.job_id AND r2.status = 'error') as error_count
       FROM cron_job_runs r1
       WHERE r1.id = (SELECT MAX(id) FROM cron_job_runs r3 WHERE r3.job_id = r1.job_id)
       ORDER BY r1.job_id`
    );
    const rows = stmt.all<{
      job_id: string;
      started_at: string;
      completed_at: string;
      duration_ms: number;
      status: string;
      result: string | null;
      error: string | null;
      success_count: number;
      error_count: number;
    }>();
    stmt.finalize();

    return rows.map((row) => ({
      jobId: row.job_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      status: row.status as "success" | "error",
      result: row.result,
      error: row.error,
      successCount: row.success_count,
      errorCount: row.error_count,
    }));
  }

  /**
   * Get recent runs for a specific job.
   */
  getJobRunHistory(jobId: string, limit = 20): Array<{
    startedAt: string;
    completedAt: string;
    durationMs: number;
    status: "success" | "error";
    result: string | null;
    error: string | null;
  }> {
    const stmt = this.db.prepare(
      `SELECT started_at, completed_at, duration_ms, status, result, error
       FROM cron_job_runs WHERE job_id = ? ORDER BY completed_at DESC LIMIT ?`
    );
    const rows = stmt.all<{
      started_at: string;
      completed_at: string;
      duration_ms: number;
      status: string;
      result: string | null;
      error: string | null;
    }>(jobId, limit);
    stmt.finalize();

    return rows.map((row) => ({
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      status: row.status as "success" | "error",
      result: row.result,
      error: row.error,
    }));
  }
}
