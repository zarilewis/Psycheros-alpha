# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
deno task dev      # Run with hot reload
deno task start    # Run production mode
deno check src/main.ts   # Type check
deno lint          # Lint all files
```

## Environment Setup

```bash
cp .env.example .env
# Edit .env and set ZAI_API_KEY
```

## Architecture

SBy is a persistent AI entity harness daemon. Unlike CLI-based assistants, it runs as a web service at http://localhost:3000.

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

- **`src/llm/`** - OpenAI-compatible client for Z.ai API. Handles streaming, tool calls, and thinking/reasoning content.
- **`src/db/`** - SQLite persistence via `@db/sqlite`. Stores conversations and messages.
- **`src/tools/`** - Tool registry and executors. Has `shell` (command execution) and `update_title` (conversation naming) tools.
- **`src/entity/`** - The agentic loop. `EntityTurn` orchestrates: load context → LLM call → tool execution → persist → repeat until done.
- **`src/server/`** - HTTP server with SSE streaming. Includes `routes.ts` (API/static), `state-changes.ts` (unified state mutations), `ui-updates.ts` (reactive DOM updates), and `templates.ts` (HTML rendering).
- **`src/types.ts`** - Shared types used across modules.

### Key Patterns

**SBy.md Living State**: The entity's persistent memory. Loaded into system prompt each turn via `loadSByMd()`. Entity can update it using shell tool.

**Hybrid Streaming**: Thinking and content stream token-by-token. Tool calls and results are discrete SSE events rendered as UI blocks.

**Tool Execution Loop**: `EntityTurn.process()` yields chunks, executes tool calls, adds results to context, and continues until LLM returns without tool calls (max 10 iterations).

**Module-Internal Types**: Types in `*/types.ts` exported for intra-module use but not re-exported from `mod.ts` unless needed externally.

### SSE Event Types

```typescript
type: "thinking" | "content" | "tool_call" | "tool_result" | "dom_update" | "status" | "done"
```

### Reactive UI Updates

State changes that affect the UI use a unified pattern:

1. **State change functions** in `src/server/state-changes.ts` perform DB operations and return `affectedRegions`
2. **Tools** call state change functions and pass `affectedRegions` through in their result
3. **Entity loop** reads `result.affectedRegions` and yields `dom_update` SSE events
4. **API endpoints** use `generateUIUpdates()` + `renderAsOobSwaps()` for HTMX OOB swaps
5. **Client** handles `dom_update` events with `htmx.swap()`

To add a new state-changing feature:
1. Add function to `state-changes.ts` that returns `{ success, data, affectedRegions }`
2. Call it from tool or API endpoint
3. UI updates flow automatically

### Adding a New Tool

1. Create tool file in `src/tools/` with `Tool` interface (definition + execute function)
2. Register in `createDefaultRegistry()` in `registry.ts`
3. If tool changes UI state, use a state change function from `state-changes.ts`
