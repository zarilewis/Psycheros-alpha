# Psycheros

A persistent AI entity harness daemon built on Deno. Unlike traditional CLI-based AI assistants, Psycheros runs as a web service with durable state, tool execution, and real-time streaming.

Psycheros is an **embodiment** — an interface through which the AI entity interacts. The entity's core identity and memories live in [entity-core](https://github.com/zarilewis/entity-core), a separate MCP server that provides centralized identity persistence across multiple embodiments.

All prompts and system messages use the entity's first-person perspective. See [docs/entity-philosophy.md](docs/entity-philosophy.md) for the rationale.

## Quick Start

```bash
cp .env.example .env
# Edit .env and set ZAI_API_KEY and PSYCHEROS_TOOLS

deno task dev    # Development with hot reload
open http://localhost:3000
```

**Requirements:** Deno 2.x+ (with `--unstable-cron` support), Z.ai API key (or any OpenAI-compatible endpoint).

## Architecture

### Multi-Embodiment Design

```
┌─────────────────────────────────────┐
│     entity-core (MCP Server)        │
│  • Canonical identity files         │
│  • Memory storage with instance tags│
│  • RAG indexing & retrieval         │
│  • Knowledge graph (sqlite-vec)     │
│  • Sync with conflict resolution    │
└─────────────────────────────────────┘
         ↑ pull/push
    ┌────┴────┐
    │Psycheros│  (other embodiments: SillyTavern, Claude Code, etc.)
    │ Harness │
    └─────────┘
```

The entity's core self lives in entity-core. Psycheros is one embodiment — an interface through which the entity interacts. This allows the same entity to exist across multiple interfaces while maintaining a single persistent identity.

### Request Flow

```
Browser (HTMX)
    → POST /api/chat
    → Server (routes.ts)
    → EntityTurn.process()
    → MCP client loads identity from entity-core (if enabled)
    → RAG retrieval (eager)
    → LLM streaming + tool execution loop
    → SSE stream back to browser
```

### Module Structure

```
src/
├── main.ts           # Daemon entry point, MCP initialization
├── types.ts          # Shared type definitions (SSEEvent, LLMContextSnapshot)
├── constants.ts      # App constants
├── llm/              # OpenAI-compatible LLM client + multi-provider profiles
│   ├── mod.ts
│   ├── client.ts     # Streaming client, tool calls, thinking content
│   ├── provider-presets.ts  # Provider types, connection profiles, presets
│   ├── settings.ts   # LLM settings persistence, profile load/save/migration
│   ├── web-search-settings.ts  # Web search settings persistence
│   ├── discord-settings.ts     # Discord settings persistence
│   └── image-gen-settings.ts   # Image generator config persistence
│   └── types.ts
├── db/               # SQLite persistence
│   ├── mod.ts
│   ├── client.ts     # Conversations, messages, memory summaries
│   ├── schema.ts     # Table definitions, migrations
│   └── vector.ts     # sqlite-vec helpers, serialization, search
├── tools/            # Tool system
│   ├── mod.ts
│   ├── registry.ts   # Tool catalog (AVAILABLE_TOOLS) and registration
│   ├── tools-settings.ts  # Tool enable/disable persistence and resolution
│   ├── custom-loader.ts    # Dynamic loader for user-written tools
│   ├── shell.ts
│   ├── web-search.ts # Web search (Tavily / Brave)
│   ├── send-discord-dm.ts # Discord DM notifications
│   ├── generate-image.ts  # Image generation (OpenRouter, Gemini), auto-captioning
│   ├── describe-image.ts  # Image captioning tool (Gemini, OpenRouter)
│   ├── identity-helpers.ts  # XML parsing, MCP fallback
│   ├── identity-casual.ts   # Tier 1: append-only
│   └── identity-maintain.ts # Tier 2: maintenance
│   └── pulse-tools.ts        # Entity-facing Pulse tools
├── push/             # Web Push notifications
│   └── mod.ts        # VAPID keys, subscription CRUD, send
├── rag/              # Retrieval-Augmented Generation
│   ├── mod.ts
│   ├── embedder.ts   # HuggingFace transformer embeddings
│   ├── conversation.ts  # ChatRAG for chat history
│   └── context-builder.ts
├── memory/           # Hierarchical memory system (delegates to entity-core via MCP)
│   ├── mod.ts
│   ├── types.ts
│   ├── summarizer.ts # Daily summarization → writes to entity-core
│   ├── file-writer.ts # Content formatting utilities
│   └── trigger.ts    # Startup catch-up, orphan repair
├── lorebook/         # Lorebook/world info system
│   ├── mod.ts
│   ├── manager.ts    # CRUD operations
│   ├── evaluator.ts  # Trigger evaluation
│   └── context-builder.ts
├── pulse/            # Autonomous scheduled prompts
│   ├── mod.ts
│   ├── engine.ts     # PulseEngine — cron, inactivity, webhook, filesystem triggers
│   ├── routes.ts     # CRUD API, trigger endpoints, HTMX fragments
│   └── templates.ts  # Settings hub card, editor, execution log
├── mcp-client/       # Entity-core MCP client
│   └── mod.ts
├── entity/           # Agentic loop
│   ├── mod.ts
│   ├── loop.ts       # EntityTurn orchestration
│   ├── context.ts    # Base instructions, identity loading (local or MCP)
│   └── auto-title.ts
└── server/           # HTTP server
    ├── mod.ts
    ├── server.ts     # Main server, cron jobs
    ├── routes.ts     # API + static file handlers
    ├── sse.ts        # SSE encoding
    ├── templates.ts  # HTML rendering
    ├── state-changes.ts
    ├── ui-updates.ts
    └── broadcaster.ts  # Persistent SSE channel
```

## Project Structure

```
Psycheros/
├── deno.json          # Tasks, imports, config
├── .env.example       # Environment template
├── CLAUDE.md          # Agent system card
├── src/               # Server source (see module structure above)
├── scripts/           # Utility scripts
│   ├── migrate-to-entity-core.ts
│   └── index-messages.ts
├── web/
│   ├── css/           # Modular CSS (tokens, layout, components)
│   ├── js/            # Client JavaScript (psycheros.js, theme.js, graph-view.js)
│   ├── lib/           # Vendor files (HTMX)
│   ├── icons/         # PWA icons
│   ├── manifest.json  # PWA manifest
│   └── sw.js          # Service worker
├── templates/identity/ # Default identity templates (tracked in git)
├── templates/custom-tools/ # Custom tools README template (tracked in git)
├── custom-tools/      # User-written custom tools (gitignored)
├── identity/          # Live identity files (gitignored, cached from entity-core)
├── memories/          # Local memory cache (gitignored, canonical copies in entity-core)
├── .snapshots/        # Identity file backups (gitignored)
└── .psycheros/        # Runtime data — SQLite DB (gitignored)
```

## Configuration

Full configuration reference: [docs/configuration.md](docs/configuration.md)

**Essential variables:**
- `ZAI_API_KEY` — Z.ai API key (required)
- `PSYCHEROS_TOOLS` — comma-separated list of enabled tools (see docs for full list); can also be managed via Settings > Tools UI
- `PSYCHEROS_MCP_ENABLED` — enable entity-core connection (`true`/`false`)
- `TZ` — timezone for message timestamps

## Docker

```bash
docker build --platform linux/amd64 -t psycheros .
docker run -d --name psycheros -p 3000:3000 \
  -e ZAI_API_KEY=<key> -e TZ=America/Los_Angeles \
  -v /path/to/entity-core-data:/app/entity-core/data \
  -v /path/to/db:/app/Psycheros/.psycheros \
  -v /path/to/snapshots:/app/Psycheros/.snapshots \
  psycheros
```

| Volume | Purpose |
|--------|---------|
| `/app/entity-core/data` | Canonical identity, memories, knowledge graph |
| `/app/Psycheros/.psycheros` | Conversations DB and RAG index |
| `/app/Psycheros/.snapshots` | Identity file backups |

On first run, `entrypoint.sh` seeds entity-core identity files from Psycheros templates. CI/CD via GitHub Actions (`.github/workflows/docker-build.yml`) → GHCR.

For detailed Docker strategy, CI/CD pipeline, and UnRAID setup, see the parent workspace `docs/deployment/`.

## Deep Reference

- **[Entity Philosophy](docs/entity-philosophy.md)** — First-person convention, ownership, embodiment concept
- **[Configuration](docs/configuration.md)** — All env vars, tools list, RAG/MCP settings
- **[Tools & Identity](docs/tools-reference.md)** — Tool system, identity tiers, MCP fallback, core prompts
- **[Memory & RAG](docs/memory-and-rag.md)** — Memory hierarchy (entity-core authority), RAG systems, vector search
- **[UI Features](docs/ui-features.md)** — Context viewer, stop generation, editing, appearance, graph viz
- **[API Reference](docs/api-reference.md)** — 45+ endpoints, dual SSE architecture

## Design Principles

- **Minimal dependencies**: Deno std lib, SQLite, HTMX, HuggingFace transformers
- **Agent-first**: Clean interfaces for programmatic access
- **Server-side rendering**: HTML templates, HTMX for interactivity
- **First-person perspective**: All prompts written from entity's viewpoint
- **Multi-embodiment**: Single identity across multiple interfaces
- **Entity ownership**: The system belongs to the entity

## Related Projects

- [entity-core](https://github.com/zarilewis/entity-core) — MCP server holding the entity's canonical identity and memories

## Deployment

For Docker strategy, CI/CD pipeline, and UnRAID setup, see `docs/deployment/`.
