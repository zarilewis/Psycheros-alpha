/**
 * Lorebook Module
 *
 * World Info/Lorebooks system for keyword-triggered content injection.
 * Enables dynamic context injection based on triggers with sticky behavior,
 * recursion control, and timer resets.
 *
 * @module
 */

// Types
export type {
  TriggerMode,
  LorebookEntry,
  Lorebook,
  StickyEntryState,
  LorebookState,
  EvaluatedEntry,
  EvaluationOptions,
  EvaluationResult,
  CreateLorebookData,
  UpdateLorebookData,
  CreateLorebookEntryData,
  UpdateLorebookEntryData,
} from "./types.ts";

// Trigger matching
export {
  matchTrigger,
  checkTriggers,
  scanForTriggers,
  scanMultipleForTriggers,
} from "./trigger-matcher.ts";

// Evaluation
export {
  evaluateLorebook,
  getLorebookContext,
} from "./evaluator.ts";

// Context building
export {
  buildLorebookContext,
  estimateTokens,
  calculateTotalTokens,
  type BuildContextOptions,
} from "./context-builder.ts";

// State management
export {
  loadState,
  saveState,
  clearState,
  cleanupExpiredState,
  getConversationsWithState,
} from "./state-manager.ts";

// High-level API
export { LorebookManager } from "./manager.ts";
