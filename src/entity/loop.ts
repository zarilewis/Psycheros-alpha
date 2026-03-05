/**
 * Entity Loop
 *
 * The main orchestration module that handles a single conversation turn.
 * Manages the full agentic loop: LLM call -> tool execution -> continue.
 *
 * ## Error Handling Strategy
 *
 * This module uses a "best-effort persistence" strategy:
 *
 * 1. **User message persistence** - CRITICAL. If this fails, the turn is aborted
 *    because we cannot proceed without the foundation message. Throws an error.
 *
 * 2. **Assistant message persistence** - IMPORTANT but non-fatal. If this fails,
 *    the content has already been streamed to the client. We log the error and
 *    continue so the user sees the response. Data may be lost on server restart.
 *
 * 3. **Tool result persistence** - IMPORTANT but non-fatal. Tool results have
 *    already been yielded to the client and added to the LLM context. We log
 *    the error and continue. The LLM will still see and process the results.
 *
 * This strategy prioritizes user experience (not breaking mid-stream) over
 * data integrity, with the assumption that DB failures are rare and transient.
 */

import type { LLMClient, StreamChunk, ChatMessage } from "../llm/mod.ts";
import type { DBClient } from "../db/mod.ts";
import type { ToolRegistry, ToolContext } from "../tools/mod.ts";
import type { ToolCall, ToolResult, Message, UIUpdate, TurnMetrics, LLMContextSnapshot } from "../types.ts";
import type { Retriever } from "../rag/mod.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { LorebookManager } from "../lorebook/mod.ts";
import { loadSelfContent, loadUserContent, loadRelationshipContent, loadCustomContent, buildSystemMessage } from "./context.ts";
import { buildRAGContext, formatChatHistoryForContext } from "../rag/mod.ts";
import { generateUIUpdates } from "../server/ui-updates.ts";
import { createCollector, finalize, setFinishReason } from "../metrics/mod.ts";

/**
 * Format a timestamp for message content.
 * Uses the TZ environment variable for timezone, defaults to UTC.
 * Format: [YYYY-MM-DD HH:MM]
 */
function formatMessageTimestamp(date: Date): string {
  const timeZone = Deno.env.get("TZ") || "UTC";
  const year = date.toLocaleDateString("en-US", { timeZone, year: "numeric" });
  const month = date.toLocaleDateString("en-US", { timeZone, month: "2-digit" });
  const day = date.toLocaleDateString("en-US", { timeZone, day: "2-digit" });
  const time = date.toLocaleTimeString("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `[${year}-${month}-${day} ${time}]`;
}

/**
 * Configuration for the entity turn processor.
 */
export interface EntityConfig {
  /** Root directory of the project (where SBy.md lives) */
  projectRoot: string;
  /** Maximum tool iterations before stopping (prevents infinite loops) */
  maxToolIterations?: number;
  /** Optional RAG retriever for memory search */
  ragRetriever?: Retriever;
  /** Optional chat RAG for searching conversation history */
  chatRAG?: ConversationRAG;
  /** Optional MCP client for syncing with entity-core */
  mcpClient?: MCPClient;
  /** Optional lorebook manager for world info/triggered content */
  lorebookManager?: LorebookManager;
}

/**
 * Default maximum tool iterations.
 */
const DEFAULT_MAX_TOOL_ITERATIONS = 10;

/**
 * Extended yield type that includes tool results, UI updates, and metrics.
 */
export type EntityYield =
  | StreamChunk
  | { type: "tool_result"; result: ToolResult }
  | { type: "dom_update"; update: UIUpdate }
  | { type: "metrics"; metrics: TurnMetrics }
  | { type: "context"; context: LLMContextSnapshot };

/**
 * Represents a single turn in the conversation.
 * Handles the full cycle: LLM call -> tool execution -> continue until done.
 */
export class EntityTurn {
  private readonly maxToolIterations: number;

  constructor(
    private llm: LLMClient,
    private db: DBClient,
    private tools: ToolRegistry,
    private config: EntityConfig,
  ) {
    this.maxToolIterations =
      config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  }

  /**
   * Process a user message and yield stream chunks.
   *
   * This handles the full agentic loop:
   * 1. Load SBy.md and build context
   * 2. Get conversation history from DB
   * 3. Stream LLM response
   * 4. If tool calls, execute them and continue
   * 5. Persist all messages to DB
   *
   * @param conversationId - The conversation ID to use
   * @param userMessage - The user's message text
   * @yields Stream chunks and tool results as they occur
   */
  async *process(
    conversationId: string,
    userMessage: string,
  ): AsyncGenerator<EntityYield, void, unknown> {
    // Ensure conversation exists - if not, create one and use its ID
    let conversation = this.db.getConversation(conversationId);
    if (!conversation) {
      conversation = this.db.createConversation();
      // Use the newly created conversation's ID for all subsequent operations
      conversationId = conversation.id;
      console.warn(
        `EntityTurn: Requested conversation not found. Created new conversation ${conversationId}.`,
      );
    }

    // Load self files, user files, relationship files, and custom files, build system message
    // Use MCP client if available, otherwise fall back to local files
    const selfContent = await loadSelfContent(this.config.projectRoot, this.config.mcpClient);
    const userContent = await loadUserContent(this.config.projectRoot, this.config.mcpClient);
    const relationshipContent = await loadRelationshipContent(this.config.projectRoot, this.config.mcpClient);
    const customContent = await loadCustomContent(this.config.projectRoot, this.config.mcpClient);

    // Retrieve relevant memories using RAG if available
    let memoriesContent: string | undefined;
    if (this.config.ragRetriever) {
      console.log("[RAG] Retrieving memories for query:", userMessage.substring(0, 50));
      try {
        const memories = await this.config.ragRetriever.retrieve(userMessage);
        console.log("[RAG] Found", memories.length, "memories");
        memoriesContent = buildRAGContext(memories);
        if (memoriesContent) {
          console.log("[RAG] Injected memories into context (", memoriesContent.length, "chars)");
        }
      } catch (error) {
        // Non-fatal: log and continue without memories
        console.error(
          "EntityTurn: RAG retrieval failed:",
          error instanceof Error ? error.message : String(error)
        );
      }
    } else {
      console.log("[RAG] No retriever configured - skipping RAG");
    }

    // Retrieve relevant chat history using Chat RAG if available
    let chatHistoryContent: string | undefined;
    if (this.config.chatRAG) {
      console.log("[ChatRAG] Searching chat history for:", userMessage.substring(0, 50));
      try {
        const chatMessages = await this.config.chatRAG.searchTiered({
          query: userMessage,
          conversationId: conversationId,
          limit: 5,
          minScore: 0.5,
          currentThreshold: 0.6,
        });
        console.log("[ChatRAG] Found", chatMessages.length, "relevant messages");
        chatHistoryContent = formatChatHistoryForContext(chatMessages);
        if (chatHistoryContent) {
          console.log("[ChatRAG] Injected chat history into context (", chatHistoryContent.length, "chars)");
        }
      } catch (error) {
        // Non-fatal: log and continue without chat history
        console.error(
          "EntityTurn: Chat RAG search failed:",
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Evaluate lorebook triggers if manager is available
    let lorebookContent: string | undefined;
    if (this.config.lorebookManager) {
      try {
        // Get conversation history for lorebook evaluation (before adding current user message)
        const history = this.db.getMessages(conversationId);
        const historyForLorebook = history.map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

        const result = this.config.lorebookManager.evaluate(
          userMessage,
          historyForLorebook,
          conversationId
        );

        if (result.context) {
          lorebookContent = result.context;
          console.log(
            "[Lorebook] Triggered",
            result.entries.length,
            "entries (",
            result.totalTokens,
            "tokens)"
          );
        }
      } catch (error) {
        // Non-fatal: log and continue without lorebook content
        console.error(
          "EntityTurn: Lorebook evaluation failed:",
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const systemMessage = buildSystemMessage(selfContent, userContent, relationshipContent, customContent, memoriesContent, chatHistoryContent, lorebookContent);

    // Get conversation history from DB
    const history = this.db.getMessages(conversationId);

    // Persist the user message
    // Note: This must succeed before we proceed, as it's the foundation of the turn
    // Store the message ID for chat RAG indexing
    let userMessageId: string | undefined;
    try {
      // Generate ID upfront so we can use it for chat RAG indexing
      userMessageId = crypto.randomUUID();
      this.db.addMessage(conversationId, {
        role: "user",
        content: userMessage,
      }, userMessageId);

      // Index the user message for chat RAG (non-blocking, non-fatal)
      if (this.config.chatRAG && userMessageId) {
        this.config.chatRAG.indexMessage(
          userMessageId,
          conversationId,
          "user",
          userMessage
        ).catch((error) => {
          console.warn("[ChatRAG] Failed to index user message:", error);
        });
      }
    } catch (error) {
      // User message persistence is critical - rethrow with context
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to persist user message: ${message}`);
    }

    // Build the messages array for the LLM
    const messages = this.buildMessages(systemMessage, history, userMessage);

    // Get tool definitions
    const toolDefinitions = this.tools.getDefinitions();

    // Create and yield context snapshot for debugging
    const contextSnapshot: LLMContextSnapshot = {
      timestamp: new Date().toISOString(),
      conversationId,
      userMessage,
      systemMessage,
      selfContent,
      userContent,
      relationshipContent,
      memoriesContent,
      chatHistoryContent,
      lorebookContent,
      messages: messages.slice(1).map((msg) => ({
        role: msg.role,
        content: msg.content,
        toolCalls: msg.tool_calls,
        toolCallId: msg.tool_call_id,
      })),
      toolDefinitions,
      metrics: {
        systemMessageLength: systemMessage.length,
        totalMessages: messages.length,
        estimatedTokens: Math.ceil(systemMessage.length / 4) +
          messages.reduce((acc, m) => acc + Math.ceil((m.content?.length || 0) / 4), 0),
      },
    };
    yield { type: "context", context: contextSnapshot };

    // Track current iteration for tool loop protection
    let iteration = 0;

    // Main agentic loop
    while (iteration < this.maxToolIterations) {
      iteration++;

      // Create metrics collector for this iteration
      const metricsCollector = createCollector(conversationId);

      // Accumulate the assistant's response
      let assistantContent = "";
      let assistantReasoning = "";
      const toolCalls: ToolCall[] = [];
      let streamError: Error | null = null;
      let finishReason = "stop";

      // Stream LLM response with error handling
      try {
        for await (const chunk of this.llm.chatStream(messages, toolDefinitions, {
          metricsCollector,
        })) {
          // Yield all chunks to the caller
          yield chunk;

          // Accumulate content based on chunk type
          switch (chunk.type) {
            case "thinking":
              assistantReasoning += chunk.content;
              break;
            case "content":
              assistantContent += chunk.content;
              break;
            case "tool_call":
              toolCalls.push(chunk.toolCall);
              break;
            case "done":
              // Stream finished for this iteration - capture finish reason
              finishReason = chunk.finishReason;
              setFinishReason(metricsCollector, chunk.finishReason);
              break;
          }
        }
      } catch (error) {
        // Capture the error but continue to persist what we have
        streamError = error instanceof Error ? error : new Error(String(error));
        console.error("EntityTurn: LLM stream error:", streamError.message);
        finishReason = "error";
      }

      // Generate message ID upfront so we can link metrics to it
      const hasContent = assistantContent || toolCalls.length > 0 || assistantReasoning;
      const messageId = hasContent ? crypto.randomUUID() : undefined;

      // Persist the assistant message FIRST (metrics reference it via FK)
      // This ensures we don't lose content that was already streamed
      if (hasContent) {
        try {
          this.db.addMessage(conversationId, {
            role: "assistant",
            content: assistantContent,
            reasoningContent: assistantReasoning || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          }, messageId);

          // Index the assistant message for chat RAG (non-blocking, non-fatal)
          if (this.config.chatRAG && messageId && assistantContent) {
            this.config.chatRAG.indexMessage(
              messageId,
              conversationId,
              "assistant",
              assistantContent
            ).catch((error) => {
              console.warn("[ChatRAG] Failed to index assistant message:", error);
            });
          }
        } catch (dbError) {
          // Non-fatal: content already streamed to client (see Error Handling Strategy)
          console.error(
            "EntityTurn: Failed to persist assistant message:",
            dbError instanceof Error ? dbError.message : String(dbError),
          );
        }
      }

      // Finalize and persist metrics (non-fatal), linked to message if present
      // Must happen AFTER message insert due to FK constraint
      const metrics = finalize(metricsCollector, { finishReason, messageId });
      this.db.addTurnMetrics(metrics);
      yield { type: "metrics", metrics };

      // If there was a stream error, re-throw it after persisting
      if (streamError) {
        throw streamError;
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        return;
      }

      // Build tool execution context
      const toolContext: Omit<ToolContext, "toolCallId"> = {
        conversationId,
        db: this.db,
        config: this.config,
      };

      // Execute all tool calls with context
      const toolResults = await this.tools.executeAll(toolCalls, toolContext);

      // Persist tool results and add to messages for next iteration
      // Track UI regions that need updating (from tool results, not metadata)
      const affectedUIRegions = new Set<string>();

      for (const result of toolResults) {
        // Yield the tool result
        yield { type: "tool_result", result };

        // Collect affected UI regions from the result
        // (State change functions return these, making the pattern unified)
        if (result.affectedRegions) {
          for (const region of result.affectedRegions) {
            affectedUIRegions.add(region);
          }
        }

        // Persist to DB with error handling
        try {
          this.db.addMessage(conversationId, {
            role: "tool",
            content: result.content,
            toolCallId: result.toolCallId,
          });
        } catch (dbError) {
          // Non-fatal: result already yielded and in LLM context (see Error Handling Strategy)
          console.error(
            "EntityTurn: Failed to persist tool result:",
            dbError instanceof Error ? dbError.message : String(dbError),
          );
        }
      }

      // Generate and yield UI updates for affected regions
      if (affectedUIRegions.size > 0) {
        const uiUpdates = generateUIUpdates(
          Array.from(affectedUIRegions),
          this.db,
          conversationId
        );
        for (const update of uiUpdates) {
          yield { type: "dom_update", update };
        }
      }

      // Add assistant message with tool calls to the messages array
      const assistantTimestamp = formatMessageTimestamp(new Date());
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: `${assistantTimestamp} ${assistantContent || ""}`,
        tool_calls: toolCalls,
      };
      messages.push(assistantMsg);

      // Add tool results to messages for next LLM call
      for (const result of toolResults) {
        const toolTimestamp = formatMessageTimestamp(new Date());
        const toolMsg: ChatMessage = {
          role: "tool",
          content: `${toolTimestamp} ${result.content}`,
          tool_call_id: result.toolCallId,
        };
        messages.push(toolMsg);
      }

      // Continue the loop to let the LLM process tool results
    }

    // If we hit max iterations, yield a warning content chunk and done
    // This ensures the caller knows why processing stopped
    const warningMessage =
      `\n\n[System: Stopped after ${this.maxToolIterations} tool iterations to prevent infinite loop.]`;

    yield { type: "content", content: warningMessage };

    // Persist this system-generated message so the context is clear
    this.db.addMessage(conversationId, {
      role: "assistant",
      content: warningMessage,
    });

    console.warn(
      `EntityTurn: Hit max tool iterations (${this.maxToolIterations}). ` +
        "Stopping to prevent infinite loop.",
    );

    yield { type: "done", finishReason: "max_iterations" };
  }

  /**
   * Build the messages array for the LLM request.
   * Each message includes a timestamp prefix for temporal awareness.
   *
   * @param systemMessage - The system message with SBy.md content
   * @param history - Previous messages from the database
   * @param userMessage - The new user message
   * @returns Array of ChatMessage for the LLM
   */
  private buildMessages(
    systemMessage: string,
    history: Message[],
    userMessage: string,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Add system message (no timestamp - has its own in content)
    messages.push({
      role: "system",
      content: systemMessage,
    });

    // Add history with timestamps (convert from DB format to LLM format)
    for (const msg of history) {
      const timestamp = formatMessageTimestamp(msg.createdAt);
      const chatMsg: ChatMessage = {
        role: msg.role,
        content: `${timestamp} ${msg.content}`,
      };

      // Add tool call ID if present (for tool role messages)
      if (msg.toolCallId) {
        chatMsg.tool_call_id = msg.toolCallId;
      }

      // Add tool calls if present (for assistant messages)
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        chatMsg.tool_calls = msg.toolCalls;
      }

      messages.push(chatMsg);
    }

    // Add the new user message with timestamp
    const now = formatMessageTimestamp(new Date());
    messages.push({
      role: "user",
      content: `${now} ${userMessage}`,
    });

    return messages;
  }
}
