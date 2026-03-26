# UI Features

Detailed documentation for Psycheros web UI features.

## Context Inspector

Built-in debugging tool for inspecting the full context sent to the LLM. Toggle via the code icon (`</>`) in the header.

**Architecture:** Context snapshots are persisted to the `context_snapshots` database table on each turn. The inspector fetches data via `GET /api/conversations/:id/context` — data survives page refresh and conversation switching. Capped at 50 snapshots per conversation (auto-pruned on insert).

**Turn Navigation:** Use the prev/next arrows to inspect any turn in the conversation, not just the latest.

**Search:** Full-text search across all snapshot content with match highlighting.

**Tabs:**
- **System**: Identity sections (self, user, relationship) as collapsible sections with size badges, plus the full assembled system message
- **RAG**: All five retrieval sources — memories, chat history, lorebook entries, data vault, knowledge graph
- **Messages**: Conversation history sent to the LLM with role badges and collapsible content
- **Tools**: Available tool definitions with parameters
- **Metrics**: Per-section size breakdown, token counts, and context window utilization bar

**Key types:** `LLMContextSnapshot` (in-memory, `src/types.ts`) and `ContextSnapshotRecord` (persisted, `src/types.ts`). Snapshot built in `EntityTurn.process()` (`src/entity/loop.ts`), persisted via `DBClient.addContextSnapshot()`.

## Temporal Awareness

Every message includes an XML-tagged timestamp in the LLM context, enabling the entity to understand when events occurred and time gaps between messages.

**Format**: `<t>YYYY-MM-DD HH:MM</t>`

XML tags are used so the LLM treats timestamps as structural metadata. These tags are **stripped from rendered output** — the user never sees them. Instead, timestamps are displayed as proper UI elements in message headers (drawn from database `createdAt` metadata).

**LLM context example:**
```
[user]: <t>2026-03-03 14:22</t> Hey, what did you think about our conversation yesterday?
[assistant]: <t>2026-03-03 14:23</t> I enjoyed our discussion about...
[user]: <t>2026-03-05 15:17</t> Can you summarize what we talked about?
```

**Display timestamps**: Shown in `.msg-header` as `msg-timestamp` elements. Time-only for today ("3:42 PM"), date + time for older messages ("Mar 14, 3:42 PM"). Server-side via `formatMessageTime()` in `templates.ts`, client-side via `formatChatTimestamp()` in `psycheros.js`.

**Timezone**: Configurable via General Settings UI. The selected timezone propagates to all three timestamp formatters (server-side message headers, client-side streaming, entity temporal XML). Empty selection falls back to the `TZ` environment variable, then UTC for entity context and the browser's local timezone for display.

Implemented in `src/entity/loop.ts` via `formatMessageTimestamp()`. XML stripping in `src/server/markdown.ts` and `web/js/psycheros.js`.

## Stop Generation

During streaming, the Send button transforms into a Stop button with two-tap confirmation to prevent accidental cancellation.

**States:**
1. **Stop** (orange with warning icon) — initial state during streaming
2. **Tap again** (pulsing amber) — confirmation required, resets after 3 seconds
3. **[Stopped]** — shown in the message when generation is halted

**Behavior:**
- Partial assistant response is **not persisted** when stopped
- User message **is persisted** (saved before streaming begins)
- Switching conversations mid-stream also aborts generation

Implemented in `web/js/psycheros.js`: `requestStopGeneration()`, `stopGeneration()`. CSS in `web/css/components.css`.

## Auto-Scroll

Smart proximity-based scroll latching replaces the naive "always scroll to bottom" approach. Matches standard chat app conventions.

**Behavior:**
- **Latched by default** — when the user is within 80px of the bottom, new content automatically scrolls into view
- **Scroll up to disengage** — scrolling away from the bottom unlatches auto-scroll immediately; the user can read history undisturbed during streaming
- **Scroll-to-bottom pill** — a circular button appears whenever the user is scrolled away from the bottom, not just during streaming
- **New-content badge** — a pulsing green dot on the pill indicates content has arrived while the user was scrolled up
- **Click pill to re-latch** — instant scroll during streaming (avoids race with growing content), smooth scroll when idle
- **Scroll back to bottom naturally** — also re-latches and dismisses the pill
- **Sending a message always latches** — user intent is unambiguous, view jumps to the new message

**Self-healing DOM:** The `AutoScroll` module detects stale DOM references (from HTMX swaps and `innerHTML` replacements) via `element.isConnected` checks and automatically reinitializes.

Implemented in `web/js/psycheros.js`: `AutoScroll` IIFE module. CSS in `web/css/components.css`: `.scroll-to-bottom-pill`, `.scroll-pill-badge`.

## Message Editing

Both user and assistant messages can be edited after they're sent.

**Features:**
- Edit button (pencil icon) appears on hover
- Inline editing with textarea replacing message content
- Save/Cancel buttons for confirming or discarding changes
- Edited messages marked with `[edited]` tag
- `edited_at` timestamp stored in database
- ChatRAG re-indexing: edited messages are automatically re-indexed for semantic search

**API:** `PUT /api/messages/:id` with body `{ "content": "...", "conversationId": "..." }`

Implemented in `web/js/psycheros.js` and `src/server/state-changes.ts`.

## Markdown Rendering

Both user and assistant messages render markdown formatting with progressive streaming.

- **Server-side**: `renderMarkdown()` in `src/server/markdown.ts` uses `marked` + `DOMPurify`. Strips LLM XML artifacts (`<t>` timestamp tags, non-HTML XML wrappers) before rendering.
- **Client-side streaming**: Progressive markdown rendering — content is parsed and rendered live during streaming via debounced `marked.parse()` (40ms). A blinking block cursor (▌) appears inline during generation. Each content segment between tool calls is independently rendered.
- **Client-side completion**: On `done` event, final render applied, cursor removed, thinking/tool sections collapsed.
- **XML stripping**: `stripEntityXml()` removes `<t>timestamp</t>` tags (including content), partial tags at chunk boundaries, and non-HTML XML wrappers while preserving standard HTML tags.
- **Supported**: Headers, lists, code blocks, blockquotes, tables, links, emphasis
- **Dependencies**: `jsdom` provides DOM environment for DOMPurify sanitization

## General Settings

Customizable display names and timezone for the chat interface. Access via Settings → General Settings (first card in the settings hub).

### Display Names

- **Entity Name** — replaces "Assistant" in message headers across the chat UI
- **Your Name** — replaces "You" in message headers across the chat UI

### Timezone

- **Display Timezone** — dropdown of ~40 common IANA timezones grouped by region, with "(System Default)" option
- Affects all message timestamps: server-rendered, client-streamed, and entity temporal XML
- Empty selection uses the system/browser default

Settings are loaded on page init from the server and cached in `globalThis.PsycherosSettings` for instant access during streaming. Saving updates the in-memory cache immediately so new messages reflect the change without a page reload.

**Persistence:** Settings stored in `.psycheros/general-settings.json` on the server. Defaults: `{ "entityName": "Assistant", "userName": "You", "timezone": "" }`.

**API Endpoints:**
- `GET /api/general-settings` — get current settings
- `POST /api/general-settings` — save settings (`{ "entityName": "...", "userName": "...", "timezone": "..." }`)
- `GET /fragments/settings/general` — render settings form fragment

## Appearance Settings

Customizable UI theming accessible via Settings → Appearance in the sidebar.

### Color Themes

8 preset themes: Cosmic, Ocean, Forest, Sunset, Lavender, Midnight, Ember, Frost. Each has distinct accent colors. Custom accent color also available via color picker.

### Background Images

- Upload custom backgrounds (JPEG, PNG, GIF, WebP up to 5MB)
- Apply backgrounds from URL
- Gallery with thumbnails, delete support
- Blur slider (0-20px) and overlay opacity slider (0-100%)

### Glass Effect

Frosted glass (glassmorphism) effect on UI panels when background is active. Uses `backdrop-filter: blur()` with semi-transparent backgrounds. Automatically hides dark overlay when enabled.

### Persistence

Theme preferences persist server-side in `.psycheros/appearance-settings.json`. On page load, the server is queried first and its values take precedence; localStorage acts as a synchronous cache for instant rendering and an offline fallback. On theme changes, settings are saved to both localStorage (immediate) and the server (async fire-and-forget). CSS variables in `web/css/tokens.css`.

**API Endpoints:**
- `GET /api/appearance-settings` — get current appearance settings
- `POST /api/appearance-settings` — save appearance settings
- `GET /api/backgrounds` — list uploaded backgrounds
- `POST /api/backgrounds` — upload new background
- `DELETE /api/backgrounds/:filename` — delete background
- `GET /backgrounds/:filename` — serve background image file

## System Admin Panel

Built-in diagnostics and log viewer for inspecting system health without shell access. Access via Settings → System Admin.

### Diagnostics Dashboard

Aggregates health data from 7 subsystems into a single view:

- **Overview**: Uptime, active SSE clients, database file size
- **Database**: Row counts for conversations, messages, lorebooks, lorebook_entries, memory_summaries
- **Vector System**: sqlite-vec availability/version, sync status between main tables and vec0 virtual tables
- **RAG**: Enabled status, indexed file count, chunk count
- **Memory Consolidation**: Enabled status, summary counts by granularity (daily/weekly/monthly/yearly), summarized chat count
- **MCP (entity-core)**: Connection status, last sync timestamp, pending identity/memory count
- **Knowledge Graph**: Node and edge counts

Data cached for 5 seconds to avoid hammering SQLite on rapid refreshes. Manual refresh via button.

### Log Viewer

Ring buffer capturing the last 1,000 log entries from all `console.*` calls. Component tags are parsed from `[Bracket]` prefixes in log messages.

**Filtering:**
- By level (Error, Warning, Info)
- By component tag (DB, RAG, MCP, Server, etc.)
- By entry count limit (50, 100, 250, 500)

**Copy to clipboard** formats logs as markdown with a fenced code block — designed for pasting into an LLM for analysis. Diagnostics copy produces structured markdown with sections matching the dashboard.

Timestamps render in the browser's local timezone (not the server's).

### Actions

Manual operations panel for running one-off maintenance tasks. Currently hosts:

- **Batch Populate Knowledge Graph**: Runs `entity-core/scripts/batch-populate-graph.ts` to backfill the knowledge graph from existing memory files. Extracts entities and relationships via LLM, creates `memory_ref` nodes with mentions edges, and generates embeddings. Idempotent — already-processed memories are skipped.

**Parameters:**
- **Days** (default 30) — how far back to look for memories
- **Granularity** — `daily`, `weekly`, `monthly`, `yearly`, `significant`, or `all`
- **Dry run** — extract entities without writing to the graph
- **Verbose** — show per-entity detail in output

Output includes exit code and full script stdout/stderr. The script runs as a subprocess against entity-core, so it uses entity-core's data directory and LLM settings (passed through from the Psycheros environment).

**Source files:** `src/server/logger.ts`, `src/server/diagnostics.ts`, `src/server/admin-routes.ts`, `src/server/admin-templates.ts`, `web/js/admin.js`, `web/css/admin.css`

## Knowledge Graph Visualization

Interactive graph viewer for the knowledge graph stored in entity-core. Requires MCP connection (`PSYCHEROS_MCP_ENABLED=true`).

Access via Settings → Knowledge Graph in the sidebar.

**Features:**
- Create/delete nodes (person, emotion, event, topic, preference, place, goal, health, boundary, tradition, insight)
- Create edges between selected nodes
- Search nodes by label/description
- Filter by node type
- Zoom/fit controls
- Node details panel showing connections

Uses vis-network library. Client-side JS in `web/js/graph-view.js`, dynamically loaded when the graph fragment is displayed.

**API Endpoints:**
- `GET /api/graph` — full graph data
- `POST /api/graph/nodes` — create node
- `POST /api/graph/edges` — create edge
- `DELETE /api/graph/nodes/:id` — delete node
- `DELETE /api/graph/edges/:id` — delete edge

## Data Vault

Document storage and search system accessible via Settings → Data Vault in the sidebar. Documents are chunked, embedded, and proactively searched every turn for context injection.

**Features:**
- Upload documents (.md, .txt, .pdf, .docx, .xlsx up to 10MB)
- Set scope: global (all conversations) or per-chat (single conversation)
- Document cards showing title, file type, scope, chunk count, size, source (upload/entity), date
- Edit entity-created documents inline (uploaded docs require re-upload)
- Delete documents with confirmation
- Entity can also create/edit vault documents via `vault_write` tool

**API Endpoints:**
- `GET /api/vault` — list documents
- `POST /api/vault` — upload document
- `GET /api/vault/:id` — get document metadata
- `PUT /api/vault/:id` — update document
- `DELETE /api/vault/:id` — delete document
- `POST /api/vault/search` — search vault

**Source files:** `src/vault/manager.ts`, `src/vault/processor.ts`, `src/tools/vault-tools.ts`, `src/server/routes.ts`

## Memories Editor

Review and edit the entity's recorded memories accessible via Settings → Memories in the sidebar. Modeled after the Core Prompts UI with the same tabbed navigation pattern.

**Features:**
- Five tabs: Daily, Weekly, Monthly, Yearly, Significant
- File lists sorted newest-first, each linking to a full editor
- Editor displays read-only metadata (source instance, created/updated timestamps, version) when available from entity-core
- Save writes the local file, pushes an overwrite update to entity-core via MCP (if connected), and reindexes the file in RAG
- Significant tab includes a Create form for manually adding new significant memories
- Works in offline mode (no MCP) — edits are saved locally only

**Flow:**
1. Settings hub → Memories card → tabbed view
2. Click tab → file list for that granularity
3. Click file → editor with textarea
4. Edit and Save → writes local file + MCP update + RAG reindex
5. Or (Significant tab): fill date + content → Create → new memory file

**MCP Integration:**
- **Read**: If MCP is connected, `memory_read` fetches richer metadata from entity-core (source instance, timestamps, version). Falls back to local file.
- **Save**: Calls `memory_update` on entity-core (explicit overwrite, no append merge). Falls back to local-only if MCP is disconnected.
- **Create**: Calls `memory_create` on entity-core for new significant memories.
- **RAG**: `MemoryIndexer.reindexFile()` processes only the changed file — removes old chunks, re-reads, re-chunks, re-embeds, re-stores.

**Security:**
- Granularity validated against allowed values
- Date validated against entity-core's regex (`^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$`)
- Path traversal prevented by sanitizing date/granularity before file path construction
- Only significant memories can be created new; other granularities are edit-only

**API Endpoints:**
- `GET /fragments/settings/memories` — tabbed view
- `GET /fragments/settings/memories/:granularity` — file list
- `GET /fragments/settings/memories/:granularity/:date` — editor
- `POST /api/memories/:granularity/:date` — save edited memory
- `POST /api/memories/significant/create` — create new significant memory

**Source files:** `src/server/templates.ts` (render functions), `src/server/routes.ts` (handlers), `src/mcp-client/mod.ts` (MCP methods), `src/rag/indexer.ts` (reindexFile)
