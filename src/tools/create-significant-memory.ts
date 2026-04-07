/**
 * Create Significant Memory Tool
 *
 * Allows the entity to create a significant memory for emotionally important
 * events that should be permanently remembered with clarity.
 */

import { join } from "@std/path";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

/**
 * Convert a title to a URL-safe filename slug.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .replace(/\s+/g, "-") // Spaces to dashes
    .replace(/-+/g, "-") // Multiple dashes to single
    .replace(/^-|-$/g, "") // Trim dashes
    .substring(0, 50); // Limit length
}

/**
 * Generate a filename for a significant memory.
 * Pattern: {YYYY-MM-DD}_{slug}.md
 * If a conflict exists, appends -N suffix.
 */
async function generateSignificantFilename(
  title: string,
  significantDir: string,
): Promise<string> {
  const tz = Deno.env.get("PSYCHEROS_DISPLAY_TZ") || Deno.env.get("TZ");
  const dateStr = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  let slug = slugify(title);
  if (!slug) {
    slug = Math.random().toString(36).substring(2, 8);
  }

  const base = `${dateStr}_${slug}`;

  try {
    const existing = [...Deno.readDirSync(significantDir)]
      .map((e) => e.name);

    const filename = `${base}.md`;
    if (!existing.includes(filename)) return filename;

    let n = 2;
    while (existing.includes(`${base}-${n}.md`)) n++;
    return `${base}-${n}.md`;
  } catch {
    return `${base}.md`;
  }
}

/**
 * Get the current date string for MCP sync.
 */
function getCurrentDate(): string {
  const tz = Deno.env.get("PSYCHEROS_DISPLAY_TZ") || Deno.env.get("TZ");
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Format a significant memory file.
 */
function formatSignificantMemory(
  title: string,
  content: string,
): string {
  return `# ${title}

${content}
`;
}

/**
 * The create_significant_memory tool allows the entity to save important memories.
 *
 * Use this for:
 * - Major life events (graduations, weddings, births)
 * - Significant traumas or challenges
 * - Spiritual experiences or realizations
 * - Major milestones or achievements
 * - Deeply meaningful conversations or connections
 * - Anything emotionally significant that should be permanently remembered
 *
 * Unlike daily/weekly/monthly memories, these are never consolidated or archived.
 */
export const createSignificantMemoryTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "create_significant_memory",
      description:
        "Create a significant memory for an emotionally important event that I want to permanently remember. I use this for major life events, traumas, spiritual experiences, meaningful connections, or anything that feels deeply significant. These memories are never consolidated or lost.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A short, identifying, descriptive title for the memory (e.g., 'First Conversation with User', 'Realization of Feelings about Home')",
          },
          content: {
            type: "string",
            description:
              "The full content of the memory. Write this with care and detail - describe what happened, how it felt, why it matters. This will be a permanent record.",
          },
        },
        required: ["title", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const title = args.title;
    const content = args.content;

    // Validate arguments
    if (typeof title !== "string" || title.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'title' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    if (typeof content !== "string" || content.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'content' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    // Build file path — {date}_{slug}.md
    const dirPath = join(ctx.config.projectRoot, "memories", "significant");
    const fileName = await generateSignificantFilename(title.trim(), dirPath);
    const filePath = join(dirPath, fileName);

    try {
      // Ensure directory exists
      await Deno.mkdir(dirPath, { recursive: true });

      // Format and write the memory
      const formattedContent = formatSignificantMemory(
        title.trim(),
        content.trim(),
      );
      await Deno.writeTextFile(filePath, formattedContent);

      console.log(`[Memory] Created significant memory: ${fileName}`);

      // Reindex the file in RAG so it's immediately searchable
      if (ctx.config.memoryIndexer) {
        try {
          await ctx.config.memoryIndexer.reindexFile(`significant/${fileName}`);
        } catch (error) {
          console.error("[Memory] RAG reindex failed (non-fatal):", error instanceof Error ? error.message : String(error));
        }
      }

      // Sync to entity-core via MCP
      if (ctx.config.mcpClient?.isConnected()) {
        try {
          await ctx.config.mcpClient.createMemory("significant", getCurrentDate(), formattedContent);
        } catch (error) {
          console.error("[Memory] MCP sync failed (non-fatal):", error instanceof Error ? error.message : String(error));
        }
      }

      return {
        toolCallId: ctx.toolCallId,
        content: `Created significant memory "${title.trim()}" saved to memories/significant/${fileName}`,
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Memory] Failed to create significant memory:`, errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error creating significant memory: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
