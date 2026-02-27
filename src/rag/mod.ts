/**
 * RAG Module
 *
 * Retrieval-Augmented Generation system for SBy.
 * Provides local-first semantic search over the memories directory
 * and conversational history.
 *
 * @module
 *
 * @example
 * ```typescript
 * import { createIndexer, createRetriever, buildRAGContext } from "./rag/mod.ts";
 *
 * // Index memories on startup
 * const indexer = createIndexer(db, "memories");
 * await indexer.indexAll();
 *
 * // Retrieve relevant memories for a query
 * const retriever = createRetriever(db);
 * const results = await retriever.retrieve("Tell me about apples");
 *
 * // Format for context
 * const context = buildRAGContext(results);
 * ```
 */

// Types
export type {
  RAGConfig,
  Chunk,
  ChunkMetadata,
  RetrievalResult,
  Embedder,
  Chunker,
  Indexer,
  Retriever,
  IndexedMemory,
  VectorSearchResult,
} from "./types.ts";

export { DEFAULT_RAG_CONFIG } from "./types.ts";

// Embedder
export { LocalEmbedder, getEmbedder } from "./embedder.ts";

// Chunker
export { MemoryChunker, getChunker, estimateTokens } from "./chunker.ts";

// Indexer
export { MemoryIndexer, createIndexer } from "./indexer.ts";

// Retriever
export { MemoryRetriever, createRetriever } from "./retriever.ts";

// Context Builder
export { formatMemories, buildRAGContext } from "./context-builder.ts";

// Conversational RAG
export {
  ConversationRAG,
  getConversationRAG,
  formatChatHistoryForContext,
} from "./conversation.ts";
export type { ChatSearchOptions, RetrievedMessage } from "./conversation.ts";
