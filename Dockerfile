# Psycheros + entity-core single-container image
# Target: linux/amd64 (UnRAID homelab)
#
# Build context is the Zari workspace root (parent of both repos).
# Usage:
#   docker build --platform linux/amd64 -t psycheros .
#   docker run -p 3000:3000 -e ZAI_API_KEY=<key> psycheros

FROM denoland/deno:2.6.7

# Install dumb-init for proper PID 1 signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy application source
COPY Psycheros/ ./Psycheros/
COPY entity-core/ ./entity-core/

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Enable nodeModulesDir in both projects (Docker only, not in source repos).
# This creates local node_modules/ directories instead of relying on the
# global /deno-dir cache, which has proven unreliable across build environments.
RUN cd /app/Psycheros && deno eval "\
    const j = JSON.parse(Deno.readTextFileSync('deno.json')); \
    j.nodeModulesDir = 'auto'; \
    Deno.writeTextFileSync('deno.json', JSON.stringify(j, null, 2) + '\n');" \
    && cd /app/entity-core && deno eval "\
    const j = JSON.parse(Deno.readTextFileSync('deno.json')); \
    j.nodeModulesDir = 'auto'; \
    Deno.writeTextFileSync('deno.json', JSON.stringify(j, null, 2) + '\n');"

# Install all dependencies into local node_modules/ directories
RUN cd /app/Psycheros && deno install --entrypoint src/main.ts \
    && cd /app/entity-core && deno install --entrypoint src/mod.ts

# Cache dynamic imports that deno install can't statically analyze
RUN cd /app/Psycheros && deno cache npm:@huggingface/transformers@3.3.1 \
    && deno cache "npm:sqlite-vec@0.0.1-alpha.9" || true

# Warm-start both apps to cache any remaining transitive JSR deps
# (e.g. @denosaurs/plug → @std/path@0.217.0 pulled by @db/sqlite)
RUN cd /app/entity-core && timeout 5s deno run -A --unstable-cron src/mod.ts || true
RUN cd /app/Psycheros && timeout 10s deno run -A --unstable-cron src/main.ts || true

# Create volume-mounted directories (will be overlaid by volume mounts)
RUN mkdir -p \
    /app/Psycheros/.snapshots \
    /app/Psycheros/.psycheros \
    /app/entity-core/data

EXPOSE 3000

# Default environment — MCP wired up for single-container layout
ENV PSYCHEROS_HOST=0.0.0.0
ENV PSYCHEROS_PORT=3000
ENV PSYCHEROS_MCP_ENABLED=true
ENV PSYCHEROS_MCP_COMMAND=deno
ENV PSYCHEROS_MCP_ARGS="run -A --unstable-cron /app/entity-core/src/mod.ts"
ENV PSYCHEROS_ENTITY_CORE_DATA_DIR=/app/entity-core/data

# Health check (start-period accounts for embedding model load time)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD deno eval "const r = await fetch('http://localhost:3000/health'); if (!r.ok) Deno.exit(1);"

# Set working directory to Psycheros so Deno.cwd() resolves static files correctly
WORKDIR /app/Psycheros

# Entrypoint seeds identity templates, then execs into dumb-init → deno
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["deno", "run", "-A", "--unstable-cron", "/app/Psycheros/src/main.ts"]
