/**
 * LLM Settings Persistence
 *
 * Manages loading and saving LLM configuration settings to disk.
 * Settings are stored in `.psycheros/llm-settings.json` and fall back
 * to environment variables when the file doesn't exist.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/**
 * User-configurable LLM settings persisted to disk.
 */
export interface LLMSettings {
  /** Base URL for the API endpoint */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model identifier to use */
  model: string;
  /** Worker model for lightweight tasks (auto-titling, summarization) */
  workerModel: string;
  /** Sampling temperature (0-2) */
  temperature: number;
  /** Top-p (nucleus) sampling (0-1) */
  topP: number;
  /** Top-k sampling (0 = disabled) */
  topK: number;
  /** Frequency penalty (-2 to 2) */
  frequencyPenalty: number;
  /** Presence penalty (-2 to 2) */
  presencePenalty: number;
  /** Maximum tokens for response generation */
  maxTokens: number;
  /** Context window size (informational, not sent to API) */
  contextLength: number;
  /** Whether chain-of-thought reasoning is enabled */
  thinkingEnabled: boolean;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Hardcoded fallback defaults when no env vars or settings file exists.
 */
const FALLBACK_DEFAULTS: LLMSettings = {
  baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
  apiKey: "",
  model: "glm-4.7",
  workerModel: "GLM-4.5-Air",
  temperature: 0.7,
  topP: 1,
  topK: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  maxTokens: 4096,
  contextLength: 128000,
  thinkingEnabled: true,
};

/**
 * Build default settings from environment variables, falling back to hardcoded defaults.
 */
export function getDefaultSettings(): LLMSettings {
  return {
    baseUrl:
      Deno.env.get("ZAI_BASE_URL") || FALLBACK_DEFAULTS.baseUrl,
    apiKey:
      Deno.env.get("ZAI_API_KEY") || FALLBACK_DEFAULTS.apiKey,
    model:
      Deno.env.get("ZAI_MODEL") || FALLBACK_DEFAULTS.model,
    workerModel:
      Deno.env.get("ZAI_WORKER_MODEL") || FALLBACK_DEFAULTS.workerModel,
    temperature: FALLBACK_DEFAULTS.temperature,
    topP: FALLBACK_DEFAULTS.topP,
    topK: FALLBACK_DEFAULTS.topK,
    frequencyPenalty: FALLBACK_DEFAULTS.frequencyPenalty,
    presencePenalty: FALLBACK_DEFAULTS.presencePenalty,
    maxTokens: FALLBACK_DEFAULTS.maxTokens,
    contextLength: FALLBACK_DEFAULTS.contextLength,
    thinkingEnabled: FALLBACK_DEFAULTS.thinkingEnabled,
  };
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load LLM settings from the settings file.
 * Falls back to environment variable defaults if the file doesn't exist.
 */
export async function loadSettings(projectRoot: string): Promise<LLMSettings> {
  const defaults = getDefaultSettings();
  const settingsPath = join(projectRoot, ".psycheros", "llm-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<LLMSettings>;
    // Merge saved settings over defaults (saved values take priority)
    return { ...defaults, ...saved };
  } catch {
    // File doesn't exist or is invalid - use defaults
    return defaults;
  }
}

/**
 * Save LLM settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveSettings(
  projectRoot: string,
  settings: LLMSettings,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
  const settingsPath = join(settingsDir, "llm-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Mask an API key for safe display (shows first 3 and last 4 chars).
 * Returns the key unchanged if it's too short to mask.
 */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) {
    return key ? "••••••••" : "";
  }
  return key.slice(0, 3) + "••••••••" + key.slice(-4);
}
