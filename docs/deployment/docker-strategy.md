# Docker Strategy

## Approach

Single container. Psycheros is the main process and spawns entity-core as a subprocess via MCP over stdio. No need for multi-container orchestration.

## Image Requirements

- **Base**: `denoland/deno:2.6.7` (Debian slim)
- **PID 1**: `dumb-init` for proper signal forwarding
- **Native deps**: sqlite-vec extension (`lib/vec0.so`, x86-64 Linux, bundled in Psycheros repo)
- **Flags**: `--unstable-cron` required for Deno memory consolidation crons

## Dockerfile

The Dockerfile is committed in this repo (`Dockerfile`). The CI/CD workflow copies it to the build context root. Build context requires both Psycheros and entity-core as sibling directories.

Single-stage build:
1. Installs `dumb-init` for signal handling
2. Copies full source for both projects
3. Injects `nodeModulesDir: "auto"` + `vendor: true` into both `deno.json` files (Docker only, not in source repos) — bypasses Deno's global `/deno-dir` cache which is unreliable in CI-built images
4. Runs `deno install --entrypoint` for both projects
5. Explicitly caches the `@huggingface/transformers` dynamic import
6. Warm-starts both apps briefly to cache transitive deps

At runtime, both `deno run` commands use `--cached-only` so the container never hits the network for module resolution. All dependencies are fully baked into the image.

## Entrypoint Script

`entrypoint.sh` runs before the Deno process on every container start:
- Seeds entity-core's identity directories from Psycheros templates if empty (first-run only)
- Ensures memory subdirectories exist
- Execs into `dumb-init` → `deno` for proper signal handling

This solves the first-run problem: without seeding, MCP pull returns empty arrays from entity-core and the entity has no identity.

## Volume Mounts

Three persistent volumes needed. Psycheros `identity/` and `memories/` are ephemeral in-memory caches repopulated from entity-core via MCP on every startup — no volume mount needed.

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `entity-core-data` | `/app/entity-core/data/` | Canonical identity, memories, graph.db |
| `psycheros-db` | `/app/Psycheros/.psycheros/` | SQLite (conversations, RAG index) |
| `psycheros-snapshots` | `/app/Psycheros/.snapshots/` | Identity backups |

## Environment Variables

### Required (user must set)

| Variable | Example |
|----------|---------|
| `ZAI_API_KEY` | Your Z.ai API key |

### Optional

| Variable | Default | Notes |
|----------|---------|-------|
| `TZ` | `UTC` | Timezone for memory timestamps (e.g., `America/Los_Angeles`) |
| `PSYCHEROS_TOOLS` | _(empty = none)_ | Comma-separated tool list, or `all` |
| `PSYCHEROS_RAG_ENABLED` | `true` | Enable RAG retrieval |
| `PSYCHEROS_PORT` | `3000` | HTTP port |

### Defaulted in Dockerfile (do not set unless overriding)

| Variable | Default |
|----------|---------|
| `PSYCHEROS_HOST` | `0.0.0.0` |
| `PSYCHEROS_MCP_ENABLED` | `true` |
| `PSYCHEROS_MCP_COMMAND` | `deno` |
| `PSYCHEROS_MCP_ARGS` | `run -A --cached-only --unstable-cron /app/entity-core/src/mod.ts` |
| `PSYCHEROS_ENTITY_CORE_DATA_DIR` | `/app/entity-core/data` |

## Health Check

`GET /health` returns `{"status":"ok"}` with HTTP 200.

The Dockerfile includes a `HEALTHCHECK` instruction:
```
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3
```

`--start-period=30s` accounts for the embedding model load time on first start.

## sqlite-vec

Psycheros ships pre-built sqlite-vec native extensions for common platforms:
- **Linux**: `lib/vec0.so` (x86-64, aarch64)
- **macOS**: `lib/vec0.dylib` (aarch64, x86-64)
- **Windows**: `lib/vec0.dll` (x86-64)

If no matching extension is found in `lib/` at startup, Psycheros automatically downloads the correct prebuilt binary from the [sqlite-vec GitHub releases](https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9) (v0.1.9) and caches it in `lib/`. This covers Linux, macOS, and Windows on both x86-64 and aarch64. The download requires internet access on first run; subsequent runs use the cached file.

The `.dockerignore` excludes non-Linux extensions from the Docker build context. On unsupported architectures, the system falls back to in-memory cosine similarity.

## Graceful Shutdown

Psycheros handles both SIGINT and SIGTERM. On `docker stop`:
1. dumb-init forwards SIGTERM to Deno process
2. Shutdown handler triggers MCP sync (pushes pending changes to entity-core)
3. SQLite databases closed cleanly
4. Process exits immediately (no grace period timeout)
