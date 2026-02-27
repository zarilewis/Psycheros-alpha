/**
 * SBy Database Module
 *
 * Exports database functionality for the SBy daemon.
 */

export { DBClient } from "./client.ts";
export { initializeSchema } from "./schema.ts";
export {
  loadVectorExtension,
  isVectorModuleAvailable,
  ensureVectorModule,
  serializeVector,
  deserializeVector,
  createVectorTable,
  insertVector,
  deleteVector,
  searchSimilarVectors,
  getVecVersion,
} from "./vector.ts";
export type { VectorSearchRow } from "./vector.ts";
