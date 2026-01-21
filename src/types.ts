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
 * - done: Stream completion signal
 */
export interface SSEEvent {
  type: "thinking" | "content" | "tool_call" | "tool_result" | "dom_update" | "status" | "done";
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

