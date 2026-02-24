/**
 * Memory Module Type Definitions
 *
 * Types for the hierarchical memory consolidation system where the entity
 * writes their own memories from conversations.
 */

/**
 * Granularity levels for memory summaries.
 */
export type Granularity = "daily" | "weekly" | "monthly" | "yearly";

/**
 * A memory file with its metadata and content.
 */
export interface MemoryFile {
  /** Path to the memory file (relative to project root) */
  path: string;
  /** Content of the memory file */
  content: string;
  /** Chat IDs referenced in this memory */
  chatIds: string[];
  /** Granularity level */
  granularity: Granularity;
  /** Date string (YYYY-MM-DD for daily, YYYY-WXX for weekly, YYYY-MM for monthly, YYYY for yearly) */
  date: string;
}

/**
 * A message with its conversation context for summarization.
 */
export interface MessageWithContext {
  /** Message ID */
  id: string;
  /** Conversation ID */
  conversationId: string;
  /** Message role */
  role: "system" | "user" | "assistant" | "tool";
  /** Message content */
  content: string;
  /** Creation timestamp */
  createdAt: Date;
}

/**
 * Conversation data grouped for summarization.
 */
export interface ConversationForSummary {
  /** Conversation ID */
  id: string;
  /** Conversation title (if any) */
  title?: string;
  /** Messages in this conversation */
  messages: MessageWithContext[];
}

/**
 * Result of a summarization operation.
 */
export interface SummaryResult {
  /** Whether the summarization was successful */
  success: boolean;
  /** The generated memory file (if successful) */
  memoryFile?: MemoryFile;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Configuration for the memory summarizer.
 */
export interface SummarizerConfig {
  /** Root directory for memory files */
  memoriesDir: string;
  /** Maximum tokens for summary generation */
  maxSummaryTokens?: number;
  /** Whether memory consolidation is enabled */
  enabled?: boolean;
}

/**
 * Date format info for each granularity.
 */
export interface DateFormatInfo {
  /** The date string format */
  dateStr: string;
  /** The file path (relative to memories dir) */
  filePath: string;
  /** The title for the memory file */
  title: string;
}

/**
 * Get date format info for a given date and granularity.
 */
export function getDateFormatInfo(date: Date, granularity: Granularity): DateFormatInfo {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  // Get ISO week number
  const jan1 = new Date(year, 0, 1);
  const daysDiff = Math.floor((date.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
  const weekNum = String(Math.ceil((daysDiff + jan1.getDay() + 1) / 7)).padStart(2, "0");

  switch (granularity) {
    case "daily": {
      const dateStr = `${year}-${month}-${day}`;
      return {
        dateStr,
        filePath: `daily/${dateStr}.md`,
        title: `Daily Memory - ${dateStr}`,
      };
    }
    case "weekly": {
      const weekStr = `${year}-W${weekNum}`;
      return {
        dateStr: weekStr,
        filePath: `weekly/${weekStr}.md`,
        title: `Weekly Memory - ${weekStr}`,
      };
    }
    case "monthly": {
      const monthStr = `${year}-${month}`;
      return {
        dateStr: monthStr,
        filePath: `monthly/${monthStr}.md`,
        title: `Monthly Memory - ${monthStr}`,
      };
    }
    case "yearly":
      return {
        dateStr: String(year),
        filePath: `yearly/${year}.md`,
        title: `Yearly Memory - ${year}`,
      };
  }
}
