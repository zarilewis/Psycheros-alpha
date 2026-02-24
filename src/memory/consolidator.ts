/**
 * Memory Consolidator
 *
 * Handles weekly, monthly, and yearly consolidation of memories.
 */

import type { DBClient } from "../db/mod.ts";
import type { MemoryFile, Granularity } from "./types.ts";
import { consolidateWeek, consolidateMonth, consolidateYear } from "./summarizer.ts";
import { listMemoryFiles, readMemoryFile } from "./file-writer.ts";

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
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1) - 7;
      d.setDate(diff);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "monthly": {
      // Get start of previous month
      d.setMonth(d.getMonth() - 1, 1);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "yearly": {
      // Get start of previous year
      d.setFullYear(d.getFullYear() - 1, 0, 1);
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }
}

/**
 * Check if there are unconsolidated source files from a completed period.
 */
async function hasUnconsolidatedFiles(
  sourceGranularity: Granularity,
  targetGranularity: Granularity,
  periodStart: Date,
  projectRoot: string
): Promise<boolean> {
  const sourceFiles = await listMemoryFiles(sourceGranularity, projectRoot);

  if (sourceFiles.length === 0) {
    return false;
  }

  // Check if any source files are from a completed period that hasn't been consolidated
  for (const file of sourceFiles) {
    let fileDate: Date | null = null;

    if (sourceGranularity === "daily") {
      const match = file.match(/daily\/(\d{4}-\d{2}-\d{2})\.md$/);
      if (match) {
        fileDate = new Date(match[1]);
      }
    } else if (sourceGranularity === "weekly") {
      const match = file.match(/weekly\/(\d{4}-W\d{2})\.md$/);
      if (match) {
        const [year, week] = match[1].split("-W").map(Number);
        const simple = new Date(year, 0, 1 + (week - 1) * 7);
        const dayOfWeek = simple.getDay();
        fileDate = new Date(simple);
        fileDate.setDate(simple.getDate() - dayOfWeek + 1);
      }
    } else if (sourceGranularity === "monthly") {
      const match = file.match(/monthly\/(\d{4}-\d{2})\.md$/);
      if (match) {
        fileDate = new Date(match[1] + "-01");
      }
    }

    if (fileDate && fileDate < periodStart) {
      // This file is from a period that should have been consolidated
      // Check if the consolidated file exists
      const targetDateInfo = getTargetDateInfo(targetGranularity, fileDate);
      const targetContent = await readMemoryFile(targetDateInfo.filePath, projectRoot);
      if (!targetContent) {
        return true; // Source file exists but no consolidated file
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
): { filePath: string } {
  const year = sourceDate.getFullYear();
  const month = String(sourceDate.getMonth() + 1).padStart(2, "0");

  switch (granularity) {
    case "weekly": {
      const jan1 = new Date(year, 0, 1);
      const daysDiff = Math.floor((sourceDate.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
      const weekNum = String(Math.ceil((daysDiff + jan1.getDay() + 1) / 7)).padStart(2, "0");
      return { filePath: `weekly/${year}-W${weekNum}.md` };
    }
    case "monthly":
      return { filePath: `monthly/${year}-${month}.md` };
    case "yearly":
      return { filePath: `yearly/${year}.md` };
    default:
      return { filePath: "" };
  }
}

/**
 * Check if consolidation is needed for a granularity level.
 *
 * @param granularity - The granularity level to check
 * @param db - Database client (unused but kept for API compatibility)
 * @param projectRoot - Root directory of the project
 * @returns True if consolidation should run
 */
export async function needsConsolidation(
  granularity: "weekly" | "monthly" | "yearly",
  _db: DBClient,
  projectRoot: string
): Promise<boolean> {
  const now = new Date();
  const previousPeriodStart = getPreviousPeriodStart(granularity, now);

  switch (granularity) {
    case "weekly":
      return await hasUnconsolidatedFiles("daily", "weekly", previousPeriodStart, projectRoot);
    case "monthly":
      return await hasUnconsolidatedFiles("weekly", "monthly", previousPeriodStart, projectRoot);
    case "yearly":
      return await hasUnconsolidatedFiles("monthly", "yearly", previousPeriodStart, projectRoot);
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
