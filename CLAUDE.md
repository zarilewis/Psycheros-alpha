# CLAUDE.md

Agent system card for Claude Code. See README.md for full architecture documentation.

## Commands

```bash
deno task dev          # Development with hot reload
deno task start        # Production mode
deno task stop         # Graceful shutdown
deno check src/main.ts # Type check
deno lint              # Lint
```

## Setup

```bash
cp .env.example .env   # Then set ZAI_API_KEY
```

## Key Files

| File | Purpose |
|------|---------|
| `src/entity/loop.ts` | Agentic loop - LLM calls, tool execution |
| `src/server/routes.ts` | API endpoints and handlers |
| `src/server/broadcaster.ts` | Persistent SSE for background updates |
| `src/server/state-changes.ts` | Unified state mutations |
| `src/tools/registry.ts` | Tool registration |
| `src/metrics/mod.ts` | Streaming performance metrics |
| `src/memory/mod.ts` | Hierarchical memory system |
| `src/memory/consolidator.ts` | Weekly/monthly/yearly consolidation |
| `src/rag/mod.ts` | RAG retrieval system |
| `src/rag/retriever.ts` | Memory similarity search |
| `web/js/sby.js` | Client-side SSE handling |

## Patterns

**Module Structure**: Each `src/*/` has a `mod.ts` barrel file. Import from `mod.ts`, not internal files.

**Adding a Tool**:
1. Create `src/tools/my-tool.ts` with `Tool` interface
2. Register in `createDefaultRegistry()` in `registry.ts`
3. For UI updates: use state-change function, return `affectedRegions`

**State Changes** (for reactive UI):
1. Add function to `state-changes.ts` returning `{ success, data, affectedRegions }`
2. Synchronous: return from tool (flows through chat stream)
3. Background: call `getBroadcaster().broadcastUpdates()` directly

**SSE Channels**:
- `/api/chat` - Per-request stream (thinking, content, tool calls, metrics)
- `/api/events` - Persistent channel (background dom_update events)

**Memory System**:
- Daily summarization triggered on first message of new day
- Consolidation runs via cron: weekly (Sun 5AM), monthly (1st 5AM), yearly (Jan 1 5AM)
- Files stored in `memories/{daily,weekly,monthly,yearly}/`
- Archived dailies moved to `memories/archive/daily/`

**RAG Retrieval**:
- Enabled by default, configured via `SBY_RAG_*` env vars
- Embeds memory files on startup using HuggingFace transformers
- Retrieves top-k similar chunks before each LLM call
