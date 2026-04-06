# Tools & Identity System

## Tool System Overview

Tools are registered in `src/tools/registry.ts` via `AVAILABLE_TOOLS`. Each tool implements the `Tool` interface and can be enabled via the `PSYCHEROS_TOOLS` environment variable or the Settings > Tools UI.

Tool enable/disable state persists to `.psycheros/tools-settings.json`. When this file exists, user overrides take precedence over the env var. Some tools are auto-enabled regardless (e.g., `web_search` when a web search provider is configured).

### Adding a New Built-in Tool

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface
2. Add the tool to `AVAILABLE_TOOLS` in `src/tools/registry.ts`
3. Add the tool name to the appropriate category in `TOOL_CATEGORIES` in `src/tools/tools-settings.ts`
4. For UI updates: use a state-change function, return `affectedRegions`
5. Tool descriptions use first-person: "I use this to..."

### Adding a Custom Tool

Custom tools live in the `custom-tools/` directory at the project root. No core code changes are needed.

1. Create `custom-tools/my-tool.js` exporting a default `Tool` object
2. The file must export `{ definition: { type: "function", function: { name, description, parameters } }, execute: async (args, ctx) => { ... } }`
3. `ctx` provides: `toolCallId`, `conversationId`, `db` (database client), `config` (with `projectRoot`)
4. Restart the server — the tool appears in Settings > Tools under Custom Tools
5. Toggle it on to enable it for the entity

Invalid custom tool files are logged as warnings and skipped.

### Tools Settings UI

Accessible via Settings > Tools in the sidebar. Provides a web interface for managing tool enable/disable state.

**Features:**
- Tools grouped by category (System, Identity, Knowledge Graph, Data Vault, Web Search, Pulse, Memory, Notification)
- Toggle switches for each individual tool
- Per-category "Enable All" / "Disable All" buttons
- Global "Enable All" / "Disable All" buttons
- Expandable detail view showing full description and parameters schema
- Custom Tools section showing user-loaded tools from `custom-tools/`
- Save persists to `.psycheros/tools-settings.json` and hot-reloads the tool registry

**Priority order for resolving enabled state:**
1. User override (from settings file) — explicit toggle
2. Auto-enabled tools (e.g., `web_search` when provider configured)
3. `PSYCHEROS_TOOLS` environment variable

**API Endpoints:**
- `GET /api/tools-settings` — get all tools metadata, categories, and current overrides
- `POST /api/tools-settings` — save overrides and hot-reload (`{ "toolOverrides": { "shell": true, ... } }`)
- `GET /fragments/settings/tools` — render Tools settings UI fragment

**Related Source Files:**

| File | Purpose |
|------|---------|
| `src/tools/registry.ts` | `AVAILABLE_TOOLS` catalog and `ToolRegistry` class |
| `src/tools/tools-settings.ts` | `ToolsSettings` type, categories, load/save, enable resolution |
| `src/tools/custom-loader.ts` | Dynamic loader for `custom-tools/` directory |
| `src/server/templates.ts` | `renderToolsSettings()` and helper functions |
| `src/server/routes.ts` | `handleGetToolsSettings`, `handleSaveToolsSettings`, `handleToolsSettingsFragment` |

See [configuration.md](configuration.md) for the full list of available tools.

## Knowledge Graph Tools

The entity can read and write to its knowledge graph. Write tools auto-generate vector embeddings for semantic search.

### Read Tools (6)

| Tool | Description |
|------|-------------|
| `graph_search_nodes` | Semantic search for nodes by query, type, limit |
| `graph_get_node` | Get a specific node by ID |
| `graph_get_edges` | Query relationships by source/target/type |
| `graph_traverse` | Walk the graph from a starting node |
| `graph_get_subgraph` | Extract full neighborhood around a node |
| `graph_stats` | Get node/edge counts and vector search status |

### Write Tools (7)

| Tool | Description |
|------|-------------|
| `graph_create_node` | Create a node with duplicate prevention and auto-embedding |
| `graph_create_edge` | Create a relationship between two nodes (supports IDs or labels) |
| `graph_update_node` | Update label, description, or confidence (re-embeds) |
| `graph_update_edge` | Update weight, evidence, or validity |
| `graph_delete_node` | Soft-delete a node and its connected edges |
| `graph_delete_edge` | Remove a relationship |
| `graph_write_batch` | Batch create nodes and edges (edges can reference existing nodes by label) |

## Web Search Tool

The entity can search the web for current information using either Tavily or Brave Search. The provider and API key are configured via the Settings UI or environment variables — the tool is auto-enabled when a provider is selected.

| Setting | Env Var | Description |
|---------|---------|-------------|
| Provider | `PSYCHEROS_WEB_SEARCH` | `disabled` (default), `tavily`, or `brave` |
| Tavily key | `TAVILY_API_KEY` | Required when using Tavily |
| Brave key | `BRAVE_SEARCH_API_KEY` | Required when using Brave Search |

The tool accepts a `query` (required) and `max_results` (optional, default 5, max 10). Results are returned as a formatted list with titles, URLs, and snippets.

Settings are persisted to `.psycheros/web-search-settings.json` (gitignored).

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/web-search.ts` | `web_search` tool with Tavily and Brave providers |
| `src/llm/web-search-settings.ts` | Settings type, load/save, API key masking |

## Data Vault Tools

The entity can create, list, and search documents stored in the Data Vault for persistent reference.

| Tool | Description |
|------|-------------|
| `vault_write` | Create or update a vault document with title, content, and scope (global/chat) |
| `vault_list` | List vault documents, optionally filtered by scope |
| `vault_search` | Search vault for relevant content by query |

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/vault-tools.ts` | 3 vault document management tools |
| `src/vault/manager.ts` | VaultManager — CRUD, chunking, embedding, search |

## Pulse Tools

The entity can create, trigger, and delete autonomous scheduled prompts (Pulses). Entity-created Pulses default to silent mode and auto-delete after execution. When a visible-mode Pulse fires, the entity perceives the prompt as system-initiated via a `[System — Pulse "name"]` prefix rather than a user message.

| Tool | Description |
|------|-------------|
| `create_pulse` | Create a new Pulse with name, prompt, schedule, and optional chain configuration |
| `trigger_pulse` | Manually fire an existing Pulse by ID |
| `delete_pulse` | Delete a Pulse and its associated triggers |

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/pulse-tools.ts` | 3 entity-facing Pulse tools |
| `src/pulse/engine.ts` | PulseEngine — scheduling, execution, chain handling |
| `src/pulse/routes.ts` | CRUD API, trigger endpoints, webhook receiver |
| `src/pulse/templates.ts` | Settings UI — hub card, editor, execution log |
| `src/pulse/timezone.ts` | Timezone conversion helpers for local↔UTC cron scheduling |

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/graph-read.ts` | 6 read-only graph query tools |
| `src/tools/graph-write.ts` | 7 graph write tools with auto-embedding |

## Identity Tools

The entity can modify its identity files through two tiers of tools, plus a custom file tool.

### Tier 1: Casual Tools (Append-Only)

Safe for everyday use — can only add content, never modify or delete existing content.

| Tool | Description |
|------|-------------|
| `append_to_self` | Add new self-knowledge (who I am, how I work) |
| `append_to_user` | Add new user knowledge (preferences, patterns, life) |
| `append_to_relationship` | Add relationship understanding (dynamics, history) |

### Tier 2: Maintenance Tools (Full Suite)

For intentional reorganization — includes prepend, section updates, and full replacement.

| Tool | Description |
|------|-------------|
| `maintain_identity` | Full file maintenance with operations: append, prepend, update_section, replace |
| `list_identity_snapshots` | View available backups created during replace operations |

### Custom File Tool

For managing freeform custom files in `identity/custom/` — topics that don't fit the predefined self/user/relationship structure.

| Tool | Description |
|------|-------------|
| `custom_file` | Create and modify custom identity files |

Operations: `create` (new file, content auto-wrapped in XML tags), `append` (add to end), `prepend` (add to beginning), `update_section` (replace content under a heading), `replace` (overwrite with snapshot). Filenames use `.md` extension with letters, numbers, and underscores only. Deletion is user-only via the Core Prompts UI.

### MCP Fallback Pattern

All identity tools route through entity-core when MCP is connected, falling back to local files when offline:

```
Tool called → MCP connected?
                ↓ Yes          ↓ No
         Call MCP tool    Write local file
                ↓                ↓
         Server-side       Queue for sync
         manipulation
```

Changes preserve XML tag structure in identity files. Content is added cleanly without metadata comments — core prompts load every turn, so token efficiency matters.

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/registry.ts` | Tool registration and default registry |
| `src/tools/identity-helpers.ts` | Identity file utilities (XML parsing, MCP fallback) |
| `src/tools/identity-casual.ts` | Tier 1 append-only identity tools |
| `src/tools/identity-maintain.ts` | Tier 2 maintenance identity tools |
| `src/tools/identity-custom.ts` | Custom identity file tool (create, append, replace) |

## Push Notification Tool

The entity can send push notifications to the user's device. This works even when the app is closed — tapping the notification opens Psycheros directly to the conversation. Uses the Web Push protocol with VAPID keys.

| Tool | Description |
|------|-------------|
| `send_notification` | Send a push notification with a title and body; optionally link to a conversation |
| `send_discord_dm` | Send a Discord DM to the user |

**Parameters:** `title` (required, short title), `body` (required, up to ~200 chars), `conversation_id` (optional, opens Psycheros to this conversation on tap).

**Setup:** The user must grant notification permission via Settings > General > Enable Push Notifications. VAPID keys are auto-generated on first use and stored in `.psycheros/push-vapid-keys.json` (gitignored). Subscriptions are stored in the `push_subscriptions` SQLite table. Expired subscriptions are automatically cleaned up when the entity sends a notification.

**Data flow:** Entity calls `send_notification` → server encrypts payload with VAPID keys → push service (FCCM) delivers to browser → service worker receives `push` event → calls `showNotification()` → user taps notification → service worker's `notificationclick` opens Psycheros at `/c/{conversationId}`.

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/send-notification.ts` | `send_notification` tool implementation |
| `src/push/mod.ts` | VAPID key management, subscription CRUD, `web-push` integration |
| `web/sw.js` | `push` and `notificationclick` event handlers |
| `web/js/psycheros.js` | Client-side subscription logic, `requestNotificationPermission()` |

## Discord DM Tool

The entity can send Discord DMs to the user as an alternative notification channel. This is useful when push notifications are unreliable (e.g., on Android web apps). Uses a Discord bot token to open a DM channel and send messages via the Discord REST API.

| Tool | Description |
|------|-------------|
| `send_discord_dm` | Send a Discord DM with a message; optionally specify a target channel/user ID |

**Parameters:** `message` (required, up to 2000 chars), `channel_id` (optional, overrides the configured default).

**Setup:** Configure via Settings > External Connections in the web UI, or set environment variables:

| Setting | Env Var | Description |
|---------|---------|-------------|
| Bot Token | `DISCORD_BOT_TOKEN` | Discord bot token (create at discord.com/developers/applications) |
| Default Channel ID | `DISCORD_DEFAULT_CHANNEL_ID` | Discord user ID to DM by default |

Settings are persisted to `.psycheros/discord-settings.json` (gitignored). The tool is auto-enabled when a bot token is configured and the feature is enabled.

**Data flow:** Entity calls `send_discord_dm` → server opens DM channel via `POST /users/@me/channels` with the user ID → sends message via `POST /channels/{dm_channel_id}/messages` with bot auth.

**Error handling:** The tool returns clear messages for common Discord API errors — 401 (invalid token), 403 (missing access), 404 (unknown channel/user), 429 (rate limited with retry-after info).

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/send-discord-dm.ts` | `send_discord_dm` tool implementation |
| `src/llm/discord-settings.ts` | Settings type, load/save, token masking |

## Home Automation Tool

The entity can control smart home devices such as smart plugs. Currently supports Shelly Plug devices via their local HTTP API. The entity turns devices on/off or checks their power status by name.

| Tool | Description |
|------|-------------|
| `control_device` | Turn a smart device on/off or check its power status by device name |

**Parameters:** `device` (required, name of the configured device), `action` (required, one of `"on"`, `"off"`, `"status"`).

**Setup:** Configure via Settings > External Connections > Home in the web UI. Add devices with a name, type (currently "Shelly Plug"), and IP address/hostname. Settings are persisted to `.psycheros/home-settings.json` (gitignored). The tool is auto-enabled when at least one device is enabled.

**Device settings shape:**
```json
{
  "devices": [
    {
      "name": "Coffee Maker",
      "type": "shelly-plug",
      "address": "192.168.1.100",
      "enabled": true
    }
  ]
}
```

**Data flow:** Entity calls `control_device("Coffee Maker", "on")` → server looks up device by name → dispatches to the Shelly handler → sends `GET http://{address}/relay/0?turn=on` → returns power state from Shelly JSON response.

**Error handling:** The tool returns clear messages for device not found (lists available devices), disabled devices, unknown device types, network timeouts (5s), and HTTP errors.

**Extensibility:** The `type` field in device settings routes to protocol-specific handlers. Adding a new device type (e.g., Kasa, Home Assistant) requires only adding a new handler function — the tool interface stays the same.

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/control-device.ts` | `control_device` tool implementation with Shelly Plug handler |
| `src/llm/home-settings.ts` | Settings type, load/save |

## Identity File Structure (Core Prompts)

Identity files are versioned markdown stored in the `identity/` directory:

```
identity/
├── self/               # Entity identity
│   ├── base_instructions.md   # Core system prompt (loaded first, editable via UI)
│   ├── my_identity.md
│   ├── my_persona.md
│   ├── my_personhood.md
│   ├── my_wants.md
│   └── my_mechanics.md
├── user/               # User knowledge
│   ├── user_identity.md
│   ├── user_life.md
│   ├── user_beliefs.md
│   ├── user_preferences.md
│   ├── user_patterns.md
│   └── user_notes.md
├── relationship/       # Shared dynamics
│   ├── relationship_dynamics.md
│   ├── relationship_history.md
│   └── relationship_notes.md
└── custom/             # User-defined files
    └── *.md
```

### Base Instructions (`base_instructions.md`)

The `identity/self/base_instructions.md` file holds the entity's core system prompt. It is:

- **Loaded first** into every LLM request, before all other identity files
- **Wrapped** in `<base_instructions>` and `</base_instructions>` XML tags
- **Editable** via Settings → Core Prompts → Self in the web UI
- **Templated** — uses `{{timestamp}}` which is replaced with the current ISO timestamp each turn

On fresh installs, this file is seeded from `templates/identity/self/base_instructions.md`. The file is excluded from the regular self-content loading to avoid duplication, since it's injected separately at the top of the system message.

### Custom Identity Files

The `identity/custom/` directory allows creating arbitrary identity files:
- Must use single-word filenames (letters, numbers, underscores only)
- Automatically wrapped in XML tags matching the filename
- Managed via Settings → Core Prompts in the web UI
- Sorted alphabetically (no predefined order)

### Data Protection

- `identity/`, `memories/`, `.snapshots/` are in `.gitignore` — protected from git overwrites
- Fresh installations get default files from `templates/identity/` via `src/init/mod.ts`
- When MCP is enabled, identity files are loaded from entity-core (local `identity/` is a cache)

### Core Prompts UI

Accessible via Settings hub in the sidebar. Provides a web interface for managing identity files:

**Tabs:** Self, User, Relationship, Custom

**Features:**
- View and edit any identity file
- Create/delete custom files

Snapshots (browse, create, preview, restore) are accessible via Settings → Entity Core → Snapshots.
