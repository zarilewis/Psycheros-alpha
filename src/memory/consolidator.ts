/**
 * Memory Consolidator
 *
 * Handles weekly, monthly, and yearly consolidation of memories.
 */

import type { DBClient } from "../db/mod.ts";
import type { MemoryFile, Granularity } from "./types.ts";
import { getISOWeek, getISOWeekMonday } from "./types.ts";
import { consolidateWeek, consolidateMonth, consolidateYear } from "./summarizer.ts";
import { listMemoryFiles, type OnMemoryCreated } from "./file-writer.ts";

/**
 * Consolidation result.
 */
export interface ConsolidationResult {
  success: boolean;
  memoryFile?: MemoryFile;
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
 * Collect all target consolidation periods that have unconsolidated source files.
 * Checks active directories only and verifies database records.
 *
 * @returns Set of target date strings that need consolidation
 */
async function findUnconsolidatedPeriods(
  sourceGranularity: Granularity,
  targetGranularity: Granularity,
  periodStart: Date,
  db: DBClient,
  projectRoot: string
): Promise<Set<string>> {
  const sourceFiles = await listMemoryFiles(sourceGranularity, projectRoot, false);

  if (sourceFiles.length === 0) {
    return new Set();
  }

  const unconsolidatedPeriods = new Set<string>();

  for (const file of sourceFiles) {
    let fileDate: Date | null = null;

    if (sourceGranularity === "daily") {
      const match = file.match(/(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})_(?:\w+)\.md$/)
        || file.match(/(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})\.md$/);
      if (match) {
        fileDate = new Date(match[1]);
      }
    } else if (sourceGranularity === "weekly") {
      const match = file.match(/(?:^|\/)weekly\/(\d{4}-W\d{2})\.md$/);
      if (match) {
        const [year, week] = match[1].split("-W").map(Number);
        fileDate = getISOWeekMonday(year, week);
      }
    } else if (sourceGranularity === "monthly") {
      const match = file.match(/(?:^|\/)monthly\/(\d{4}-\d{2})\.md$/);
      if (match) {
        fileDate = new Date(match[1] + "-01");
      }
    }

    if (fileDate && fileDate < periodStart) {
      const targetDateInfo = getTargetDateInfo(targetGranularity, fileDate);
      const existingSummary = db.getMemorySummary(
        targetDateInfo.dateStr,
        targetGranularity as "daily" | "weekly" | "monthly" | "yearly"
      );
      if (!existingSummary) {
        console.log(`[Memory] Found unconsolidated ${sourceGranularity} file: ${file} -> needs ${targetGranularity} ${targetDateInfo.dateStr}`);
        unconsolidatedPeriods.add(targetDateInfo.dateStr);
      }
    }
  }

  return unconsolidatedPeriods;
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
      const iso = getISOWeek(sourceDate);
      const dateStr = `${iso.year}-W${String(iso.week).padStart(2, "0")}`;
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

  const sourceGranularity = granularity === "weekly" ? "daily"
    : granularity === "monthly" ? "weekly"
    : "monthly";

  const periods = await findUnconsolidatedPeriods(sourceGranularity, granularity, previousPeriodStart, db, projectRoot);
  return periods.size > 0;
}

/**
 * Run consolidation for a specific target period.
 *
 * @param granularity - The granularity level
 * @param targetDateStr - The target period date string (e.g., "2026-W13", "2026-03", "2026")
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @param onCreated - Optional callback for when a memory is created
 * @returns Consolidation result
 */
export async function runConsolidation(
  granularity: "weekly" | "monthly" | "yearly",
  db: DBClient,
  projectRoot: string,
  onCreated?: OnMemoryCreated,
  targetDateStr?: string,
): Promise<ConsolidationResult> {
  let targetDate: Date;

  if (targetDateStr) {
    // Parse the provided target date string
    if (granularity === "weekly") {
      const match = targetDateStr.match(/^(\d{4})-W(\d{2})$/);
      if (match) {
        targetDate = getISOWeekMonday(parseInt(match[1]), parseInt(match[2]));
      } else {
        return { success: false, error: `Invalid weekly date string: ${targetDateStr}` };
      }
    } else if (granularity === "monthly") {
      targetDate = new Date(targetDateStr + "-01");
    } else {
      targetDate = new Date(`${targetDateStr}-01-01`);
    }
  } else {
    // Fall back to previous period for backwards compatibility
    const now = new Date();
    targetDate = getPreviousPeriodStart(granularity, now);
  }

  try {
    let memoryFile: import("./types.ts").MemoryFile | null = null;

    switch (granularity) {
      case "weekly":
        memoryFile = await consolidateWeek(targetDate, db, projectRoot, undefined, onCreated);
        break;
      case "monthly":
        memoryFile = await consolidateMonth(targetDate, db, projectRoot, undefined, onCreated);
        break;
      case "yearly":
        memoryFile = await consolidateYear(targetDate, db, projectRoot, undefined, onCreated);
        break;
    }

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

/**
 * Run consolidation for ALL unconsolidated periods across all granularity levels.
 * This is the catch-up function that ensures no period is missed.
 *
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @param onCreated - Optional callback for when a memory is created
 * @returns Array of consolidation results for all periods processed
 */
export async function runAllConsolidations(
  db: DBClient,
  projectRoot: string,
  onCreated?: OnMemoryCreated,
): Promise<ConsolidationResult[]> {
  const now = new Date();
  const results: ConsolidationResult[] = [];

  // Weekly: find all unconsolidated weeks
  const weeklyPeriodStart = getPreviousPeriodStart("weekly", now);
  const weeklyPeriods = await findUnconsolidatedPeriods("daily", "weekly", weeklyPeriodStart, db, projectRoot);
  for (const periodStr of weeklyPeriods) {
    console.log(`[Memory] Consolidating week: ${periodStr}`);
    const result = await runConsolidation("weekly", db, projectRoot, onCreated, periodStr);
    results.push(result);
  }

  // Monthly: find all unconsolidated months
  const monthlyPeriodStart = getPreviousPeriodStart("monthly", now);
  const monthlyPeriods = await findUnconsolidatedPeriods("weekly", "monthly", monthlyPeriodStart, db, projectRoot);
  for (const periodStr of monthlyPeriods) {
    console.log(`[Memory] Consolidating month: ${periodStr}`);
    const result = await runConsolidation("monthly", db, projectRoot, onCreated, periodStr);
    results.push(result);
  }

  // Yearly: find all unconsolidated years
  const yearlyPeriodStart = getPreviousPeriodStart("yearly", now);
  const yearlyPeriods = await findUnconsolidatedPeriods("monthly", "yearly", yearlyPeriodStart, db, projectRoot);
  for (const periodStr of yearlyPeriods) {
    console.log(`[Memory] Consolidating year: ${periodStr}`);
    const result = await runConsolidation("yearly", db, projectRoot, onCreated, periodStr);
    results.push(result);
  }

  return results;
}
