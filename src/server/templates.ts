/**
 * HTML Templates
 *
 * Server-side template functions for rendering HTML components.
 * Used by routes to serve HTMX-compatible HTML fragments.
 *
 * @module
 */

import type { Conversation, Message, ToolCall, ToolResult, TurnMetrics } from "../types.ts";
import type { Lorebook, LorebookEntry } from "../lorebook/mod.ts";

// =============================================================================
// Utilities
// =============================================================================

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Safely parse JSON with a fallback value.
 * Returns the fallback if parsing fails.
 */
function tryJsonParse<T>(text: string, fallback: T): T | unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Type guard for objects with a string command property.
 */
function hasStringCommand(obj: unknown): obj is { command: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "command" in obj &&
    typeof (obj as Record<string, unknown>).command === "string"
  );
}

/**
 * Format a date for display.
 */
function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 86400000) {
    // Less than a day
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (diff < 604800000) {
    // Less than a week
    return d.toLocaleDateString([], { weekday: "short" });
  } else {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

// =============================================================================
// Accent Color Override
// =============================================================================

/**
 * Parse a hex color to RGB components.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Convert RGB to hex.
 */
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => {
    const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

/**
 * Lighten a color by a percentage.
 */
function lighten(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r + (255 - rgb.r) * percent,
    rgb.g + (255 - rgb.g) * percent,
    rgb.b + (255 - rgb.b) * percent
  );
}

/**
 * Darken a color by a percentage.
 */
function darken(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r * (1 - percent),
    rgb.g * (1 - percent),
    rgb.b * (1 - percent)
  );
}

/**
 * Generate CSS override for accent color from env var.
 * Returns empty string if no override is set.
 */
function getAccentColorOverride(): string {
  const accentColor = Deno.env.get("PSYCHEROS_ACCENT_COLOR");
  if (!accentColor) return "";

  const rgb = hexToRgb(accentColor);
  if (!rgb) return "";

  const hover = lighten(accentColor, 0.2);
  const muted = darken(accentColor, 0.4);
  const subtle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`;
  const glow = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.25)`;

  return `<style>
  :root {
    --c-accent: ${accentColor};
    --c-accent-hover: ${hover};
    --c-accent-muted: ${muted};
    --c-accent-subtle: ${subtle};
    --c-accent-glow: ${glow};
  }
</style>`;
}

// =============================================================================
// Page Templates
// =============================================================================

/**
 * Render the full app shell HTML.
 * This is served on initial page load.
 */
export function renderAppShell(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Psycheros</title>
  <link rel="stylesheet" href="/css/main.css?v=10">
  ${getAccentColorOverride()}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.svg">
  <script src="/lib/htmx.min.js"></script>
  <script src="/lib/htmx-sse.js"></script>
</head>
<body>
  <div class="app">
    ${renderHeader()}
    <div class="main">
      <div class="sidebar-overlay" onclick="Psycheros.toggleSidebar()"></div>
      ${renderSidebar([])}
      <div class="chat" id="chat">
        ${renderEmptyState()}
        ${renderInputArea()}
      </div>
    </div>
  </div>
  <script type="module" src="/js/psycheros.js?v=10"></script>
</body>
</html>`;
}

/**
 * Render the header component.
 */
export function renderHeader(): string {
  return `<header class="header">
  <div class="header-left">
    <button class="sidebar-toggle" onclick="Psycheros.toggleSidebar()" aria-label="Toggle sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12h18M3 6h18M3 18h18"/>
      </svg>
    </button>
    <div class="logo">Psycheros</div>
  </div>
  <div class="header-right">
    <button class="context-toggle" onclick="Psycheros.toggleContextViewer()" aria-label="Toggle context viewer" title="View LLM Context">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>
    </button>
  </div>
</header>`;
}

/**
 * Render just the header title text.
 * Returns the conversation title if available, otherwise "Untitled".
 */
export function renderHeaderTitle(title?: string): string {
  return escapeHtml(title || "Untitled");
}

/**
 * Render the sidebar with conversation list.
 */
export function renderSidebar(conversations: Conversation[]): string {
  return `<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <span class="sidebar-title">Conversations</span>
    <button class="btn btn--primary btn--sm" onclick="Psycheros.newConversation()">+ New</button>
  </div>
  <nav class="conv-list" id="conv-list" hx-get="/fragments/conv-list" hx-trigger="load" hx-swap="innerHTML">
    ${renderConversationList(conversations)}
  </nav>
  <div class="sidebar-footer">
    <span class="sidebar-title">Settings</span>
    <a class="sidebar-settings-link"
      hx-get="/fragments/settings/core-prompts"
      hx-target="#chat"
      hx-swap="innerHTML"
      onclick="Psycheros.closeSidebarAfterNav()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      <span>Core Prompts</span>
    </a>
    <a class="sidebar-settings-link"
      hx-get="/fragments/settings/lorebooks"
      hx-target="#chat"
      hx-swap="innerHTML"
      onclick="Psycheros.closeSidebarAfterNav()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
      <span>Context Notes</span>
    </a>
  </div>
</aside>`;
}

/**
 * Render the conversation list items.
 * This can be returned as a partial for HTMX swaps.
 */
export function renderConversationList(conversations: Conversation[]): string {
  if (conversations.length === 0) {
    return `<div class="conv-empty">No conversations yet</div>`;
  }

  return conversations
    .map((conv) => renderConversationItem(conv))
    .join("");
}

/**
 * Render a single conversation list item with swipe actions.
 */
export function renderConversationItem(
  conv: Conversation,
  isActive = false
): string {
  const title = escapeHtml(conv.title || "Untitled");
  const date = formatDate(conv.updatedAt || conv.createdAt);
  const escapedId = escapeHtml(conv.id);
  const encodedId = encodeURIComponent(conv.id);

  // Swipe wrapper structure with edit action (delete removed - too easy to lose conversations)
  return `<div class="conv-item-wrapper" data-conv-id="${escapedId}">
  <div class="conv-swipe-action conv-swipe-action--edit" data-action="edit">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  </div>
  <a class="conv-item${isActive ? " active" : ""}"
    data-conv-id="${escapedId}"
    hx-get="/fragments/chat/${encodedId}"
    hx-target="#chat"
    hx-swap="innerHTML"
    hx-push-url="/c/${encodedId}">
    <input type="checkbox" class="conv-select-checkbox" data-conv-id="${escapedId}" onclick="event.stopPropagation()">
    <span class="conv-title">${title}</span>
    <span class="conv-date">${date}</span>
    <div class="conv-actions">
      <button class="conv-action-btn conv-action-btn--edit" data-action="edit" title="Edit title" onclick="event.preventDefault(); event.stopPropagation(); Psycheros.startTitleEdit('${escapedId}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <button class="conv-action-btn conv-action-btn--delete" data-action="delete" title="Delete" onclick="event.preventDefault(); event.stopPropagation(); Psycheros.showDeleteModal(['${escapedId}'])">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3,6 5,6 21,6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
  </a>
</div>`;
}

// =============================================================================
// Chat View Templates
// =============================================================================

/**
 * Map of message ID to metrics for efficient lookup during rendering.
 */
export type MetricsMap = Map<string, TurnMetrics>;

/**
 * Render the chat view for a conversation.
 * Includes messages and input area.
 *
 * @param messages - Messages to render
 * @param metricsMap - Optional map of message ID to metrics
 */
export function renderChatView(messages: Message[], metricsMap?: MetricsMap): string {
  return `<div class="messages" id="messages">
  ${messages.length === 0 ? "" : renderMessages(messages, metricsMap)}
</div>
${renderInputArea()}`;
}

/**
 * Render all messages.
 */
export function renderMessages(messages: Message[], metricsMap?: MetricsMap): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => renderMessage(m, metricsMap?.get(m.id)))
    .join("");
}

/**
 * Render a single message based on role.
 */
export function renderMessage(msg: Message, metrics?: TurnMetrics): string {
  if (msg.role === "user") {
    return renderUserMessage(msg.content);
  } else if (msg.role === "assistant") {
    return renderAssistantMessage(msg, metrics);
  }
  return "";
}

/**
 * Render a user message.
 */
export function renderUserMessage(content: string): string {
  return `<div class="msg msg--user">
  <div class="msg-header">You</div>
  <div class="msg-content">${escapeHtml(content)}</div>
</div>`;
}

/**
 * Render an assistant message with optional thinking, tool calls, and metrics.
 */
export function renderAssistantMessage(msg: Message, metrics?: TurnMetrics): string {
  let html = `<div class="msg msg--assistant">
  <div class="msg-header">Assistant${metrics ? renderMetricsIndicator(metrics) : ""}</div>
  <div class="msg-content">`;

  // Thinking section
  if (msg.reasoningContent) {
    html += renderThinkingSection(msg.reasoningContent);
  }

  // Tool calls
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      html += renderToolCard(tc);
    }
  }

  // Main content
  if (msg.content) {
    html += `<div class="assistant-text">${escapeHtml(msg.content)}</div>`;
  }

  html += `</div></div>`;
  return html;
}

/**
 * Format milliseconds as human-readable string.
 */
function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms >= 1000) {
    return (ms / 1000).toFixed(1) + "s";
  }
  return Math.round(ms) + "ms";
}

/**
 * Get CSS class for metric value based on thresholds.
 */
function getMetricClass(metric: string, value: number | null): string {
  if (value === null || value === undefined) return "";

  switch (metric) {
    case "ttfb":
      if (value > 2000) return "slow";
      if (value > 1000) return "warning";
      return "";
    case "ttfc":
      if (value > 3000) return "slow";
      if (value > 2000) return "warning";
      return "";
    case "maxChunkGap":
      if (value > 1000) return "slow";
      if (value > 500) return "warning";
      return "";
    case "slowChunkCount":
      if (value > 5) return "slow";
      if (value > 0) return "warning";
      return "";
    default:
      return "";
  }
}

/**
 * Render the metrics indicator for an assistant message header.
 */
export function renderMetricsIndicator(metrics: TurnMetrics): string {
  const summary = formatMs(metrics.totalDuration);

  const rows = [
    { label: "TTFB", value: metrics.ttfb, metric: "ttfb", raw: false },
    { label: "TTFC", value: metrics.ttfc, metric: "ttfc", raw: false },
    { label: "Max Gap", value: metrics.maxChunkGap, metric: "maxChunkGap", raw: false },
    { label: "Slow Chunks", value: metrics.slowChunkCount, metric: "slowChunkCount", raw: true },
    { label: "Total", value: metrics.totalDuration, metric: "total", raw: false },
    { label: "Chunks", value: metrics.chunkCount, metric: "chunks", raw: true },
  ];

  const tooltipRows = rows
    .map((row) => {
      const valueClass = getMetricClass(row.metric, row.value);
      const displayValue = row.raw ? (row.value ?? "-") : formatMs(row.value);
      return `<div class="metrics-row">
      <span class="metrics-label">${row.label}</span>
      <span class="metrics-value ${valueClass}">${displayValue}</span>
    </div>`;
    })
    .join("");

  return `<div class="metrics-indicator">
    <span class="metrics-indicator-icon">&#9201;</span>
    <span class="metrics-indicator-summary">${summary}</span>
    <div class="metrics-tooltip">${tooltipRows}</div>
  </div>`;
}

/**
 * Render the empty state when no conversation is selected.
 */
export function renderEmptyState(): string {
  return `<div class="messages" id="messages">
  <div class="empty-state" id="empty-state">
    <div class="empty-title">Psycheros</div>
    <p class="empty-text">Start a new conversation or select one from the sidebar.</p>
  </div>
</div>`;
}

/**
 * Render the input area.
 */
export function renderInputArea(): string {
  return `<div class="input-area">
  <div class="input-container">
    <textarea
      class="input-field"
      id="message-input"
      placeholder="Type your message..."
      rows="1"
      onkeydown="Psycheros.handleKeyDown(event)"
      oninput="Psycheros.autoResize(this)"
    ></textarea>
    <button class="send-btn" id="send-btn" onclick="Psycheros.sendMessage()">Send</button>
  </div>
</div>`;
}

// =============================================================================
// Component Templates
// =============================================================================

/**
 * Render a collapsible thinking section.
 * Collapsed by default; toggle 'expanded' class to show content.
 */
export function renderThinkingSection(content: string): string {
  return `<div class="thinking">
  <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="thinking-toggle">&#9660;</span>
    <span>Thinking</span>
  </div>
  <div class="thinking-content">${escapeHtml(content)}</div>
</div>`;
}

/**
 * Render a tool call card.
 * Collapsed by default; toggle 'expanded' class to show args/result.
 */
export function renderToolCard(toolCall: ToolCall, result?: ToolResult): string {
  const name = escapeHtml(toolCall.function.name);
  let args = toolCall.function.arguments;

  // Generate brief summary for collapsed state
  let summary = "";
  const parsed = tryJsonParse(args, null);
  if (hasStringCommand(parsed)) {
    // For shell commands, show abbreviated command
    const cmd = parsed.command;
    summary = cmd.length > 50 ? cmd.substring(0, 50) + "..." : cmd;
  }

  // Try to format JSON for expanded view
  const parsedForFormat = tryJsonParse(args, null);
  if (parsedForFormat !== null) {
    args = JSON.stringify(parsedForFormat, null, 2);
  }

  let html = `<div class="tool" data-tool-call-id="${toolCall.id}">
  <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="tool-icon">&#9881;</span>
    <span class="tool-name">${name}</span>
    ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ""}
    <span class="tool-toggle">&#9660;</span>
  </div>
  <div class="tool-args">${escapeHtml(args)}</div>`;

  if (result) {
    html += renderToolResult(result);
  }

  html += `</div>`;
  return html;
}

/**
 * Render a tool result section.
 */
export function renderToolResult(result: ToolResult): string {
  const isError = result.isError ?? false;
  let content = result.content;

  // Try to format JSON if it looks like JSON
  if (content.startsWith("{") || content.startsWith("[")) {
    const parsed = tryJsonParse(content, null);
    if (parsed !== null) {
      content = JSON.stringify(parsed, null, 2);
    }
  }

  return `<div class="tool-result${isError ? " error" : ""}">
  <div class="tool-result-label">${isError ? "Error" : "Output"}</div>
  ${escapeHtml(content)}
</div>`;
}

// =============================================================================
// Settings Templates
// =============================================================================

/**
 * Valid core prompt directories.
 */
const VALID_DIRECTORIES = ["self", "user", "relationship", "custom", "snapshots"] as const;
type PromptDirectory = typeof VALID_DIRECTORIES[number];

/**
 * Check if a directory is a valid prompt directory.
 */
export function isValidPromptDirectory(dir: string): dir is PromptDirectory {
  return VALID_DIRECTORIES.includes(dir as PromptDirectory);
}

/**
 * Render the Core Prompts Settings view.
 * Shows tabs for self/user/relationship/custom directories and file list.
 */
export function renderCorePromptsSettings(activeDir: PromptDirectory = "self"): string {
  const tabs = [
    { id: "self", label: "Self" },
    { id: "user", label: "User" },
    { id: "relationship", label: "Relationship" },
    { id: "custom", label: "Custom" },
    { id: "snapshots", label: "Snapshots" },
  ];

  const tabsHtml = tabs.map((tab) => {
    const isActive = tab.id === activeDir;
    const getUrl = tab.id === "snapshots"
      ? "/fragments/settings/snapshots"
      : `/fragments/settings/core-prompts/${tab.id}`;
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="${getUrl}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      id="tab-${tab.id}"
    >${tab.label}</button>`;
  }).join("");

  return `<div class="settings-view">
  <div class="settings-header">
    <h1 class="settings-title">Core Prompts</h1>
    <p class="settings-desc">Edit the prompt files that define the entity's core behavior.</p>
  </div>
  <div class="settings-tabs">
    ${tabsHtml}
  </div>
  <div class="settings-content" id="settings-content"
    hx-get="/fragments/settings/core-prompts/${activeDir}"
    hx-trigger="load"
    hx-swap="innerHTML">
    <div class="settings-loading">Loading...</div>
  </div>
</div>`;
}

/**
 * Render the file list for a prompt directory.
 * Includes OOB swap to update the active tab state.
 * For custom directory, includes create file input and delete buttons.
 */
export function renderFileList(directory: PromptDirectory, files: string[]): string {
  const isCustom = directory === "custom";

  // Custom directory has special UI for creating files
  let createFileHtml = "";
  if (isCustom) {
    createFileHtml = `
      <div class="settings-create-file">
        <input
          type="text"
          class="settings-create-file-input"
          id="custom-filename-input"
          placeholder="New file name (e.g., my_context.md)"
          pattern="[a-zA-Z0-9_]+\\.md"
        />
        <button
          class="btn btn--primary btn--sm"
          onclick="Psycheros.createCustomFile()"
        >
          Create
        </button>
      </div>`;
  }

  const fileListHtml = files.length === 0
    ? `<div class="settings-empty">${isCustom ? "No custom files yet. Create one above!" : "No files in this directory"}</div>`
    : `<div class="settings-file-list">
      ${files.map((file) => {
        const displayName = file.replace(/\.md$/, "").replace(/_/g, " ");
        const deleteButton = isCustom
          ? `<button
              class="settings-file-delete"
              onclick="event.stopPropagation(); Psycheros.deleteCustomFile('${escapeHtml(file)}')"
              title="Delete file"
            >🗑️</button>`
          : "";
        return `<button
          class="settings-file-item"
          hx-get="/fragments/settings/file/${directory}/${encodeURIComponent(file)}"
          hx-target="#settings-content"
          hx-swap="innerHTML"
        >
          <span class="settings-file-icon">📄</span>
          <span class="settings-file-name">${escapeHtml(displayName)}</span>
          ${deleteButton}
        </button>`;
      }).join("")}
    </div>`;

  // OOB swap to update active tab
  const oobSwap = renderTabActiveState(directory);

  return createFileHtml + fileListHtml + oobSwap;
}

/**
 * Render the active tab indicator as an OOB swap.
 */
function renderTabActiveState(activeDir: PromptDirectory): string {
  const tabs = ["self", "user", "relationship", "custom"];
  return tabs.map((dir) => {
    const isActive = dir === activeDir;
    const label = dir === "custom" ? "Custom" : dir.charAt(0).toUpperCase() + dir.slice(1);
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="/fragments/settings/core-prompts/${dir}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-swap-oob="true"
      id="tab-${dir}"
    >${label}</button>`;
  }).join("");
}

/**
 * Render the file editor with textarea.
 */
export function renderFileEditor(
  directory: PromptDirectory,
  filename: string,
  content: string
): string {
  const displayName = filename.replace(/\.md$/, "").replace(/_/g, " ");
  const safeContent = escapeHtml(content);

  return `<div class="settings-editor">
  <div class="settings-editor-header">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/core-prompts/${directory}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >
      ← Back
    </button>
    <span class="settings-editor-filename">${escapeHtml(displayName)}</span>
  </div>
  <form
    class="settings-editor-form"
    hx-post="/api/settings/file/${directory}/${encodeURIComponent(filename)}"
    hx-target="#settings-editor-status"
    hx-swap="innerHTML"
  >
    <textarea
      class="settings-textarea"
      name="content"
      placeholder="Enter prompt content..."
      rows="20"
    >${safeContent}</textarea>
    <div class="settings-editor-actions">
      <button
        type="button"
        class="btn btn--ghost"
        hx-get="/fragments/settings/core-prompts/${directory}"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Cancel</button>
      <button type="submit" class="btn btn--primary">Save</button>
    </div>
    <div id="settings-editor-status" class="settings-editor-status"></div>
  </form>
</div>`;
}

/**
 * Render a success message after saving.
 */
export function renderSaveSuccess(): string {
  return `<div class="settings-save-success">✓ Saved successfully</div>`;
}

/**
 * Render an error message.
 */
export function renderSaveError(message: string): string {
  return `<div class="settings-save-error">✗ ${escapeHtml(message)}</div>`;
}

// =============================================================================
// Snapshot Templates
// =============================================================================

/**
 * Render the snapshots list view.
 *
 * @param snapshots - Array of snapshot metadata
 * @returns HTML string for the snapshots list
 */
export function renderSnapshotsView(
  snapshots: Array<{
    id: string;
    category: string;
    filename: string;
    timestamp: string;
    date: string;
    reason: string;
    source: string;
  }>
): string {
  // Group snapshots by date
  const grouped: Record<string, typeof snapshots> = {};
  for (const snapshot of snapshots) {
    if (!grouped[snapshot.date]) {
      grouped[snapshot.date] = [];
    }
    grouped[snapshot.date].push(snapshot);
  }

  // Sort dates descending (newest first)
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  if (sortedDates.length === 0) {
    return `<div class="snapshots-empty">
      <p>No snapshots available. Snapshots are created automatically on the scheduled hour (default 3 AM) and before major changes.</p>
      <button
        class="btn btn--primary"
        hx-post="/api/snapshots/create"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Create Manual Snapshot</button>
    </div>`;
  }

  let html = `<div class="snapshots-header">
    <button
      class="btn btn--primary btn--sm"
      hx-post="/api/snapshots/create"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >Create Manual Snapshot</button>
  </div>`;

  for (const date of sortedDates) {
    const dateSnapshots = grouped[date];
    const formattedDate = formatSnapshotDate(date);

    html += `<div class="snapshot-group">
      <h3 class="snapshot-group-date">${escapeHtml(formattedDate)}</h3>`;

    for (const snapshot of dateSnapshots) {
      const formattedTime = formatTime(snapshot.timestamp);
      const formattedReason = snapshot.reason;
      const encodedSnapshotId = encodeURIComponent(snapshot.id);
      const snapshotSource = snapshot.source || "entity-core";

      html += `
        <div class="snapshot-item"
          hx-get="/fragments/settings/snapshots/${encodedSnapshotId}"
          hx-target="#settings-content"
          hx-swap="innerHTML"
        >
          <span class="snapshot-category">${escapeHtml(snapshot.category)}</span>
          <span class="snapshot-filename">${escapeHtml(snapshot.filename.replace(/\.md$/, ""))}</span>
          <span class="snapshot-time">${formattedTime}</span>
          <span class="snapshot-reason">${escapeHtml(formattedReason)}</span>
          <span class="snapshot-source">${escapeHtml(snapshotSource)}</span>
        </div>
      `;
    }

    html += `</div>`;
  }

  return html;
}

/**
 * Render the snapshot preview view.
 *
 * @param category - The snapshot category
 * @param filename - The original filename
 * @param content - The snapshot content (including header comments)
 * @returns HTML string for the snapshot preview
 */
export function renderSnapshotPreview(
  category: string,
  filename: string,
  content: string
): string {
  const displayName = filename.replace(/\.md$/, "").replace(/_/g, " ");
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

  // Extract the actual content (skip the header comments)
  const lines = content.split("\n");
  let contentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "" && i > 2) {
      contentStart = i + 1;
      break;
    }
  }
  const actualContent = lines.slice(contentStart).join("\n");

  return `<div class="snapshot-preview">
  <div class="snapshot-preview-header">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/snapshots"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >← Back to Snapshots</button>
    <span class="snapshot-preview-filename">${escapeHtml(categoryLabel)} / ${escapeHtml(displayName)}</span>
  </div>
  <div class="snapshot-preview-content">
    <pre>${escapeHtml(actualContent)}</pre>
  </div>
  <div class="snapshot-preview-actions">
    <button
      class="btn btn--danger"
      hx-post="/api/snapshots/${encodeURIComponent(`${category}/${filename.replace(/\.md$/, "")}`)}/restore"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-confirm="Are you sure you want to restore this snapshot? This will replace the current ${categoryLabel} / ${displayName} file."
    >Restore Snapshot</button>
  </div>
</div>`;
}

/**
 * Format a date string for snapshot display.
 */
function formatSnapshotDate(dateStr: string): string {
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  if (dateStr === today) {
    return "Today";
  } else if (dateStr === yesterday) {
    return "Yesterday";
  } else {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
}

/**
 * Format a timestamp for display (just the time portion).
 */
function formatTime(timestamp: string): string {
  // Convert dashes back to colons for time portion (2026-03-02T07-24-15-996Z -> 2026-03-02T07:24:15.996Z)
  const isoTimestamp = timestamp.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z$/, 'T$1:$2:$3.$4Z');
  const date = new Date(isoTimestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// =============================================================================
// Lorebook Templates
// =============================================================================

/**
 * Render the main lorebooks list view.
 */
export function renderLorebooksView(lorebooks: Lorebook[]): string {
  let html = `<div class="settings-view">
    <div class="settings-header">
      <h1 class="settings-title">Context Books</h1>
      <p class="settings-desc">Collections of context entries that are injected into context when triggered by keywords.</p>
    </div>
    <div class="settings-content" id="settings-content">`;

  html += `<div class="lorebooks-list">`;

  if (lorebooks.length === 0) {
    html += `<div class="lorebooks-empty">
      <p>No context books yet. Create one to start adding context entries.</p>
    </div>`;
  } else {
    for (const book of lorebooks) {
      html += `<div class="lorebook-card ${book.enabled ? '' : 'lorebook-card--disabled'}">
        <div class="lorebook-card-header">
          <h3 class="lorebook-card-name">${escapeHtml(book.name)}</h3>
          <span class="lorebook-card-status">${book.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        ${book.description ? `<p class="lorebook-card-desc">${escapeHtml(book.description)}</p>` : ''}
        <div class="lorebook-card-actions">
          <button
            class="btn btn--ghost btn--sm"
            hx-get="/fragments/settings/lorebooks/${book.id}"
            hx-target="#settings-content"
            hx-swap="innerHTML"
          >View Entries</button>
          <button
            class="btn btn--ghost btn--sm"
            hx-delete="/api/lorebooks/${book.id}"
            hx-confirm="Delete this context book and all its entries?"
            hx-target="#settings-content"
            hx-swap="innerHTML"
          >Delete</button>
        </div>
      </div>`;
    }
  }

  html += `</div>`;

  // Add "Create Lorebook" form
  html += `<div class="lorebook-create">
    <h3>Create New Context Book</h3>
    <form
      hx-post="/api/lorebooks"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >
      <div class="form-group">
        <label for="lorebook-name">Name</label>
        <input type="text" id="lorebook-name" name="name" required placeholder="e.g., Character Info" />
      </div>
      <div class="form-group">
        <label for="lorebook-desc">Description (optional)</label>
        <input type="text" id="lorebook-desc" name="description" placeholder="e.g., Background context for conversations" />
      </div>
      <button type="submit" class="btn btn--primary">Create Context Book</button>
    </form>
  </div>`;

  html += `</div></div>`; // Close settings-content and settings-view

  return html;
}

/**
 * Render a single lorebook with its entries.
 */
export function renderLorebookDetailView(book: Lorebook, entries: LorebookEntry[]): string {
  let html = `<div class="settings-breadcrumb">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/lorebooks"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >← Back to Context Books</button>
  </div>
  <div class="settings-section-header">
    <h2>${escapeHtml(book.name)}</h2>
    <p class="settings-section-desc">${book.description ? escapeHtml(book.description) : 'No description'}</p>
  </div>`;

  // Entries list
  html += `<div class="lorebook-entries-list">`;

  if (entries.length === 0) {
    html += `<div class="lorebooks-empty">
      <p>No entries yet. Add triggers to inject content into context.</p>
    </div>`;
  } else {
    // Sort by priority (highest first)
    const sortedEntries = [...entries].sort((a, b) => b.priority - a.priority);

    for (const entry of sortedEntries) {
      html += renderEntryCard(entry);
    }
  }

  html += `</div>`;

  // Create entry form
  html += `<div class="lorebook-entry-create">
    <h3>Add New Entry</h3>
    <form
      hx-post="/api/lorebooks/${book.id}/entries"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      class="lorebook-entry-form"
    >
      <div class="form-row">
        <div class="form-group">
          <label for="entry-name">Name</label>
          <input type="text" id="entry-name" name="name" required placeholder="e.g., Character Info" />
        </div>
        <div class="form-group form-group--small">
          <label for="entry-priority">Priority</label>
          <input type="number" id="entry-priority" name="priority" value="0" />
        </div>
      </div>

      <div class="form-group">
        <label for="entry-triggers">Triggers (comma-separated)</label>
        <input type="text" id="entry-triggers" name="triggers" required placeholder="e.g., alice, character, friend" />
      </div>

      <div class="form-group">
        <label for="entry-content">Content</label>
        <textarea id="entry-content" name="content" rows="4" required placeholder="Information to inject when triggered..."></textarea>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="entry-triggerMode">Trigger Mode</label>
          <select id="entry-triggerMode" name="triggerMode">
            <option value="substring">Substring (default)</option>
            <option value="word">Word Boundary</option>
            <option value="exact">Exact Match</option>
            <option value="regex">Regex</option>
          </select>
        </div>
        <div class="form-group form-group--small">
          <label for="entry-scanDepth">Scan Depth</label>
          <input type="number" id="entry-scanDepth" name="scanDepth" value="5" min="1" max="50" />
        </div>
      </div>

      <div class="form-row form-row--checkboxes">
        <label class="checkbox-label">
          <input type="checkbox" name="caseSensitive" />
          Case Sensitive
        </label>
        <label class="checkbox-label">
          <input type="checkbox" name="enabled" checked />
          Enabled
        </label>
        <label class="checkbox-label">
          <input type="checkbox" name="sticky" onchange="const durInput = document.getElementById('entry-stickyDuration'); if (this.checked) { durInput.disabled = false; durInput.style.opacity = '1'; durInput.style.pointerEvents = 'auto'; } else { durInput.disabled = true; durInput.style.opacity = '0.5'; durInput.style.pointerEvents = 'none'; }" />
          Sticky
        </label>
      </div>

      <div class="form-row">
        <div class="form-group form-group--small">
          <label for="entry-stickyDuration">Sticky Duration (turns)</label>
          <input type="number" id="entry-stickyDuration" name="stickyDuration" value="0" min="0" disabled style="opacity: 0.5; pointer-events: none;" />
        </div>
      </div>

      <button type="submit" class="btn btn--primary">Add Entry</button>
    </form>
  </div>`;

  return html;
}

/**
 * Render a single entry card.
 */
function renderEntryCard(entry: LorebookEntry): string {
  const triggersHtml = entry.triggers.map(t => `<span class="trigger-tag">${escapeHtml(t)}</span>`).join('');

  return `<div class="entry-card ${entry.enabled ? '' : 'entry-card--disabled'}">
    <div class="entry-card-header">
      <h4 class="entry-card-name">${escapeHtml(entry.name)}</h4>
      <span class="entry-card-priority">Priority: ${entry.priority}</span>
    </div>
    <div class="entry-card-triggers">${triggersHtml}</div>
    <div class="entry-card-content">${escapeHtml(entry.content.substring(0, 200))}${entry.content.length > 200 ? '...' : ''}</div>
    <div class="entry-card-meta">
      <span>${entry.triggerMode}</span>
      ${entry.sticky ? `<span>Sticky: ${entry.stickyDuration} turns</span>` : ''}
      ${!entry.enabled ? `<span>Disabled</span>` : ''}
    </div>
    <div class="entry-card-actions">
      <button
        class="btn btn--ghost btn--sm"
        hx-get="/fragments/settings/lorebooks/${entry.bookId}/entries/${entry.id}/edit"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Edit</button>
      <button
        class="btn btn--ghost btn--sm"
        hx-delete="/api/lorebooks/${entry.bookId}/entries/${entry.id}"
        hx-confirm="Delete this entry?"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Delete</button>
    </div>
  </div>`;
}

/**
 * Render the entry editor form.
 */
export function renderEntryEditor(entry: LorebookEntry): string {
  const triggersStr = entry.triggers.join(', ');

  return `<div class="settings-breadcrumb">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/lorebooks/${entry.bookId}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >← Back to Context Book</button>
  </div>
  <div class="settings-section-header">
    <h2>Edit Entry: ${escapeHtml(entry.name)}</h2>
  </div>

  <form
    hx-put="/api/lorebooks/${entry.bookId}/entries/${entry.id}"
    hx-target="#settings-content"
    hx-swap="innerHTML"
    class="lorebook-entry-form"
  >
    <div class="form-row">
      <div class="form-group">
        <label for="entry-name">Name</label>
        <input type="text" id="entry-name" name="name" value="${escapeHtml(entry.name)}" required />
      </div>
      <div class="form-group form-group--small">
        <label for="entry-priority">Priority</label>
        <input type="number" id="entry-priority" name="priority" value="${entry.priority}" />
      </div>
    </div>

    <div class="form-group">
      <label for="entry-triggers">Triggers (comma-separated)</label>
      <input type="text" id="entry-triggers" name="triggers" value="${escapeHtml(triggersStr)}" required />
    </div>

    <div class="form-group">
      <label for="entry-content">Content</label>
      <textarea id="entry-content" name="content" rows="6" required>${escapeHtml(entry.content)}</textarea>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="entry-triggerMode">Trigger Mode</label>
        <select id="entry-triggerMode" name="triggerMode">
          <option value="substring" ${entry.triggerMode === 'substring' ? 'selected' : ''}>Substring</option>
          <option value="word" ${entry.triggerMode === 'word' ? 'selected' : ''}>Word Boundary</option>
          <option value="exact" ${entry.triggerMode === 'exact' ? 'selected' : ''}>Exact Match</option>
          <option value="regex" ${entry.triggerMode === 'regex' ? 'selected' : ''}>Regex</option>
        </select>
      </div>
      <div class="form-group form-group--small">
        <label for="entry-scanDepth">Scan Depth</label>
        <input type="number" id="entry-scanDepth" name="scanDepth" value="${entry.scanDepth}" min="1" max="50" />
      </div>
    </div>

    <div class="form-row form-row--checkboxes">
      <label class="checkbox-label">
        <input type="checkbox" name="caseSensitive" ${entry.caseSensitive ? 'checked' : ''} />
        Case Sensitive
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="enabled" ${entry.enabled ? 'checked' : ''} />
        Enabled
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="sticky" ${entry.sticky ? 'checked' : ''} onchange="const durInput = document.getElementById('entry-stickyDuration'); if (this.checked) { durInput.disabled = false; durInput.style.opacity = '1'; durInput.style.pointerEvents = 'auto'; } else { durInput.disabled = true; durInput.style.opacity = '0.5'; durInput.style.pointerEvents = 'none'; }" />
        Sticky
      </label>
    </div>

    <div class="form-row form-row--checkboxes">
      <label class="checkbox-label">
        <input type="checkbox" name="nonRecursable" ${entry.nonRecursable ? 'checked' : ''} />
        Non-Recursable
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="preventRecursion" ${entry.preventRecursion ? 'checked' : ''} />
        Prevent Recursion
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="reTriggerResetsTimer" ${entry.reTriggerResetsTimer ? 'checked' : ''} />
        Re-trigger Resets Timer
      </label>
    </div>

    <div class="form-row">
      <div class="form-group form-group--small">
        <label for="entry-stickyDuration">Sticky Duration (turns)</label>
        <input type="number" id="entry-stickyDuration" name="stickyDuration" value="${entry.stickyDuration}" min="0" ${!entry.sticky ? 'disabled' : ''} style="${!entry.sticky ? 'opacity: 0.5; pointer-events: none;' : ''}" />
      </div>
      <div class="form-group form-group--small">
        <label for="entry-maxTokens">Max Tokens (0 = unlimited)</label>
        <input type="number" id="entry-maxTokens" name="maxTokens" value="${entry.maxTokens}" min="0" />
      </div>
    </div>

    <div class="form-actions">
      <button type="submit" class="btn btn--primary">Save Changes</button>
      <button
        type="button"
        class="btn btn--ghost"
        hx-get="/fragments/settings/lorebooks/${entry.bookId}"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Cancel</button>
    </div>
  </form>`;
}


