#!/bin/sh
set -e

# Seed entity-core identity dirs from Psycheros templates if empty.
# On first run with a fresh volume mount, entity-core's data dirs are empty.
# Without seeding, MCP pull returns empty arrays and the entity has no identity.

TEMPLATES="/app/Psycheros/templates/identity"
DATA="/app/entity-core/data"

for subdir in self user relationship custom; do
  target="$DATA/$subdir"
  mkdir -p "$target"

  # Check if target has any .md files
  if ! ls "$target"/*.md >/dev/null 2>&1; then
    # Only copy if template dir exists and has .md files
    if ls "$TEMPLATES/$subdir"/*.md >/dev/null 2>&1; then
      cp "$TEMPLATES/$subdir"/*.md "$target/"
      count=$(ls "$target"/*.md 2>/dev/null | wc -l | tr -d ' ')
      echo "[Entrypoint] Seeded $subdir/ with $count template file(s)"
    fi
  else
    echo "[Entrypoint] $subdir/ already has identity files, skipping"
  fi
done

# Ensure memory subdirs exist
for memdir in daily weekly monthly yearly significant archive/daily; do
  mkdir -p "$DATA/memories/$memdir"
done

exec /usr/bin/dumb-init -- "$@"
