/**
 * RAG Module
 *
 * Retrieval-Augmented Generation system for Psycheros.
 * Provides local semantic search over chat history, data vault,
 * and lorebook. Memory retrieval is delegated to entity-core via MCP.
 *
 * @module
 */

// Types
export type {
  RAGConfig,
  Chunk,
  ChunkMetadata,
  RetrievalResult,
  Embedder,
  Chunker,
  IndexedMemory,
  VectorSearchResult,
} from "./types.ts";

export { DEFAULT_RAG_CONFIG } from "./types.ts";

// Embedder
export { LocalEmbedder, getEmbedder } from "./embedder.ts";

// Chunker
export { MemoryChunker, getChunker, estimateTokens } from "./chunker.ts";

// Context Builder
export {
  formatMemories,
  buildRAGContext,
  buildGraphContext,
} from "./context-builder.ts";
export type { BuildGraphContextOptions, GraphContextResult } from "./context-builder.ts";

// Conversational RAG
export {
  ConversationRAG,
  getConversationRAG,
  formatChatHistoryForContext,
} from "./conversation.ts";
export type { ChatSearchOptions, RetrievedMessage } from "./conversation.ts";
