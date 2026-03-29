# API Reference

## Dual SSE Architecture

Two SSE channels serve different purposes:

### Per-Request Stream (`POST /api/chat`)

Opened per chat request, closes when the response is complete.

Event flow: `context → thinking → content → tool_call → tool_result → metrics → done`

Also emits `dom_update` events for UI changes triggered by tool execution, and `status` events for retry notifications and errors.

### Persistent Channel (`GET /api/events`)

Opened on page load, stays open indefinitely. Server can push events at any time.

Used for: auto-title updates, background operations, and any UI changes that happen outside of a chat request.

Managed by `EventBroadcaster` singleton in `src/server/broadcaster.ts`.

## API Endpoints

### App

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | App shell HTML |
| `GET` | `/c/:id` | Conversation page |
| `GET` | `/health` | Health check endpoint |
| `GET` | `/api/events` | Persistent SSE channel |
| `GET` | `/fragments/*` | HTML fragments for HTMX |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Send message, stream response (SSE) |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/conversations` | List conversations |
| `POST` | `/api/conversations` | Create conversation |
| `GET` | `/api/conversations/:id/messages` | Get messages |
| `GET` | `/api/conversations/:id/context` | Get all context snapshots |
| `GET` | `/api/conversations/:id/context/latest` | Get latest context snapshot |
| `PATCH` | `/api/conversations/:id/title` | Update title |
| `DELETE` | `/api/conversations/:id` | Delete conversation |
| `DELETE` | `/api/conversations` | Batch delete conversations |

### Messages

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/messages/:id` | Update message content |

### Memory

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/memory/consolidate/:granularity` | Trigger memory consolidation |
| `POST` | `/api/memories/:granularity/:date` | Save edited memory (writes local file, pushes MCP update, reindexes RAG) |
| `POST` | `/api/memories/significant/create` | Create new significant memory |

### Identity / Core Prompts

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/settings/file/:dir/:filename` | Save core prompt file |
| `POST` | `/api/settings/custom` | Create custom identity file |
| `DELETE` | `/api/settings/custom/:filename` | Delete custom identity file |

### Snapshots

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/snapshots` | List snapshots (requires MCP) |
| `POST` | `/api/snapshots/create` | Create manual snapshot |
| `POST` | `/api/snapshots/:id/restore` | Restore from snapshot |

### Lorebooks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/lorebooks` | List all lorebooks |
| `POST` | `/api/lorebooks` | Create new lorebook |
| `GET` | `/api/lorebooks/:id` | Get specific lorebook |
| `PUT` | `/api/lorebooks/:id` | Update lorebook |
| `DELETE` | `/api/lorebooks/:id` | Delete lorebook |
| `GET` | `/api/lorebooks/:id/entries` | List lorebook entries |
| `POST` | `/api/lorebooks/:id/entries` | Create lorebook entry |
| `PUT` | `/api/lorebooks/:id/entries/:entryId` | Update lorebook entry |
| `DELETE` | `/api/lorebooks/:id/entries/:entryId` | Delete lorebook entry |
| `DELETE` | `/api/lorebooks/state/:conversationId` | Reset lorebook state |

### Knowledge Graph

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/graph` | Get full knowledge graph (nodes, edges, stats) |
| `POST` | `/api/graph/nodes` | Create graph node (auto-generates embedding) |
| `POST` | `/api/graph/edges` | Create graph edge |
| `PUT` | `/api/graph/nodes/:id` | Update graph node (re-generates embedding) |
| `PUT` | `/api/graph/edges/:id` | Update graph edge |
| `DELETE` | `/api/graph/nodes/:id` | Delete graph node (cascades to edges) |
| `DELETE` | `/api/graph/edges/:id` | Delete graph edge |

### Backgrounds

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/backgrounds` | List uploaded backgrounds |
| `POST` | `/api/backgrounds` | Upload background image |
| `DELETE` | `/api/backgrounds/:filename` | Delete background image |
| `GET` | `/backgrounds/:filename` | Serve background image file |

### Appearance Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/appearance-settings` | Get current appearance settings |
| `POST` | `/api/appearance-settings` | Save appearance settings |

Settings stored in `.psycheros/appearance-settings.json`. Shape: `{ "preset": string|null, "customAccent": string|null, "bgImage": string|null, "bgBlur": number, "bgOverlayOpacity": number, "glassEnabled": boolean }`. Defaults to phosphor preset with no background.

### Data Vault

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/vault` | List vault documents |
| `POST` | `/api/vault` | Upload vault document (multipart: document, title, scope) |
| `GET` | `/api/vault/:id` | Get vault document metadata |
| `PUT` | `/api/vault/:id` | Update vault document title/content |
| `DELETE` | `/api/vault/:id` | Delete vault document |
| `POST` | `/api/vault/search` | Search vault by query |

### General Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/general-settings` | Get general settings (entity name, user name) |
| `POST` | `/api/general-settings` | Save general settings |

Settings stored in `.psycheros/general-settings.json`. Defaults: `{ "entityName": "Assistant", "userName": "You" }`.

### LLM Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/llm-settings` | Get current LLM settings |
| `POST` | `/api/llm-settings` | Save LLM settings |
| `POST` | `/api/llm-settings/reset` | Reset to environment variable defaults |
| `POST` | `/api/llm-settings/test` | Test LLM connection |

### Web Search Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/web-search-settings` | Get current web search settings (API keys masked) |
| `POST` | `/api/web-search-settings` | Save web search settings |
| `POST` | `/api/web-search-settings/reset` | Reset to environment variable defaults |

### MCP

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/mcp/sync` | Manually trigger MCP sync |

### System Admin

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/fragments/admin` | Admin hub with tab navigation |
| `GET` | `/fragments/admin/diagnostics` | Diagnostics dashboard HTML fragment |
| `GET` | `/fragments/admin/logs` | Log viewer HTML fragment |
| `GET` | `/fragments/admin/jobs` | Scheduled jobs dashboard HTML fragment |
| `GET` | `/fragments/admin/actions` | Actions panel HTML fragment |
| `GET` | `/fragments/settings/vault` | Data Vault management fragment |
| `GET` | `/fragments/settings/vault/:id` | Vault document detail/edit fragment |
| `GET` | `/fragments/settings/memories` | Memories tabbed view fragment |
| `GET` | `/fragments/settings/memories/:granularity` | Memory file list fragment (daily/weekly/monthly/yearly/significant) |
| `GET` | `/fragments/settings/memories/:granularity/:date` | Memory editor fragment |
| `GET` | `/api/admin/diagnostics` | JSON diagnostics snapshot (all subsystems) |
| `GET` | `/api/admin/logs` | JSON log entries with filtering (`?level=`, `?component=`, `?limit=`, `?since=`) |
| `GET` | `/api/admin/logs/entries` | HTML partial of log entries (same query params as above) |
| `GET` | `/api/admin/jobs` | JSON scheduled jobs status |
| `GET` | `/api/admin/jobs/rows` | HTML partial of job table rows |
| `POST` | `/api/admin/jobs/:id/trigger` | Manually trigger a scheduled job |
| `POST` | `/api/admin/actions/batch-populate` | Run batch-populate-graph script (`{ days, granularity, dryRun, verbose }`) |

### Pulse

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pulses` | List all pulses |
| `POST` | `/api/pulses` | Create a new pulse (JSON body) |
| `GET` | `/api/pulses/:id` | Get single pulse |
| `PUT` | `/api/pulses/:id` | Update a pulse |
| `DELETE` | `/api/pulses/:id` | Delete a pulse |
| `POST` | `/api/pulses/:id/trigger` | Manual trigger |
| `POST` | `/api/pulses/:id/stop` | Abort a running Pulse |
| `GET` | `/api/pulses/running/:conversationId` | Get pulse ID running for a conversation |
| `POST` | `/api/webhook/pulse/:id` | Webhook trigger (Bearer token auth) |
| `GET` | `/api/pulses/runs` | List pulse runs (paginated, filterable by `?pulseId=`, `?status=`) |
| `GET` | `/api/pulses/:id/runs` | Runs for a specific pulse |
| `GET` | `/api/pulses/runs/:runId` | Single run details |
| `GET` | `/fragments/settings/pulse` | Main tabbed Pulse view (Prompts + Execution Log) |
| `GET` | `/fragments/settings/pulse/new` | New Pulse editor |
| `GET` | `/fragments/settings/pulse/:id/edit` | Edit Pulse editor |
| `GET` | `/fragments/settings/pulse/list` | Prompt list partial (for HTMX reload) |
| `GET` | `/fragments/settings/pulse/log` | Execution log partial (paginated) |

## Related Source Files

| File | Purpose |
|------|---------|
| `src/server/routes.ts` | All API endpoint handlers |
| `src/server/admin-routes.ts` | Admin panel route handlers |
| `src/server/admin-templates.ts` | Admin panel HTML rendering |
| `src/server/diagnostics.ts` | Diagnostics snapshot aggregation |
| `src/server/logger.ts` | Log capture ring buffer |
| `src/server/sse.ts` | SSE encoding utilities |
| `src/server/broadcaster.ts` | Persistent SSE channel (EventBroadcaster) |
| `src/server/state-changes.ts` | Unified state mutations |
| `src/server/ui-updates.ts` | Reactive DOM updates |
| `src/server/templates.ts` | HTML rendering for fragments |
| `src/pulse/engine.ts` | Pulse scheduling and execution engine |
| `src/pulse/routes.ts` | Pulse CRUD and trigger API handlers |
| `src/pulse/templates.ts` | Pulse settings UI rendering |
