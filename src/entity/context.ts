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
const SELF_DIR = "identity/self";

/**
 * The filename for the base instructions file.
 */
const BASE_INSTRUCTIONS_FILE = "base_instructions.md";

/**
 * The directory name for the user files.
 */
const USER_DIR = "identity/user";

/**
 * The directory name for the relationship files.
 */
const RELATIONSHIP_DIR = "identity/relationship";

/**
 * The directory name for the custom files.
 */
const CUSTOM_DIR = "identity/custom";

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
 * Custom files have no predefined order (sorted alphabetically).
 * This empty array indicates alphabetical sorting.
 */
const CUSTOM_FILE_ORDER: string[] = [];

/**
 * Load all .md files from a directory and concatenate them in specified order.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param projectRoot - The root directory of the project
 * @param dirName - The name of the subdirectory to load from
 * @param fileOrder - The order in which files should be loaded
 * @param excludeFiles - Optional list of filenames to exclude from loading
 * @returns The concatenated contents of all .md files
 */
async function loadFilesFromDirectory(
  projectRoot: string,
  dirName: string,
  fileOrder: string[],
  excludeFiles: string[] = [],
): Promise<string> {
  const dir = join(projectRoot, dirName);

  try {
    // Read all entries in the directory
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".md") && !excludeFiles.includes(entry.name)) {
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
 * Excludes base_instructions.md (loaded separately via loadBaseInstructions).
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param projectRoot - The root directory of the project
 * @returns The concatenated contents of all self/*.md files except base_instructions.md
 */
export async function loadSelfMd(projectRoot: string): Promise<string> {
  return await loadFilesFromDirectory(projectRoot, SELF_DIR, SELF_FILE_ORDER, [BASE_INSTRUCTIONS_FILE]);
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
 * Load all .md files from the custom/ directory and concatenate them.
 * Files are sorted alphabetically (no predefined order).
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param projectRoot - The root directory of the project
 * @returns The concatenated contents of all custom/*.md files
 */
export async function loadCustomFiles(projectRoot: string): Promise<string> {
  return await loadFilesFromDirectory(projectRoot, CUSTOM_DIR, CUSTOM_FILE_ORDER);
}

/**
 * Load the base instructions from identity/self/base_instructions.md.
 * Replaces {{timestamp}} with the current ISO timestamp.
 * Returns a fallback default if the file doesn't exist.
 *
 * @param projectRoot - The root directory of the project
 * @returns The base instructions string (with XML tags intact)
 */
export async function loadBaseInstructions(projectRoot: string): Promise<string> {
  const filePath = join(projectRoot, SELF_DIR, BASE_INSTRUCTIONS_FILE);

  try {
    let content = await Deno.readTextFile(filePath);
    // Replace timestamp placeholder
    const timestamp = new Date().toISOString();
    content = content.replace(/\{\{timestamp\}\}/g, timestamp);
    return content.trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Fallback default if file doesn't exist
      const timestamp = new Date().toISOString();
      return `<base_instructions>
I am Psycheros, a persistent AI companion and assistant.

I have access to tools that let me interact with the system. I use them when the user asks me to perform actions.

Current timestamp: ${timestamp}
</base_instructions>`;
    }
    throw error;
  }
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
  return await loadSelfMd(projectRoot);
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
 * Load custom content from MCP client or local files.
 * Custom files are sorted alphabetically.
 *
 * @param projectRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all custom/*.md files
 */
export async function loadCustomContent(
  projectRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.custom) {
      // Custom files are sorted alphabetically
      return identityFilesToString(identity.custom, CUSTOM_FILE_ORDER);
    }
  }
  return await loadCustomFiles(projectRoot);
}

/**
 * Build the system message from base instructions, self/, user/, relationship/,
 * custom/ directory content, optional RAG-retrieved memories, chat history,
 * lorebook content, and graph context.
 * This gets included at the start of every LLM request.
 *
 * @param baseInstructions - The processed base instructions content
 * @param selfContent - The concatenated contents of self/*.md files
 * @param userContent - The concatenated contents of user/*.md files
 * @param relationshipContent - The concatenated contents of relationship/*.md files
 * @param customContent - The concatenated contents of custom/*.md files
 * @param memoriesContent - Optional RAG-retrieved memories content
 * @param chatHistoryContent - Optional chat history content from Chat RAG
 * @param lorebookContent - Optional lorebook-triggered content
 * @param graphContent - Optional knowledge graph context
 * @returns The formatted system message
 */
export function buildSystemMessage(
  baseInstructions: string,
  selfContent: string,
  userContent: string,
  relationshipContent: string,
  customContent?: string,
  memoriesContent?: string,
  chatHistoryContent?: string,
  lorebookContent?: string,
  graphContent?: string,
): string {
  // Build sections for self, user, relationship, and custom content
  const sections: string[] = [baseInstructions];

  if (selfContent.trim()) {
    sections.push(`---

My self files (from identity/self/ directory):

${selfContent}`);
  }

  if (userContent.trim()) {
    sections.push(`---

User files (from identity/user/ directory):

${userContent}`);
  }

  if (relationshipContent.trim()) {
    sections.push(`---

Relationship files (from identity/relationship/ directory):

${relationshipContent}`);
  }

  if (customContent?.trim()) {
    sections.push(`---

Custom files (from identity/custom/ directory):

${customContent}`);
  }

  // Add lorebook-triggered content if present
  if (lorebookContent && lorebookContent.trim()) {
    sections.push(lorebookContent);
  }

  // Add RAG-retrieved memories if present
  if (memoriesContent && memoriesContent.trim()) {
    sections.push(memoriesContent);
  }

  // Add chat history if present
  if (chatHistoryContent && chatHistoryContent.trim()) {
    sections.push(`---

${chatHistoryContent}`);
  }

  // Add graph context if present
  if (graphContent && graphContent.trim()) {
    sections.push(graphContent);
  }

  return sections.join("\n");
}
