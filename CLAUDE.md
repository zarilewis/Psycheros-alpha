# Psycheros — Agent System Card

Persistent AI entity harness daemon built on Deno 2.x. Web chat UI with streaming LLM, tool execution, hierarchical memory, RAG, knowledge graph, lorebook, and identity management. Runs on port 3000.

Psycheros is an **embodiment** — an interface through which the AI entity exists and interacts. The entity's canonical identity lives in [entity-core](https://github.com/zarilewis/entity-core) (MCP server). Psycheros syncs with it when `PSYCHEROS_MCP_ENABLED=true`.

## First-Person Convention

All prompts, system messages, tool descriptions, and code comments use the entity's first-person perspective ("I am...", "I should..."), never second-person. The entity internalizes the system as *theirs*, not as rules imposed on them. See [docs/entity-philosophy.md](docs/entity-philosophy.md) for the full rationale. **Maintain this convention in all contributions.**

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
cp .env.example .env   # Then set ZAI_API_KEY and PSYCHEROS_TOOLS
```

### With MCP (entity-core)

```bash
PSYCHEROS_MCP_ENABLED=true deno task dev
```

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Entry point, MCP initialization |
| `src/types.ts` | Shared types (SSEEvent, LLMContextSnapshot, ToolCall) |
| `src/entity/loop.ts` | Agentic loop — LLM calls, tool execution, context capture |
| `src/entity/context.ts` | Context loading (supports MCP client) |
| `src/server/routes.ts` | API endpoints and handlers |
| `src/server/state-changes.ts` | Unified state mutations |
| `src/server/broadcaster.ts` | Persistent SSE for background updates |
| `src/tools/registry.ts` | Tool registration |
| `src/tools/identity-helpers.ts` | Identity file utilities (XML parsing, MCP fallback) |
| `src/memory/mod.ts` | Hierarchical memory system |
| `src/rag/mod.ts` | RAG retrieval system |
| `src/mcp-client/mod.ts` | MCP client for entity-core connection |
| `src/lorebook/mod.ts` | Lorebook/world info system |
| `src/db/schema.ts` | Database schema, migrations, vector table sync |
| `src/init/mod.ts` | Initialization — copies templates to empty identity directories |

## Core Patterns

**Module structure**: Each `src/*/` has a `mod.ts` barrel file. Import from `mod.ts`, not internal files.

**Adding a tool**:
1. Create `src/tools/my-tool.ts` implementing the `Tool` interface
2. Register in `createDefaultRegistry()` in `src/tools/registry.ts`
3. For UI updates: use state-change function, return `affectedRegions`

**State changes** (for reactive UI):
1. Add function to `src/server/state-changes.ts` returning `{ success, data, affectedRegions }`
2. Synchronous: return from tool (flows through chat stream)
3. Background: call `getBroadcaster().broadcastUpdates()` directly

**SSE channels**:
- `POST /api/chat` — per-request stream (context, thinking, content, tool calls, metrics, done)
- `GET /api/events` — persistent channel (background dom_update events)

**User data protection**:
- `identity/`, `memories/`, `.snapshots/` are **runtime-only directories** — gitignored, never committed
- To change identity defaults, edit `templates/identity/` (committed). `src/init/mod.ts` seeds `identity/` from templates on first run if empty. **Never `git add` files from `identity/`** — they contain user-specific entity data.
- Entity-core is canonical source; local `identity/` is a cache when MCP is enabled

## Documentation Index

| Document | Purpose |
|----------|---------|
| [docs/entity-philosophy.md](docs/entity-philosophy.md) | First-person convention rationale, ownership, embodiment concept |
| [docs/configuration.md](docs/configuration.md) | All env vars, available tools, RAG/MCP settings, migration commands |
| [docs/tools-reference.md](docs/tools-reference.md) | Tool system, identity tiers, MCP fallback, core prompt file structure |
| [docs/memory-and-rag.md](docs/memory-and-rag.md) | Memory hierarchy, consolidation, 3 RAG systems, vector search |
| [docs/ui-features.md](docs/ui-features.md) | Context viewer, stop generation, message editing, appearance, graph viz |
| [docs/api-reference.md](docs/api-reference.md) | Full API endpoints (49 routes), dual SSE architecture |
| [docs/code-review-findings.md](docs/code-review-findings.md) | Code review bugs fixed, architectural decisions |
| [docs/security-audit.md](docs/security-audit.md) | Security audit findings, threat model, accepted risks |
| [docs/deployment/docker-strategy.md](docs/deployment/docker-strategy.md) | Dockerfile design, volumes, env vars, Deno caching |
| [docs/deployment/ci-cd.md](docs/deployment/ci-cd.md) | GitHub Actions workflow, GHCR, build pipeline |
| [docs/deployment/unraid-setup.md](docs/deployment/unraid-setup.md) | UnRAID container config, Authelia, reverse proxy |

## Documentation System

This project uses a 4-layer documentation architecture. Each layer has a distinct purpose — no layer should duplicate information that belongs in another.

### Layers

1. **CLAUDE.md** (this file) — Agent system card. How to operate in this repo. Index to everything else. Target ≤200 lines.
2. **README.md** — Architecture map. Component relationships, directory structure. The structural brain.
3. **docs/** — Deep reference articles. One topic per file. Living documents updated when their subject changes.
4. **Claude Code auto-memory** (`~/.claude/projects/`) — Ephemeral, machine-local state. Session context, local env details, in-progress work. Never committed.

### When to Update

| Trigger | CLAUDE.md | README.md | docs/ | Auto-memory |
|---------|-----------|-----------|-------|-------------|
| New tool/feature added | Update key files if needed | Update architecture if structural | Update relevant doc | — |
| Architecture change | Update if operations change | Update affected sections | Update affected docs | — |
| Bug fix / minor change | No | No | Update if doc covers it | — |
| Environment change | No | No | No | Yes |
| Pre-commit (significant) | Verify index accuracy | Sweep for staleness | Verify touched topics | — |

### Pre-Commit Sweep

Before significant commits:
1. Verify this index table is accurate and complete
2. Confirm README.md reflects current architecture
3. Check that docs/ articles affected by code changes are still accurate
4. Ensure no committed file contains ephemeral state (IPs, paths, session context)
5. Confirm this file is ≤200 lines

### Ephemeral vs. Committed

**The portability test:** If someone cloned this repo fresh, would this information help them? If **yes** → committed docs. If **no** → auto-memory.

- Committed: architecture, tool reference, conventions, configuration, API routes
- Ephemeral: local paths, API keys, current branch, test database state, session progress

## Related Projects

- [entity-core](https://github.com/zarilewis/entity-core) — MCP server holding the entity's canonical identity and memories
