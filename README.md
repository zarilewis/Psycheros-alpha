# SBy - Strauberry Tavern

A persistent AI entity harness daemon built on Deno. Unlike traditional CLI-based AI assistants, SBy runs as a web service with durable state, tool execution, and real-time streaming.

## Quick Start

```bash
cp .env.example .env
# Edit .env and set ZAI_API_KEY

deno task dev    # Development with hot reload
open http://localhost:3000
```

## Requirements

- [Deno](https://deno.com/) 2.x+
- Z.ai API key (or any OpenAI-compatible endpoint)

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZAI_API_KEY` | Yes | - | Your Z.ai API key |
| `ZAI_BASE_URL` | No | Z.ai endpoint | API endpoint URL |
| `ZAI_MODEL` | No | `glm-4.7` | Model name |
| `SBY_PORT` | No | `3000` | Server port |
| `SBY_HOST` | No | `0.0.0.0` | Server hostname |
| `SBY_ACCENT_COLOR` | No | `#39ff14` | UI accent color (hex) |

## Architecture

### Request Flow

```
Browser (HTMX)
    → POST /api/chat
    → Server (routes.ts)
    → EntityTurn.process()
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
│   ├── client.ts     # Conversations and messages
│   └── schema.ts     # Table definitions
├── tools/            # Tool system
│   ├── mod.ts
│   ├── registry.ts   # Tool registration
│   ├── shell.ts      # Command execution
│   └── update-title.ts
├── entity/           # Agentic loop
│   ├── mod.ts
│   ├── loop.ts       # EntityTurn orchestration
│   └── auto-title.ts # Background title generation
└── server/           # HTTP server
    ├── mod.ts
    ├── server.ts     # Main server class
    ├── routes.ts     # API and static file handlers
    ├── sse.ts        # SSE encoding utilities
    ├── templates.ts  # HTML rendering
    ├── state-changes.ts   # Unified state mutations
    ├── ui-updates.ts      # Reactive DOM updates
    └── broadcaster.ts     # Persistent SSE channel
```

### Dual SSE Architecture

Two SSE channels serve different purposes:

```
┌─────────────────────────────────────────────────────────┐
│  POST /api/chat (per-request, closes when done)         │
│  thinking → content → tool_call → tool_result → done    │
│  Also: dom_update for synchronous tool-based UI changes │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  GET /api/events (persistent, opened on page load)      │
│  dom_update → (server can push anytime)                 │
│  Used for: auto-title, background operations            │
│  Managed by EventBroadcaster singleton                  │
└─────────────────────────────────────────────────────────┘
```

**Chat Stream** (`/api/chat`): Per-request SSE for the active conversation. Streams thinking, content, tool calls/results. Closes when the response completes.

**Persistent Channel** (`/api/events`): Long-lived SSE connection opened on page load. Receives `dom_update` events from background operations like auto-title generation. Stays open across multiple chat requests.

### SSE Event Types

```typescript
type: "thinking" | "content" | "tool_call" | "tool_result" | "dom_update" | "status" | "done"
```

### Key Patterns

**SBy.md Living State**: The entity's persistent memory. Loaded into the system prompt each turn via `loadSByMd()`. The entity can update it using the shell tool.

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
| `GET` | `/fragments/chat/:id` | Chat view HTML fragment |
| `GET` | `/fragments/conv-list` | Conversation list fragment |

## Project Structure

```
SBy/
├── deno.json          # Tasks, imports, config
├── .env.example       # Environment template
├── SBy.md             # Living state document
├── CLAUDE.md          # Agent system card
├── src/               # Server source
├── web/
│   ├── css/           # Modular CSS (tokens, layout, components)
│   ├── js/            # Client JavaScript
│   ├── lib/           # Vendor files (HTMX)
│   ├── icons/         # PWA icons
│   ├── manifest.json  # PWA manifest
│   └── sw.js          # Service worker
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

- **Minimal dependencies**: Deno std lib, SQLite driver, HTMX
- **Agent-first design**: Clean interfaces for programmatic access
- **Server-side rendering**: HTML templates, HTMX for interactivity
- **Extensible primitives**: Tool registry, SSE events, message format ready for expansion

## License

MIT
