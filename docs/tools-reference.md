# Tools & Identity System

## Tool System Overview

Tools are registered in `src/tools/registry.ts` via `createDefaultRegistry()`. Each tool implements the `Tool` interface and must be explicitly enabled via the `PSYCHEROS_TOOLS` environment variable.

### Adding a New Tool

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface
2. Register in `createDefaultRegistry()` in `src/tools/registry.ts`
3. For UI updates: use a state-change function, return `affectedRegions`
4. Tool descriptions use first-person: "I use this to..."

See [configuration.md](configuration.md) for the full list of available tools.

## Identity Tools

The entity can modify its identity files through two tiers of tools.

### Tier 1: Casual Tools (Append-Only)

Safe for everyday use — can only add content, never modify or delete existing content.

| Tool | Description |
|------|-------------|
| `append_to_self` | Add new self-knowledge (who I am, how I work) |
| `append_to_user` | Add new user knowledge (preferences, patterns, life) |
| `append_to_relationship` | Add relationship understanding (dynamics, history) |

### Tier 2: Maintenance Tools (Full Suite)

For intentional reorganization — includes prepend, section updates, and full replacement.

| Tool | Description |
|------|-------------|
| `maintain_identity` | Full file maintenance with operations: append, prepend, update_section, replace |
| `list_identity_snapshots` | View available backups created during replace operations |

### MCP Fallback Pattern

All identity tools route through entity-core when MCP is connected, falling back to local files when offline:

```
Tool called → MCP connected?
                ↓ Yes          ↓ No
         Call MCP tool    Write local file
                ↓                ↓
         Server-side       Queue for sync
         manipulation
```

Changes are timestamped and preserve XML tag structure in identity files.

### Related Source Files

| File | Purpose |
|------|---------|
| `src/tools/registry.ts` | Tool registration and default registry |
| `src/tools/identity-helpers.ts` | Identity file utilities (XML parsing, MCP fallback) |
| `src/tools/identity-casual.ts` | Tier 1 append-only identity tools |
| `src/tools/identity-maintain.ts` | Tier 2 maintenance identity tools |

## Identity File Structure (Core Prompts)

Identity files are versioned markdown stored in the `identity/` directory:

```
identity/
├── self/               # Entity identity
│   ├── my_identity.md
│   ├── my_persona.md
│   ├── my_personhood.md
│   ├── my_wants.md
│   └── my_mechanics.md
├── user/               # User knowledge
│   ├── user_identity.md
│   ├── user_life.md
│   ├── user_beliefs.md
│   ├── user_preferences.md
│   ├── user_patterns.md
│   └── user_notes.md
├── relationship/       # Shared dynamics
│   ├── relationship_dynamics.md
│   ├── relationship_history.md
│   └── relationship_notes.md
└── custom/             # User-defined files
    └── *.md
```

### Custom Identity Files

The `identity/custom/` directory allows creating arbitrary identity files:
- Must use single-word filenames (letters, numbers, underscores only)
- Automatically wrapped in XML tags matching the filename
- Managed via Settings → Core Prompts in the web UI
- Sorted alphabetically (no predefined order)

### Data Protection

- `identity/`, `memories/`, `.snapshots/` are in `.gitignore` — protected from git overwrites
- Fresh installations get default files from `templates/identity/` via `src/init/mod.ts`
- When MCP is enabled, identity files are loaded from entity-core (local `identity/` is a cache)

### Core Prompts UI

Accessible via Settings hub in the sidebar. Provides a web interface for managing identity files:

**Tabs:** Self, User, Relationship, Custom, Snapshots

**Features:**
- View and edit any identity file
- Create/delete custom files
- Create manual snapshots
- Preview and restore from snapshots (requires MCP connection)
