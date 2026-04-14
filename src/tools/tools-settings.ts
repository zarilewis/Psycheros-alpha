/**
 * Tools Settings
 *
 * Manages tool enable/disable state persistence and resolution.
 * Tools settings are stored in `.psycheros/tools-settings.json` and
 * take precedence over the PSYCHEROS_TOOLS env var once saved.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

export interface ToolCategory {
  id: string;
  name: string;
  description: string;
  toolNames: string[];
}

export interface ToolEntry {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  parameters?: Record<string, unknown>;
}

export interface ToolsSettings {
  /** Map of tool name -> explicit enabled state.
   *  Only contains entries the user has explicitly toggled. */
  toolOverrides: Record<string, boolean>;
}

// =============================================================================
// Tool Categories
// =============================================================================

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: "system",
    name: "System",
    description: "Shell execution, metrics, and system operations",
    toolNames: ["shell", "update_title", "get_metrics", "sync_mcp"],
  },
  {
    id: "identity",
    name: "Identity",
    description: "Self, user, and relationship identity management",
    toolNames: [
      "identity_append",
      "maintain_identity",
      "list_identity_snapshots",
      "custom_file",
    ],
  },
  {
    id: "graph",
    name: "Knowledge Graph",
    description: "Query and modify the entity knowledge graph",
    toolNames: [
      "graph_query",
      "graph_mutate",
      "graph_write_batch",
    ],
  },
  {
    id: "vault",
    name: "Data Vault",
    description: "Document storage and retrieval",
    toolNames: ["vault"],
  },
  {
    id: "web-search",
    name: "Web Search",
    description: "Search the web for current information",
    toolNames: ["web_search"],
  },
  {
    id: "pulse",
    name: "Pulse",
    description: "Autonomous entity prompts and scheduling",
    toolNames: ["pulse"],
  },
  {
    id: "memory",
    name: "Memory",
    description: "Significant memory creation",
    toolNames: ["create_significant_memory"],
  },
  {
    id: "notification",
    name: "Notification",
    description: "Send push notifications to the user's device",
    toolNames: ["send_notification", "send_discord_dm"],
  },
  {
    id: "home-automation",
    name: "Home Automation",
    description: "Control smart home devices",
    toolNames: ["control_device"],
  },
  {
    id: "image-gen",
    name: "Image Generation",
    description: "Generate images using configured providers",
    toolNames: ["generate_image"],
  },
  {
    id: "image-captioning",
    name: "Image Captioning",
    description: "Describe and understand images",
    toolNames: ["describe_image"],
  },
  {
    id: "look-closer",
    name: "Look Closer",
    description: "Re-examine images for detailed descriptions",
    toolNames: ["look_closer"],
  },
];

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_TOOLS_SETTINGS: ToolsSettings = {
  toolOverrides: {},
};

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load tools settings from the settings file.
 * Returns defaults if the file doesn't exist or is invalid.
 */
export async function loadToolsSettings(projectRoot: string): Promise<ToolsSettings> {
  const settingsPath = join(projectRoot, ".psycheros", "tools-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<ToolsSettings>;
    return {
      ...DEFAULT_TOOLS_SETTINGS,
      ...saved,
      toolOverrides: { ...(saved.toolOverrides ?? {}) },
    };
  } catch {
    return { ...DEFAULT_TOOLS_SETTINGS };
  }
}

/**
 * Save tools settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveToolsSettings(
  projectRoot: string,
  settings: ToolsSettings,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
  const settingsPath = join(settingsDir, "tools-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve the final list of enabled tool names by merging env var,
 * user overrides, and auto-enabled tools.
 *
 * Priority:
 * 1. If toolOverrides has an entry for a tool, use that value.
 * 2. Otherwise, if the env var list includes the tool, it's enabled.
 * 3. Auto-enabled tools are always enabled regardless.
 *
 * @param settings - The loaded tools settings
 * @param allToolNames - All known tool names (built-in + custom)
 * @param envToolNames - Tools from PSYCHEROS_TOOLS env var
 * @param autoEnabledToolNames - Tools that should always be enabled (e.g. web_search when provider configured)
 */
export function getEnabledToolNames(
  settings: ToolsSettings,
  allToolNames: string[],
  envToolNames: string[],
  autoEnabledToolNames: string[],
): string[] {
  const envSet = new Set(envToolNames.map((t) => t.toLowerCase()));
  const autoSet = new Set(autoEnabledToolNames.map((t) => t.toLowerCase()));
  const overrides = settings.toolOverrides;

  // If env says "all" (or is unconfigured) and no overrides exist, enable everything
  if ((envSet.has("all") || envToolNames.length === 0) && Object.keys(overrides).length === 0) {
    return allToolNames;
  }

  // If env says "none" and no overrides exist, enable nothing
  if (envSet.has("none") && Object.keys(overrides).length === 0) {
    return autoEnabledToolNames;
  }

  const enabled: string[] = [];

  for (const name of allToolNames) {
    const lower = name.toLowerCase();

    // Explicit override takes precedence
    if (lower in overrides) {
      if (overrides[lower]) {
        enabled.push(name);
      }
      continue;
    }

    // Auto-enabled tools are always on
    if (autoSet.has(lower)) {
      enabled.push(name);
      continue;
    }

    // Fall back to env var list
    if (envSet.has("all") || envSet.has(lower)) {
      enabled.push(name);
    }
  }

  return enabled;
}
