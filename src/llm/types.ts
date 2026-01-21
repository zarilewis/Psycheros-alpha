/**
 * LLM Client Type Definitions
 *
 * Types specific to the LLM client for communicating with the Z.ai API.
 * These types handle the OpenAI-compatible protocol with Z.ai extensions
 * like thinking/reasoning content.
 */

import type { ToolCall, ToolDefinition } from "../types.ts";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for the LLM client.
 */
export interface LLMConfig {
  /** Base URL for the API endpoint */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model identifier to use */
  model: string;
  /** Whether to enable chain-of-thought reasoning */
  thinkingEnabled: boolean;
}

// =============================================================================
// Request Types
// =============================================================================

/**
 * Message format for chat requests.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/**
 * Request body for chat completions.
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  thinking?: { type: "enabled" | "disabled" };
  tools?: ToolDefinition[];
  tool_choice?: "auto";
  temperature?: number;
  max_tokens?: number;
}

// =============================================================================
// Response Types
// =============================================================================

/**
 * Delta object in a streaming response chunk.
 */
export interface ChatDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

/**
 * Choice object in a streaming response chunk.
 */
export interface ChatChoice {
  index: number;
  delta: ChatDelta;
  finish_reason?: "stop" | "tool_calls" | "length" | null;
}

/**
 * A single chunk from a streaming chat response.
 */
export interface ChatResponseChunk {
  id: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ChatChoice[];
}

/**
 * Non-streaming chat response.
 */
export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: "stop" | "tool_calls" | "length";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// =============================================================================
// Stream Chunk Types
// =============================================================================

/**
 * Parsed stream chunk with classified content type.
 * Used to provide a clean interface for consumers of the streaming API.
 */
export type StreamChunk =
  | { type: "thinking"; content: string }
  | { type: "content"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; finishReason: string };

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error response from the API.
 */
export interface APIError {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * Custom error class for LLM client errors.
 *
 * Provides structured error information including:
 * - Error code for programmatic handling
 * - HTTP status code when available
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
