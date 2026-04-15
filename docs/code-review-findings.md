# Code Review Findings

Status: **Complete** — all critical and high-severity issues fixed. Post-alpha fixes below.

## Scope

Full code review covering code quality, error handling, input validation, SQLite usage, LLM client robustness, frontend security, memory/RAG correctness, and tool execution safety.

## Initial Observations

- ~69 TypeScript source files, ~320 total files
- No automated tests — validation done via manual browser testing
- No linting/formatting config beyond Deno defaults
- Server-side HTML rendering in `templates.ts` (~1000 LOC)
- Raw HTTP server (no framework) — all routing/parsing is manual
- Custom SSE implementation

## Bugs Found and Fixed

### Tools default behavior (High — security)
- **Problem**: `PSYCHEROS_TOOLS` defaulted to all tools enabled when env var unset, contradicting `.env.example` docs that said "no tools enabled by default". This meant the shell tool (arbitrary command execution) was active by default.
- **Location**: `src/main.ts:22-24`
- **Fix**: Changed default from `return ["all"]` to `return []`

### Service worker cached stale assets (High — UX)
- **Problem**: Old SBy UI persisted in Chrome even after code updates. Cache name `sby-v4` and precache list referenced `/js/sby.js` (now `psycheros.js`).
- **Fix**: Renamed cache to `psycheros-v1`, updated asset list, old caches auto-purge

### Extra newlines in assistant messages (Medium — UX)
- **Problem**: CSS `white-space: pre-wrap` on `.assistant-text` preserved literal whitespace from HTML between `<p>` tags. Compounded by `breaks: true` in server-side marked config.
- **Fix**: Changed to `white-space: normal` and `breaks: false`

### `htmx:oobErrorNoTarget` on conversation switch (Low — console noise)
- **Problem**: OOB swap for `#header-title` had no target element in the header template.
- **Fix**: Added `<span id="header-title">` to header; conversation title now displays in header bar

### Identity files overwritten by entity (Medium — data loss on deploy)
- **Problem**: Entity writes to `identity/user/` files during chat, overwriting tracked git files. Solved by gitignoring identity directories and seeding from templates on first run.

## Security Fixes

### XSS in hx-confirm attribute (High)
- **Location**: `src/server/templates.ts:1110`
- **Problem**: `categoryLabel` and `displayName` interpolated into `hx-confirm` attribute without HTML escaping
- **Fix**: Wrapped with `escapeHtml()`

### XSS in background gallery onclick handlers (High)
- **Location**: `src/server/templates.ts:~2411-2416`
- **Problem**: `bg.url` and `bg.filename` interpolated into inline onclick handlers without escaping
- **Fix**: Added client-side `escapeAttr()` helper, applied to all interpolated values

### Request body size limits (Low)
- **Problem**: No Content-Length enforcement on most endpoints
- **Fix**: 1MB for JSON/form, 10MB for uploads, returns 413

### Error message sanitization (Low)
- **Problem**: 18 catch blocks leaked internal paths to clients
- **Fix**: Generic messages to clients, real errors logged server-side

## LLM Client Resilience (Session 17)

### No timeout on LLM API fetch (Critical — availability)
- **Problem**: `fetch()` call to Z.ai API had no timeout. If the API hung or was unreachable, Psycheros would block indefinitely — silent stall, no error, no logging.
- **Location**: `src/llm/client.ts` — `makeRequest()`
- **Fix**: Added `AbortController` with 30s connection timeout (configurable via `connectTimeout`). Throws `LLMError` with code `CONNECT_TIMEOUT`.

### No stall detection on streaming response (Critical — availability)
- **Problem**: `reader.read()` on the SSE stream body had no timeout. If the API accepted the connection (HTTP 200) then stopped sending data mid-stream, the reader blocked indefinitely.
- **Location**: `src/llm/client.ts` — `chatStream()` read loop
- **Fix**: Added `readWithTimeout()` wrapper with 60s stall timeout (configurable via `streamStallTimeout`). Cancels the reader on timeout to tear down the TCP connection. Throws `LLMError` with code `STREAM_STALL_TIMEOUT`.

### Silent malformed chunk swallowing (Medium — observability)
- **Problem**: `parseSSELine()` returned `null` on JSON parse failure, same as empty lines. Consumers silently skipped it. If the API sent consistently malformed data, the user got an empty response with no error.
- **Location**: `src/llm/client.ts` — `parseSSELine()`
- **Fix**: Returns `"malformed"` sentinel. After 5 consecutive malformed chunks, throws `LLMError` with code `MALFORMED_STREAM`.

### Generic error message hid failure category (Medium — observability)
- **Problem**: All LLM errors surfaced as `"An error occurred while processing your message"` — no distinction between timeout, network failure, rate limit, auth error, or server error. Status event sent raw JSON that the client displayed as a string.
- **Location**: `src/server/routes.ts` — chat catch block; `web/js/psycheros.js` — status event handler
- **Fix**: Error switch in routes.ts maps error codes to descriptive user-facing messages. Client-side parses JSON status events and displays error text with toast notification.

### No logging on LLM request lifecycle (Low — observability)
- **Problem**: Zero log output between context-loading and error catch. Impossible to tell from logs whether a request was sent, when connection established, or how long streaming took.
- **Location**: `src/llm/client.ts`
- **Fix**: Added `[LLM]` tagged logging: request send (model, message count, tools), connect timing, stream completion stats, abnormal stream termination warnings.

## Known Issues (deferred)

### Type errors in `src/tools/graph-read.ts`
- 4 type errors at lines 472, 477, 487, 492 — `as` casts from specific arg types to `Record<string, unknown>` that TypeScript rejects
- App runs fine (Deno doesn't type-check at runtime) but `deno check` fails on these
- Fix: Cast through `unknown` first, or make the tool registry generic over arg types

### sqlite-vec on macOS
- Native extensions available for both platforms: `lib/vec0.so` (Linux x86-64) and `lib/vec0.dylib` (macOS aarch64)
- sqlite-vec loads natively on both macOS and Docker — no fallback needed
- Auto-download: if no matching extension is found at startup, the correct binary is downloaded from GitHub releases (v0.1.9) and cached in `lib/`. Covers Windows as well.

### graph_create_edge rejects labels with cryptic JSON error (Medium — UX)
- `graph_create_edge` only accepted `fromId`/`toId` but entity naturally used `fromLabel`/`toLabel` (consistent with `graph_write_batch`)
- Undefined IDs passed to entity-core → Zod validation failure → MCP error returned as plain text → Psycheros `JSON.parse()` threw `SyntaxError`
- Fix: Added `fromLabel`/`toLabel` support with label-to-ID resolution via `getGraphNodes()` (exact case-insensitive match). Clear error messages for missing nodes.
- Initial fix used `searchGraphNodes()` (semantic search) which failed for short proper nouns — switched to direct node list lookup

### Phase 4: Resource Finalization & Startup Safety (Session 27)

#### FIXED: MCP connect race condition — fire-and-forget startup
- **Severity**: High — `mcpClient.connect()` was not awaited; server init ran in parallel. First request after startup could fail if MCP handshake hadn't completed.
- **Location**: `src/main.ts:108`
- **Fix**: `await mcpClient.connect()` with try/catch. Offline fallback behavior preserved.

#### FIXED: Prepared statements not finalized on error paths
- **Severity**: Medium (resource leak) — `stmt.get()`/`stmt.run()` could throw before `stmt.finalize()`, leaking statement handles
- **Locations**: `src/entity/loop.ts:339`, `src/lorebook/state-manager.ts:92`
- **Fix**: Wrapped in try/finally blocks for guaranteed finalization

#### FIXED: Shell tool abort listener leak
- **Severity**: Medium (memory leak) — abort event listener registered without `{ once: true }`, never removed on normal completion
- **Location**: `src/tools/shell.ts:98`
- **Fix**: Added `{ once: true }` option to `addEventListener`

#### FIXED: MCP transport not cleaned up on connect failure
- **Severity**: Medium (resource leak) — if `client.connect()` threw, transport and client objects were left dangling
- **Location**: `src/mcp-client/mod.ts:164`
- **Fix**: Cleanup in catch block: `client.close()`, then null both references

## Confirmed Safe Patterns

- All SQLite queries are parameterized
- User/assistant messages rendered through `marked` + `DOMPurify`
- `isValidFilename()` properly checks for path traversal
- Background upload generates safe filenames server-side
- Background delete handler regex blocks traversal after URL decoding
- Prepared statements wrapped in try/finally for guaranteed finalization

## Post-Alpha Fixes

### OpenRouter image generation payload incorrect (High — functionality)
- **Problem**: Sent `size` (DALL-E parameter) which OpenRouter doesn't support on `/chat/completions`. Used wrong `modalities` ordering. Base URL trailing slash produced double-slash 404s.
- **Locations**: `src/tools/generate-image.ts:192-199`
- **Fix**: Replaced `size` with `image_config` (`aspect_ratio`, `image_size`); changed `modalities` to `["image", "text"]`; strip trailing slash from base URL.

### `[IMAGE:...]` marker regex fragile (Medium — rendering)
- **Problem**: Four locations used `[^}]+` which fails when prompt/description contains `}` characters. Also, server-side template regex required `<p>` wrapper that markdown render doesn't always produce.
- **Locations**: `src/entity/loop.ts:788`, `src/server/templates.ts:1455,1673`, `src/server/routes.ts:6672`
- **Fix**: Changed to `.*` (lazy) pattern, consistent with existing `fadeImageMarker` regex. Removed `<p>` wrapper requirement from template regex.

- Tool execution serialized across concurrent turns via promise mutex in `ToolRegistry.executeAll()`, preventing race conditions on shared resources (identity files, knowledge graph, memories) when multiple turns run simultaneously (e.g., background stream + new conversation, Pulse + user chat)

See also: [security-audit.md](security-audit.md) for the full security assessment.

## Pulse System Bug Fixes

### Inactivity trigger rapid-fire (High — UX/exhaustion)
- **Problem**: `handleInactivityTick()` had no cooldown mechanism. Once the inactivity threshold was exceeded, the Pulse fired every minute (the cron tick interval). The `lastRunAt` guard present in `handleCronTick()` was missing from the inactivity handler.
- **Location**: `src/pulse/engine.ts` — `handleInactivityTick()`
- **Fix**: Added `lastRunAt` check — after firing, the Pulse won't fire again until the full threshold period has elapsed since the last run.

### Inactivity jitter window never fires for short thresholds (High — functionality)
- **Problem**: The jitter window was calculated as `threshold + [randomIntervalMin, randomIntervalMax]`. For a 4-min threshold, the window was 16.5–23.5 min instead of the intended 6.5–13.5 min. Combined with a max probability of 40% and only 1-2 tick chances, the Pulse frequently missed its window entirely. Additionally, once past the window, the Pulse was permanently suppressed (`elapsedMs > windowEndMs → return`).
- **Location**: `src/pulse/engine.ts` — `handleInactivityTick()` jitter logic
- **Fix**: Window now uses `randomIntervalMin/Max` as absolute elapsed times from the effective start. Upper window bound changed from hard return to fall-through, so the Pulse fires if the jitter window is missed.

### Inactivity trigger fires retroactively on enable (Medium — UX)
- **Problem**: The inactivity timer was based solely on `lastGlobalUserMessage`. Enabling a Pulse after the threshold had already elapsed caused it to fire immediately on the next tick.
- **Location**: `src/pulse/engine.ts` — `handleInactivityTick()` and `registerTriggers()`
- **Fix**: Track `inactivityEnabledAt` per Pulse (set to `Date.now()` on registration). Effective start time is `max(enabledAt, lastUserMessage)`. User activity still resets the clock as expected.

### Pulse run duration stored as literal SQL string (Medium — data integrity)
- **Problem**: `completePulseRun()` passed a CAST expression as a string parameter value instead of inlining it in the SQL. This stored `"CAST(...)"` as the duration_ms value and caused "column index out of range" errors (9 values for 8 placeholders).
- **Location**: `src/db/client.ts` — `completePulseRun()`
- **Fix**: Inlined the CAST expression in the SQL statement and adjusted parameter order to match the 8 placeholders.

### Pulse errors not reported to client (Medium — UX)
- **Problem**: When a visible Pulse failed (LLM error, etc.), the catch block only logged to console and updated the DB. No notification was sent to the client — the chat bar stayed active and no error toast appeared.
- **Location**: `src/pulse/engine.ts` — `executePulse()` catch block
- **Fix**: On error, broadcast `status` event with error details and `done` event with `"error"` to trigger the client's error UI (red toast + inline error message).

### Pulse streaming lost on SSE reconnection (Medium — UX)
- **Problem**: Pulse responses stream via the persistent SSE channel. If the EventSource connection drops during the inactivity wait (common on WSL2), all streaming events are lost. The user sees no response until manually refreshing.
- **Location**: `src/pulse/engine.ts` — `executePulse()`; `web/js/psycheros.js` — persistent SSE handlers
- **Fix**: Added `pulse_complete` event broadcast after Pulse execution (success or error). Client-side handler detects if streaming was missed (`pulseAssistantEl === null`) and reloads the conversation from the server.

## Multi-Provider LLM Profiles

### Profile save race condition (High — data loss)
- **Problem**: Adding a new LLM profile used a client-side read-modify-write flow (GET all settings, push new profile, POST back). If the GET returned stale data (e.g., from cache, race condition, or HTMX page swap), existing profiles would be silently overwritten.
- **Location**: `src/server/templates.ts` — `saveProfile()` JS; `src/server/routes.ts` — `handleSaveLLMSettings()`
- **Fix**: Added `POST /api/llm-settings/profile` endpoint that handles add/update atomically on the server. The client now sends just the profile object; the server reads current settings, merges the profile in, and saves. The bulk `POST /api/llm-settings` is kept only for delete operations.

### Test connection credential mixing (Medium — security)
- **Problem**: `handleTestLLMConnection` fell back to the active profile's API key when the test profile's key was empty — even if the test profile had a different base URL. This could send requests to one provider with another provider's credentials.
- **Location**: `src/server/routes.ts` — `handleTestLLMConnection()`
- **Fix**: Credential fallback only triggers when ALL three values (baseUrl, apiKey, model) are empty on the test profile.

### Worker model thinking not disabled (Medium — unnecessary tokens)
- **Problem**: `createClientFromProfile()` with `useWorker: true` still had `thinkingEnabled` from the profile, causing lightweight tasks (auto-titling) to request chain-of-thought reasoning unnecessarily.
- **Location**: `src/llm/client.ts` — `createClientFromProfile()`
- **Fix**: `thinkingEnabled` defaults to `false` when `useWorker: true`, unless explicitly overridden.

## Memory System Bug Fixes

### Significant memories not indexed into RAG or synced to MCP (High — functionality)
- **Problem**: When the entity created a significant memory via the `create_significant_memory` tool, the file was written to disk but never indexed into RAG or synced to entity-core. The web UI path correctly called `reindexFile()` and `createMemory()` after writing, but the tool path only wrote the file. Significant memories were invisible to RAG search until the next server restart.
- **Location**: `src/tools/create-significant-memory.ts` — `execute()`; `src/entity/loop.ts` — `EntityConfig`
- **Fix**: Added `memoryIndexer` to `EntityConfig` (threaded from server through routes and pulse engine). The tool now calls `memoryIndexer.reindexFile()` and `mcpClient.createMemory()` after writing, both with non-fatal error handling. Existing significant memories on disk are unaffected — `indexAll()` on startup already indexes them.
