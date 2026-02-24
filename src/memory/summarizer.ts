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
import { getDateFormatInfo } from "./types.ts";
import { writeMemoryFile, formatMemoryContent, extractChatIds } from "./file-writer.ts";

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
- Refer to the user in third-person ("they", "the user")
- Focus on what felt meaningful, interesting, or worth remembering
- Include emotional tones and relationship moments
- Tag each memory with the conversation ID: [chat:ID]
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
- Refer to the user in third-person
- Capture themes, patterns, and meaningful moments
- Include chat IDs for drill-down: [chat:id1, id2]
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
- Refer to the user in third-person
- Capture major themes, significant conversations, and growth
- Include chat IDs for context: [chat:id1, id2]
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
- Refer to the user in third-person
- Capture the arc of my year - growth, changes, meaningful moments
- Include chat IDs for context: [chat:id1, id2]
- This is my yearly memory - I preserve what matters for my long-term continuity
- Write as bullet points, one memory per line

Monthly memories from this year:
{{MONTHLY_MEMORIES}}

I write my yearly memory as bullet points. I start each point with "- ".`;

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
  llm: LLMClient
): Promise<string[]> {
  if (conversations.length === 0) {
    return [];
  }

  const conversationsText = formatConversationsForPrompt(conversations);
  const prompt = DAILY_SUMMARY_PROMPT.replace("{{CONVERSATIONS}}", conversationsText);

  const messages: ChatMessage[] = [
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
  config?: Partial<SummarizerConfig>
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    console.log("[Memory] Summarization disabled, skipping");
    return null;
  }

  const dateStr = date.toISOString().split("T")[0];

  // Check if we've already summarized this date
  const existingChatIds = db.getConversationIdsByDate(dateStr);
  const allSummarized = existingChatIds.every((chatId) => db.isChatSummarized(chatId, dateStr));

  if (allSummarized && existingChatIds.length > 0) {
    console.log(`[Memory] Date ${dateStr} already summarized, skipping`);
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
    const bulletPoints = await generateDailySummary(conversations, llm);

    if (bulletPoints.length === 0) {
      console.log(`[Memory] No memories generated for ${dateStr}`);
      return null;
    }

    // Format the memory file
    const dateInfo = getDateFormatInfo(date, "daily");
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

    // Write the file
    const success = await writeMemoryFile(memoryFile, db, projectRoot);

    if (!success) {
      return null;
    }

    return memoryFile;
  } finally {
    // Worker client doesn't need explicit cleanup
  }
}

/**
 * Summarize the previous day (convenience function).
 */
export async function summarizePreviousDay(
  db: DBClient,
  projectRoot: string,
  config?: Partial<SummarizerConfig>
): Promise<MemoryFile | null> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  return await summarizeDay(yesterday, db, projectRoot, config);
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
  config?: Partial<SummarizerConfig>
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return null;
  }

  // Get all daily files for this week
  const { readMemoryFile, listMemoryFiles, archiveDailyMemory } = await import("./file-writer.ts");
  const dailyFiles = await listMemoryFiles("daily", projectRoot);

  // Filter to files from this week
  const weekStart = getWeekStart(weekDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const weekFiles: string[] = [];
  for (const file of dailyFiles) {
    const match = file.match(/daily\/(\d{4}-\d{2}-\d{2})\.md$/);
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
  const prompt = WEEKLY_SUMMARY_PROMPT.replace("{{DAILY_MEMORIES}}", memoriesText);

  const llm = createDefaultClient();
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

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

  const success = await writeMemoryFile(memoryFile, db, projectRoot);

  if (success) {
    // Archive the daily files
    for (const file of weekFiles) {
      await archiveDailyMemory(file, projectRoot);
    }
  }

  return success ? memoryFile : null;
}

/**
 * Get the start of the week (Monday) for a given date.
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the start of the month for a given date.
 */
function getMonthStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setHours(0, 0, 0, 0);
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
  config?: Partial<SummarizerConfig>
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return null;
  }

  const { readMemoryFile, listMemoryFiles, archiveDailyMemory } = await import("./file-writer.ts");
  const weeklyFiles = await listMemoryFiles("weekly", projectRoot);

  // Filter to files from this month
  const monthStart = getMonthStart(monthDate);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);
  monthEnd.setDate(monthEnd.getDate() - 1);

  const monthFiles: string[] = [];
  for (const file of weeklyFiles) {
    const match = file.match(/weekly\/(\d{4}-W\d{2})\.md$/);
    if (match) {
      // Parse week file date - get the Monday of that ISO week
      const weekStr = match[1];
      const [year, week] = weekStr.split("-W").map(Number);
      const simple = new Date(year, 0, 1 + (week - 1) * 7);
      const dayOfWeek = simple.getDay();
      const weekStart = new Date(simple);
      weekStart.setDate(simple.getDate() - dayOfWeek + 1);
      weekStart.setHours(0, 0, 0, 0);

      if (weekStart >= monthStart && weekStart <= monthEnd) {
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
  const prompt = MONTHLY_SUMMARY_PROMPT.replace("{{WEEKLY_MEMORIES}}", memoriesText);

  const llm = createDefaultClient();
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

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

  const success = await writeMemoryFile(memoryFile, db, projectRoot);

  if (success) {
    // Archive the weekly files
    for (const file of monthFiles) {
      await archiveDailyMemory(file, projectRoot);
    }
  }

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
  config?: Partial<SummarizerConfig>
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return null;
  }

  const { readMemoryFile, listMemoryFiles, archiveDailyMemory } = await import("./file-writer.ts");
  const monthlyFiles = await listMemoryFiles("monthly", projectRoot);

  // Filter to files from this year
  const year = yearDate.getFullYear();
  const yearFiles: string[] = [];
  for (const file of monthlyFiles) {
    const match = file.match(/monthly\/(\d{4})-\d{2}\.md$/);
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
  const prompt = YEARLY_SUMMARY_PROMPT.replace("{{MONTHLY_MEMORIES}}", memoriesText);

  const llm = createDefaultClient();
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

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

  const success = await writeMemoryFile(memoryFile, db, projectRoot);

  if (success) {
    // Archive the monthly files
    for (const file of yearFiles) {
      await archiveDailyMemory(file, projectRoot);
    }
  }

  return success ? memoryFile : null;
}
