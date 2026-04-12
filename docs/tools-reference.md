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
- Two tabs: **Built-in** (shipped with Psycheros) and **Custom** (user-written)
- Built-in tools grouped by category (System, Identity, Knowledge Graph, Data Vault, Web Search, Pulse, Memory, Notification, Image Generation, Image Captioning)
- Toggle switches for each individual tool
- Per-category "Enable All" / "Disable All" buttons
- Global "Enable All" / "Disable All" buttons
- Expandable detail view showing full description and parameters schema
- Custom tab includes an **Import Tool** button to upload `.js` files directly
- Save persists to `.psycheros/tools-settings.json` and hot-reloads the tool registry

**Priority order for resolving enabled state:**
1. User override (from settings file) — explicit toggle
2. Auto-enabled tools (e.g., `web_search` when provider configured)
3. `PSYCHEROS_TOOLS` environment variable

**API Endpoints:**
- `GET /api/tools-settings` — get all tools metadata, categories, and current overrides
- `POST /api/tools-settings` — save overrides and hot-reload (`{ "toolOverrides": { "shell": true, ... } }`)
- `POST /api/custom-tools/upload` — upload a `.js` custom tool file (multipart/form-data, field `tool`, max 100KB); writes to `custom-tools/`, hot-reloads registry
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

### Query Tool (omni read)

| Tool | Description |
|------|-------------|
| `graph_query` | Unified read tool with `query_type` discriminator: `search` (semantic node search), `get_node` (by ID), `get_edges` (relationships), `traverse` (walk from a node), `subgraph` (full neighborhood), `stats` (counts) |

### Mutate Tool (omni write)

| Tool | Description |
|------|-------------|
| `graph_mutate` | Unified write tool with `operation` discriminator: `create_node`, `create_edge`, `update_node`, `update_edge`, `delete_node`, `delete_edge` |
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

## Data Vault Tool

The entity can create, read, append, list, and search documents stored in the Data Vault for persistent reference.

| Tool | Description |
|------|-------------|
| `vault` | Unified vault tool with `operation` discriminator: `write` (create/update), `read` (full content), `append` (add content, creates if missing), `list` (all documents), `search` (find relevant content) |

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/vault-tools.ts` | `vault` — unified vault document management tool |
| `src/vault/manager.ts` | VaultManager — CRUD, chunking, embedding, search |

## Pulse Tool

The entity can create, trigger, and delete autonomous scheduled prompts (Pulses). Entity-created Pulses default to silent mode and auto-delete after execution. When a visible-mode Pulse fires, the entity perceives the prompt as system-initiated via a `[System — Pulse "name"]` prefix rather than a user message.

| Tool | Description |
|------|-------------|
| `pulse` | Unified Pulse tool with `operation` discriminator: `create` (schedule a new Pulse), `trigger` (fire immediately), `delete` (remove permanently) |

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/pulse-tools.ts` | `pulse` — unified Pulse management tool |
| `src/pulse/engine.ts` | PulseEngine — scheduling, execution, chain handling |
| `src/pulse/routes.ts` | CRUD API, trigger endpoints, webhook receiver |
| `src/pulse/templates.ts` | Settings UI — hub card, editor, execution log |
| `src/pulse/timezone.ts` | Timezone conversion helpers for local↔UTC cron scheduling |

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/graph-read.ts` | `graph_query` — unified read tool for graph queries |
| `src/tools/graph-write.ts` | `graph_mutate` + `graph_write_batch` — graph write tools with auto-embedding |

## Identity Tools

The entity can modify its identity files through two tiers of tools, plus a custom file tool.

### Tier 1: Casual Tool (Append-Only)

Safe for everyday use — can only add content, never modify or delete existing content.

| Tool | Description |
|------|-------------|
| `identity_append` | Add new knowledge to identity files via `category` param (`self`, `user`, `relationship`) |

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

Operations: `create` (new file, content auto-wrapped in XML tags), `append` (add to end), `prepend` (add to beginning), `update_section` (append content under a markdown heading, preserves existing content), `replace` (overwrite with snapshot). Filenames use `.md` extension with letters, numbers, and underscores only. Deletion is user-only via the Core Prompts UI.

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
| `src/tools/identity-casual.ts` | `identity_append` — Tier 1 append-only identity tool |
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

The entity can send Discord DMs to the user as an alternative notification channel. This is useful when push notifications are unreliable (e.g., on Android web apps). Uses a Discord bot token to open a DM channel and send messages via the Discord REST API. The entity can also attach images (e.g., generated via `generate_image`) to DMs.

| Tool | Description |
|------|-------------|
| `send_discord_dm` | Send a Discord DM with a message; optionally attach an image or specify a target channel/user ID |

**Parameters:** `message` (required, up to 2000 chars), `channel_id` (optional, overrides the configured default), `image_path` (optional, path to an image file relative to `.psycheros/`, e.g. `generated-images/abc.png`). Supported image formats: png, jpg/jpeg, webp, gif.

**Setup:** Configure via Settings > External Connections in the web UI, or set environment variables:

| Setting | Env Var | Description |
|---------|---------|-------------|
| Bot Token | `DISCORD_BOT_TOKEN` | Discord bot token (create at discord.com/developers/applications) |
| Default Channel ID | `DISCORD_DEFAULT_CHANNEL_ID` | Discord user ID to DM by default |

Settings are persisted to `.psycheros/discord-settings.json` (gitignored). The tool is auto-enabled when a bot token is configured and the feature is enabled.

**Data flow:** Entity calls `send_discord_dm` → server opens DM channel via `POST /users/@me/channels` with the user ID → if `image_path` is provided, sends a `multipart/form-data` request with the image attachment; otherwise sends a JSON request → message (and optional image) sent via `POST /channels/{dm_channel_id}/messages` with bot auth.

**Error handling:** The tool returns clear messages for common Discord API errors — 401 (invalid token), 403 (missing access), 404 (unknown channel/user), 429 (rate limited with retry-after info), as well as file-not-found and unsupported image type errors.

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

## Image Generation Tool

The entity can generate images using configured provider slots (OpenRouter or Google Gemini). Multiple generators can be configured with different models and settings. Anchor images provide style/character reference, users can attach images to chat messages, and the entity can iterate on previously generated images.

| Tool | Description |
|------|-------------|
| `generate_image` | Generate an image or iterate on a previous one using a configured provider |

**Parameters:** `generator_id` (required, ID of the configured generator), `prompt` (required, text description of the desired image), `negative_prompt` (optional, things to avoid), `anchor_ids` (optional, array of anchor image IDs to use as style reference), `user_image_path` (optional, path to a user-attached chat image), `input_image_path` (optional, path to a previously generated image for reference-based iteration/modification).

**Setup:** Configure via Settings > Vision > Generators. Each generator has a name, description, provider (OpenRouter or Gemini), and provider-specific settings. Settings are persisted to `.psycheros/image-gen-settings.json` (gitignored). The tool is auto-enabled when at least one generator has `enabled: true`.

**Supported Providers:**

| Provider | Models | Notes |
|----------|--------|-------|
| OpenRouter | Any image-capable model on OpenRouter | Requires API key and base URL; model-specific endpoints |
| Gemini | `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`, `gemini-2.5-flash-image` | Requires Google API key; supports aspect ratio selection |

**Anchor Images:** Reference images stored in `.psycheros/anchors/` with metadata in the `anchor_images` SQLite table. The entity sees available anchor IDs in its system context and can reference them by ID for style/character consistency.

**Chat Attachments:** Users can attach images to messages via a clip icon button in the chat input. Attachments are uploaded to `.psycheros/chat-attachments/` and auto-captioned (dual short/long) before being passed to the entity. The user message is prefixed with `[USER_IMAGE: /chat-attachments/filename | Caption: long description | Short: brief description]`.

**Reference-Based Iteration:** The `input_image_path` parameter allows the entity to send a previously generated image back to the provider along with a modification prompt. The reference image is included as inline data in the API request. This enables workflows like "change the background", "make it darker", "add a character".

**Image Persistence:** Generated images are saved to `.psycheros/generated-images/` and displayed inline in chat. Images persist across conversation switches via `[IMAGE:...]` markers appended to the assistant message content in the database. Generated images are automatically captioned with both a longform and shortform description. Both are stored in the marker JSON; the shortform replaces the longform in LLM context after 5 conversation turns to save tokens.

**Context Fading:** Image descriptions (both `[IMAGE:...]` and `[USER_IMAGE:...]`) fade from longform to shortform after 5 conversation turns in the LLM context. The DB always retains the full description. The entity can use the `look_closer` tool to re-examine any image for full details. `look_closer` results also fade after 5 turns. Additionally, tool call arguments for image tools (`generate_image`, `describe_image`, `look_closer`) are truncated in context — string values over 50 characters are cut short. Non-image tools are unaffected. This reduces token usage from verbose prompts and descriptions stored in tool call history.

**Data flow:** Entity calls `generate_image` → server reads generator config → dispatches to provider (OpenRouter or Gemini API) → saves image to disk → auto-captions via configured captioning provider (dual short/long) → returns `[IMAGE:...]` marker with both descriptions → entity loop yields `image_generated` SSE event → frontend renders inline image.

**Error handling:** The tool returns clear messages for provider errors, missing generators, disabled generators, and image read failures.

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/generate-image.ts` | `generate_image` tool with OpenRouter and Gemini providers, auto-captioning |
| `src/tools/describe-image.ts` | Shared captioning functions (dual short/long), `describe_image` tool |
| `src/tools/look-closer.ts` | `look_closer` tool for re-examining images after context fade |
| `src/llm/image-gen-settings.ts` | Settings type (generators + captioning), load/save, API key masking |

## Image Captioning

Image captioning provides automatic description of images via a configurable vision model. It serves three purposes: auto-captioning chat attachments and generated images, providing the entity with an explicit `describe_image` tool, and providing a `look_closer` tool for re-examining images after context fading.

### Dual Description System

All auto-captioning produces both a **longform** (detailed, thorough) and **shortform** (single sentence, under 15 words) description. Both are stored in the message content in the database. When building LLM context, the `buildMessages()` method in the entity loop applies fading: after 5 conversation turns, longform is replaced with shortform. This significantly reduces token usage in long conversations with many images.

The `IMAGE_DESCRIPTION_FADE_TURNS` constant (default: 5) controls the grace period.

### Auto-Captioning

- **Chat attachments**: When a user sends a message with an image, the server synchronously captions it before passing to the entity. Both descriptions are included: `[USER_IMAGE: path | Caption: long | Short: short]`.
- **Generated images**: After the `generate_image` tool saves an image, it is automatically captioned. Both `description` (long) and `shortDescription` (short) are included in the `[IMAGE:...]` marker JSON.
- **Failure handling**: Captioning failures are non-blocking. Chat attachments fall back to path-only (`[USER_IMAGE: path]`). Generated images still display without a description.

### describe_image Tool

The entity can explicitly describe any image by local path or URL. Returns the full longform description.

| Tool | Description |
|------|-------------|
| `describe_image` | Get a detailed description of an image from a local path or URL |

**Parameters:** `path` (optional, local file path relative to `.psycheros/`), `url` (optional, remote image URL). One of `path` or `url` is required.

**Use cases:** Examining images found via web search, reviewing previously generated images, understanding user-attached images in more detail.

### look_closer Tool

The entity can re-examine any image by path to get a fresh detailed description. This is useful when the image's description has faded from context.

| Tool | Description |
|------|-------------|
| `look_closer` | Re-examine an image for a detailed description |

**Parameters:** `image_path` (required, path relative to `.psycheros/`).

**Behavior:** Re-captions the image using the configured captioning provider and returns the full longform description. The result is prefixed with `[look_closer]` for identification and also fades from context after 5 turns.

**Setup:** Both `describe_image` and `look_closer` are auto-enabled when a captioning provider is configured. Supports Gemini and OpenRouter as captioning providers with independent model selection.

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/describe-image.ts` | `describe_image` tool, `captionImage()`, `captionImageDual()`, `fetchAndCaptionUrl()` |
| `src/tools/look-closer.ts` | `look_closer` tool |
| `src/server/routes.ts` | Auto-caption flow for chat attachments |
| `src/entity/loop.ts` | Context fading logic (`buildFadeMap()`, `fadeImageMarker()`, `fadeToolCallArguments()`) |
| `src/llm/image-gen-settings.ts` | `CaptioningSettings` type, part of `ImageGenSettings` |

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
