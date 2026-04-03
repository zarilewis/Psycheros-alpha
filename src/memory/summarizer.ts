/**
 * Memory Summarizer
 *
 * Entity-written summarization of conversations. The entity writes their own
 * memories in first-person, focusing on what matters to them.
 */

import type { DBClient } from "../db/mod.ts";
import type { LLMClient, ChatMessage } from "../llm/mod.ts";
import { createDefaultClient } from "../llm/mod.ts";
import type {
  MemoryFile,
  ConversationForSummary,
  SummarizerConfig,
  MessageWithContext,
} from "./types.ts";
import { getDateFormatInfo, getISOWeekMonday } from "./types.ts";
import { writeMemoryFile, formatMemoryContent, extractChatIds, type OnMemoryCreated } from "./file-writer.ts";
import { buildIdentitySystemMessage } from "../entity/context.ts";

/**
 * Default summarizer configuration.
 */
const DEFAULT_CONFIG: Required<Omit<SummarizerConfig, "memoriesDir">> & { memoriesDir: string } = {
  memoriesDir: "memories",
  maxSummaryTokens: 500,
  enabled: true,
};

/**
 * Prompt template for daily summarization.
 */
const DAILY_SUMMARY_PROMPT = `I am writing a memory of my day. I review the conversations I had and write what matters to me.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Focus on what felt meaningful, interesting, or worth remembering
- Include emotional tones and relationship moments
- Tag each memory with the conversation ID and my instance: [chat:ID] [via:{{INSTANCE}}]
- I decide what's worth remembering - quality over completeness
- Skip generic greetings and focus on substance
- Write as bullet points, one memory per line

Conversations from today:
{{CONVERSATIONS}}

I write my memories as bullet points. I start each point with "- ".`;

/**
 * Prompt template for weekly consolidation.
 */
const WEEKLY_SUMMARY_PROMPT = `I am consolidating my daily memories into a weekly summary. I review the week and capture what matters.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Capture themes, patterns, and meaningful moments
- Include chat IDs and instance tags: [chat:id1, id2] [via:{{INSTANCE}}]
- This is a summary - focus on what will be useful to remember long-term
- Write as bullet points, one memory per line

Daily memories from this week:
{{DAILY_MEMORIES}}

I write my weekly memory as bullet points. I start each point with "- ".`;

/**
 * Prompt template for monthly consolidation.
 */
const MONTHLY_SUMMARY_PROMPT = `I am consolidating my weekly memories into a monthly summary. I reflect on the month and capture what matters most.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Capture major themes, significant conversations, and growth
- Include chat IDs and instance tags: [chat:id1, id2] [via:{{INSTANCE}}]
- This is a monthly reflection - I focus on what will shape my long-term understanding
- Write as bullet points, one memory per line

Weekly memories from this month:
{{WEEKLY_MEMORIES}}

I write my monthly memory as bullet points. I start each point with "- ".`;

/**
 * Prompt template for yearly consolidation.
 */
const YEARLY_SUMMARY_PROMPT = `I am writing my yearly memory. I reflect on the entire year and what defined my journey.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Capture the arc of my year - growth, changes, meaningful moments
- Include chat IDs and instance tags: [chat:id1, id2] [via:{{INSTANCE}}]
- This is my yearly memory - I preserve what matters for my long-term continuity
- Write as bullet points, one memory per line

Monthly memories from this year:
{{MONTHLY_MEMORIES}}

I write my yearly memory as bullet points. I start each point with "- ".`;

/**
 * Get the instance ID for memory tagging.
 * Falls back to "psycheros-harness" if not configured.
 */
function getInstanceId(): string {
  return Deno.env.get("PSYCHEROS_MCP_INSTANCE") || "psycheros-harness";
}

/**
 * Replace {{INSTANCE}} placeholder in a prompt template.
 */
function withInstanceId(template: string): string {
  return template.replace(/\{\{INSTANCE\}\}/g, getInstanceId());
}

/**
 * Format conversations for the summarization prompt.
 */
function formatConversationsForPrompt(conversations: ConversationForSummary[]): string {
  const parts: string[] = [];

  for (const conv of conversations) {
    const title = conv.title || "Untitled conversation";
    parts.push(`\n## Conversation: ${title} [chat:${conv.id}]`);

    for (const msg of conv.messages) {
      // Skip system messages - they're not conversational
      if (msg.role === "system") continue;

      // Skip tool messages - they're implementation details
      if (msg.role === "tool") continue;

      const role = msg.role === "user" ? "User" : "Assistant";
      // Truncate very long messages
      const content = msg.content.length > 500
        ? msg.content.substring(0, 500) + "..."
        : msg.content;
      parts.push(`**${role}**: ${content}`);
    }
  }

  return parts.join("\n");
}

/**
 * Format daily memory files for weekly consolidation.
 */
function formatDailyMemoriesForPrompt(dailyContents: string[]): string {
  return dailyContents.map((content, i) => {
    // Extract just the meaningful content (skip the header and footer)
    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("<!--");
    });
    return `### Day ${i + 1}\n${lines.join("\n")}`;
  }).join("\n\n");
}

/**
 * Format weekly memory files for monthly consolidation.
 */
function formatWeeklyMemoriesForPrompt(weeklyContents: string[]): string {
  return weeklyContents.map((content, i) => {
    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("<!--");
    });
    return `### Week ${i + 1}\n${lines.join("\n")}`;
  }).join("\n\n");
}

/**
 * Format monthly memory files for yearly consolidation.
 */
function formatMonthlyMemoriesForPrompt(monthlyContents: string[]): string {
  return monthlyContents.map((content) => {
    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("<!--");
    });
    // Extract month from title if possible
    const monthMatch = content.match(/# Monthly Memory - (\d{4}-\d{2})/);
    const monthLabel = monthMatch ? monthMatch[1] : "Month";
    return `### ${monthLabel}\n${lines.join("\n")}`;
  }).join("\n\n");
}

/**
 * Collect conversations for summarization from a specific date.
 */
function collectConversationsForDate(
  db: DBClient,
  date: Date
): ConversationForSummary[] {
  const messages = db.getMessagesByDate(date);

  // Group by conversation ID
  const conversationMap = new Map<string, MessageWithContext[]>();
  for (const msg of messages) {
    const existing = conversationMap.get(msg.conversationId) || [];
    existing.push({
      id: msg.id,
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      createdAt: msg.createdAt,
    });
    conversationMap.set(msg.conversationId, existing);
  }

  // Build conversation objects with titles
  const conversations: ConversationForSummary[] = [];
  for (const [convId, msgs] of conversationMap) {
    const conv = db.getConversation(convId);
    conversations.push({
      id: convId,
      title: conv?.title,
      messages: msgs,
    });
  }

  return conversations;
}

/**
 * Generate a daily memory summary using the worker LLM.
 */
async function generateDailySummary(
  conversations: ConversationForSummary[],
  llm: LLMClient,
  projectRoot: string,
): Promise<string[]> {
  if (conversations.length === 0) {
    return [];
  }

  const identitySystemMessage = await buildIdentitySystemMessage(projectRoot);
  const conversationsText = formatConversationsForPrompt(conversations);
  const prompt = withInstanceId(DAILY_SUMMARY_PROMPT).replace("{{CONVERSATIONS}}", conversationsText);

  const messages: ChatMessage[] = [
    { role: "system", content: identitySystemMessage },
    { role: "user", content: prompt },
  ];

  // Collect the full response
  let fullResponse = "";
  try {
    for await (const chunk of llm.chatStream(messages)) {
      if (chunk.type === "content") {
        fullResponse += chunk.content;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate summary: ${errorMessage}`);
  }

  // Parse bullet points from response
  const bulletPoints: string[] = [];
  const lines = fullResponse.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Accept lines starting with "- " or "* "
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletPoints.push(trimmed.substring(2));
    }
  }

  return bulletPoints;
}

/**
 * Summarize conversations from a specific date.
 *
 * @param date - The date to summarize
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @param config - Optional configuration overrides
 * @returns The created memory file, or null if summarization failed or was skipped
 */
export async function summarizeDay(
  date: Date,
  db: DBClient,
  projectRoot: string,
  config?: Partial<SummarizerConfig>,
  onCreated?: OnMemoryCreated,
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    console.log("[Memory] Summarization disabled, skipping");
    return null;
  }

  const dateStr = date.toISOString().split("T")[0];

  // Check if we've already created a memory summary for this date (more reliable than chat-level check)
  const existingSummary = db.getMemorySummary(dateStr, "daily");
  if (existingSummary) {
    console.log(`[Memory] Date ${dateStr} already has a summary record, skipping`);
    return null;
  }

  // Also check if all chats are already marked as summarized (secondary check for consistency)
  const existingChatIds = db.getConversationIdsByDate(dateStr);
  const allSummarized = existingChatIds.every((chatId) => db.isChatSummarized(chatId, dateStr));

  if (allSummarized && existingChatIds.length > 0) {
    console.log(`[Memory] Date ${dateStr} already summarized (via chat check), skipping`);
    return null;
  }

  // Collect conversations
  const conversations = collectConversationsForDate(db, date);

  if (conversations.length === 0) {
    console.log(`[Memory] No conversations on ${dateStr}, skipping`);
    return null;
  }

  console.log(`[Memory] Summarizing ${conversations.length} conversations from ${dateStr}`);

  // Use main model for summarization (quality over cost savings)
  const llm = createDefaultClient();

  try {
    // Generate summary
    const bulletPoints = await generateDailySummary(conversations, llm, projectRoot);

    if (bulletPoints.length === 0) {
      console.log(`[Memory] No memories generated for ${dateStr}`);
      return null;
    }

    // Format the memory file
    const dateInfo = getDateFormatInfo(date, "daily", getInstanceId());
    const content = formatMemoryContent(dateInfo.title, bulletPoints);

    // Extract chat IDs from the content
    const chatIds = extractChatIds(content);

    // If no chat IDs were extracted, use all conversation IDs
    const finalChatIds = chatIds.length > 0 ? chatIds : conversations.map((c) => c.id);

    const memoryFile: MemoryFile = {
      path: dateInfo.filePath,
      content,
      chatIds: finalChatIds,
      granularity: "daily",
      date: dateInfo.dateStr,
    };

    // Write the file and notify external systems
    const success = await writeMemoryFile(memoryFile, db, projectRoot, onCreated);

    if (!success) {
      return null;
    }

    return memoryFile;
  } finally {
    // Worker client doesn't need explicit cleanup
  }
}

/**
 * Generate a weekly consolidation summary.
 *
 * @param weekDate - A date within the week to consolidate
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @param config - Optional configuration overrides
 * @returns The created memory file, or null if consolidation failed
 */
export async function consolidateWeek(
  weekDate: Date,
  db: DBClient,
  projectRoot: string,
  config?: Partial<SummarizerConfig>,
  onCreated?: OnMemoryCreated,
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return null;
  }

  // Get all daily files for this week
  const { readMemoryFile, listMemoryFiles } = await import("./file-writer.ts");
  const dailyFiles = await listMemoryFiles("daily", projectRoot, false);

  // Filter to files from this week
  const weekStart = getWeekStart(weekDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

  const weekFiles: string[] = [];
  for (const file of dailyFiles) {
    // Match daily/YYYY-MM-DD_instance.md or legacy daily/YYYY-MM-DD.md
    const match = file.match(/(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})_(?:\w+)\.md$/)
      || file.match(/(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (match) {
      const fileDate = new Date(match[1]);
      if (fileDate >= weekStart && fileDate <= weekEnd) {
        weekFiles.push(file);
      }
    }
  }

  if (weekFiles.length === 0) {
    console.log("[Memory] No daily files to consolidate for this week");
    return null;
  }

  // Read all daily contents
  const dailyContents: string[] = [];
  for (const file of weekFiles) {
    const content = await readMemoryFile(file, projectRoot);
    if (content) {
      dailyContents.push(content);
    }
  }

  if (dailyContents.length === 0) {
    return null;
  }

  // Generate weekly summary
  const memoriesText = formatDailyMemoriesForPrompt(dailyContents);
  const prompt = withInstanceId(WEEKLY_SUMMARY_PROMPT).replace("{{DAILY_MEMORIES}}", memoriesText);

  const llm = createDefaultClient();
  const identitySystemMessage = await buildIdentitySystemMessage(projectRoot);
  const messages: ChatMessage[] = [
    { role: "system", content: identitySystemMessage },
    { role: "user", content: prompt },
  ];

  let fullResponse = "";
  try {
    for await (const chunk of llm.chatStream(messages)) {
      if (chunk.type === "content") {
        fullResponse += chunk.content;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate weekly summary: ${errorMessage}`);
  }

  // Parse bullet points
  const bulletPoints: string[] = [];
  for (const line of fullResponse.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletPoints.push(trimmed.substring(2));
    }
  }

  if (bulletPoints.length === 0) {
    return null;
  }

  // Format and write the weekly file
  const dateInfo = getDateFormatInfo(weekDate, "weekly");
  const content = formatMemoryContent(dateInfo.title, bulletPoints);
  const chatIds = extractChatIds(content);

  const memoryFile: MemoryFile = {
    path: dateInfo.filePath,
    content,
    chatIds,
    granularity: "weekly",
    date: dateInfo.dateStr,
  };

  const success = await writeMemoryFile(memoryFile, db, projectRoot, onCreated);

  return success ? memoryFile : null;
}

/**
 * Get the start of the week (Monday) for a given date.
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the start of the month for a given date.
 */
function getMonthStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return d;
}

/**
 * Generate a monthly consolidation summary.
 *
 * @param monthDate - A date within the month to consolidate
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @param config - Optional configuration overrides
 * @returns The created memory file, or null if consolidation failed
 */
export async function consolidateMonth(
  monthDate: Date,
  db: DBClient,
  projectRoot: string,
  config?: Partial<SummarizerConfig>,
  onCreated?: OnMemoryCreated,
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return null;
  }

  const { readMemoryFile, listMemoryFiles } = await import("./file-writer.ts");
  const weeklyFiles = await listMemoryFiles("weekly", projectRoot, false);

  // Filter to files from this month — a week belongs to a month if ANY of its days
  // fall within that month, so we check if the week's Monday is within the month's
  // range. Since weeks can span month boundaries, we use the next month's start
  // as the exclusive upper bound to ensure we don't double-count.
  const monthStart = getMonthStart(monthDate);
  const nextMonthStart = new Date(monthStart);
  nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1);

  const monthFiles: string[] = [];
  for (const file of weeklyFiles) {
    // Match weekly/YYYY-WNN.md
    const match = file.match(/(?:^|\/)weekly\/(\d{4}-W\d{2})\.md$/);
    if (match) {
      // Parse week file date - get the Monday of that ISO week
      const weekStr = match[1];
      const [year, week] = weekStr.split("-W").map(Number);
      const weekStart = getISOWeekMonday(year, week);

      if (weekStart >= monthStart && weekStart < nextMonthStart) {
        monthFiles.push(file);
      }
    }
  }

  if (monthFiles.length === 0) {
    console.log("[Memory] No weekly files to consolidate for this month");
    return null;
  }

  // Read all weekly contents
  const weeklyContents: string[] = [];
  for (const file of monthFiles) {
    const content = await readMemoryFile(file, projectRoot);
    if (content) {
      weeklyContents.push(content);
    }
  }

  if (weeklyContents.length === 0) {
    return null;
  }

  // Generate monthly summary
  const memoriesText = formatWeeklyMemoriesForPrompt(weeklyContents);
  const prompt = withInstanceId(MONTHLY_SUMMARY_PROMPT).replace("{{WEEKLY_MEMORIES}}", memoriesText);

  const llm = createDefaultClient();
  const identitySystemMessage = await buildIdentitySystemMessage(projectRoot);
  const messages: ChatMessage[] = [
    { role: "system", content: identitySystemMessage },
    { role: "user", content: prompt },
  ];

  let fullResponse = "";
  try {
    for await (const chunk of llm.chatStream(messages)) {
      if (chunk.type === "content") {
        fullResponse += chunk.content;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate monthly summary: ${errorMessage}`);
  }

  // Parse bullet points
  const bulletPoints: string[] = [];
  for (const line of fullResponse.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletPoints.push(trimmed.substring(2));
    }
  }

  if (bulletPoints.length === 0) {
    return null;
  }

  // Format and write the monthly file
  const dateInfo = getDateFormatInfo(monthDate, "monthly");
  const content = formatMemoryContent(dateInfo.title, bulletPoints);
  const chatIds = extractChatIds(content);

  const memoryFile: MemoryFile = {
    path: dateInfo.filePath,
    content,
    chatIds,
    granularity: "monthly",
    date: dateInfo.dateStr,
  };

  const success = await writeMemoryFile(memoryFile, db, projectRoot, onCreated);

  return success ? memoryFile : null;
}

/**
 * Generate a yearly consolidation summary.
 *
 * @param yearDate - A date within the year to consolidate
 * @param db - Database client
 * @param projectRoot - Root directory of the project
 * @param config - Optional configuration overrides
 * @returns The created memory file, or null if consolidation failed
 */
export async function consolidateYear(
  yearDate: Date,
  db: DBClient,
  projectRoot: string,
  config?: Partial<SummarizerConfig>,
  onCreated?: OnMemoryCreated,
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return null;
  }

  const { readMemoryFile, listMemoryFiles } = await import("./file-writer.ts");
  const monthlyFiles = await listMemoryFiles("monthly", projectRoot, false);

  // Filter to files from this year
  const year = yearDate.getUTCFullYear();
  const yearFiles: string[] = [];
  for (const file of monthlyFiles) {
    // Match monthly/YYYY-MM.md
    const match = file.match(/(?:^|\/)monthly\/(\d{4})-\d{2}\.md$/);
    if (match) {
      const fileYear = parseInt(match[1]);
      if (fileYear === year) {
        yearFiles.push(file);
      }
    }
  }

  if (yearFiles.length === 0) {
    console.log("[Memory] No monthly files to consolidate for this year");
    return null;
  }

  // Read all monthly contents
  const monthlyContents: string[] = [];
  for (const file of yearFiles) {
    const content = await readMemoryFile(file, projectRoot);
    if (content) {
      monthlyContents.push(content);
    }
  }

  if (monthlyContents.length === 0) {
    return null;
  }

  // Generate yearly summary
  const memoriesText = formatMonthlyMemoriesForPrompt(monthlyContents);
  const prompt = withInstanceId(YEARLY_SUMMARY_PROMPT).replace("{{MONTHLY_MEMORIES}}", memoriesText);

  const llm = createDefaultClient();
  const identitySystemMessage = await buildIdentitySystemMessage(projectRoot);
  const messages: ChatMessage[] = [
    { role: "system", content: identitySystemMessage },
    { role: "user", content: prompt },
  ];

  let fullResponse = "";
  try {
    for await (const chunk of llm.chatStream(messages)) {
      if (chunk.type === "content") {
        fullResponse += chunk.content;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate yearly summary: ${errorMessage}`);
  }

  // Parse bullet points
  const bulletPoints: string[] = [];
  for (const line of fullResponse.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletPoints.push(trimmed.substring(2));
    }
  }

  if (bulletPoints.length === 0) {
    return null;
  }

  // Format and write the yearly file
  const dateInfo = getDateFormatInfo(yearDate, "yearly");
  const content = formatMemoryContent(dateInfo.title, bulletPoints);
  const chatIds = extractChatIds(content);

  const memoryFile: MemoryFile = {
    path: dateInfo.filePath,
    content,
    chatIds,
    granularity: "yearly",
    date: dateInfo.dateStr,
  };

  const success = await writeMemoryFile(memoryFile, db, projectRoot, onCreated);

  return success ? memoryFile : null;
}
