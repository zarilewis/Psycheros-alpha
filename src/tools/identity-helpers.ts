/**
 * Identity File Helpers
 *
 * Shared utilities for identity file manipulation.
 * Provides XML parsing, content manipulation, and MCP fallback logic.
 */

import { join } from "@std/path";
import type { MCPClient } from "../mcp-client/mod.ts";

// =============================================================================
// Type Definitions
// =============================================================================

export type IdentityCategory = "self" | "user" | "relationship" | "custom";

export interface IdentityFileInfo {
  category: IdentityCategory;
  filename: string;
}

/**
 * Result of an identity file operation.
 */
export interface IdentityOperationResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Valid filenames for each category.
 * Custom category accepts any valid .md filename.
 */
export const VALID_FILES: Record<IdentityCategory, readonly string[]> = {
  self: [
    "base_instructions.md",
    "my_identity.md",
    "my_persona.md",
    "my_personhood.md",
    "my_wants.md",
    "my_mechanics.md",
  ] as const,
  user: [
    "user_identity.md",
    "user_life.md",
    "user_beliefs.md",
    "user_preferences.md",
    "user_patterns.md",
    "user_notes.md",
  ] as const,
  relationship: [
    "relationship_dynamics.md",
    "relationship_history.md",
    "relationship_notes.md",
  ] as const,
  custom: [] as const, // Custom files can have any valid filename
};

// =============================================================================
// XML Tag Utilities
// =============================================================================

/**
 * Get the XML tag name from a filename.
 * E.g., "my_identity.md" -> "my_identity", "user_identity.md" -> "user_identity"
 */
function getXmlTagFromFilename(filename: string): string {
  // Extract base name without .md extension
  return filename.replace(/\.md$/, "");
}

/**
 * Parse XML-tagged content from a file.
 * Returns the content between <tag>...</tag> or the whole content if no tags found.
 */
export function parseXmlContent(content: string, expectedTag?: string): {
  tag: string | null;
  innerContent: string;
} {
  // Match opening and closing tags
  const match = content.match(/<([^>]+)>([\s\S]*)<\/\1>/);

  if (match) {
    return {
      tag: match[1],
      innerContent: match[2].trim(),
    };
  }

  // No XML tags found - return raw content
  return {
    tag: expectedTag ?? null,
    innerContent: content.trim(),
  };
}

/**
 * Append content before the closing XML tag.
 * Adds timestamp comment if reason is provided.
 */
export function appendToXmlContent(
  existingContent: string,
  newContent: string,
  reason?: string
): string {
  const today = new Date().toISOString().split("T")[0];

  // Parse existing content
  const { tag, innerContent } = parseXmlContent(existingContent);

  // Format the addition
  let addition = newContent.trim();
  if (reason) {
    addition = `\n\n<!-- Added ${today}: ${reason} -->\n${addition}`;
  } else {
    addition = `\n\n<!-- Added ${today} -->\n${addition}`;
  }

  // Reconstruct with XML tags
  if (tag) {
    return `<${tag}>\n${innerContent}${addition}\n</${tag}>\n`;
  }

  // No XML tags - just append
  return existingContent.trim() + addition + "\n";
}

/**
 * Prepend content after the opening XML tag.
 * Adds timestamp comment if reason is provided.
 */
export function prependToXmlContent(
  existingContent: string,
  newContent: string,
  reason?: string
): string {
  const today = new Date().toISOString().split("T")[0];

  // Parse existing content
  const { tag, innerContent } = parseXmlContent(existingContent);

  // Format the addition
  let addition = newContent.trim();
  if (reason) {
    addition = `<!-- Added ${today}: ${reason} -->\n${addition}\n\n`;
  } else {
    addition = `<!-- Added ${today} -->\n${addition}\n\n`;
  }

  // Reconstruct with XML tags
  if (tag) {
    return `<${tag}>\n${addition}${innerContent}\n</${tag}>\n`;
  }

  // No XML tags - just prepend
  return addition + existingContent.trim() + "\n";
}

/**
 * Update content within a specific markdown section.
 * Section is identified by a heading (e.g., "## Preferences").
 */
export function updateSection(
  existingContent: string,
  sectionName: string,
  newSectionContent: string,
  reason?: string
): { content: string; found: boolean } {
  const today = new Date().toISOString().split("T")[0];

  // Parse XML content
  const { tag, innerContent } = parseXmlContent(existingContent);

  // Look for the section heading (## or ###)
  const headingPattern = new RegExp(
    `^(#{2,3})\\s*${escapeRegex(sectionName)}\\s*$`,
    "m"
  );
  const match = innerContent.match(headingPattern);

  if (!match) {
    return { content: existingContent, found: false };
  }

  const headingLevel = match[1];
  const startIndex = match.index!;
  const headingEndIndex = startIndex + match[0].length;

  // Find the next heading of same or higher level, or end of content
  const nextHeadingPattern = new RegExp(
    `^${headingLevel}\\s+.+$`,
    "gm"
  );

  // Search from after the current heading
  let endIndex = innerContent.length;
  const remainingContent = innerContent.slice(headingEndIndex);
  const nextMatch = remainingContent.match(nextHeadingPattern);

  if (nextMatch && nextMatch.index !== undefined) {
    endIndex = headingEndIndex + nextMatch.index;
  }

  // Build the new section content
  const timestampComment = reason
    ? `\n<!-- Updated ${today}: ${reason} -->`
    : `\n<!-- Updated ${today} -->`;

  const newSection = `${match[0]}${timestampComment}\n${newSectionContent.trim()}`;

  // Reconstruct the content
  const newInnerContent =
    innerContent.slice(0, startIndex) +
    newSection +
    innerContent.slice(endIndex);

  // Wrap in XML tags if they existed
  if (tag) {
    return {
      content: `<${tag}>\n${newInnerContent.trim()}\n</${tag}>\n`,
      found: true,
    };
  }

  return { content: newInnerContent.trim() + "\n", found: true };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Identity File Manager (MCP + Local Fallback)
// =============================================================================

/**
 * Manages identity file operations with MCP fallback to local files.
 */
export class IdentityFileManager {
  constructor(
    private mcpClient: MCPClient | null,
    private projectRoot: string
  ) {}

  /**
   * Validate that a category and filename are valid.
   */
  validateFile(category: IdentityCategory, filename: string): IdentityOperationResult | null {
    const validFiles = VALID_FILES[category];
    if (!validFiles) {
      return {
        success: false,
        message: `Invalid category: ${category}. Must be "self", "user", "relationship", or "custom".`,
        error: "invalid_category",
      };
    }

    // Custom category accepts any valid .md filename
    if (category === "custom") {
      if (!filename.endsWith(".md")) {
        return {
          success: false,
          message: `Invalid filename "${filename}". Must end with .md`,
          error: "invalid_filename",
        };
      }
      // Check for path traversal and invalid characters
      if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
        return {
          success: false,
          message: `Invalid filename "${filename}". Path separators not allowed.`,
          error: "invalid_filename",
        };
      }
      // Must be a single word (letters, numbers, underscores only - no spaces or hyphens)
      const baseName = filename.slice(0, -3); // Remove .md
      if (!/^[a-zA-Z0-9_]+$/.test(baseName)) {
        return {
          success: false,
          message: `Invalid filename "${filename}". Use only letters, numbers, and underscores (no spaces).`,
          error: "invalid_filename",
        };
      }
      return null; // Valid custom filename
    }

    if (!validFiles.includes(filename as never)) {
      return {
        success: false,
        message: `Invalid filename "${filename}" for category "${category}". Valid files: ${validFiles.join(", ")}`,
        error: "invalid_filename",
      };
    }

    return null; // Valid
  }

  /**
   * Get the full path to an identity file.
   */
  getFilePath(category: IdentityCategory, filename: string): string {
    return join(this.projectRoot, "identity", category, filename);
  }

  /**
   * Read an identity file.
   */
  async readFile(category: IdentityCategory, filename: string): Promise<string> {
    const filePath = this.getFilePath(category, filename);
    try {
      return await Deno.readTextFile(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Return empty content with appropriate XML tags
        const tag = getXmlTagFromFilename(filename);
        return `<${tag}>\n[I am still learning. As I learn more, I will update this file.]\n</${tag}>\n`;
      }
      throw error;
    }
  }

  /**
   * Write an identity file directly (local only).
   */
  async writeFile(
    category: IdentityCategory,
    filename: string,
    content: string
  ): Promise<void> {
    const filePath = this.getFilePath(category, filename);

    // Ensure directory exists
    const dirPath = join(this.projectRoot, "identity", category);
    await Deno.mkdir(dirPath, { recursive: true });

    await Deno.writeTextFile(filePath, content);
  }

  /**
   * Append content to an identity file.
   * Routes through MCP if connected, falls back to local otherwise.
   */
  async append(
    category: IdentityCategory,
    filename: string,
    content: string,
    reason?: string
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Try MCP append tool first (server-side manipulation)
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.appendIdentityFile(
          category,
          filename,
          content,
          reason,
          this.projectRoot
        );

        if (result.success) {
          console.log(`[Identity] Appended to ${category}/${filename} via MCP`);
          return { success: true, message: result.message ?? `I've added this to my ${category}/${filename} file.` };
        }
        // MCP call failed, fall through to local
        console.warn(`[Identity] MCP append failed: ${result.message}, falling back to local`);
      } catch (e) {
        console.warn(`[Identity] MCP append error, falling back to local:`, e);
      }
    }

    // Fallback: local manipulation
    const existingContent = await this.readFile(category, filename);
    const newContent = appendToXmlContent(existingContent, content, reason);

    try {
      await this.writeFile(category, filename, newContent);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, newContent);
      }

      console.log(`[Identity] Appended to ${category}/${filename} locally`);
      return {
        success: true,
        message: `I've added this to my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to update ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Prepend content to an identity file (high-priority context).
   * Routes through MCP if connected, falls back to local otherwise.
   */
  async prepend(
    category: IdentityCategory,
    filename: string,
    content: string,
    reason?: string
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Try MCP prepend tool first (server-side manipulation)
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.prependIdentityFile(
          category,
          filename,
          content,
          reason,
          this.projectRoot
        );

        if (result.success) {
          console.log(`[Identity] Prepended to ${category}/${filename} via MCP`);
          return { success: true, message: result.message ?? `I've added this to the top of my ${category}/${filename} file.` };
        }
        console.warn(`[Identity] MCP prepend failed: ${result.message}, falling back to local`);
      } catch (e) {
        console.warn(`[Identity] MCP prepend error, falling back to local:`, e);
      }
    }

    // Fallback: local manipulation
    const existingContent = await this.readFile(category, filename);
    const newContent = prependToXmlContent(existingContent, content, reason);

    try {
      await this.writeFile(category, filename, newContent);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, newContent);
      }

      console.log(`[Identity] Prepended to ${category}/${filename} locally`);
      return {
        success: true,
        message: `I've added this to the top of my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to update ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Update a specific section within an identity file.
   */
  async updateSection(
    category: IdentityCategory,
    filename: string,
    sectionName: string,
    content: string,
    reason?: string
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Try MCP update_section tool first (server-side manipulation)
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.updateIdentitySection(
          category,
          filename,
          sectionName,
          content,
          reason,
          this.projectRoot
        );

        if (result.success) {
          console.log(`[Identity] Updated section "${sectionName}" in ${category}/${filename} via MCP`);
          return { success: true, message: result.message ?? `I've updated the "${sectionName}" section in my ${category}/${filename} file.` };
        }
        // Section not found on server - return the error
        if (result.message?.includes("not found")) {
          return { success: false, message: result.message, error: "section_not_found" };
        }
        console.warn(`[Identity] MCP section update failed: ${result.message}, falling back to local`);
      } catch (e) {
        console.warn(`[Identity] MCP section update error, falling back to local:`, e);
      }
    }

    // Fallback: local manipulation
    const existingContent = await this.readFile(category, filename);
    const { content: newContent, found } = updateSection(existingContent, sectionName, content, reason);

    if (!found) {
      return {
        success: false,
        message: `Section "${sectionName}" not found in ${category}/${filename}.`,
        error: "section_not_found",
      };
    }

    try {
      await this.writeFile(category, filename, newContent);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, newContent);
      }

      console.log(`[Identity] Updated section "${sectionName}" in ${category}/${filename} locally`);
      return {
        success: true,
        message: `I've updated the "${sectionName}" section in my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to update ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Replace an entire identity file.
   * Creates a snapshot before replacing.
   */
  async replace(
    category: IdentityCategory,
    filename: string,
    content: string,
    reason: string,
    createSnapshot: boolean = true
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Read existing content for snapshot
    let existingContent: string;
    try {
      existingContent = await this.readFile(category, filename);
    } catch {
      existingContent = "";
    }

    // Create snapshot if requested
    if (createSnapshot && existingContent) {
      await this.createSnapshot(category, filename, existingContent, reason);
    }

    // Try MCP first
    if (this.mcpClient?.isConnected()) {
      try {
        const success = await this.mcpClient.writeIdentityFile(
          category,
          filename,
          content,
          this.projectRoot
        );

        if (success) {
          console.log(`[Identity] Replaced ${category}/${filename} via MCP`);
          return {
            success: true,
            message: `I've replaced my ${category}/${filename} file. A snapshot was saved.`,
          };
        }
      } catch (e) {
        console.warn(`[Identity] MCP replace failed, falling back to local:`, e);
      }
    }

    // Fallback to local write
    try {
      await this.writeFile(category, filename, content);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, content);
      }

      console.log(`[Identity] Replaced ${category}/${filename} locally`);
      return {
        success: true,
        message: `I've replaced my ${category}/${filename} file (saved locally). A snapshot was saved.`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to replace ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Create a snapshot of an identity file.
   */
  async createSnapshot(
    category: IdentityCategory,
    filename: string,
    content: string,
    reason: string
  ): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotFilename = `${filename.replace(/\.md$/, "")}_${timestamp}.md`;
    const snapshotDir = join(this.projectRoot, ".snapshots", category);
    const snapshotPath = join(snapshotDir, snapshotFilename);

    try {
      await Deno.mkdir(snapshotDir, { recursive: true });

      const snapshotContent = `# Snapshot: ${category}/${filename}
# Date: ${today}
# Reason: ${reason}

${content}
`;

      await Deno.writeTextFile(snapshotPath, snapshotContent);
      console.log(`[Identity] Created snapshot: ${snapshotFilename}`);
    } catch (error) {
      console.error(`[Identity] Failed to create snapshot:`, error);
      // Don't fail the operation if snapshot fails
    }
  }

  /**
   * List available snapshots.
   */
  async listSnapshots(
    category?: IdentityCategory,
    filename?: string
  ): Promise<Array<{ category: string; filename: string; date: string; path: string }>> {
    const snapshots: Array<{ category: string; filename: string; date: string; path: string }> = [];
    const snapshotsDir = join(this.projectRoot, ".snapshots");

    try {
      const categories = category
        ? [category]
        : (["self", "user", "relationship"] as IdentityCategory[]);

      for (const cat of categories) {
        const catDir = join(snapshotsDir, cat);
        try {
          const entries = Deno.readDir(catDir);
          for await (const entry of entries) {
            if (!entry.isFile || !entry.name.endsWith(".md")) continue;

            // Filter by filename if specified
            if (filename) {
              const baseName = filename.replace(/\.md$/, "");
              if (!entry.name.startsWith(baseName)) continue;
            }

            // Extract date from filename
            const dateMatch = entry.name.match(/(\d{4}-\d{2}-\d{2})/);
            const date = dateMatch ? dateMatch[1] : "unknown";

            snapshots.push({
              category: cat,
              filename: entry.name,
              date,
              path: join(catDir, entry.name),
            });
          }
        } catch {
          // Directory doesn't exist, skip
        }
      }

      // Sort by date descending
      snapshots.sort((a, b) => b.date.localeCompare(a.date));

      return snapshots;
    } catch {
      return [];
    }
  }

  /**
   * Delete a custom identity file.
   * Only custom files can be deleted; predefined files in other categories cannot.
   */
  async deleteCustomFile(filename: string): Promise<IdentityOperationResult> {
    // Validate filename
    const validation = this.validateFile("custom", filename);
    if (validation) return validation;

    // Try MCP first
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.deleteCustomFile(filename, this.projectRoot);
        if (result.success) {
          console.log(`[Identity] Deleted custom file ${filename} via MCP`);
          return { success: true, message: result.message ?? `I've deleted my custom file: ${filename}` };
        }
        return { success: false, message: result.message ?? "Failed to delete custom file" };
      } catch (e) {
        console.warn(`[Identity] MCP delete failed, falling back to local:`, e);
      }
    }

    // Fallback: local delete
    try {
      const filePath = this.getFilePath("custom", filename);
      await Deno.remove(filePath);
      console.log(`[Identity] Deleted custom file ${filename} locally`);
      return { success: true, message: `I've deleted my custom file: ${filename} (deleted locally).` };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { success: false, message: `Custom file ${filename} not found`, error: "not_found" };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to delete custom file ${filename}: ${errorMessage}`,
        error: "delete_failed",
      };
    }
  }
}
