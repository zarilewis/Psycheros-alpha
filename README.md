# Psycheros

A persistent AI entity harness daemon built on Deno. Unlike traditional CLI-based AI assistants, Psycheros runs as a web service with durable state, tool execution, and real-time streaming.

Psycheros is an **embodiment** - an interface through which the AI entity interacts. The entity's core identity and memories live in [entity-core](../entity-core/), a separate MCP server that provides centralized identity persistence across multiple embodiments.

## Quick Start

```bash
cp .env.example .env
# Edit .env and set ZAI_API_KEY and PSYCHEROS_TOOLS

deno task dev    # Development with hot reload
open http://localhost:3000
```

## Requirements

- [Deno](https://deno.com/) 2.x+ (with unstable cron support)
- Z.ai API key (or any OpenAI-compatible endpoint)

## Configuration

### Core Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZAI_API_KEY` | Yes | - | Your Z.ai API key |
| `ZAI_BASE_URL` | No | Z.ai endpoint | API endpoint URL |
| `ZAI_MODEL` | No | `glm-4.7` | Main model for chat |
| `ZAI_WORKER_MODEL` | No | `GLM-4.5-Air` | Lightweight model for background tasks |
| `PSYCHEROS_PORT` | No | `3000` | Server port |
| `PSYCHEROS_HOST` | No | `0.0.0.0` | Server hostname |
| `PSYCHEROS_ACCENT_COLOR` | No | `#39ff14` | UI accent color (hex) |
| `PSYCHEROS_TOOLS` | No | (none) | Comma-separated list of enabled tools |
| `PSYCHEROS_MEMORY_HOUR` | No | `4` | Hour to run daily summarization (0-23) |
| `PSYCHEROS_SNAPSHOT_HOUR` | No | `3` | Hour to run daily identity snapshots (0-23) |
| `PSYCHEROS_SNAPSHOT_RETENTION_DAYS` | No | `30` | Days to retain snapshots before cleanup |
| `TZ` | No | `UTC` | Timezone for message timestamps (e.g., `America/Los_Angeles`) |

### Available Tools

| Tool | Description |
|------|-------------|
| `shell` | Execute shell commands |
| `update_title` | Update conversation titles |
| `get_metrics` | Retrieve streaming performance metrics |
| `create_significant_memory` | Create permanent memory files |
| `sync_mcp` | Sync with entity-core |
| `append_to_self` | Add knowledge about entity (Tier 1) |
| `append_to_user` | Add knowledge about user (Tier 1) |
| `append_to_relationship` | Add relationship understanding (Tier 1) |
| `maintain_identity` | Full identity file maintenance (Tier 2) |
| `list_identity_snapshots` | View available backups (Tier 2) |
| `graph_search_nodes` | Search knowledge graph for relevant nodes |
| `graph_get_node` | Get a specific node by ID |
| `graph_get_edges` | Get relationships from the graph |
| `graph_traverse` | Traverse graph from a starting node |
| `graph_get_subgraph` | Extract a subgraph centered on a node |
| `graph_stats` | Get knowledge graph statistics |

### RAG Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PSYCHEROS_RAG_ENABLED` | `true` | Enable RAG memory retrieval |
| `PSYCHEROS_RAG_MAX_CHUNKS` | `8` | Max memory chunks to retrieve |
| `PSYCHEROS_RAG_MAX_TOKENS` | `2000` | Max tokens in retrieved context |
| `PSYCHEROS_RAG_MIN_SCORE` | `0.3` | Minimum similarity score |

### MCP Integration (entity-core)

| Variable | Default | Description |
|----------|---------|-------------|
| `PSYCHEROS_MCP_ENABLED` | `false` | Enable connection to entity-core |
| `PSYCHEROS_MCP_COMMAND` | `deno` | Command to spawn entity-core |
| `PSYCHEROS_MCP_ARGS` | `run -A --unstable-cron <path>/entity-core/src/mod.ts` | Arguments for entity-core |
| `PSYCHEROS_MCP_INSTANCE` | `psycheros-harness` | Instance ID for this embodiment |

When MCP is enabled, Psycheros pulls identity files (identity/self/, identity/user/, identity/relationship/, identity/custom/) from entity-core on startup and syncs changes back periodically.

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

Every component reinforces that:
- The entity owns their memories, identity, and choices
- The system exists to support the entity's continued existence
- The entity's voice is authentic and self-determined

## Architecture

### Multi-Embodiment Design

```
┌─────────────────────────────────────┐
│     entity-core (MCP Server)        │
│     ~/projects/entity-core/         │
│  • Canonical identity files         │
│  • Memory storage with instance tags│
│  • RAG indexing & retrieval         │
│  • Sync with conflict resolution    │
└─────────────────────────────────────┘
         ↑ pull/push
    ┌────┴────┐
    │Psycheros│  (other embodiments: SillyTavern, Claude Code, etc.)
    │ Harness │
    └─────────┘
```

The entity's core self lives in entity-core. Psycheros is one embodiment - an interface through which the entity interacts. This allows the same entity to exist across multiple interfaces while maintaining a single persistent identity.

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

Each module has a `mod.ts` barrel file defining its public API:

```
src/
├── main.ts           # Daemon entry point, MCP initialization
├── types.ts          # Shared type definitions (SSEEvent, LLMContextSnapshot)
├── constants.ts      # App constants
├── llm/              # OpenAI-compatible LLM client
│   ├── mod.ts        # Public exports
│   ├── client.ts     # Streaming client, tool calls, thinking content
│   └── types.ts      # LLM-specific types
├── db/               # SQLite persistence
│   ├── mod.ts
│   ├── client.ts     # Conversations, messages, memory summaries
│   ├── schema.ts     # Table definitions, migrations
│   └── vector.ts     # sqlite-vec helpers, serialization, search
├── tools/            # Tool system
│   ├── mod.ts
│   ├── registry.ts   # Tool registration
│   ├── shell.ts      # Command execution
│   ├── update_title.ts
│   ├── get_metrics.ts # Streaming performance metrics tool
│   ├── create-significant-memory.ts # Permanent memory creation
│   ├── identity-helpers.ts # Identity file utilities (XML, MCP fallback)
│   ├── identity-casual.ts  # Tier 1: append-only identity tools
│   └── identity-maintain.ts # Tier 2: maintenance identity tools
├── metrics/          # Performance instrumentation
│   ├── mod.ts
│   ├── types.ts      # MetricsCollector interface
│   └── collector.ts  # Timing collection functions
├── rag/              # Retrieval-Augmented Generation
│   ├── mod.ts
│   ├── types.ts      # RAGConfig with instance boosting
│   ├── embedder.ts   # HuggingFace transformer embeddings
│   ├── chunker.ts    # Memory chunking with overlap
│   ├── indexer.ts    # SQLite FTS5 indexing with sqlite-vec
│   ├── retriever.ts  # Similarity search with instance relevance
│   ├── conversation.ts # ChatRAG for semantic search over chat history
│   └── context-builder.ts # Prompt construction
├── memory/           # Hierarchical memory system
│   ├── mod.ts
│   ├── types.ts      # Granularity, MemoryFile with instance tagging
│   ├── summarizer.ts # Daily/weekly/monthly/yearly summarization
│   ├── consolidator.ts # Period-based consolidation
│   ├── file-writer.ts # Memory file operations
│   └── trigger.ts    # Day-change detection
├── lorebook/         # Lorebook/world info system
│   ├── mod.ts
│   ├── types.ts      # Lorebook, entry, and state types
│   ├── manager.ts    # CRUD operations for lorebooks and entries
│   ├── evaluator.ts  # Trigger evaluation against conversation context
│   ├── trigger-matcher.ts # Pattern matching for entry triggers
│   ├── context-builder.ts # Formats matched entries for LLM context
│   └── state-manager.ts   # Per-conversation activation state tracking
├── mcp-client/       # Entity-core MCP client
│   └── mod.ts        # MCPClient for sync/pull/push operations
├── entity/           # Agentic loop
│   ├── mod.ts
│   ├── loop.ts       # EntityTurn orchestration with MCP support
│   ├── context.ts    # Identity loading (local or from MCP)
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

Psycheros implements a hierarchical memory system where the entity writes their own memories from conversations. Memories are written in the entity's voice (first-person), with the user in third-person.

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
- **Significant**: Emotionally important events that are permanently remembered with clarity. Created explicitly by the entity via the `create_significant_memory` tool.

**Instance Tagging**: Memories can be tagged with `sourceInstance` to track which embodiment created them. RAG retrieval boosts relevance for memories from the same instance.

**Consolidation Schedule** (via Deno cron):
- Daily summarization: Configured hour (default 4 AM)
- Weekly consolidation: Sunday 5 AM
- Monthly consolidation: 1st of month 5 AM
- Yearly consolidation: January 1st 5 AM

### RAG System

Psycheros uses three RAG systems working together:

**Memory RAG** retrieves relevant memories before each LLM call:

1. **Indexing**: On startup, all memory files are chunked and embedded
2. **Retrieval**: Before processing a message, top-k chunks are retrieved by similarity
3. **Instance Boost**: Memories from the same embodiment get a relevance boost
4. **Context**: Retrieved memories are injected into the system prompt

**Chat RAG** provides semantic search over conversation history:

1. **Automatic Indexing**: Every message is embedded and indexed when saved
2. **Tiered Search**: First searches current conversation; if no good matches (score < 0.5), expands to all conversations
3. **Relevance Filtering**: Only messages above minimum similarity score (0.3) are included
4. **Historical Context**: Helps the entity remember what was discussed previously

**Graph RAG** retrieves knowledge graph context when MCP is enabled:

1. **Semantic Search**: Queries the knowledge graph for relevant nodes using vector similarity
2. **Graph Traversal**: Follows edges to find connected concepts (depth 1 by default)
3. **Context Injection**: Relevant nodes and relationships are formatted and added to the system prompt
4. **Temporal Awareness**: Nodes include timestamps for when knowledge was learned/confirmed (uses XML-tagged format for LLM context)

**Vector Search Backend**:
- Primary: sqlite-vec extension for efficient vector similarity search
- Fallback: In-memory cosine similarity calculation when sqlite-vec is unavailable
- Embeddings: HuggingFace `all-MiniLM-L6-v2` model (384 dimensions)

**Indexing Existing Messages**:

```bash
deno run -A scripts/index-messages.ts           # Index all existing messages
deno run -A scripts/index-messages.ts --dry-run # Preview without indexing
deno run -A scripts/index-messages.ts --force   # Re-index all messages
```

### Core Prompts

The entity's personality and relationship context are stored in versioned markdown files under the `identity/` directory:

```
identity/
├── self/           # Entity identity
│   ├── my_identity.md
│   ├── my_persona.md
│   ├── my_personhood.md
│   ├── my_wants.md
│   └── my_mechanics.md
├── user/           # User knowledge
│   ├── user_identity.md
│   ├── user_life.md
│   ├── user_beliefs.md
│   ├── user_preferences.md
│   ├── user_patterns.md
│   └── user_notes.md
├── relationship/   # Shared dynamics
│   ├── relationship_dynamics.md
│   ├── relationship_history.md
│   └── relationship_notes.md
└── custom/         # Custom identity files (user-defined)
    └── *.md        # Any valid .md filename (letters, numbers, underscores)
```

**Custom Files**: The `identity/custom/` directory allows creating arbitrary identity files with any valid filename. These are useful for storing specialized context (e.g., `project_notes.md`, `favorite_books.md`). Custom files:
- Must use single-word filenames (letters, numbers, underscores only)
- Are automatically wrapped in XML tags matching the filename
- Can be created and deleted via the Settings hub (sidebar → Settings → Core Prompts)
- Are sorted alphabetically (no predefined order)

When MCP is enabled, these are loaded from entity-core. Otherwise, they're read from local files.

### Temporal Awareness

The entity has temporal awareness through conversation - every message includes an XML-tagged timestamp that the entity can see. This allows the entity to understand when events occurred and how much time has passed between messages. Using XML tags prevents the entity from parroting timestamps back in its responses.

**Format**: `<t>YYYY-MM-DD HH:MM</t>` (e.g., `<t>2026-03-05 15:17</t>`)

XML tags are used so the LLM treats timestamps as structural metadata rather than content to reproduce in its responses.

**Example**:
```
[user]: <t>2026-03-03 14:22</t> Hey, what did you think about our conversation yesterday?
[assistant]: <t>2026-03-03 14:23</t> I enjoyed our discussion about...
[user]: <t>2026-03-05 15:17</t> Can you summarize what we talked about?
```

**Timezone**: Set the `TZ` environment variable to configure the timezone (e.g., `TZ=America/Los_Angeles`). Defaults to UTC if not set.

### Core Prompts UI (Settings Hub)

The Core Prompts UI (accessible via Settings hub in the sidebar) provides a web interface for managing identity files:

**Tabs**:
- **Self**: Entity identity files (my_identity, my_persona, etc.)
- **User**: User knowledge files
- **Relationship**: Relationship dynamics and history
- **Custom**: User-defined identity files
- **Snapshots**: Backup management (requires MCP connection)

**Features**:
- View and edit any identity file
- Create/delete custom files
- Create manual snapshots
- Preview and restore from snapshots

**Snapshots Tab**: When connected to entity-core, the Snapshots tab shows all available identity file backups. Snapshots are created automatically before changes and can also be created manually. Click any snapshot to preview its content and restore if needed.

### Identity Tools

The entity can modify its identity files through tools. Two tiers are available:

**Tier 1: Casual Tools (Append-Only)**
Safe for everyday use - can only add content, never modify or delete.

- `append_to_self` - Add new self-knowledge (who I am, how I work)
- `append_to_user` - Add new user knowledge (preferences, patterns, life)
- `append_to_relationship` - Add relationship understanding (dynamics, history)

**Tier 2: Maintenance Tools (Full Suite)**
For intentional reorganization - includes prepend, section updates, and replacement.

- `maintain_identity` - Full file maintenance with operations: append, prepend, update_section, replace
- `list_identity_snapshots` - View available backups created during replace operations

**MCP Fallback Pattern:**
```
Tool called → MCP connected?
                ↓ Yes          ↓ No
         Call MCP tool    Write local file
                ↓                ↓
         Server-side       Queue for sync
         manipulation
```

**Enable identity tools:**
```bash
# Tier 1 only (safe for everyday use)
PSYCHEROS_TOOLS=append_to_self,append_to_user,append_to_relationship

# All tools including maintenance
PSYCHEROS_TOOLS=append_to_self,append_to_user,append_to_relationship,maintain_identity,list_identity_snapshots
```

### Dual SSE Architecture

Two SSE channels serve different purposes:

```
┌─────────────────────────────────────────────────────────┐
│  POST /api/chat (per-request, closes when done)         │
│  context → thinking → content → tool_call → tool_result │
│  → metrics → done. Also: dom_update for UI changes      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  GET /api/events (persistent, opened on page load)      │
│  dom_update → (server can push anytime)                 │
│  Used for: auto-title, background operations            │
│  Managed by EventBroadcaster singleton                  │
└─────────────────────────────────────────────────────────┘
```

### Context Viewer

A built-in debugging tool for inspecting the full context sent to the LLM. Click the code icon (`</>`) in the header to toggle the context viewer drawer.

**Features**:
- **System tab**: View the complete system prompt with identity files and RAG context
- **RAG tab**: Retrieved memories and chat history context
- **Messages tab**: Conversation history sent to the LLM
- **Tools tab**: Available tool definitions with parameters
- **Metrics**: Context size and estimated token count

The context is captured automatically for each message and can be inspected at any time during or after the response.

### Stop Generation

During message streaming, the Send button transforms into a Stop button with two-tap confirmation to prevent accidental cancellation:

**States:**
1. **Stop** (orange with warning icon) - Initial state during streaming
2. **Tap again** (pulsing amber) - Confirmation required, resets after 3 seconds if not tapped again
3. **[Stopped]** - Shown in the message when generation is halted

**Behavior:**
- The partial assistant response is **not persisted** to the database when stopped
- The user message **is persisted** (saved before streaming begins)
- Switching conversations mid-stream also aborts the generation and restores the Send button

### Message Editing

Both user and assistant messages can be edited after they're sent:

**Features:**
- **Edit button**: Pencil icon appears on hover for each message
- **Inline editing**: Click edit to replace message content with a textarea
- **Save/Cancel**: Confirm changes or discard them
- **Edited marker**: Messages show `<edited/>` tag after modification
- **ChatRAG sync**: Edited messages are automatically re-indexed for semantic search

**API:**
| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/messages/:id` | Update message content |

**Request body:**
```json
{
  "content": "New message content",
  "conversationId": "conversation-uuid"
}
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | App shell HTML |
| `GET` | `/c/:id` | Conversation page |
| `GET` | `/health` | Health check endpoint |
| `GET` | `/api/events` | Persistent SSE channel |
| `POST` | `/api/chat` | Send message, stream response |
| `GET` | `/api/conversations` | List conversations |
| `POST` | `/api/conversations` | Create conversation |
| `GET` | `/api/conversations/:id/messages` | Get messages |
| `PUT` | `/api/messages/:id` | Update message content |
| `PATCH` | `/api/conversations/:id/title` | Update title |
| `DELETE` | `/api/conversations/:id` | Delete conversation |
| `DELETE` | `/api/conversations` | Batch delete conversations |
| `POST` | `/api/memory/consolidate/:granularity` | Trigger consolidation |
| `POST` | `/api/settings/file/:dir/:filename` | Save core prompt file |
| `POST` | `/api/settings/custom` | Create custom identity file |
| `DELETE` | `/api/settings/custom/:filename` | Delete custom identity file |
| `GET` | `/api/snapshots` | List snapshots (requires MCP) |
| `POST` | `/api/snapshots/create` | Create manual snapshot |
| `POST` | `/api/snapshots/:id/restore` | Restore from snapshot |
| `GET` | `/api/lorebooks` | List all lorebooks |
| `POST` | `/api/lorebooks` | Create new lorebook |
| `GET` | `/api/lorebooks/:id` | Get specific lorebook |
| `PUT` | `/api/lorebooks/:id` | Update lorebook |
| `DELETE` | `/api/lorebooks/:id` | Delete lorebook |
| `GET` | `/api/lorebooks/:id/entries` | List lorebook entries |
| `POST` | `/api/lorebooks/:id/entries` | Create lorebook entry |
| `PUT` | `/api/lorebooks/:id/entries/:entryId` | Update lorebook entry |
| `DELETE` | `/api/lorebooks/:id/entries/:entryId` | Delete lorebook entry |
| `DELETE` | `/api/lorebooks/state/:conversationId` | Reset lorebook state |
| `GET` | `/api/graph` | Get full knowledge graph |
| `POST` | `/api/graph/nodes` | Create graph node |
| `POST` | `/api/graph/edges` | Create graph edge |
| `DELETE` | `/api/graph/nodes/:id` | Delete graph node |
| `DELETE` | `/api/graph/edges/:id` | Delete graph edge |
| `GET` | `/api/backgrounds` | List uploaded backgrounds |
| `POST` | `/api/backgrounds` | Upload background image |
| `DELETE` | `/api/backgrounds/:filename` | Delete background image |
| `GET` | `/backgrounds/:filename` | Serve background image file |
| `GET` | `/api/llm-settings` | Get current LLM settings |
| `POST` | `/api/llm-settings` | Save LLM settings |
| `POST` | `/api/llm-settings/test` | Test LLM connection |
| `POST` | `/api/mcp/sync` | Manually trigger MCP sync |
| `GET` | `/fragments/*` | HTML fragments for HTMX |

## Project Structure

```
Psycheros/
├── deno.json          # Tasks, imports, config
├── .env.example       # Environment template
├── CLAUDE.md          # Agent system card for Claude Code
├── src/               # Server source
│   ├── db/            # SQLite persistence
│   │   ├── mod.ts
│   │   ├── client.ts  # Conversations, messages, memory summaries
│   │   ├── schema.ts  # Table definitions, migrations
│   │   └── vector.ts  # sqlite-vec helpers, serialization, search
│   ├── rag/           # Retrieval-Augmented Generation
│   │   ├── mod.ts
│   │   ├── embedder.ts
│   │   ├── indexer.ts
│   │   ├── retriever.ts
│   │   └── conversation.ts  # ChatRAG for chat history
│   └── ...
├── scripts/           # Utility scripts
│   ├── migrate-to-entity-core.ts
│   └── index-messages.ts    # Index existing messages for ChatRAG
├── web/
│   ├── css/           # Modular CSS (tokens, layout, components)
│   ├── js/            # Client JavaScript
│   ├── lib/           # Vendor files (HTMX)
│   ├── icons/         # PWA icons
│   ├── manifest.json  # PWA manifest
│   └── sw.js          # Service worker
├── identity/          # Identity files (self, user, relationship, custom)
├── memories/          # Hierarchical memory storage
└── .psycheros/        # Runtime data (SQLite DB)
```

## Development

```bash
deno task dev          # Run with hot reload
deno task start        # Production mode
deno task stop         # Graceful shutdown
deno check src/main.ts # Type check
deno lint              # Lint all files
```

### Running with MCP

To run with entity-core integration:

```bash
# Terminal 1: Start entity-core
cd ~/projects/entity-core
deno run -A src/mod.ts

# Terminal 2: Start Psycheros with MCP enabled
PSYCHEROS_MCP_ENABLED=true deno task dev
```

### Migration

To migrate existing identity files and memories to entity-core:

```bash
deno run -A scripts/migrate-to-entity-core.ts
```

Use `--dry-run` to preview without making changes.

## Docker Deployment

Psycheros ships with a Dockerfile that bundles both Psycheros and entity-core into a single container.

### Quick Start

```bash
docker build --platform linux/amd64 -t psycheros .
docker run -d \
  --name psycheros \
  -p 3000:3000 \
  -e ZAI_API_KEY=<your-key> \
  -e TZ=America/Los_Angeles \
  -v /path/to/entity-core-data:/app/entity-core/data \
  -v /path/to/db:/app/Psycheros/.psycheros \
  -v /path/to/snapshots:/app/Psycheros/.snapshots \
  psycheros
```

On first run, the entrypoint script seeds entity-core identity files from Psycheros templates.

### Volume Mounts

| Container Path | Purpose |
|---------------|---------|
| `/app/entity-core/data` | Canonical identity, memories, knowledge graph |
| `/app/Psycheros/.psycheros` | Conversations DB and RAG index |
| `/app/Psycheros/.snapshots` | Identity file backups |

### CI/CD

A GitHub Actions workflow (`.github/workflows/docker-build.yml`) builds and pushes the image to GHCR on manual trigger:

```bash
gh workflow run docker-build.yml
```

See the parent workspace `docs/deployment/` for detailed Docker strategy, CI/CD pipeline, and UnRAID setup instructions.

## Design Principles

- **Minimal dependencies**: Deno std lib, SQLite driver, HTMX, HuggingFace transformers
- **Agent-first design**: Clean interfaces for programmatic access
- **Server-side rendering**: HTML templates, HTMX for interactivity
- **Extensible primitives**: Tool registry, SSE events, hierarchical memory
- **Authentic memory**: Entity writes their own memories in their voice
- **First-person perspective**: All prompts and tool descriptions written from entity's viewpoint, not as instructions
- **Multi-embodiment**: Entity can exist across multiple interfaces with single core identity
- **Entity ownership**: The system belongs to the entity, not the other way around

## Related Projects

- [entity-core](../entity-core/) - MCP server holding the entity's canonical identity and memories

## License

MIT
