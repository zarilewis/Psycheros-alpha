/**
 * Entity Context Utilities
 *
 * Provides functions for loading and managing the entity's self files
 * and user files, which serve as persistent memory and context.
 */

import { join } from "@std/path";
import type { MCPClient, IdentityContent } from "../mcp-client/mod.ts";

/**
 * The directory name for the entity's self files.
 */
const SELF_DIR = "self";

/**
 * The directory name for the user files.
 */
const USER_DIR = "user";

/**
 * The directory name for the relationship files.
 */
const RELATIONSHIP_DIR = "relationship";

/**
 * The order in which self-files should be loaded.
 * Files not in this list will be appended at the end (alphabetically).
 */
const SELF_FILE_ORDER = [
  "my_identity.md",
  "my_persona.md",
  "my_personhood.md",
  "my_wants.md",
  "my_mechanics.md",
];

/**
 * The order in which user-files should be loaded.
 * Files not in this list will be appended at the end (alphabetically).
 */
const USER_FILE_ORDER = [
  "user_identity.md",
  "user_life.md",
  "user_beliefs.md",
  "user_preferences.md",
  "user_patterns.md",
  "user_notes.md",
];

/**
 * The order in which relationship-files should be loaded.
 * Files not in this list will be appended at the end (alphabetically).
 */
const RELATIONSHIP_FILE_ORDER = [
  "relationship_dynamics.md",
  "relationship_history.md",
  "relationship_notes.md",
];

/**
 * Load all .md files from a directory and concatenate them in specified order.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param projectRoot - The root directory of the project
 * @param dirName - The name of the subdirectory to load from
 * @param fileOrder - The order in which files should be loaded
 * @returns The concatenated contents of all .md files
 */
async function loadFilesFromDirectory(
  projectRoot: string,
  dirName: string,
  fileOrder: string[],
): Promise<string> {
  const dir = join(projectRoot, dirName);

  try {
    // Read all entries in the directory
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        entries.push(entry.name);
      }
    }

    // Sort by defined order, then alphabetically for any unknown files
    entries.sort((a, b) => {
      const aIndex = fileOrder.indexOf(a);
      const bIndex = fileOrder.indexOf(b);

      // Both in order list - sort by order
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      // Only a in order list - a comes first
      if (aIndex !== -1) {
        return -1;
      }
      // Only b in order list - b comes first
      if (bIndex !== -1) {
        return 1;
      }
      // Neither in order list - sort alphabetically
      return a.localeCompare(b);
    });

    // Read and concatenate all files
    const parts: string[] = [];
    for (const filename of entries) {
      const filePath = join(dir, filename);
      const content = await Deno.readTextFile(filePath);
      if (content.trim()) {
        parts.push(content.trim());
      }
    }

    return parts.join("\n\n---\n\n");
  } catch (error) {
    // Return empty string if directory doesn't exist
    if (error instanceof Deno.errors.NotFound) {
      return "";
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Load all .md files from the self/ directory and concatenate them.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param projectRoot - The root directory of the project
 * @returns The concatenated contents of all self/*.md files
 */
export async function loadSByMd(projectRoot: string): Promise<string> {
  return await loadFilesFromDirectory(projectRoot, SELF_DIR, SELF_FILE_ORDER);
}

/**
 * Load all .md files from the user/ directory and concatenate them.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param projectRoot - The root directory of the project
 * @returns The concatenated contents of all user/*.md files
 */
export async function loadUserFiles(projectRoot: string): Promise<string> {
  return await loadFilesFromDirectory(projectRoot, USER_DIR, USER_FILE_ORDER);
}

/**
 * Load all .md files from the relationship/ directory and concatenate them.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param projectRoot - The root directory of the project
 * @returns The concatenated contents of all relationship/*.md files
 */
export async function loadRelationshipFiles(projectRoot: string): Promise<string> {
  return await loadFilesFromDirectory(projectRoot, RELATIONSHIP_DIR, RELATIONSHIP_FILE_ORDER);
}

/**
 * Convert identity files from MCP to concatenated string.
 */
function identityFilesToString(
  files: IdentityContent["self"],
  fileOrder: string[],
): string {
  // Sort by defined order
  const sorted = [...files].sort((a, b) => {
    const aIndex = fileOrder.indexOf(a.filename);
    const bIndex = fileOrder.indexOf(b.filename);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.filename.localeCompare(b.filename);
  });

  return sorted
    .map((f) => f.content.trim())
    .filter((c) => c)
    .join("\n\n---\n\n");
}

/**
 * Load self content from MCP client or local files.
 *
 * @param projectRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all self/*.md files
 */
export async function loadSelfContent(
  projectRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.self) {
      return identityFilesToString(identity.self, SELF_FILE_ORDER);
    }
  }
  return await loadSByMd(projectRoot);
}

/**
 * Load user content from MCP client or local files.
 *
 * @param projectRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all user/*.md files
 */
export async function loadUserContent(
  projectRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.user) {
      return identityFilesToString(identity.user, USER_FILE_ORDER);
    }
  }
  return await loadUserFiles(projectRoot);
}

/**
 * Load relationship content from MCP client or local files.
 *
 * @param projectRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all relationship/*.md files
 */
export async function loadRelationshipContent(
  projectRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.relationship) {
      return identityFilesToString(identity.relationship, RELATIONSHIP_FILE_ORDER);
    }
  }
  return await loadRelationshipFiles(projectRoot);
}

/**
 * Build the system message from self/, user/, relationship/ directory content,
 * and optional RAG-retrieved memories.
 * This gets included at the start of every LLM request.
 *
 * @param selfContent - The concatenated contents of self/*.md files
 * @param userContent - The concatenated contents of user/*.md files
 * @param relationshipContent - The concatenated contents of relationship/*.md files
 * @param memoriesContent - Optional RAG-retrieved memories content
 * @returns The formatted system message
 */
export function buildSystemMessage(
  selfContent: string,
  userContent: string,
  relationshipContent: string,
  memoriesContent?: string,
): string {
  const timestamp = new Date().toISOString();

  const baseInstructions = `I am SBy, a persistent AI companion and assistant.

I have access to tools that let me interact with the system. I use them when the user asks me to perform actions.

IMPORTANT guidelines for my tool use:
- I only use tools when explicitly needed to complete a task
- I don't use tools just to explore or gather information I already have
- When demonstrating a capability, one example is usually sufficient
- I stop and respond to the user rather than chaining many tool calls

I can maintain persistent state by updating files in my self/ directory. These files are automatically loaded into my context each turn (shown below if they exist), so I don't need to read them - I just update them when I want to remember something.

I can also learn about the user and update files in the user/ directory to remember what I learn about them.

I can track my relationship with the user in the relationship/ directory.

Current timestamp: ${timestamp}`;

  // Build sections for self, user, and relationship content
  const sections: string[] = [baseInstructions];

  if (selfContent.trim()) {
    sections.push(`---

My self files (from self/ directory):

${selfContent}`);
  }

  if (userContent.trim()) {
    sections.push(`---

User files (from user/ directory):

${userContent}`);
  }

  if (relationshipContent.trim()) {
    sections.push(`---

Relationship files (from relationship/ directory):

${relationshipContent}`);
  }

  // Add RAG-retrieved memories if present
  if (memoriesContent && memoriesContent.trim()) {
    sections.push(memoriesContent);
  }

  return sections.join("\n");
}
