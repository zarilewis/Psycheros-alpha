/**
 * Memory Consolidator
 *
 * Handles weekly, monthly, and yearly consolidation of memories.
 */

import type { DBClient } from "../db/mod.ts";
import type { MemoryFile, Granularity } from "./types.ts";
import { consolidateWeek, consolidateMonth, consolidateYear } from "./summarizer.ts";
import { listMemoryFiles } from "./file-writer.ts";

/**
 * Consolidation result.
 */
export interface ConsolidationResult {
  success: boolean;
  memoryFile?: MemoryFile;
  archivedFiles?: string[];
  error?: string;
}

/**
 * Get the start of the previous period for a given granularity.
 */
function getPreviousPeriodStart(granularity: "weekly" | "monthly" | "yearly", now: Date): Date {
  const d = new Date(now);

  switch (granularity) {
    case "weekly": {
      // Get start of previous week (Monday)
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1) - 7;
      d.setUTCDate(diff);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "monthly": {
      // Get start of previous month
      d.setUTCMonth(d.getUTCMonth() - 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "yearly": {
      // Get start of previous year
      d.setUTCFullYear(d.getUTCFullYear() - 1, 0, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
  }
}

/**
 * Check if there are unconsolidated source files from a completed period.
 * Checks both active and archive directories, and verifies database records.
 */
async function hasUnconsolidatedFiles(
  sourceGranularity: Granularity,
  targetGranularity: Granularity,
  periodStart: Date,
  db: DBClient,
  projectRoot: string
): Promise<boolean> {
  // Include archived files since they may still need consolidation
  const sourceFiles = await listMemoryFiles(sourceGranularity, projectRoot, true);

  if (sourceFiles.length === 0) {
    return false;
  }

  // Check if any source files are from a completed period that hasn't been consolidated
  for (const file of sourceFiles) {
    let fileDate: Date | null = null;
    let fileDateStr: string | null = null;

    // Handle both active and archive paths
    if (sourceGranularity === "daily") {
      // Match both daily/YYYY-MM-DD.md and archive/daily/YYYY-MM-DD.md
      const match = file.match(/(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})\.md$/);
      if (match) {
        fileDateStr = match[1];
        fileDate = new Date(match[1]);
      }
    } else if (sourceGranularity === "weekly") {
      // Match both weekly/YYYY-WNN.md and archive/weekly/YYYY-WNN.md
      const match = file.match(/(?:^|\/)weekly\/(\d{4}-W\d{2})\.md$/);
      if (match) {
        fileDateStr = match[1];
        const [year, week] = match[1].split("-W").map(Number);
        const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
        const dayOfWeek = simple.getUTCDay();
        fileDate = new Date(simple);
        fileDate.setUTCDate(simple.getUTCDate() - dayOfWeek + 1);
      }
    } else if (sourceGranularity === "monthly") {
      // Match both monthly/YYYY-MM.md and archive/monthly/YYYY-MM.md
      const match = file.match(/(?:^|\/)monthly\/(\d{4}-\d{2})\.md$/);
      if (match) {
        fileDateStr = match[1];
        fileDate = new Date(match[1] + "-01");
      }
    }

    if (fileDate && fileDateStr && fileDate < periodStart) {
      // This file is from a period that should have been consolidated
      // Check the DATABASE for a consolidated record (not just file existence)
      const targetDateInfo = getTargetDateInfo(targetGranularity, fileDate);
      const existingSummary = db.getMemorySummary(
        targetDateInfo.dateStr,
        targetGranularity as "daily" | "weekly" | "monthly" | "yearly"
      );
      if (!existingSummary) {
        console.log(`[Memory] Found unconsolidated ${sourceGranularity} file: ${file} -> needs ${targetGranularity} ${targetDateInfo.dateStr}`);
        return true; // Source file exists but no consolidated record in DB
      }
    }
  }

  return false;
}

/**
 * Get target file path info for a consolidation.
 */
function getTargetDateInfo(
  granularity: Granularity,
  sourceDate: Date
): { filePath: string; dateStr: string } {
  const year = sourceDate.getUTCFullYear();
  const month = String(sourceDate.getUTCMonth() + 1).padStart(2, "0");

  switch (granularity) {
    case "weekly": {
      const jan1 = new Date(Date.UTC(year, 0, 1));
      const daysDiff = Math.floor((sourceDate.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
      const weekNum = String(Math.ceil((daysDiff + jan1.getUTCDay() + 1) / 7)).padStart(2, "0");
      const dateStr = `${year}-W${weekNum}`;
      return { filePath: `weekly/${dateStr}.md`, dateStr };
    }
    case "monthly": {
      const dateStr = `${year}-${month}`;
      return { filePath: `monthly/${dateStr}.md`, dateStr };
    }
    case "yearly":
      return { filePath: `yearly/${year}.md`, dateStr: String(year) };
    default:
      return { filePath: "", dateStr: "" };
  }
}

/**
 * Check if consolidation is needed for a granularity level.
 *
 * @param granularity - The granularity level to check
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @returns True if consolidation should run
 */
export async function needsConsolidation(
  granularity: "weekly" | "monthly" | "yearly",
  db: DBClient,
  projectRoot: string
): Promise<boolean> {
  const now = new Date();
  const previousPeriodStart = getPreviousPeriodStart(granularity, now);

  switch (granularity) {
    case "weekly":
      return await hasUnconsolidatedFiles("daily", "weekly", previousPeriodStart, db, projectRoot);
    case "monthly":
      return await hasUnconsolidatedFiles("weekly", "monthly", previousPeriodStart, db, projectRoot);
    case "yearly":
      return await hasUnconsolidatedFiles("monthly", "yearly", previousPeriodStart, db, projectRoot);
  }
}

/**
 * Run consolidation for a specific granularity level.
 *
 * @param granularity - The granularity level
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @returns Consolidation result
 */
export async function runConsolidation(
  granularity: "weekly" | "monthly" | "yearly",
  db: DBClient,
  projectRoot: string
): Promise<ConsolidationResult> {
  // Get a date in the previous period to consolidate
  const now = new Date();
  const targetDate = getPreviousPeriodStart(granularity, now);

  switch (granularity) {
    case "weekly":
      try {
        const memoryFile = await consolidateWeek(targetDate, db, projectRoot);
        return {
          success: !!memoryFile,
          memoryFile: memoryFile ?? undefined,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

    case "monthly":
      try {
        const memoryFile = await consolidateMonth(targetDate, db, projectRoot);
        return {
          success: !!memoryFile,
          memoryFile: memoryFile ?? undefined,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

    case "yearly":
      try {
        const memoryFile = await consolidateYear(targetDate, db, projectRoot);
        return {
          success: !!memoryFile,
          memoryFile: memoryFile ?? undefined,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
  }
}

/**
 * Run all needed consolidations.
 *
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @returns Array of consolidation results
 */
export async function runAllConsolidations(
  db: DBClient,
  projectRoot: string
): Promise<ConsolidationResult[]> {
  const results: ConsolidationResult[] = [];

  // Check and run weekly consolidation
  if (await needsConsolidation("weekly", db, projectRoot)) {
    results.push(await runConsolidation("weekly", db, projectRoot));
  }

  // Check and run monthly consolidation
  if (await needsConsolidation("monthly", db, projectRoot)) {
    results.push(await runConsolidation("monthly", db, projectRoot));
  }

  // Check and run yearly consolidation
  if (await needsConsolidation("yearly", db, projectRoot)) {
    results.push(await runConsolidation("yearly", db, projectRoot));
  }

  return results;
}
