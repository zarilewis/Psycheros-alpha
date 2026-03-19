/**
 * Vault Module
 *
 * Barrel exports for the Data Vault system.
 */

export { VaultManager } from "./manager.ts";
export { formatVaultContext } from "./retriever.ts";
export { extractText, resolveFileType } from "./processor.ts";
export type {
  VaultDocument,
  VaultChunk,
  VaultSearchResult,
  VaultListOptions,
  VaultCreateOptions,
  VaultSearchOptions,
  VaultScope,
  VaultSource,
  VaultFileType,
} from "./types.ts";
export {
  SUPPORTED_VAULT_TYPES,
  VAULT_MIME_TYPES,
  MAX_VAULT_FILE_SIZE,
  VAULT_DEFAULT_MAX_TOKENS,
  VAULT_DEFAULT_MAX_CHUNKS,
} from "./types.ts";
