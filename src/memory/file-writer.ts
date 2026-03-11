/**
 * Memory File Writer
 *
 * Handles writing memory files with proper format and chat ID extraction.
 */

import type { DBClient } from "../db/mod.ts";
import type { MemoryFile, Granularity } from "./types.ts";

/**
 * Write a memory file to disk and update the database.
 * Note: "significant" memories skip database tracking (they don't consolidate).
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

    // Significant memories are not tracked in the database (no consolidation)
    if (memory.granularity === "significant") {
      console.log(`[Memory] Wrote significant memory: ${memory.path}`);
      return true;
    }

    // Record in database for consolidatable granularities (use upsert to prevent duplicates)
    const summaryId = db.upsertMemorySummary(
      memory.date,
      memory.granularity as "daily" | "weekly" | "monthly" | "yearly",
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
 * @param includeArchive - Whether to include archived files (default: false)
 * @returns Array of file paths (relative to memories directory)
 */
export async function listMemoryFiles(
  granularity: Granularity,
  projectRoot: string,
  includeArchive = false
): Promise<string[]> {
  const files: string[] = [];

  // Read from active directory
  const dirPath = `${projectRoot}/memories/${granularity}`;
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

  // Read from archive directory if requested
  if (includeArchive) {
    const archivePath = `${projectRoot}/memories/archive/${granularity}`;
    try {
      for await (const entry of Deno.readDir(archivePath)) {
        if (entry.isFile && entry.name.endsWith(".md") && entry.name !== ".gitkeep") {
          files.push(`archive/${granularity}/${entry.name}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
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

/**
 * Write a significant memory file to disk.
 * Significant memories are NOT recorded in the database (they don't consolidate).
 *
 * @param title - The title for the memory
 * @param content - The content of the memory
 * @param conversationId - The ID of the conversation where this memory was created
 * @param projectRoot - Root directory of the project
 * @returns The relative file path if successful, null on error
 */
export async function writeSignificantMemory(
  title: string,
  content: string,
  conversationId: string,
  projectRoot: string
): Promise<string | null> {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timestamp = now.toISOString();

  // Create slug from title
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);

  const fileName = `${dateStr}_${slug}.md`;
  const relativePath = `significant/${fileName}`;
  const fullPath = `${projectRoot}/memories/${relativePath}`;

  try {
    // Ensure directory exists
    await Deno.mkdir(`${projectRoot}/memories/significant`, { recursive: true });

    // Format the memory file
    const formattedContent = `# ${title}

${content}

<!--
Date: ${dateStr}
Conversation: ${conversationId}
Created: ${timestamp}
-->
`;

    // Write the file
    await Deno.writeTextFile(fullPath, formattedContent);

    console.log(`[Memory] Wrote significant memory: ${relativePath}`);
    return relativePath;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Memory] Failed to write significant memory:`, errorMessage);
    return null;
  }
}
