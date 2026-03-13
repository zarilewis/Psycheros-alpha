# Psycheros + entity-core single-container image
# Target: linux/amd64 (UnRAID homelab)
#
# Build context is the Zari workspace root (parent of both repos).
# Usage:
#   docker build --platform linux/amd64 -t psycheros .
#   docker run -p 3000:3000 -e ZAI_API_KEY=<key> psycheros

FROM denoland/deno:2.6.7 AS deps

WORKDIR /app

# Copy dependency manifests first for cache-friendly layers
# Psycheros: deno.lock is gitignored, so only copy deno.json
COPY Psycheros/deno.json Psycheros/
COPY entity-core/deno.json entity-core/deno.lock entity-core/

# Copy just enough source for deno cache to resolve all imports
COPY Psycheros/src/ Psycheros/src/
COPY entity-core/src/ entity-core/src/

# Install dependencies for both projects (deno install fully resolves npm packages)
RUN cd /app/Psycheros && deno install --entrypoint src/main.ts \
    && cd /app/entity-core && deno install --entrypoint src/mod.ts

# --- Runtime stage ---
FROM denoland/deno:2.6.7

# Install dumb-init for proper PID 1 signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy cached Deno modules from deps stage
COPY --from=deps /deno-dir /deno-dir

# Copy full application source
COPY Psycheros/ ./Psycheros/
COPY entity-core/ ./entity-core/

# Copy entrypoint script (seeds entity-core identity on first run)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

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
