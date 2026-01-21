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
}

// =============================================================================
// SSE Event Types (Hybrid Streaming)
// =============================================================================

/**
 * Types of Server-Sent Events for streaming responses.
 * - thinking: Extended thinking/reasoning content
 * - content: Main response content
 * - tool_call: Tool invocation request
 * - tool_result: Result from tool execution
 * - status: Status updates (e.g., "processing", "complete")
 * - done: Stream completion signal
 */
export type SSEEventType =
  | "thinking"
  | "content"
  | "tool_call"
  | "tool_result"
  | "status"
  | "done";

/**
 * A Server-Sent Event for streaming to clients.
 */
export interface SSEEvent {
  type: SSEEventType;
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
// Entity Types
// =============================================================================

/**
 * Configuration for the entity loop.
 */
export interface EntityConfig {
  modelId: string;
  maxTokens: number;
  temperature: number;
  systemPromptPath: string;
  stateDocPath: string;
}

/**
 * Represents the current state of the entity.
 */
export interface EntityState {
  isRunning: boolean;
  currentConversationId: string | null;
  lastActivityAt: Date | null;
}
