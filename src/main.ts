/**
 * SBy Daemon Entry Point
 *
 * Starts the persistent entity harness server.
 */

import "@std/dotenv/load";
import { Server } from "./server/mod.ts";

const VERSION = "0.1.0";

// Configuration from environment or defaults
const config = {
  port: parseInt(Deno.env.get("SBY_PORT") || "3000"),
  hostname: Deno.env.get("SBY_HOST") || "0.0.0.0",
  projectRoot: Deno.cwd(),
};

console.log(`
╔═══════════════════════════════════════╗
║  SBy - Strauberry Tavern v${VERSION}        ║
║  Entity Harness Daemon                ║
╚═══════════════════════════════════════╝
`);

console.log(`Starting server on http://${config.hostname}:${config.port}`);
console.log(`Project root: ${config.projectRoot}`);
console.log(`Press Ctrl+C to stop\n`);

const server = new Server(config);

// Handle graceful shutdown
Deno.addSignalListener("SIGINT", () => {
  console.log("\nShutting down...");
  server.stop();
  Deno.exit(0);
});

await server.start();
