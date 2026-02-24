/**
 * Memory File Writer
 *
 * Handles writing memory files with proper format and chat ID extraction.
 */

import type { DBClient } from "../db/mod.ts";
import type { MemoryFile, Granularity } from "./types.ts";

/**
 * Write a memory file to disk and update the database.
 *
 * @param memory - The memory file to write
 * @param db - Database client for recording the summary
 * @param projectRoot - Root directory of the project
 * @returns True if successful, false on error
 */
export async function writeMemoryFile(
  memory: MemoryFile,
  db: DBClient,
  projectRoot: string
): Promise<boolean> {
  const fullPath = `${projectRoot}/memories/${memory.path}`;

  try {
    // Ensure the directory exists
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf("/"));
    await Deno.mkdir(dirPath, { recursive: true });

    // Write the file
    await Deno.writeTextFile(fullPath, memory.content);

    // Record in database
    const summaryId = db.createMemorySummary(
      memory.date,
      memory.granularity,
      `memories/${memory.path}`,
      memory.chatIds
    );

    // Mark each chat as summarized
    for (const chatId of memory.chatIds) {
      db.markChatSummarized(chatId, memory.date, summaryId);
    }

    console.log(`[Memory] Wrote ${memory.granularity} memory: ${memory.path}`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Memory] Failed to write memory file ${memory.path}:`, errorMessage);
    return false;
  }
}

/**
 * Extract chat IDs from memory content.
 * Looks for patterns like [chat:abc123] or [chat:abc123, def456]
 *
 * @param content - The memory content to parse
 * @returns Array of unique chat IDs
 */
export function extractChatIds(content: string): string[] {
  const chatIds = new Set<string>();

  // Match [chat:id] or [chat:id1, id2, ...]
  const chatPattern = /\[chat:([a-f0-9,\s]+)\]/gi;
  let match;

  while ((match = chatPattern.exec(content)) !== null) {
    // Split by comma and trim each ID
    const ids = match[1].split(",").map((id) => id.trim()).filter((id) => id.length > 0);
    ids.forEach((id) => chatIds.add(id));
  }

  return Array.from(chatIds);
}

/**
 * Format memory file content with proper header and structure.
 *
 * @param title - The title for the memory
 * @param bulletPoints - Array of memory bullet points
 * @returns Formatted markdown content
 */
export function formatMemoryContent(title: string, bulletPoints: string[]): string {
  const timestamp = new Date().toISOString();
  const bulletList = bulletPoints.map((point) => `- ${point}`).join("\n");

  return `# ${title}

${bulletList}

<!--
Generated: ${timestamp}
-->
`;
}

/**
 * Read an existing memory file.
 *
 * @param filePath - Path relative to memories directory
 * @param projectRoot - Root directory of the project
 * @returns The file content, or null if not found
 */
export async function readMemoryFile(
  filePath: string,
  projectRoot: string
): Promise<string | null> {
  const fullPath = `${projectRoot}/memories/${filePath}`;

  try {
    return await Deno.readTextFile(fullPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

/**
 * List all memory files for a specific granularity.
 *
 * @param granularity - The granularity level
 * @param projectRoot - Root directory of the project
 * @returns Array of file paths (relative to memories directory)
 */
export async function listMemoryFiles(
  granularity: Granularity,
  projectRoot: string
): Promise<string[]> {
  const dirPath = `${projectRoot}/memories/${granularity}`;
  const files: string[] = [];

  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.isFile && entry.name.endsWith(".md") && entry.name !== ".gitkeep") {
        files.push(`${granularity}/${entry.name}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  return files.sort();
}

/**
 * Archive a daily memory file after weekly consolidation.
 *
 * @param filePath - Path relative to memories directory
 * @param projectRoot - Root directory of the project
 * @returns True if successful
 */
export async function archiveDailyMemory(
  filePath: string,
  projectRoot: string
): Promise<boolean> {
  const sourcePath = `${projectRoot}/memories/${filePath}`;
  const archivePath = `${projectRoot}/memories/archive/${filePath}`;

  try {
    // Ensure archive directory exists
    await Deno.mkdir(archivePath.substring(0, archivePath.lastIndexOf("/")), { recursive: true });

    // Move the file
    await Deno.rename(sourcePath, archivePath);

    console.log(`[Memory] Archived: ${filePath}`);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false; // File doesn't exist, nothing to archive
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Memory] Failed to archive ${filePath}:`, errorMessage);
    return false;
  }
}
