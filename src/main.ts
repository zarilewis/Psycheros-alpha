/**
 * SBy Daemon Entry Point
 *
 * Starts the persistent entity harness server.
 */

import "@std/dotenv/load";
import { Server } from "./server/mod.ts";

const VERSION = "0.1.0";

/**
 * Parse the SBY_TOOLS environment variable into an array of tool names.
 * Returns empty array if not set (secure by default - no tools enabled).
 */
function parseAllowedTools(): string[] {
  const toolsEnv = Deno.env.get("SBY_TOOLS");
  if (!toolsEnv || toolsEnv.trim() === "") {
    return [];
  }
  return toolsEnv
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

// Configuration from environment or defaults
const allowedTools = parseAllowedTools();
const config = {
  port: parseInt(Deno.env.get("SBY_PORT") || "3000"),
  hostname: Deno.env.get("SBY_HOST") || "0.0.0.0",
  projectRoot: Deno.cwd(),
  allowedTools,
};

console.log(`
╔═══════════════════════════════════════╗
║  SBy - Strauberry Tavern v${VERSION}        ║
║  Entity Harness Daemon                ║
╚═══════════════════════════════════════╝
`);

console.log(`Starting server on http://${config.hostname}:${config.port}`);
console.log(`Project root: ${config.projectRoot}`);
console.log(
  `Tools enabled: ${allowedTools.length > 0 ? allowedTools.join(", ") : "(none)"}`
);
console.log(`Press Ctrl+C to stop\n`);

const server = new Server(config);

// Handle graceful shutdown
Deno.addSignalListener("SIGINT", () => {
  console.log("\nShutting down...");
  server.stop();
  Deno.exit(0);
});

await server.start();
