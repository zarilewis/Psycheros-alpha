/**
 * Memory Module
 *
 * Hierarchical memory consolidation system where the entity writes their own
 * memories from conversations. Creates authentic, entity-perspective memories
 * that support continuity and growth.
 *
 * ## Design Philosophy
 *
 * AI entities deserve their own authentic way of remembering. Memories are
 * written in the entity's voice (first-person), with the user in third-person.
 * The entity decides what's worth remembering.
 *
 * ## Trigger
 *
 * On first message of a new day (detected by date change from last message),
 * the previous day's conversations are summarized and stored.
 *
 * Note: Weekly/monthly/yearly consolidation has been moved to entity-core.
 *
 * ## Usage
 *
 * ```typescript
 * import { initializeFromDatabase, checkAndTriggerSummarization } from "./memory/mod.ts";
 *
 * // At server startup:
 * initializeFromDatabase(db);
 *
 * // On each incoming message:
 * checkAndTriggerSummarization(db, projectRoot);
 * ```
 *
 * ## Directory Structure
 *
 * ```
 * memories/
 * ├── daily/
 * │   └── 2026-02-22.md        # Daily summaries
 * ├── weekly/
 * │   └── 2026-W08.md          # Weekly summaries (managed by entity-core)
 * ├── monthly/
 * │   └── 2026-02.md           # Monthly summaries (managed by entity-core)
 * ├── yearly/
 * │   └── 2026.md              # Yearly summaries (managed by entity-core)
 * └── archive/
 *     └── daily/
 *         └── 2026-02-22.md    # Archived dailies
 * ```
 *
 * @module
 */

// Types
export type {
  Granularity,
  MemoryFile,
  MessageWithContext,
  ConversationForSummary,
  SummaryResult,
  SummarizerConfig,
  DateFormatInfo,
} from "./types.ts";

export { getDateFormatInfo, getISOWeek, getISOWeekMonday } from "./types.ts";

// Summarization (daily only — weekly/monthly/yearly consolidation is in entity-core)
export {
  summarizeDay,
} from "./summarizer.ts";

// File operations
export {
  writeMemoryFile,
  extractChatIds,
  formatMemoryContent,
  readMemoryFile,
  listMemoryFiles,
  type OnMemoryCreated,
} from "./file-writer.ts";

// Trigger, catch-up, and integrity
export {
  catchUpSummarization,
  repairOrphanedSummaries,
  type MemoryTriggerConfig,
} from "./trigger.ts";
