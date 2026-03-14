# Code Review Findings

Status: **Complete** — all critical and high-severity issues fixed.

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
- Native extension `lib/vec0.so` is x86-64 Linux only — falls back to in-memory cosine similarity on macOS
- Acceptable for local dev; loads natively in Docker container

## Confirmed Safe Patterns

- All SQLite queries are parameterized
- User/assistant messages rendered through `marked` + `DOMPurify`
- `isValidFilename()` properly checks for path traversal
- Background upload generates safe filenames server-side
- Background delete handler regex blocks traversal after URL decoding

See also: [security-audit.md](security-audit.md) for the full security assessment.
