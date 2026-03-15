# API Reference

## Dual SSE Architecture

Two SSE channels serve different purposes:

### Per-Request Stream (`POST /api/chat`)

Opened per chat request, closes when the response is complete.

Event flow: `context → thinking → content → tool_call → tool_result → metrics → done`

Also emits `dom_update` events for UI changes triggered by tool execution.

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

### LLM Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/llm-settings` | Get current LLM settings |
| `POST` | `/api/llm-settings` | Save LLM settings |
| `POST` | `/api/llm-settings/reset` | Reset to environment variable defaults |
| `POST` | `/api/llm-settings/test` | Test LLM connection |

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
| `GET` | `/api/admin/diagnostics` | JSON diagnostics snapshot (all subsystems) |
| `GET` | `/api/admin/logs` | JSON log entries with filtering (`?level=`, `?component=`, `?limit=`, `?since=`) |
| `GET` | `/api/admin/logs/entries` | HTML partial of log entries (same query params as above) |

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
