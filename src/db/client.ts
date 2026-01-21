/**
 * SBy Database Client
 *
 * Provides a clean interface for database operations including
 * conversation and message management.
 */

import { Database } from "@db/sqlite";
import { initializeSchema } from "./schema.ts";
import type { Conversation, Message, ToolCall } from "../types.ts";

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
}

/**
 * Input type for creating a new message (without auto-generated fields).
 */
type MessageInput = Omit<Message, "id" | "createdAt">;

/**
 * Database client for SBy persistence operations.
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

    return {
      id,
      title,
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
   * @returns The created message with generated fields
   * @throws Error if conversation doesn't exist or insert fails
   */
  addMessage(conversationId: string, message: MessageInput): Message {
    // Defense-in-depth: validate role at runtime even though TypeScript
    // enforces it at compile time and the DB schema has a CHECK constraint.
    // This catches bugs from type assertions or corrupted data.
    if (!VALID_ROLES.has(message.role)) {
      throw new Error(`Invalid message role: ${message.role}`);
    }

    const id = crypto.randomUUID();
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
              tool_call_id, tool_calls, created_at
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
}
