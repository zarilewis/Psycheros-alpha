/**
 * Discord Settings Persistence
 *
 * Manages loading and saving Discord bot configuration settings to disk.
 * Settings are stored in `.psycheros/discord-settings.json` and fall back
 * to environment variables when the file doesn't exist.
 */

import { join } from "@std/path";
import { maskApiKey } from "./settings.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * User-configurable Discord settings persisted to disk.
 */
export interface DiscordSettings {
  /** Discord bot token */
  botToken: string;
  /** Default user/channel ID to DM */
  defaultChannelId: string;
  /** Master toggle */
  enabled: boolean;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default Discord settings from environment variables.
 */
export function getDefaultDiscordSettings(): DiscordSettings {
  return {
    botToken: Deno.env.get("DISCORD_BOT_TOKEN") || "",
    defaultChannelId: Deno.env.get("DISCORD_DEFAULT_CHANNEL_ID") || "",
    enabled: !!(Deno.env.get("DISCORD_BOT_TOKEN")),
  };
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load Discord settings from the settings file.
 * Falls back to environment variable defaults if the file doesn't exist.
 */
export async function loadDiscordSettings(projectRoot: string): Promise<DiscordSettings> {
  const defaults = getDefaultDiscordSettings();
  const settingsPath = join(projectRoot, ".psycheros", "discord-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<DiscordSettings>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

/**
 * Save Discord settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveDiscordSettings(
  projectRoot: string,
  settings: DiscordSettings,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
  const settingsPath = join(settingsDir, "discord-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Get a masked version of Discord settings for safe display.
 */
export function maskDiscordSettings(settings: DiscordSettings): DiscordSettings {
  return {
    ...settings,
    botToken: maskApiKey(settings.botToken || ""),
  };
}
