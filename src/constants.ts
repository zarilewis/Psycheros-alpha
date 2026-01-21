/**
 * SBy Constants
 *
 * Shared configuration constants used across modules.
 *
 * @module
 */

// =============================================================================
// Validation Limits
// =============================================================================

/** Maximum length for conversation titles */
export const MAX_TITLE_LENGTH = 200;

/** Minimum length for conversation titles (must have at least some content) */
export const MIN_TITLE_LENGTH = 1;

// =============================================================================
// SSE Streaming
// =============================================================================

/** Maximum size for SSE message data in bytes (100KB) */
export const MAX_SSE_MESSAGE_SIZE = 100 * 1024;

/** Truncation message appended when SSE data is truncated */
export const SSE_TRUNCATION_SUFFIX = "\n... [truncated]";
