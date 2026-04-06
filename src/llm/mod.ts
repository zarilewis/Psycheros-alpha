/**
 * LLM Module
 *
 * Provides the LLM client for communicating with the Z.ai API.
 * This module exports all types and the client class for use
 * throughout the Psycheros daemon.
 */

// Re-export types (only those used externally)
export type { ChatMessage, LLMConfig, StreamChunk } from "./types.ts";

export { LLMError } from "./types.ts";

// Re-export client
export { createDefaultClient, createWorkerClient, LLMClient } from "./client.ts";

// Re-export settings
export type { LLMSettings } from "./settings.ts";
export { loadSettings, saveSettings, getDefaultSettings, maskApiKey } from "./settings.ts";

// Re-export web search settings
export type { WebSearchSettings } from "./web-search-settings.ts";
export { loadWebSearchSettings, saveWebSearchSettings, getDefaultWebSearchSettings, maskWebSearchSettings } from "./web-search-settings.ts";

// Re-export Discord settings
export type { DiscordSettings } from "./discord-settings.ts";
export { loadDiscordSettings, saveDiscordSettings, getDefaultDiscordSettings, maskDiscordSettings } from "./discord-settings.ts";

// Re-export Home settings
export type { HomeSettings, HomeDevice } from "./home-settings.ts";
export { loadHomeSettings, saveHomeSettings, getDefaultHomeSettings } from "./home-settings.ts";
