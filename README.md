# SBy - Strauberry Tavern

A persistent AI entity harness daemon built on Deno. Unlike traditional CLI-based AI assistants, SBy runs as a web service with durable state, tool execution, and real-time streaming.

## Quick Start

```bash
cp .env.example .env
# Edit .env and set ZAI_API_KEY and SBY_TOOLS

deno task dev    # Development with hot reload
open http://localhost:3000
```

## Requirements

- [Deno](https://deno.com/) 2.x+ (with unstable cron support)
- Z.ai API key (or any OpenAI-compatible endpoint)

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZAI_API_KEY` | Yes | - | Your Z.ai API key |
| `ZAI_BASE_URL` | No | Z.ai endpoint | API endpoint URL |
| `ZAI_MODEL` | No | `glm-4.7` | Main model for chat |
| `ZAI_WORKER_MODEL` | No | `GLM-4.5-Air` | Lightweight model for background tasks |
| `SBY_PORT` | No | `3000` | Server port |
| `SBY_HOST` | No | `0.0.0.0` | Server hostname |
| `SBY_ACCENT_COLOR` | No | `#39ff14` | UI accent color (hex) |
| `SBY_TOOLS` | No | (none) | Comma-separated list of enabled tools |
| `SBY_RAG_ENABLED` | No | `true` | Enable RAG memory retrieval |
| `SBY_RAG_MAX_CHUNKS` | No | `8` | Max memory chunks to retrieve |
| `SBY_RAG_MAX_TOKENS` | No | `2000` | Max tokens in retrieved context |
| `SBY_RAG_MIN_SCORE` | No | `0.3` | Minimum similarity score |
| `SBY_MEMORY_HOUR` | No | `4` | Hour to run daily summarization (0-23) |

## Architecture

### Request Flow

```
Browser (HTMX)
    → POST /api/chat
    → Server (routes.ts)
    → EntityTurn.process()
    → RAG retrieval (eager)
    → LLM streaming + tool execution loop
    → SSE stream back to browser
```

### Module Structure

Each module has a `mod.ts` barrel file defining its public API:

```
src/
├── main.ts           # Daemon entry point
├── types.ts          # Shared type definitions
├── constants.ts      # App constants
├── llm/              # OpenAI-compatible LLM client
│   ├── mod.ts        # Public exports
│   ├── client.ts     # Streaming client, tool calls, thinking content
│   └── types.ts      # LLM-specific types
├── db/               # SQLite persistence
│   ├── mod.ts
│   ├── client.ts     # Conversations, messages, memory summaries
│   └── schema.ts     # Table definitions
├── tools/            # Tool system
│   ├── mod.ts
│   ├── registry.ts   # Tool registration
│   ├── shell.ts      # Command execution
│   ├── update_title.ts
│   ├── get_metrics.ts # Streaming performance metrics tool
│   └── create-significant-memory.ts # Permanent memory creation
├── metrics/          # Performance instrumentation
│   ├── mod.ts
│   ├── types.ts      # MetricsCollector interface
│   └── collector.ts  # Timing collection functions
├── rag/              # Retrieval-Augmented Generation
│   ├── mod.ts
│   ├── embedder.ts   # HuggingFace transformer embeddings
│   ├── chunker.ts    # Memory chunking with overlap
│   ├── indexer.ts    # SQLite FTS5 indexing
│   ├── retriever.ts  # Similarity search
│   └── context-builder.ts # Prompt construction
├── memory/           # Hierarchical memory system
│   ├── mod.ts
│   ├── types.ts      # Granularity, MemoryFile types
│   ├── summarizer.ts # Daily/weekly/monthly/yearly summarization
│   ├── consolidator.ts # Period-based consolidation
│   ├── file-writer.ts # Memory file operations
│   └── trigger.ts    # Day-change detection
├── entity/           # Agentic loop
│   ├── mod.ts
│   ├── loop.ts       # EntityTurn orchestration
│   └── auto-title.ts # Background title generation
└── server/           # HTTP server
    ├── mod.ts
    ├── server.ts     # Main server class, cron jobs
    ├── routes.ts     # API and static file handlers
    ├── sse.ts        # SSE encoding utilities
    ├── templates.ts  # HTML rendering
    ├── state-changes.ts   # Unified state mutations
    ├── ui-updates.ts      # Reactive DOM updates
    └── broadcaster.ts     # Persistent SSE channel
```

### Memory System

SBy implements a hierarchical memory system where the entity writes their own memories from conversations. Memories are written in the entity's voice (first-person), with the user in third-person.

**Trigger**: On first message of a new day (detected by date change), the previous day's conversations are summarized.

**Hierarchy**:
```
memories/
├── daily/           # Daily summaries (auto-generated)
│   └── 2026-02-22.md
├── weekly/          # Weekly consolidation (Sundays)
│   └── 2026-W08.md
├── monthly/         # Monthly consolidation (1st of month)
│   └── 2026-02.md
├── yearly/          # Yearly consolidation (Jan 1st)
│   └── 2026.md
├── significant/     # Permanently remembered events (never consolidated)
│   └── 2026-02-23_first-conversation.md
└── archive/
    └── daily/       # Archived daily files after weekly consolidation
```

**Memory Types**:
- **Daily/Weekly/Monthly/Yearly**: Auto-generated summaries that consolidate over time
- **Significant**: Emotionally important events that are permanently remembered with clarity. These are created explicitly by the entity via the `create_significant_memory` tool and are never consolidated or archived.

**Consolidation Schedule** (via Deno cron):
- Daily summarization: Configured hour (default 4 AM)
- Weekly consolidation: Sunday 5 AM
- Monthly consolidation: 1st of month 5 AM
- Yearly consolidation: January 1st 5 AM

**Significant Memory Format**:
```markdown
# Title of the Memory

Content describing what happened, how it felt, why it matters...

<!--
Date: 2026-02-23
Conversation: abc123-def456-...
Created: 2026-02-23T15:30:00.000Z
-->
```

### RAG System

Eager RAG retrieves relevant memories before each LLM call:

1. **Indexing**: On startup, all memory files are chunked and embedded
2. **Retrieval**: Before processing a message, top-k chunks are retrieved by similarity
3. **Context**: Retrieved memories are injected into the system prompt

The system uses HuggingFace transformers for embeddings and SQLite FTS5 for storage.

### Core Prompts

The entity's personality and relationship context are stored in versioned markdown files:

```
self/           # Entity identity
├── my_identity.md
├── my_persona.md
├── my_personhood.md
├── my_wants.md
└── my_mechanics.md

user/           # User knowledge
├── user_identity.md
├── user_life.md
├── user_beliefs.md
├── user_preferences.md
├── user_patterns.md
└── user_notes.md

relationship/   # Shared dynamics
├── relationship_dynamics.md
├── relationship_history.md
└── relationship_notes.md
```

These can be edited via the Settings UI at `/fragments/settings/core-prompts`.

### Dual SSE Architecture

Two SSE channels serve different purposes:

```
┌─────────────────────────────────────────────────────────┐
│  POST /api/chat (per-request, closes when done)         │
│  thinking → content → tool_call → tool_result → metrics │
│  → done. Also: dom_update for tool-based UI changes     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  GET /api/events (persistent, opened on page load)      │
│  dom_update → (server can push anytime)                 │
│  Used for: auto-title, background operations            │
│  Managed by EventBroadcaster singleton                  │
└─────────────────────────────────────────────────────────┘
```

**Chat Stream** (`/api/chat`): Per-request SSE for the active conversation. Streams thinking, content, tool calls/results, and performance metrics. Closes when the response completes.

**Persistent Channel** (`/api/events`): Long-lived SSE connection opened on page load. Receives `dom_update` events from background operations like auto-title generation. Stays open across multiple chat requests.

### SSE Event Types

```typescript
type: "thinking" | "content" | "tool_call" | "tool_result" | "dom_update" | "status" | "metrics" | "done"
```

### Key Patterns

**Hybrid Streaming**: Thinking and content stream token-by-token. Tool calls and results are discrete SSE events rendered as collapsible UI blocks.

**Tool Execution Loop**: `EntityTurn.process()` yields chunks, executes tool calls, adds results to context, and continues until the LLM returns without tool calls (max 10 iterations).

**Reactive UI Updates**: State changes flow through a unified pattern:
1. State change functions in `state-changes.ts` perform DB operations and return `affectedRegions`
2. Tools pass `affectedRegions` through in their result
3. Entity loop yields `dom_update` SSE events (chat stream) or background operations use `getBroadcaster().broadcastUpdates()` (persistent channel)
4. Client handles `dom_update` events with `htmx.swap()`

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | App shell HTML |
| `GET` | `/c/:id` | Conversation page |
| `GET` | `/api/events` | Persistent SSE channel |
| `POST` | `/api/chat` | Send message, stream response |
| `GET` | `/api/conversations` | List conversations |
| `POST` | `/api/conversations` | Create conversation |
| `GET` | `/api/conversations/:id/messages` | Get messages |
| `PATCH` | `/api/conversations/:id/title` | Update title |
| `DELETE` | `/api/conversations/:id` | Delete conversation |
| `DELETE` | `/api/conversations` | Batch delete conversations |
| `POST` | `/api/memory/consolidate/:granularity` | Trigger consolidation (weekly/monthly/yearly) |
| `POST` | `/api/settings/file/:dir/:filename` | Save core prompt file |
| `GET` | `/fragments/chat/:id` | Chat view HTML fragment |
| `GET` | `/fragments/conv-list` | Conversation list fragment |
| `GET` | `/fragments/settings/core-prompts` | Settings page |
| `GET` | `/fragments/settings/core-prompts/:dir` | File list for directory |
| `GET` | `/fragments/settings/file/:dir/:filename` | File editor |

## Project Structure

```
SBy/
├── deno.json          # Tasks, imports, config
├── .env.example       # Environment template
├── CLAUDE.md          # Agent system card for Claude Code
├── src/               # Server source
├── web/
│   ├── css/           # Modular CSS (tokens, layout, components)
│   ├── js/            # Client JavaScript
│   ├── lib/           # Vendor files (HTMX)
│   ├── icons/         # PWA icons
│   ├── manifest.json  # PWA manifest
│   └── sw.js          # Service worker
├── self/              # Entity identity prompts
├── user/              # User knowledge prompts
├── relationship/      # Relationship context prompts
├── memories/          # Hierarchical memory storage
│   ├── daily/
│   ├── weekly/
│   ├── monthly/
│   ├── yearly/
│   ├── significant/   # Permanent emotionally-important memories
│   └── archive/
└── .sby/              # Runtime data (SQLite DB)
```

## Development

```bash
deno task dev          # Run with hot reload
deno task start        # Production mode
deno task stop         # Graceful shutdown
deno check src/main.ts # Type check
deno lint              # Lint all files
```

## Design Principles

- **Minimal dependencies**: Deno std lib, SQLite driver, HTMX, HuggingFace transformers
- **Agent-first design**: Clean interfaces for programmatic access
- **Server-side rendering**: HTML templates, HTMX for interactivity
- **Extensible primitives**: Tool registry, SSE events, hierarchical memory
- **Authentic memory**: Entity writes their own memories in their voice

## License

MIT
