# Configuration

All Psycheros configuration is via environment variables. Copy `.env.example` to `.env` and set values as needed.

## Core Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZAI_API_KEY` | No* | — | API key for default LLM profile |
| `ZAI_BASE_URL` | No | Z.ai endpoint | API endpoint URL for default profile |
| `ZAI_MODEL` | No | `glm-4.7` | Main model for chat (default profile) |
| `ZAI_WORKER_MODEL` | No | `GLM-4.5-Air` | Lightweight model for background tasks (title generation) |
| `PSYCHEROS_PORT` | No | `3000` | Server port |

\* `ZAI_*` variables are only used to create a default profile on first run. LLM connections are configured via **Settings > LLM Connections** in the web UI. Multiple named profiles can be created for different providers (OpenRouter, OpenAI, Alibaba/Qwen, NanoGPT, custom). Once profiles are saved to `.psycheros/llm-settings.json`, the UI settings take precedence over env vars.
| `PSYCHEROS_HOST` | No | `0.0.0.0` | Server hostname |
| `PSYCHEROS_ACCENT_COLOR` | No | `#39ff14` | UI accent color (hex) |
| `PSYCHEROS_TOOLS` | No | (none) | Comma-separated list of enabled tools |
| `PSYCHEROS_MEMORY_HOUR` | No | `4` | Fallback UTC hour for daily summarization (0-23). Only used when `PSYCHEROS_DISPLAY_TZ` is not set. |
| `PSYCHEROS_SNAPSHOT_HOUR` | No | `3` | Hour to run daily identity snapshots (0-23) |
| `PSYCHEROS_SNAPSHOT_RETENTION_DAYS` | No | `30` | Days to retain snapshots before cleanup |
| `PSYCHEROS_WEB_SEARCH` | No | `disabled` | Web search provider: `disabled`, `tavily`, or `brave` |
| `TAVILY_API_KEY` | No | — | API key for Tavily search (when `PSYCHEROS_WEB_SEARCH=tavily`) |
| `BRAVE_SEARCH_API_KEY` | No | — | API key for Brave search (when `PSYCHEROS_WEB_SEARCH=brave`) |
| `DISCORD_BOT_TOKEN` | No | — | Discord bot token for sending DMs |
| `DISCORD_DEFAULT_CHANNEL_ID` | No | — | Discord user ID to DM by default |
| `PSYCHEROS_DISPLAY_TZ` | No | — | IANA timezone for display and Pulse scheduling (e.g. `America/New_York`). Falls back to `TZ`, then UTC |
| `TZ` | No | `UTC` | Timezone for message timestamps (e.g., `America/Los_Angeles`) |

## Available Tools

Tools are enabled via the `PSYCHEROS_TOOLS` environment variable or the Settings > Tools UI. When the Tools settings file (`.psycheros/tools-settings.json`) exists, user overrides take precedence over the env var. The env var serves as a fallback when no settings file exists.

Tools can also be toggled on/off at runtime via Settings > Tools in the web UI. Changes hot-reload the tool registry without a restart.

| Tool | Description |
|------|-------------|
| `shell` | Execute shell commands |
| `update_title` | Update conversation titles |
| `get_metrics` | Retrieve streaming performance metrics |
| `create_significant_memory` | Create permanent memory files |
| `sync_mcp` | Sync with entity-core |
| `identity_append` | Add knowledge to identity files (Tier 1 — append-only) |
| `maintain_identity` | Full identity file maintenance (Tier 2 — append, prepend, update_section, rewrite_section) |
| `list_identity_snapshots` | View available backups (Tier 2) |
| `custom_file` | Create and modify custom identity files (create, append, prepend, update_section, rewrite_section) |
| `graph_query` | Query knowledge graph (search, get_node, get_edges, traverse, subgraph, stats) |
| `graph_mutate` | Mutate knowledge graph (create_node, create_edge, update_node, update_edge, delete_node, delete_edge) |
| `graph_write_batch` | Batch create multiple nodes and edges |
| `vault` | Manage vault documents (write, read, append, list, search) |
| `web_search` | Search the web via Tavily or Brave (auto-enabled when web search provider is set) |
| `pulse` | Manage Pulses (create, trigger, delete) |
| `send_notification` | Send a push notification to the user's device |
| `send_discord_dm` | Send a Discord DM to the user (auto-enabled when bot token is configured) |
| `control_device` | Control a smart home device — on/off/status (auto-enabled when devices are configured) |
| `generate_image` | Generate an image or iterate on a previous one (auto-enabled when a generator is configured) |
| `describe_image` | Describe an image by local path or URL (auto-enabled when captioning provider is configured) |

**Example configurations:**
```bash
# Tier 1 identity tools only (safe for everyday use)
PSYCHEROS_TOOLS=identity_append

# All tools except shell
PSYCHEROS_TOOLS=update_title,get_metrics,create_significant_memory,sync_mcp,identity_append,maintain_identity,list_identity_snapshots,graph_query,graph_mutate,graph_write_batch,vault,pulse
```

## RAG Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PSYCHEROS_RAG_ENABLED` | `true` | Enable RAG memory retrieval |
| `PSYCHEROS_RAG_MAX_CHUNKS` | `8` | Max memory chunks to retrieve |
| `PSYCHEROS_RAG_MAX_TOKENS` | `2000` | Max tokens in retrieved context |
| `PSYCHEROS_RAG_MIN_SCORE` | `0.3` | Minimum similarity score |

## MCP Integration (entity-core)

| Variable | Default | Description |
|----------|---------|-------------|
| `PSYCHEROS_MCP_ENABLED` | `true` | Enable connection to entity-core (set to `false` to disable) |
| `PSYCHEROS_MCP_COMMAND` | `deno` | Command to spawn entity-core |
| `PSYCHEROS_MCP_ARGS` | `run -A --unstable-cron <path>/entity-core/src/mod.ts` | Arguments for entity-core |
| `PSYCHEROS_MCP_INSTANCE` | `psycheros` | Instance ID for this embodiment |
| `ENTITY_CORE_LLM_API_KEY` | — | Override API key for entity-core's LLM (memory-to-graph extraction). Falls back to active profile's API key, then `ZAI_API_KEY` |
| `ENTITY_CORE_LLM_BASE_URL` | — | Override LLM endpoint for entity-core. Falls back to active profile's base URL, then `ZAI_BASE_URL` |
| `ENTITY_CORE_LLM_MODEL` | — | Override model for entity-core extraction. Falls back to active profile's model, then `ZAI_MODEL` |
| `ENTITY_CORE_LLM_TEMPERATURE` | — | Override temperature for entity-core extraction. Falls back to `0.3` |
| `ENTITY_CORE_LLM_MAX_TOKENS` | — | Override max tokens for entity-core extraction. Falls back to `4000` |

Psycheros automatically forwards the **active LLM profile's** credentials to entity-core so that knowledge graph extraction works out of the box. When the active profile changes, entity-core is dynamically restarted with the new credentials. Set the `ENTITY_CORE_LLM_*` variants if entity-core needs different LLM settings than Psycheros (e.g., a cheaper model for extraction).

Entity-core's model, temperature, and max tokens can also be configured via **Settings > Entity Core > LLM** in the web UI. These overrides persist to `.psycheros/entity-core-llm-settings.json` and take priority over the active profile defaults when set.

When MCP is enabled, Psycheros:
- Spawns entity-core as a subprocess on startup
- Forwards the active LLM profile's credentials (`apiKey`, `baseUrl`, `model`) to entity-core
- Dynamically restarts entity-core when the active profile changes
- Entity-core-specific `ENTITY_CORE_LLM_*` vars take priority if set
- Pulls identity files (self, user, relationship, custom) from entity-core
- Queues changes and syncs back periodically (every 5 minutes)
- Falls back to local files if MCP is unavailable

## Migration to entity-core

To migrate existing local identity files and memories to entity-core:

```bash
deno run -A scripts/migrate-to-entity-core.ts --dry-run  # Preview
deno run -A scripts/migrate-to-entity-core.ts            # Run migration
```

## Indexing Existing Messages for ChatRAG

```bash
deno run -A scripts/index-messages.ts           # Index all existing messages
deno run -A scripts/index-messages.ts --dry-run  # Preview without indexing
deno run -A scripts/index-messages.ts --force    # Re-index all messages
```
