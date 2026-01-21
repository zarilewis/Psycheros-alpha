/**
 * Server Module
 *
 * HTTP server and SSE streaming utilities for the SBy daemon.
 * This module provides the web interface and API endpoints for
 * interacting with the entity.
 *
 * @module
 *
 * @example
 * ```typescript
 * import { Server } from "./server/mod.ts";
 *
 * const server = new Server({
 *   port: 8080,
 *   projectRoot: Deno.cwd(),
 * });
 *
 * await server.start();
 * ```
 */

// Re-export SSE utilities
export {
  createSSEEncoder,
  createSSEResponse,
  encodeSSEEvent,
} from "./sse.ts";

// Re-export route handlers and types
export type { RouteContext } from "./routes.ts";
export {
  handleChat,
  handleCORS,
  handleCreateConversation,
  handleGetMessages,
  handleIndex,
  handleListConversations,
  handleStaticFile,
} from "./routes.ts";

// Re-export server
export type { ServerConfig } from "./server.ts";
export { Server } from "./server.ts";
