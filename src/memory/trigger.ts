/**
 * Memory Trigger
 *
 * Cron-based memory summarization with catch-up on startup.
 * Runs daily at a configured hour and catches up on any missed days.
 * Includes integrity checks to detect orphaned DB records from lost files.
 */

import type { DBClient } from "../db/mod.ts";
import type { OnMemoryCreated } from "./file-writer.ts";
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
 * Check integrity of memory system on startup.
 *
 * Detects orphaned DB records where memory_summaries entries exist
 * but the corresponding files are missing on disk. Clears these records
 * so catchUpSummarization() can regenerate the missing memories.
 *
 * This handles the case where the memories directory wasn't volume-mounted
 * and files were lost on container restart while the DB persisted.
 *
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @returns Number of orphaned records cleared
 */
export function repairOrphanedSummaries(
  db: DBClient,
  projectRoot: string
): number {
  const orphaned = db.findOrphanedSummaries(projectRoot);

  if (orphaned.length === 0) {
    return 0;
  }

  console.log(`[Memory] Found ${orphaned.length} orphaned summary record(s) — files missing on disk`);

  for (const record of orphaned) {
    db.deleteMemorySummary(record.id);
    console.log(`[Memory] Cleared orphaned record: ${record.date} (${record.granularity}) → ${record.filePath}`);
  }

  console.log(`[Memory] Integrity repair complete: ${orphaned.length} record(s) cleared for regeneration`);
  return orphaned.length;
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
  projectRoot: string,
  onCreated?: OnMemoryCreated,
): Promise<number> {
  // Get all dates with messages that haven't been summarized
  const unsummarizedDates = db.getUnsummarizedDates();

  // Get today's date in UTC to skip it (still in progress)
  const today = new Date().toISOString().split("T")[0];

  let summarized = 0;
  for (const date of unsummarizedDates) {
    // Don't summarize today (still in progress)
    if (date === today) continue;

    console.log(`[Memory] Catching up on ${date}...`);
    const memoryFile = await summarizeDay(new Date(date), db, projectRoot, undefined, onCreated);

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
