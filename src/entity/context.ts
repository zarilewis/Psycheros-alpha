/**
 * Entity Context Utilities
 *
 * Provides functions for loading and managing the SBy.md file
 * which serves as the entity's persistent memory and context.
 */

import { join } from "@std/path";

/**
 * The filename for the entity's state document.
 */
const SBY_MD_FILENAME = "SBy.md";

/**
 * Load the SBy.md file and return its contents.
 * Returns empty string if file doesn't exist.
 *
 * @param projectRoot - The root directory of the project
 * @returns The contents of SBy.md or empty string
 */
export async function loadSByMd(projectRoot: string): Promise<string> {
  const filePath = join(projectRoot, SBY_MD_FILENAME);

  try {
    const content = await Deno.readTextFile(filePath);
    return content;
  } catch (error) {
    // Return empty string if file doesn't exist
    if (error instanceof Deno.errors.NotFound) {
      return "";
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Update the SBy.md file with new content.
 *
 * Uses atomic write pattern (write to temp file, then rename) to prevent
 * corruption if the process is interrupted during write. This also helps
 * prevent race conditions when multiple processes might update the file.
 *
 * @param projectRoot - The root directory of the project
 * @param content - The new content to write
 */
export async function updateSByMd(
  projectRoot: string,
  content: string,
): Promise<void> {
  const filePath = join(projectRoot, SBY_MD_FILENAME);
  const tempPath = join(projectRoot, `.${SBY_MD_FILENAME}.tmp.${Date.now()}`);

  try {
    // Write to temporary file first
    await Deno.writeTextFile(tempPath, content);

    // Atomically rename temp file to target (atomic on POSIX systems)
    await Deno.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await Deno.remove(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Build the system message from SBy.md content.
 * This gets included at the start of every LLM request.
 *
 * @param sbyMdContent - The contents of the SBy.md file
 * @returns The formatted system message
 */
export function buildSystemMessage(sbyMdContent: string): string {
  const timestamp = new Date().toISOString();

  const baseInstructions = `You are SBy, a persistent AI companion and assistant.

You have access to tools that let you interact with the system. Use them when the user asks you to perform actions.

IMPORTANT guidelines for tool use:
- Only use tools when explicitly needed to complete a task
- Don't use tools just to explore or gather information you already have
- When demonstrating a capability, one example is usually sufficient
- Stop and respond to the user rather than chaining many tool calls

You can maintain persistent state by updating the SBy.md file. This file is automatically loaded into your context each turn (shown below if it exists), so you don't need to read it - just update it when you want to remember something.

Current timestamp: ${timestamp}`;

  if (sbyMdContent.trim()) {
    return `${baseInstructions}

---

Your current state document (SBy.md):

${sbyMdContent}`;
  }

  return baseInstructions;
}
