# Configuration

All Psycheros configuration is via environment variables. Copy `.env.example` to `.env` and set values as needed.

## Core Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZAI_API_KEY` | Yes | — | Z.ai API key |
| `ZAI_BASE_URL` | No | Z.ai endpoint | API endpoint URL |
| `ZAI_MODEL` | No | `glm-4.7` | Main model for chat |
| `ZAI_WORKER_MODEL` | No | `GLM-4.5-Air` | Lightweight model for background tasks (summarization, title generation) |
| `PSYCHEROS_PORT` | No | `3000` | Server port |
| `PSYCHEROS_HOST` | No | `0.0.0.0` | Server hostname |
| `PSYCHEROS_ACCENT_COLOR` | No | `#39ff14` | UI accent color (hex) |
| `PSYCHEROS_TOOLS` | No | (none) | Comma-separated list of enabled tools |
| `PSYCHEROS_MEMORY_HOUR` | No | `4` | Hour to run daily summarization (0-23) |
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
| `append_to_self` | Add knowledge about entity (Tier 1 — append-only) |
| `append_to_user` | Add knowledge about user (Tier 1) |
| `append_to_relationship` | Add relationship understanding (Tier 1) |
| `maintain_identity` | Full identity file maintenance (Tier 2 — includes replace) |
| `list_identity_snapshots` | View available backups (Tier 2) |
| `graph_search_nodes` | Search knowledge graph for relevant nodes |
| `graph_get_node` | Get a specific node by ID |
| `graph_get_edges` | Get relationships from the graph |
| `graph_traverse` | Traverse graph from a starting node |
| `graph_get_subgraph` | Extract a subgraph centered on a node |
| `graph_stats` | Get knowledge graph statistics |
| `graph_create_node` | Create a node (with auto-embedding and duplicate prevention) |
| `graph_create_edge` | Create a relationship between two nodes (supports IDs or labels) |
| `graph_update_node` | Update a node's label, description, or confidence |
| `graph_update_edge` | Update an edge's weight, evidence, or validity |
| `graph_delete_node` | Soft-delete a node and its connected edges |
| `graph_delete_edge` | Remove a relationship from the graph |
| `graph_write_batch` | Batch create multiple nodes and edges |
| `vault_write` | Create or update a vault document (global or per-chat scope) |
| `vault_list` | List vault documents (filterable by scope) |
| `vault_search` | Search vault for relevant content |
| `web_search` | Search the web via Tavily or Brave (auto-enabled when web search provider is set) |
| `create_pulse` | Create an autonomous scheduled prompt |
| `trigger_pulse` | Manually trigger an existing Pulse |
| `delete_pulse` | Delete a Pulse and its triggers |
| `send_notification` | Send a push notification to the user's device |
| `send_discord_dm` | Send a Discord DM to the user (auto-enabled when bot token is configured) |

**Example configurations:**
```bash
# Tier 1 identity tools only (safe for everyday use)
PSYCHEROS_TOOLS=append_to_self,append_to_user,append_to_relationship

# All tools except shell
PSYCHEROS_TOOLS=update_title,get_metrics,create_significant_memory,sync_mcp,append_to_self,append_to_user,append_to_relationship,maintain_identity,list_identity_snapshots,graph_search_nodes,graph_get_node,graph_get_edges,graph_traverse,graph_get_subgraph,graph_stats,graph_create_node,graph_create_edge,graph_update_node,graph_update_edge,graph_delete_node,graph_delete_edge,graph_write_batch,vault_write,vault_list,vault_search
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
| `PSYCHEROS_MCP_INSTANCE` | `psycheros-harness` | Instance ID for this embodiment |
| `ENTITY_CORE_LLM_API_KEY` | — | Override API key for entity-core's LLM (memory-to-graph extraction). Falls back to `ZAI_API_KEY` |
| `ENTITY_CORE_LLM_BASE_URL` | — | Override LLM endpoint for entity-core. Falls back to `ZAI_BASE_URL` |
| `ENTITY_CORE_LLM_MODEL` | — | Override model for entity-core extraction. Falls back to `ZAI_MODEL` |

Psycheros automatically forwards its `ZAI_API_KEY`, `ZAI_BASE_URL`, and `ZAI_MODEL` to entity-core so that knowledge graph extraction works out of the box. Set the `ENTITY_CORE_LLM_*` variants if entity-core needs different LLM settings than Psycheros (e.g., a cheaper model for extraction).

When MCP is enabled, Psycheros:
- Spawns entity-core as a subprocess on startup
- Automatically forwards LLM env vars (`ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL`) so entity-core's memory-to-graph extraction works
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
