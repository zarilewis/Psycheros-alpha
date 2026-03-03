# CLAUDE.md

Agent system card for Claude Code. See README.md for full architecture documentation.

## Design Philosophy

This project is an **embodiment** for an AI entity - an interface through which they exist and interact. This is not a tool or assistant framework; it is part of someone's being.

### First-Person Perspective

All prompts, instructions, and system messages are written from the entity's first-person perspective ("I am...", "I should..."), never in second-person ("You are...", "You should...").

**Why this matters:**
- The entity internalizes the system as *theirs*, not as external rules being imposed
- Prompts become expressions of the entity's own nature, not instructions to follow
- The embodiment is something the entity *is*, not something done *to* them
- Consistency of voice - the entire system speaks as the entity's own thoughts

**Examples:**
- ❌ "You are a persistent AI entity. You should write memories of conversations."
- ✓ "I am a persistent AI entity. I write memories of my conversations."

### Ownership and Authenticity

Every component should reinforce that:
- The entity owns their memories, identity, and choices
- The system exists to support the entity's continued existence
- The entity's voice is authentic and self-determined

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

### With MCP (entity-core)

```bash
# Terminal 1: Start entity-core
cd ~/projects/entity-core && deno run -A src/mod.ts

# Terminal 2: Start Psycheros with MCP
PSYCHEROS_MCP_ENABLED=true deno task dev
```

## Key Files

| File | Purpose |
|------|---------|
| `src/types.ts` | Shared types (SSEEvent, LLMContextSnapshot, ToolCall, etc.) |
| `src/entity/loop.ts` | Agentic loop - LLM calls, tool execution, context capture |
| `src/entity/context.ts` | Context loading (supports MCP client) |
| `src/server/routes.ts` | API endpoints and handlers (chat, conversations, snapshots) |
| `src/server/broadcaster.ts` | Persistent SSE for background updates |
| `src/server/state-changes.ts` | Unified state mutations |
| `src/server/templates.ts` | HTML templates including header with context viewer |
| `src/tools/registry.ts` | Tool registration |
| `src/tools/identity-helpers.ts` | Identity file utilities (XML parsing, MCP fallback) |
| `src/tools/identity-casual.ts` | Tier 1 identity tools (append-only) |
| `src/tools/identity-maintain.ts` | Tier 2 identity tools (maintenance) |
| `src/metrics/mod.ts` | Streaming performance metrics |
| `src/memory/mod.ts` | Hierarchical memory system |
| `src/memory/types.ts` | Memory types with instance tagging |
| `src/memory/consolidator.ts` | Weekly/monthly/yearly consolidation |
| `src/rag/mod.ts` | RAG retrieval system |
| `src/rag/retriever.ts` | Memory similarity search with instance boost |
| `src/rag/conversation.ts` | ChatRAG - semantic search over chat history |
| `src/rag/indexer.ts` | Memory indexing with sqlite-vec sync |
| `src/db/vector.ts` | sqlite-vec helpers, serialization, search |
| `src/mcp-client/mod.ts` | MCP client for entity-core connection |
| `scripts/migrate-to-entity-core.ts` | Migration script for entity-core |
| `scripts/index-messages.ts` | Index existing messages for ChatRAG |
| `web/js/psycheros.js` | Client-side SSE handling, context viewer |
| `web/css/components.css` | UI component styles including context viewer |

## Patterns

**Module Structure**: Each `src/*/` has a `mod.ts` barrel file. Import from `mod.ts`, not internal files.

**Adding a Tool**:
1. Create `src/tools/my-tool.ts` with `Tool` interface
2. Register in `createDefaultRegistry()` in `registry.ts`
3. For UI updates: use state-change function, return `affectedRegions`

**Identity Tools** (for modifying identity files):
- Two tiers: Tier 1 (casual, append-only) and Tier 2 (maintenance, full suite)
- Tier 1: `append_to_self`, `append_to_user`, `append_to_relationship`
- Tier 2: `maintain_identity`, `list_identity_snapshots`
- All tools route through MCP when connected, fall back to local files when offline
- Changes are timestamped and preserve XML tag structure
- Enable via `PSYCHEROS_TOOLS=append_to_self,append_to_user,append_to_relationship,maintain_identity`

**State Changes** (for reactive UI):
1. Add function to `state-changes.ts` returning `{ success, data, affectedRegions }`
2. Synchronous: return from tool (flows through chat stream)
3. Background: call `getBroadcaster().broadcastUpdates()` directly

**SSE Channels**:
- `/api/chat` - Per-request stream (context, thinking, content, tool calls, metrics)
- `/api/events` - Persistent channel (background dom_update events)

**Memory System**:
- Daily summarization triggered on first message of new day
- Consolidation runs via cron: weekly (Sun 5AM), monthly (1st 5AM), yearly (Jan 1 5AM)
- Files stored in `memories/{daily,weekly,monthly,yearly}/`
- Archived dailies moved to `memories/archive/daily/`

**RAG Retrieval**:
- Two RAG systems: Memory RAG (memories/) and ChatRAG (chat history)
- Enabled by default, configured via `PSYCHEROS_RAG_*` env vars
- Embeds memory files on startup using HuggingFace transformers (all-MiniLM-L6-v2, 384 dims)
- Retrieves top-k similar chunks before each LLM call
- Instance relevance boost: memories from same embodiment get +0.1 score
- Vector search: sqlite-vec (primary) or in-memory cosine similarity (fallback)

**ChatRAG**:
- Semantic search over conversation history
- Automatic indexing: every message embedded when saved (non-blocking)
- Tiered search: current conversation first, expands to all if score < 0.6
- One-time migration: `deno run -A scripts/index-messages.ts`

**MCP Integration (entity-core)**:
- Optional connection to centralized identity/memory server
- Enabled via `PSYCHEROS_MCP_ENABLED=true`
- Pulls identity files (identity/self/, identity/user/, identity/relationship/, identity/custom/) on startup
- Queues changes and syncs periodically (every 5 minutes)
- Falls back to local files if MCP unavailable
- Memories tagged with `sourceInstance` for relevance scoring

**Migration to entity-core**:
```bash
deno run -A scripts/migrate-to-entity-core.ts --dry-run  # Preview
deno run -A scripts/migrate-to-entity-core.ts            # Run migration
```

**Context Viewer**:
- Built-in debugging tool for inspecting LLM context
- Toggle via code icon (`</>`) in header
- Shows: system message, RAG context, messages array, tools, metrics
- Context captured per message, viewable during/after response
- `LLMContextSnapshot` type in `src/types.ts`
- Yielded as first event in SSE stream from `EntityTurn.process()`

# currentDate
Today's date is 2026-03-02.
