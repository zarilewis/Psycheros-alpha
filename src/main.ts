/**
 * Psycheros Daemon Entry Point
 *
 * Starts the persistent entity harness server.
 */

import "@std/dotenv/load";
import { Server } from "./server/mod.ts";
import { createMCPClient, type MCPClient } from "./mcp-client/mod.ts";
import { initialize } from "./init/mod.ts";

const VERSION = "0.1.0";

/**
 * Parse the PSYCHEROS_TOOLS environment variable into an array of tool names.
 * Defaults to no tools enabled (secure by default).
 * Use PSYCHEROS_TOOLS=none to explicitly disable all tools.
 * Use PSYCHEROS_TOOLS=all to enable all tools.
 * Use PSYCHEROS_TOOLS=tool1,tool2 to enable specific tools.
 */
function parseAllowedTools(): string[] {
  const toolsEnv = Deno.env.get("PSYCHEROS_TOOLS");
  if (!toolsEnv || toolsEnv.trim() === "") {
    // Default: no tools enabled (secure by default)
    return [];
  }
  return toolsEnv
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Parse the PSYCHEROS_RAG_ENABLED environment variable.
 * Defaults to true (RAG enabled by default).
 */
function parseRagEnabled(): boolean {
  const env = Deno.env.get("PSYCHEROS_RAG_ENABLED");
  if (env === undefined || env === "") {
    return true; // Default to enabled
  }
  return env.toLowerCase() === "true" || env === "1";
}

// Configuration from environment or defaults
const allowedTools = parseAllowedTools();
const ragEnabled = parseRagEnabled();
const config = {
  port: parseInt(Deno.env.get("PSYCHEROS_PORT") || "3000"),
  hostname: Deno.env.get("PSYCHEROS_HOST") || "0.0.0.0",
  projectRoot: Deno.cwd(),
  allowedTools,
  ragConfig: {
    enabled: ragEnabled,
    maxChunks: parseInt(Deno.env.get("PSYCHEROS_RAG_MAX_CHUNKS") || "8"),
    maxTokens: parseInt(Deno.env.get("PSYCHEROS_RAG_MAX_TOKENS") || "2000"),
    minScore: parseFloat(Deno.env.get("PSYCHEROS_RAG_MIN_SCORE") || "0.3"),
  },
};

console.log(`
╔═══════════════════════════════════════╗
║  Psycheros v${VERSION}                     ║
║  Entity Harness Daemon                ║
╚═══════════════════════════════════════╝
`);

// Initialize user data directories from templates
await initialize(config.projectRoot);

console.log(`Starting server on http://${config.hostname}:${config.port}`);
console.log(`Project root: ${config.projectRoot}`);
console.log(
  `Tools enabled: ${allowedTools.length > 0 ? allowedTools.join(", ") : "(none)"}`
);
console.log(`RAG enabled: ${ragEnabled}`);
console.log(`Press Ctrl+C to stop\n`);

// Initialize MCP client if enabled
let mcpClient: MCPClient | undefined;
const mcpEnabled = Deno.env.get("PSYCHEROS_MCP_ENABLED") === "true";

if (mcpEnabled) {
  const mcpCommand = Deno.env.get("PSYCHEROS_MCP_COMMAND") || "/home/zari/.deno/bin/deno";
  const mcpArgsStr = Deno.env.get("PSYCHEROS_MCP_ARGS") || `run -A ${Deno.env.get("HOME")}/projects/entity-core/src/mod.ts`;
  const mcpArgs = mcpArgsStr.split(" ");
  const mcpInstance = Deno.env.get("PSYCHEROS_MCP_INSTANCE") || "psycheros-harness";
  const entityCoreDataDir = Deno.env.get("PSYCHEROS_ENTITY_CORE_DATA_DIR") || `${Deno.env.get("HOME")}/projects/entity-core/data`;

  console.log(`MCP enabled: connecting to entity-core as ${mcpInstance}`);

  mcpClient = createMCPClient({
    command: mcpCommand,
    args: mcpArgs,
    instanceId: mcpInstance,
    env: {
      ENTITY_CORE_DATA_DIR: entityCoreDataDir,
    },
    syncOnStartup: true,
    syncInterval: 5 * 60 * 1000, // 5 minutes
    offlineFallback: true,
  });

  // Attempt connection (non-blocking)
  mcpClient.connect().then((connected) => {
    if (connected) {
      console.log("[MCP] Connected to entity-core");
    } else {
      console.log("[MCP] Running in offline mode (will sync when available)");
    }
  }).catch((error) => {
    console.error("[MCP] Connection failed:", error);
    console.log("[MCP] Running in offline mode");
  });
}

const server = new Server({
  ...config,
  mcpClient,
});

await server.init();

// Handle graceful shutdown
async function shutdown() {
  console.log("\nShutting down...");

  // Disconnect MCP client (triggers final sync)
  if (mcpClient) {
    console.log("[MCP] Syncing and disconnecting...");
    await mcpClient.disconnect();
  }

  server.stop();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

await server.start();
