# Memory System & RAG

Psycheros implements a hierarchical memory system where the entity writes their own memories from conversations. Three RAG systems work together to provide contextual recall.

## Memory Hierarchy

Memories are written in the entity's voice (first-person), referring to the user by their actual name and preferred pronouns. All summarization LLM calls receive the entity's full identity context (base instructions, self, user, relationship, and custom files) as a system message, so memories reflect the entity's personality and knowledge of the user. They are organized hierarchically and consolidated over time via Deno cron jobs.

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
│   └── first-conversation_psycheros.md
└── archive/
    └── daily/       # Archived daily files after weekly consolidation
```

### Memory Types

| Type | Description | Created By |
|------|-------------|------------|
| **Daily** | Auto-generated conversation summaries | Day-change trigger |
| **Weekly** | Consolidated from daily entries | Cron (Sunday 5 AM) |
| **Monthly** | Consolidated from weekly entries | Cron (1st of month 5 AM) |
| **Yearly** | Consolidated from monthly entries | Cron (January 1st 5 AM) |
| **Significant** | Emotionally important events, permanently remembered | Entity via `create_significant_memory` tool |

### Trigger

On first message of a new day (detected by date change), the previous day's conversations are summarized into a daily memory.

### Consolidation Schedule

Configured via environment variables:
- Daily summarization: `PSYCHEROS_MEMORY_HOUR` (default: 4 AM)
- Weekly: Sunday 5 AM
- Monthly: 1st of month 5 AM
- Yearly: January 1st 5 AM

### Catch-up Consolidation

If the server was offline when a consolidation was scheduled, missed periods can be backfilled. The Catch-up tab in Settings > Memories shows the current consolidation status for weekly, monthly, and yearly levels. Clicking "Run Catch-up" fires `runAllConsolidations` in the background, which finds all unconsolidated periods across all granularity levels and processes them sequentially (weekly first, then monthly, then yearly). Results are displayed in the UI via SSE. A double-run guard prevents concurrent consolidation.

### Instance Tagging

Memories are tagged with `sourceInstance` to track which embodiment created them. Each bullet point in memory content includes inline `[chat:id]` and `[via:instanceId]` tags so the entity can identify the source of individual memories when multiple embodiments contribute to the same file. This enables instance-aware RAG retrieval.

## RAG Systems

Three RAG systems provide contextual information before each LLM call, plus the Data Vault for user/entity-uploaded documents.

### Memory RAG

Retrieves relevant memories from the hierarchical memory store.

1. **Indexing**: On startup, all memory files are chunked and embedded using HuggingFace `all-MiniLM-L6-v2` (384 dimensions)
2. **Retrieval**: Before processing each message, top-k chunks are retrieved by similarity
3. **Instance Boost**: Memories from the same embodiment get +0.1 to similarity score
4. **Context**: Retrieved memories are injected into the system prompt, explicitly labeled "via RAG" so the entity understands their retrieval mechanism
5. **Auto-repair**: Startup verification detects vector table sync issues and forces reindex

### Chat RAG

Semantic search over conversation history.

1. **Automatic Indexing**: Every message is embedded when saved (non-blocking)
2. **Tiered Search**: First searches current conversation; if no good matches (score < 0.5), expands to all conversations
3. **Relevance Filtering**: Only messages above minimum similarity score (0.3) are included
4. **Historical Context**: Helps the entity remember what was discussed previously

One-time migration for existing messages:
```bash
deno run -A scripts/index-messages.ts
```

### Graph RAG

Knowledge graph context when MCP is enabled. The entity can both read from and write to its knowledge graph during conversation. The graph is a relational index of durable state (relationships, preferences, attributes) — not narrative memory.

**Context injection (automatic):**
1. **Semantic Search**: Queries the knowledge graph for relevant nodes using vector similarity (embeddings auto-generated via all-MiniLM-L6-v2)
2. **Graph Traversal**: Follows edges to find connected concepts (depth 1 by default)
3. **Anchor Nodes**: Includes "me" and "user" nodes when referenced by edges in the result set
4. **Context Injection**: Relevant nodes and relationships are formatted in compact one-line-per-relationship format and added to the system prompt

**Context format example:**
```
---
Relevant Knowledge from Graph:
user friends_with Sarah (had a bad argument Aug 2020, reconciled since)
user drives_a Subaru (red 2010 WRX)
Sarah dating Mike (met through user)
```

**Graph building (via tools):**
- The entity can create/update nodes and edges during conversation using 7 write tools
- All node creation auto-generates vector embeddings for semantic search
- Duplicate prevention: creating a node with an existing label+type returns the existing node
- Batch operations support referencing existing nodes by label (e.g., "me", "user")
- Only durable state should be stored (people, preferences, places, goals, beliefs, health) — events and episodes belong in the memory system

Requires `PSYCHEROS_MCP_ENABLED=true`.

### Vault RAG (Data Vault)

Eager RAG over user-uploaded and entity-created reference documents. Documents are chunked, embedded, and proactively searched every turn — always available, no keyword triggers needed.

**Document storage:**
- Users upload via Settings → Data Vault UI or `POST /api/vault` (supports .md, .txt, .pdf, .docx, .xlsx)
- Entity creates/updates via `vault_write` tool (saved as markdown)
- Files stored at `data/vault/documents/{global|chat-{convId}}/`
- Content extracted, chunked (512 tokens), embedded (all-MiniLM-L6-v2, 384 dims)

**Scope:**
- **Global** — available in every conversation
- **Per-chat** — only searched in the matching conversation

**Retrieval:**
1. Every turn, the user message is embedded and compared against all vault chunks
2. Always includes global documents; per-chat documents only when conversation matches
3. Top results (default 5 chunks, 1500 token budget, min 0.3 similarity) formatted and injected
4. Falls back to in-memory cosine similarity when sqlite-vec is unavailable

**Context injection order:** base instructions → identity → lorebook → **vault** → memories → chat history → graph

**Entity tools:**
| Tool | Description |
|------|-------------|
| `vault_write` | Create or update a vault document (global or per-chat scope) |
| `vault_list` | List vault documents (filterable by scope) |
| `vault_search` | Search vault for relevant content |

### Vector Search Backend

- **Primary**: sqlite-vec extension for efficient vector similarity search
  - Linux (Docker): `lib/vec0.so` (x86-64)
  - macOS: `lib/vec0.dylib` (aarch64)
- **Fallback**: In-memory cosine similarity calculation when extension is unavailable
- **Embeddings**: HuggingFace `all-MiniLM-L6-v2` model (384 dimensions)

## Related Source Files

| File | Purpose |
|------|---------|
| `src/memory/mod.ts` | Hierarchical memory system |
| `src/memory/types.ts` | Memory types with instance tagging |
| `src/memory/consolidator.ts` | Weekly/monthly/yearly consolidation |
| `src/memory/summarizer.ts` | Daily/weekly/monthly/yearly summarization with identity context |
| `src/memory/trigger.ts` | Day-change detection |
| `src/memory/file-writer.ts` | Memory file operations |
| `src/rag/mod.ts` | RAG retrieval system |
| `src/rag/embedder.ts` | HuggingFace transformer embeddings |
| `src/rag/indexer.ts` | Memory indexing with sqlite-vec sync |
| `src/rag/retriever.ts` | Similarity search with instance boost |
| `src/rag/conversation.ts` | ChatRAG for chat history |
| `src/rag/context-builder.ts` | Formats retrieved memories for context |
| `src/db/vector.ts` | sqlite-vec helpers, serialization, search |
| `src/vault/mod.ts` | Data Vault barrel exports |
| `src/vault/manager.ts` | VaultManager — CRUD, chunking, embedding, vector search |
| `src/vault/processor.ts` | Text extraction from .md/.txt/.pdf/.docx/.xlsx |
| `src/vault/retriever.ts` | Vault context formatting for system message |
| `src/vault/types.ts` | Vault type definitions |
| `src/tools/vault-tools.ts` | vault_write, vault_list, vault_search tools |
