/**
 * Entity Loop
 *
 * The main orchestration module that handles a single conversation turn.
 * Manages the full agentic loop: LLM call -> tool execution -> continue.
 */

import type { LLMClient, StreamChunk, ChatMessage } from "../llm/mod.ts";
import type { DBClient } from "../db/mod.ts";
import type { ToolRegistry, ToolContext } from "../tools/mod.ts";
import type { ToolCall, ToolResult, Message, UIUpdate } from "../types.ts";
import { loadSByMd, buildSystemMessage } from "./context.ts";
import { generateUIUpdates } from "../server/ui-updates.ts";

/**
 * Configuration for the entity turn processor.
 */
export interface EntityConfig {
  /** Root directory of the project (where SBy.md lives) */
  projectRoot: string;
  /** Maximum tool iterations before stopping (prevents infinite loops) */
  maxToolIterations?: number;
}

/**
 * Default maximum tool iterations.
 */
const DEFAULT_MAX_TOOL_ITERATIONS = 10;

/**
 * Extended yield type that includes tool results and UI updates.
 */
export type EntityYield =
  | StreamChunk
  | { type: "tool_result"; result: ToolResult }
  | { type: "dom_update"; update: UIUpdate };

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

    // Load SBy.md and build system message
    const sbyMdContent = await loadSByMd(this.config.projectRoot);
    const systemMessage = buildSystemMessage(sbyMdContent);

    // Get conversation history from DB
    const history = this.db.getMessages(conversationId);

    // Persist the user message
    // Note: This must succeed before we proceed, as it's the foundation of the turn
    try {
      this.db.addMessage(conversationId, {
        role: "user",
        content: userMessage,
      });
    } catch (error) {
      // User message persistence is critical - rethrow with context
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to persist user message: ${message}`);
    }

    // Build the messages array for the LLM
    const messages = this.buildMessages(systemMessage, history, userMessage);

    // Get tool definitions
    const toolDefinitions = this.tools.getDefinitions();

    // Track current iteration for tool loop protection
    let iteration = 0;

    // Main agentic loop
    while (iteration < this.maxToolIterations) {
      iteration++;

      // Accumulate the assistant's response
      let assistantContent = "";
      let assistantReasoning = "";
      const toolCalls: ToolCall[] = [];
      let streamError: Error | null = null;

      // Stream LLM response with error handling
      try {
        for await (const chunk of this.llm.chatStream(messages, toolDefinitions)) {
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
              // Stream finished for this iteration
              break;
          }
        }
      } catch (error) {
        // Capture the error but continue to persist what we have
        streamError = error instanceof Error ? error : new Error(String(error));
        console.error("EntityTurn: LLM stream error:", streamError.message);
      }

      // Persist the assistant message (even partial content on error)
      // This ensures we don't lose content that was already streamed
      if (assistantContent || toolCalls.length > 0 || assistantReasoning) {
        try {
          this.db.addMessage(conversationId, {
            role: "assistant",
            content: assistantContent,
            reasoningContent: assistantReasoning || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        } catch (dbError) {
          // DB write failed - log but continue so we can at least finish streaming
          console.error(
            "EntityTurn: Failed to persist assistant message:",
            dbError instanceof Error ? dbError.message : String(dbError),
          );
        }
      }

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
        services: {},
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

        // Persist to DB (with error handling)
        try {
          this.db.addMessage(conversationId, {
            role: "tool",
            content: result.content,
            toolCallId: result.toolCallId,
          });
        } catch (dbError) {
          console.error(
            "EntityTurn: Failed to persist tool result:",
            dbError instanceof Error ? dbError.message : String(dbError),
          );
          // Continue - tool results are already yielded, just logging the persistence failure
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
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls,
      };
      messages.push(assistantMsg);

      // Add tool results to messages for next LLM call
      for (const result of toolResults) {
        const toolMsg: ChatMessage = {
          role: "tool",
          content: result.content,
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

    // Add system message
    messages.push({
      role: "system",
      content: systemMessage,
    });

    // Add history (convert from DB format to LLM format)
    for (const msg of history) {
      const chatMsg: ChatMessage = {
        role: msg.role,
        content: msg.content,
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

    // Add the new user message
    messages.push({
      role: "user",
      content: userMessage,
    });

    return messages;
  }
}
