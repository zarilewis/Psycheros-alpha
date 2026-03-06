/**
 * SBy Shared Type Definitions
 *
 * Core types used throughout the SBy daemon for messages,
 * tools, SSE events, and conversations.
 */

// =============================================================================
// Message Types
// =============================================================================

/**
 * Represents a message in a conversation.
 */
export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  createdAt: Date;
}

// =============================================================================
// Tool Types
// =============================================================================

/**
 * Represents a tool call made by the assistant.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Defines a tool that can be called by the LLM.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Result of executing a tool call.
 */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  /** UI regions affected by this tool execution (for reactive updates) */
  affectedRegions?: string[];
}

/**
 * Represents a UI update to be sent to the client.
 * Used for reactive DOM updates when tools modify state.
 */
export interface UIUpdate {
  /** CSS selector for the target element */
  target: string;
  /** HTML fragment to swap in */
  html: string;
  /** HTMX swap strategy (default: innerHTML) */
  swap?: string;
}

// =============================================================================
// SSE Event Types (Hybrid Streaming)
// =============================================================================

/**
 * A Server-Sent Event for streaming to clients.
 *
 * Event types:
 * - thinking: Extended thinking/reasoning content
 * - content: Main response content
 * - tool_call: Tool invocation request
 * - tool_result: Result from tool execution
 * - dom_update: Reactive UI update with HTML fragment and swap target
 * - status: Status updates (e.g., "processing", "complete")
 * - metrics: Streaming performance metrics for the turn
 * - done: Stream completion signal
 */
export interface SSEEvent {
  type: "thinking" | "content" | "tool_call" | "tool_result" | "dom_update" | "status" | "metrics" | "context" | "done";
  data: string;
}

// =============================================================================
// Conversation/Session Types
// =============================================================================

/**
 * Represents a conversation session.
 */
export interface Conversation {
  id: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Metrics Types
// =============================================================================

/**
 * Streaming performance metrics for a single conversation turn.
 * Captures timing data to diagnose API latency issues.
 */
export interface TurnMetrics {
  id: string;
  conversationId: string;
  /** ID of the assistant message these metrics belong to (for persistence) */
  messageId?: string;
  /** ISO timestamp of when the request started */
  requestStartedAt: string;
  /** Time to first byte from API (ms) */
  ttfb: number | null;
  /** Time to first content token (ms) */
  ttfc: number | null;
  /** Largest delay between chunks (ms) */
  maxChunkGap: number | null;
  /** Number of chunk gaps exceeding 500ms threshold */
  slowChunkCount: number;
  /** End-to-end stream time (ms) */
  totalDuration: number | null;
  /** Total chunks received */
  chunkCount: number;
  /** Why the stream ended (stop, tool_calls, etc.) */
  finishReason: string | null;
  /** ISO timestamp of when metrics were recorded */
  createdAt: string;
}

// =============================================================================
// Context Snapshot Types
// =============================================================================

/**
 * Snapshot of the full context sent to the LLM for a single turn.
 * Used for debugging and prompt inspection.
 */
export interface LLMContextSnapshot {
  /** ISO timestamp when context was built */
  timestamp: string;
  /** Conversation ID this context belongs to */
  conversationId: string;
  /** User message that triggered this context */
  userMessage: string;
  /** The system message with all identity files and RAG context */
  systemMessage: string;
  /** Self content loaded from self/ directory */
  selfContent: string;
  /** User content loaded from user/ directory */
  userContent: string;
  /** Relationship content loaded from relationship/ directory */
  relationshipContent: string;
  /** RAG-retrieved memories content */
  memoriesContent?: string;
  /** ChatRAG-retrieved chat history context */
  chatHistoryContent?: string;
  /** Lorebook-triggered world info content */
  lorebookContent?: string;
  /** The messages array sent to the LLM (excluding system) */
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
  }>;
  /** Tool definitions available for this turn */
  toolDefinitions: ToolDefinition[];
  /** Metrics about context size */
  metrics: {
    systemMessageLength: number;
    totalMessages: number;
    estimatedTokens: number;
  };
}

