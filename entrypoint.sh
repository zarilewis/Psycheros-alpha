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

# Ensure memory subdirs exist in entity-core (canonical location)
for memdir in daily weekly monthly yearly significant archive/daily archive/weekly archive/monthly; do
  mkdir -p "$DATA/memories/$memdir"
done

# Symlink Psycheros memories → entity-core memories (single source of truth).
# Psycheros cron writes here; entity-core MCP also writes here.
# Both systems share one physical copy, persisted by the entity-core-data volume.
if [ -d "/app/Psycheros/memories" ] && [ ! -L "/app/Psycheros/memories" ]; then
  # Remove the directory if it exists (from Docker build) so we can symlink
  rm -rf "/app/Psycheros/memories"
fi
if [ ! -L "/app/Psycheros/memories" ]; then
  ln -s "$DATA/memories" "/app/Psycheros/memories"
  echo "[Entrypoint] Linked Psycheros/memories → entity-core/data/memories"
fi

exec /usr/bin/dumb-init -- "$@"
