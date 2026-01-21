/**
 * LLM Module
 *
 * Provides the LLM client for communicating with the Z.ai API.
 * This module exports all types and the client class for use
 * throughout the SBy daemon.
 */

// Re-export types
export type {
  APIError,
  ChatChoice,
  ChatDelta,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatResponseChunk,
  LLMConfig,
  StreamChunk,
} from "./types.ts";

export { LLMError } from "./types.ts";

// Re-export client
export { createDefaultClient, LLMClient } from "./client.ts";
