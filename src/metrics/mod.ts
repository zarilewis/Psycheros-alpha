/**
 * Metrics Module
 *
 * Streaming performance metrics collection for diagnosing API latency.
 *
 * @module
 */

export type { MetricsCollector } from "./types.ts";
export { SLOW_CHUNK_THRESHOLD_MS } from "./types.ts";

export {
  createCollector,
  recordFirstByte,
  recordChunk,
  setFinishReason,
  finalize,
} from "./collector.ts";
