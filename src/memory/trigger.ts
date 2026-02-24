/**
 * Memory Trigger
 *
 * Cron-based memory summarization with catch-up on startup.
 * Runs daily at a configured hour and catches up on any missed days.
 */

import type { DBClient } from "../db/mod.ts";
import { summarizeDay } from "./summarizer.ts";

/**
 * Configuration for memory triggers.
 */
export interface MemoryTriggerConfig {
  /** Whether memory summarization is enabled */
  enabled: boolean;
  /** Root directory of the project */
  projectRoot: string;
}

/**
 * Find and summarize all unsummarized dates.
 * Called on startup and by the daily cron job.
 *
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @returns Number of days summarized
 */
export async function catchUpSummarization(
  db: DBClient,
  projectRoot: string
): Promise<number> {
  // Get all dates with messages that haven't been summarized
  const unsummarizedDates = db.getUnsummarizedDates();

  // Get today's date to skip it (still in progress)
  const today = new Date().toISOString().split("T")[0];

  let summarized = 0;
  for (const date of unsummarizedDates) {
    // Don't summarize today (still in progress)
    if (date === today) continue;

    console.log(`[Memory] Catching up on ${date}...`);
    const memoryFile = await summarizeDay(new Date(date), db, projectRoot);

    if (memoryFile) {
      summarized++;
      console.log(`[Memory] Created memory for ${date}: ${memoryFile.path}`);
    }
  }

  if (summarized > 0) {
    console.log(`[Memory] Catch-up complete: ${summarized} day(s) summarized`);
  }

  return summarized;
}
