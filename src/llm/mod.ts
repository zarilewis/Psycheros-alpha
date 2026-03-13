/**
 * LLM Module
 *
 * Provides the LLM client for communicating with the Z.ai API.
 * This module exports all types and the client class for use
 * throughout the SBy daemon.
 */

// Re-export types (only those used externally)
export type { ChatMessage, LLMConfig, StreamChunk } from "./types.ts";

export { LLMError } from "./types.ts";

// Re-export client
export { createDefaultClient, createWorkerClient, LLMClient } from "./client.ts";

// Re-export settings
export type { LLMSettings } from "./settings.ts";
export { loadSettings, saveSettings, getDefaultSettings, maskApiKey } from "./settings.ts";
