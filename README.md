# SBy - Strauberry Tavern

A persistent entity harness daemon built on Deno. Unlike traditional CLI-based AI coding assistants, SBy runs as a persistent web service accessible via your browser.

## Vision

SBy is designed as an "entity harness" - a system for running persistent AI companions with:
- **Durable state** via the `SBy.md` living document
- **Tool execution** capabilities (shell access and more)
- **Conversation persistence** in SQLite
- **Hybrid streaming** - thinking and content stream token-by-token, tool calls render as discrete blocks

## Quick Start

```bash
# Set your Z.ai API key
export ZAI_API_KEY="your-api-key-here"

# Start the daemon
deno task start

# Open in browser
open http://localhost:3000
```

## Requirements

- [Deno](https://deno.com/) 2.x+
- Z.ai API key (or any OpenAI-compatible endpoint)

## Configuration

Environment variables:
- `ZAI_API_KEY` - Required. Your Z.ai API key
- `ZAI_BASE_URL` - Optional. API endpoint (default: Z.ai coding endpoint)
- `ZAI_MODEL` - Optional. Model name (default: `glm-4.7`)
- `SBY_PORT` - Optional. Server port (default: `3000`)
- `SBY_HOST` - Optional. Server hostname (default: `0.0.0.0`)

## Project Structure

```
SBy/
├── deno.json          # Deno config, tasks, imports
├── SBy.md             # Living state document (entity can update)
├── src/
│   ├── main.ts        # Daemon entry point
│   ├── types.ts       # Shared type definitions
│   ├── llm/           # OpenAI-compatible LLM client
│   ├── db/            # SQLite persistence layer
│   ├── tools/         # Tool system (shell, etc.)
│   ├── entity/        # Entity loop orchestration
│   └── server/        # HTTP server and SSE streaming
├── web/
│   └── index.html     # HTMX chat interface
└── .sby/              # Runtime data (SQLite DB, created automatically)
```

## Development

```bash
# Run with file watching
deno task dev

# Type check
deno check src/main.ts
```

## Architecture

- **Minimal dependencies**: Deno std lib, SQLite driver, HTMX (CDN)
- **Agent-first design**: Clean interfaces for programmatic access
- **Extensible primitives**: Tool registry, SSE event types, message format ready for expansion

## License

MIT
