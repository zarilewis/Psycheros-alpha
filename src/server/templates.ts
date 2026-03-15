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
import type { LLMSettings } from "../llm/mod.ts";
import { maskApiKey } from "../llm/mod.ts";
import { renderMarkdown } from "./markdown.ts";

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
 * Format a message timestamp for display in the chat UI.
 * Shows time only for today's messages, date + time for older ones.
 * Respects the TZ environment variable for display formatting.
 */
function formatMessageTime(date: Date): string {
  const timeZone = Deno.env.get("TZ") || undefined; // undefined = system default
  const now = new Date();
  const isToday = date.toLocaleDateString("en-US", { timeZone }) ===
    now.toLocaleDateString("en-US", { timeZone });

  if (isToday) {
    return date.toLocaleTimeString("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  return date.toLocaleDateString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
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
  <link rel="stylesheet" href="/css/main.css?v=11">
  ${getAccentColorOverride()}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="manifest" href="/manifest.json" crossorigin="use-credentials">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.svg">
  <script src="/lib/htmx.min.js"></script>
  <script src="/lib/htmx-sse.js"></script>
  <script src="/lib/marked.min.js"></script>
  <script src="/lib/dompurify.min.js"></script>
</head>
<body>
  <div class="bg-layer"></div>
  <div class="bg-overlay"></div>
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
  <script src="/js/theme.js?v=1"></script>
  <script type="module" src="/js/psycheros.js?v=11"></script>
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
    <div class="logo">Psycheros <span class="logo-sub" id="header-title"></span></div>
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
 * Render a back button that returns to the settings hub.
 */
function renderSettingsBackButton(): string {
  return `<a class="settings-back-btn"
    hx-get="/fragments/settings"
    hx-target="#chat"
    hx-swap="innerHTML">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
    <span>Settings</span>
  </a>`;
}

/**
 * Render the settings hub page listing all 5 settings categories as cards.
 */
export function renderSettingsHub(): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <h1 class="settings-title">Settings</h1>
    <p class="settings-desc">Manage entity behavior, appearance, and model configuration</p>
  </div>
  <div class="settings-content" id="settings-content">
    <div class="settings-hub-grid">
      <a class="settings-hub-card"
        hx-get="/fragments/settings/core-prompts"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Core Prompts</span>
          <span class="settings-hub-card-desc">Edit prompt files that define the entity's core behavior</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/lorebooks"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Context Notes</span>
          <span class="settings-hub-card-desc">Manage lorebooks and context entries</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/graph"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <circle cx="19" cy="5" r="2"/>
            <circle cx="5" cy="19" r="2"/>
            <line x1="14.5" y1="9.5" x2="17.5" y2="6.5"/>
            <line x1="9.5" y1="14.5" x2="6.5" y2="17.5"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Knowledge Graph</span>
          <span class="settings-hub-card-desc">Interactive knowledge graph visualization</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/appearance"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Appearance</span>
          <span class="settings-hub-card-desc">Customize colors, backgrounds, and visual effects</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/llm"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
            <rect x="9" y="9" width="6" height="6"/>
            <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">LLM Settings</span>
          <span class="settings-hub-card-desc">Configure model connection and generation parameters</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/admin"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">System Admin</span>
          <span class="settings-hub-card-desc">Logs, diagnostics, and system health monitoring</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
    </div>
  </div>
</div>`;
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
    <a class="sidebar-settings-link"
      hx-get="/fragments/settings"
      hx-target="#chat"
      hx-swap="innerHTML"
      onclick="Psycheros.closeSidebarAfterNav()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      <span>Settings</span>
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
    return renderUserMessage(msg.content, msg.id, msg.editedAt, msg.createdAt);
  } else if (msg.role === "assistant") {
    return renderAssistantMessage(msg, metrics);
  }
  return "";
}

/**
 * Render a user message.
 *
 * @param content - Message content
 * @param messageId - Optional message ID (for edit functionality)
 * @param editedAt - Optional timestamp when message was edited
 */
export function renderUserMessage(
  content: string,
  messageId?: string,
  editedAt?: Date,
  createdAt?: Date,
): string {
  const editedIndicator = editedAt
    ? `<span class="msg-edited-indicator">(edited)</span>`
    : "";
  const editBtn = messageId
    ? `<button class="msg-edit-btn" onclick="Psycheros.startMessageEdit('${escapeHtml(messageId)}')" title="Edit message">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>`
    : "";
  const dataAttr = messageId ? `data-message-id="${escapeHtml(messageId)}"` : "";
  const timeStr = createdAt ? formatMessageTime(createdAt) : "";
  const timeEl = timeStr ? `<span class="msg-timestamp">${escapeHtml(timeStr)}</span>` : "";

  return `<div class="msg msg--user" ${dataAttr}>
  <div class="msg-header">
    ${timeEl}
    <span>You</span>
    ${editedIndicator}
    ${editBtn}
  </div>
  <div class="msg-content user-text">${renderMarkdown(content)}</div>
</div>`;
}

/**
 * Render an assistant message with optional thinking, tool calls, and metrics.
 */
export function renderAssistantMessage(msg: Message, metrics?: TurnMetrics): string {
  const editedIndicator = msg.editedAt
    ? `<span class="msg-edited-indicator">(edited)</span>`
    : "";
  const editBtn = msg.id
    ? `<button class="msg-edit-btn" onclick="Psycheros.startMessageEdit('${escapeHtml(msg.id)}')" title="Edit message">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>`
    : "";

  const timeStr = msg.createdAt ? formatMessageTime(msg.createdAt) : "";
  const timeEl = timeStr ? `<span class="msg-timestamp">${escapeHtml(timeStr)}</span>` : "";

  let html = `<div class="msg msg--assistant" data-message-id="${escapeHtml(msg.id)}">
  <div class="msg-header">
    <span>Assistant</span>
    ${timeEl}
    ${editedIndicator}
    ${metrics ? renderMetricsIndicator(metrics) : ""}
    ${editBtn}
  </div>
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

  // Main content - render markdown for assistant messages
  if (msg.content) {
    html += `<div class="assistant-text">${renderMarkdown(msg.content)}</div>`;
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
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Core Prompts</h1>
        <p class="settings-desc">Edit the prompt files that define the entity's core behavior.</p>
      </div>
    </div>
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
    <span class="settings-editor-tokens" id="settings-editor-tokens">...</span>
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
      data-tokenize
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
    source?: string;
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
      hx-confirm="Are you sure you want to restore this snapshot? This will replace the current ${escapeHtml(categoryLabel)} / ${escapeHtml(displayName)} file."
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
      <div class="settings-header-row">
        ${renderSettingsBackButton()}
        <div>
          <h1 class="settings-title">Context Books</h1>
          <p class="settings-desc">Collections of context entries that are injected into context when triggered by keywords.</p>
        </div>
      </div>
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



// =============================================================================
// Knowledge Graph Templates
// =============================================================================

/**
 * Render the Knowledge Graph visualization view.
 */
export function renderGraphView(stats: {
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  vectorSearchAvailable: boolean;
} | null): string {
  const nodeCount = stats?.totalNodes ?? 0;
  const edgeCount = stats?.totalEdges ?? 0;
  const vectorStatus = stats?.vectorSearchAvailable ? "active" : "off";

  return `
<div class="gv">
  <!-- Header -->
  <div class="gv-header">
    <div class="gv-header-left">
      ${renderSettingsBackButton()}
      <div class="gv-title-block">
        <h2 class="gv-title">Knowledge Graph</h2>
        <div class="gv-stats">
          <span><strong>${nodeCount}</strong> nodes</span>
          <span class="gv-stats-sep">&middot;</span>
          <span><strong>${edgeCount}</strong> edges</span>
          <span class="gv-stats-sep">&middot;</span>
          <span>vec: ${vectorStatus}</span>
        </div>
      </div>
    </div>
    <div class="gv-header-actions">
      <button id="graph-refresh" class="btn btn--ghost btn--sm" title="Refresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
      </button>
    </div>
  </div>

  <!-- Toolbar -->
  <div class="gv-toolbar">
    <div class="gv-toolbar-controls">
      <button id="graph-zoom-fit" class="btn btn--ghost btn--sm" title="Fit to view">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
        </svg>
      </button>
      <button id="graph-zoom-in" class="btn btn--ghost btn--sm" title="Zoom in">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
      <button id="graph-zoom-out" class="btn btn--ghost btn--sm" title="Zoom out">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
    </div>
    <input type="text" id="graph-search" placeholder="Search..." class="gv-search" />
    <select id="graph-filter-type" class="gv-filter">
      <option value="">All types</option>
    </select>
  </div>

  <!-- Graph Canvas -->
  <div id="graph-container" class="gv-canvas">
    <div class="gv-loading">
      <div class="gv-spinner"></div>
    </div>
  </div>

  <!-- Node Detail Panel (slides from right) -->
  <div id="graph-node-panel" class="gv-panel">
    <div class="gv-panel-header">
      <h3 id="panel-node-label">Node</h3>
      <button id="panel-close" class="btn btn--ghost btn--sm">&times;</button>
    </div>
    <div class="gv-panel-body" id="panel-content"></div>
  </div>

  <!-- Create Node Modal -->
  <div id="graph-create-modal" class="gv-modal">
    <div class="gv-modal-box">
      <h3>Create Node</h3>
      <form id="create-node-form">
        <div class="gv-field">
          <label for="node-type">Type</label>
          <select id="node-type" name="type" required>
            <option value="person">Person</option>
            <option value="emotion">Emotion</option>
            <option value="event">Event</option>
            <option value="topic" selected>Topic</option>
            <option value="preference">Preference</option>
            <option value="place">Place</option>
            <option value="goal">Goal</option>
            <option value="health">Health</option>
            <option value="boundary">Boundary</option>
            <option value="tradition">Tradition</option>
            <option value="insight">Insight</option>
            <option value="memory_ref">Memory Ref</option>
          </select>
        </div>
        <div class="gv-field">
          <label for="node-label">Label</label>
          <input type="text" id="node-label" name="label" required placeholder="e.g. hiking, Tyler, anxiety" />
        </div>
        <div class="gv-field">
          <label for="node-description">Description</label>
          <textarea id="node-description" name="description" rows="2" placeholder="Optional..."></textarea>
        </div>
        <div class="gv-field gv-field-range">
          <label for="node-confidence">Confidence</label>
          <div class="gv-range-row">
            <input type="range" id="node-confidence" name="confidence" min="0" max="1" step="0.1" value="0.5" />
            <span id="confidence-value" class="gv-range-val">0.5</span>
          </div>
        </div>
        <div class="gv-modal-actions">
          <button type="button" class="btn btn--ghost" id="cancel-create">Cancel</button>
          <button type="submit" class="btn btn--primary">Create</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Edit Node Modal -->
  <div id="graph-edit-modal" class="gv-modal">
    <div class="gv-modal-box">
      <h3>Edit Node</h3>
      <form id="edit-node-form">
        <input type="hidden" id="edit-node-id" />
        <div class="gv-field">
          <label for="edit-node-label">Label</label>
          <input type="text" id="edit-node-label" required />
        </div>
        <div class="gv-field">
          <label for="edit-node-description">Description</label>
          <textarea id="edit-node-description" rows="2"></textarea>
        </div>
        <div class="gv-field gv-field-range">
          <label for="edit-node-confidence">Confidence</label>
          <div class="gv-range-row">
            <input type="range" id="edit-node-confidence" min="0" max="1" step="0.1" value="0.5" />
            <span id="edit-confidence-value" class="gv-range-val">0.5</span>
          </div>
        </div>
        <div class="gv-modal-actions">
          <button type="button" class="btn btn--ghost" id="cancel-edit">Cancel</button>
          <button type="submit" class="btn btn--primary">Save</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Bottom Action Bar -->
  <div class="gv-actions">
    <button id="graph-create-node" class="btn btn--ghost gv-action-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span>Add Node</span>
    </button>
    <button id="graph-create-edge" class="btn btn--ghost gv-action-btn" disabled>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      <span>Connect</span>
    </button>
    <button id="graph-delete" class="btn btn--ghost gv-action-btn gv-action-danger" disabled>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
      <span>Delete</span>
    </button>
  </div>
</div>

<style>
/* ─── Graph View ─────────────────────────────────────────────────────────── */
/* Namespaced with .gv- to avoid conflicts with app-wide styles              */

.gv {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--c-bg);
  color: var(--c-fg);
  font-family: var(--font-sans);
}

/* Header */
.gv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg-raised);
  gap: var(--sp-3);
  flex-shrink: 0;
}
.gv-header-left {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}
.gv-title-block { min-width: 0; }
.gv-title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--c-accent);
  letter-spacing: 0.02em;
}
.gv-stats {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--font-size-xs);
  color: var(--c-fg-muted);
  font-family: var(--font-mono);
  margin-top: 2px;
}
.gv-stats strong { color: var(--c-fg); font-weight: var(--font-weight-medium); }
.gv-stats-sep { opacity: 0.3; }
.gv-header-actions { flex-shrink: 0; }

/* Toolbar */
.gv-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg-raised);
  flex-shrink: 0;
}
.gv-toolbar-controls {
  display: flex;
  gap: 2px;
}
.gv-search {
  flex: 1;
  min-width: 0;
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg-sunken);
  color: var(--c-fg);
  font-size: var(--font-size-sm);
  font-family: var(--font-sans);
  outline: none;
  transition: border-color var(--transition);
}
.gv-search:focus {
  border-color: var(--c-accent);
  box-shadow: 0 0 0 2px var(--c-accent-subtle);
}
.gv-search::placeholder { color: var(--c-fg-subtle); }
.gv-filter {
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg-sunken);
  color: var(--c-fg);
  font-size: var(--font-size-sm);
  font-family: var(--font-sans);
  cursor: pointer;
  outline: none;
  max-width: 120px;
}
.gv-filter:focus { border-color: var(--c-accent); }

/* Canvas */
.gv-canvas {
  flex: 1;
  position: relative;
  background: var(--c-bg);
  overflow: hidden;
  min-height: 0;
}
.vis-network { outline: none !important; }

/* Loading */
.gv-loading {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
}
.gv-spinner {
  width: 28px; height: 28px;
  border: 2px solid var(--c-border-strong);
  border-top-color: var(--c-accent);
  border-radius: 50%;
  animation: gv-spin 0.8s linear infinite;
}
@keyframes gv-spin { to { transform: rotate(360deg); } }

/* Empty state */
.gv-empty {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  color: var(--c-fg-muted);
  font-size: var(--font-size-sm);
}
.gv-empty svg { margin-bottom: var(--sp-3); }
.gv-empty p { margin: var(--sp-1) 0; }
.gv-empty-hint { font-size: var(--font-size-xs); color: var(--c-fg-subtle); }

/* ─── Node Detail Panel ──────────────────────────────────────────────────── */
.gv-panel {
  position: absolute;
  top: 0; right: 0;
  width: 280px;
  max-width: 85vw;
  height: 100%;
  background: var(--c-bg-raised);
  border-left: 1px solid var(--c-border);
  box-shadow: -4px 0 16px rgba(0,0,0,0.4);
  z-index: 50;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.2s ease;
}
.gv-panel.gv-panel-open {
  transform: translateX(0);
}
.gv-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.gv-panel-header h3 {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--c-fg-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gv-panel-body {
  padding: var(--sp-3) var(--sp-4);
  overflow-y: auto;
  flex: 1;
  -webkit-overflow-scrolling: touch;
}

/* Detail rows inside panel */
.gv-detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--c-border);
  font-size: var(--font-size-sm);
}
.gv-detail-label {
  color: var(--c-fg-muted);
  font-size: var(--font-size-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-family: var(--font-mono);
}
.gv-detail-value {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--c-fg);
}
.gv-detail-section {
  margin-top: var(--sp-4);
}
.gv-detail-desc {
  margin: var(--sp-1) 0 0;
  font-size: var(--font-size-sm);
  color: var(--c-fg);
  line-height: var(--line-height);
}
.gv-conn-list {
  list-style: none;
  padding: 0;
  margin: var(--sp-2) 0 0;
}
.gv-conn-list li {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
  font-size: var(--font-size-sm);
  border-bottom: 1px solid var(--c-border);
}
.gv-conn-list li:last-child { border-bottom: none; }
.gv-conn-dir { color: var(--c-accent); font-family: var(--font-mono); font-size: var(--font-size-xs); }
.gv-conn-type { color: var(--c-fg-muted); font-family: var(--font-mono); font-size: var(--font-size-xs); }
.gv-conn-label { color: var(--c-fg); }
.gv-node-id {
  display: block;
  font-size: var(--font-size-xs);
  color: var(--c-fg-subtle);
  font-family: var(--font-mono);
  word-break: break-all;
  margin-top: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  background: var(--c-bg-sunken);
  border-radius: var(--radius-sm);
}
.gv-edit-btn {
  width: 100%;
  margin-top: var(--sp-4);
  justify-content: center;
}

/* ─── Modal ──────────────────────────────────────────────────────────────── */
.gv-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  padding: var(--sp-4);
}
.gv-modal.gv-modal-open {
  opacity: 1;
  pointer-events: auto;
}
.gv-modal-box {
  background: var(--c-bg-raised);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-md);
  padding: var(--sp-6);
  width: 100%;
  max-width: 380px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  transform: scale(0.95);
  transition: transform 0.15s ease;
}
.gv-modal.gv-modal-open .gv-modal-box {
  transform: scale(1);
}
.gv-modal-box h3 {
  margin: 0 0 var(--sp-4);
  font-family: var(--font-mono);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--c-fg-strong);
}

/* Form fields */
.gv-field {
  margin-bottom: var(--sp-4);
}
.gv-field label {
  display: block;
  font-size: var(--font-size-xs);
  color: var(--c-fg-muted);
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--sp-1);
}
.gv-field input[type="text"],
.gv-field textarea,
.gv-field select {
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg-sunken);
  color: var(--c-fg);
  font-size: var(--font-size-sm);
  font-family: var(--font-sans);
  outline: none;
  transition: border-color var(--transition);
  box-sizing: border-box;
}
.gv-field input:focus,
.gv-field textarea:focus,
.gv-field select:focus {
  border-color: var(--c-accent);
  box-shadow: 0 0 0 2px var(--c-accent-subtle);
}
.gv-field textarea { resize: vertical; min-height: 48px; }
.gv-range-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.gv-range-row input[type="range"] {
  flex: 1;
  accent-color: var(--c-accent);
  height: 4px;
}
.gv-range-val {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--c-fg-muted);
  min-width: 2em;
  text-align: right;
}
.gv-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}

/* ─── Bottom Action Bar ──────────────────────────────────────────────────── */
.gv-actions {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-4);
  background: var(--c-bg-raised);
  border-top: 1px solid var(--c-border);
  flex-shrink: 0;
}
.gv-action-btn {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--font-size-sm);
  flex: 1;
  justify-content: center;
  padding: var(--sp-2) var(--sp-3);
}
.gv-action-btn:not(:disabled):hover {
  color: var(--c-accent);
  border-color: var(--c-accent-muted);
}
.gv-action-danger:not(:disabled):hover {
  color: var(--c-error);
  border-color: var(--c-error);
}

/* ─── Back button override ───────────────────────────────────────────────── */
.gv-header .settings-back-btn {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--radius-sm);
  color: var(--c-fg-muted);
  font-size: var(--font-size-sm);
  text-decoration: none;
  transition: color var(--transition), background var(--transition);
  flex-shrink: 0;
}
.gv-header .settings-back-btn:hover {
  color: var(--c-accent);
  background: var(--c-accent-subtle);
}

/* ─── Toast ──────────────────────────────────────────────────────────────── */
#gv-toast-container {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  pointer-events: none;
}
.gv-toast {
  background: var(--c-bg-raised);
  border: 1px solid var(--c-border-strong);
  color: var(--c-fg);
  font-size: var(--font-size-sm);
  font-family: var(--font-sans);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: auto;
  max-width: 340px;
  text-align: center;
}
.gv-toast.gv-toast-visible {
  opacity: 1;
  transform: translateY(0);
}

/* ─── Mobile ─────────────────────────────────────────────────────────────── */
@media (max-width: 600px) {
  .gv-header { padding: var(--sp-2) var(--sp-3); }
  .gv-toolbar {
    flex-wrap: wrap;
    padding: var(--sp-2) var(--sp-3);
    gap: var(--sp-2);
  }
  .gv-toolbar-controls { order: 1; }
  .gv-search { order: 3; flex-basis: 100%; }
  .gv-filter { order: 2; flex: 1; max-width: none; }
  .gv-panel {
    width: 100%;
    max-width: 100vw;
    border-left: none;
    border-top: 1px solid var(--c-border);
    top: auto;
    bottom: 0;
    height: 55vh;
    transform: translateY(100%);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
  }
  .gv-panel.gv-panel-open { transform: translateY(0); }
  .gv-actions { padding: var(--sp-2) var(--sp-3); }
  .gv-action-btn span { display: none; }
  .gv-action-btn { flex: 0; padding: var(--sp-2); }
  .gv-stats { display: none; }
}
</style>
`;
}

// =============================================================================
// Appearance Settings Templates
// =============================================================================

/**
 * Render the Appearance Settings view.
 */
export function renderAppearanceSettings(): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Appearance</h1>
        <p class="settings-desc">Customize colors, background images, and visual effects</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <!-- Color Theme Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Color Theme</h3>
      <p class="theme-section-desc">Choose a predefined accent color or create your own</p>
      <div class="theme-grid" id="theme-grid">
        <button class="theme-swatch" data-theme="phosphor" title="Phosphor Green" style="--swatch-color: #39ff14">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Phosphor</span>
        </button>
        <button class="theme-swatch" data-theme="ocean" title="Ocean Blue" style="--swatch-color: #00d4ff">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Ocean</span>
        </button>
        <button class="theme-swatch" data-theme="sunset" title="Sunset Orange" style="--swatch-color: #ff6b35">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Sunset</span>
        </button>
        <button class="theme-swatch" data-theme="violet" title="Violet Dream" style="--swatch-color: #a855f7">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Violet</span>
        </button>
        <button class="theme-swatch" data-theme="rose" title="Rose" style="--swatch-color: #f43f5e">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Rose</span>
        </button>
        <button class="theme-swatch" data-theme="amber" title="Amber" style="--swatch-color: #f59e0b">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Amber</span>
        </button>
        <button class="theme-swatch" data-theme="mint" title="Mint" style="--swatch-color: #10b981">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Mint</span>
        </button>
        <button class="theme-swatch" data-theme="slate" title="Slate" style="--swatch-color: #64748b">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Slate</span>
        </button>
      </div>
    </section>

    <!-- Custom Color Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Custom Accent Color</h3>
      <p class="theme-section-desc">Enter a hex color or use the color picker</p>
      <div class="custom-color-input">
        <input type="color" id="custom-color-picker" class="color-picker" value="#39ff14">
        <input type="text" id="custom-color-hex" class="color-hex-input" placeholder="#39ff14" maxlength="7">
        <button class="btn btn--ghost btn--sm" onclick="Theme.reset()">Reset to Default</button>
      </div>
    </section>

    <!-- Background Image Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Background Image</h3>
      <p class="theme-section-desc">Add a background image for a personalized look</p>

      <div class="bg-controls">
        <div class="bg-url-input">
          <input type="url" id="bg-url" class="input-field" placeholder="Enter image URL...">
          <button class="btn btn--primary btn--sm" onclick="applyBackgroundUrl()">Apply URL</button>
        </div>

        <div class="bg-upload-area">
          <span class="bg-upload-label">Or upload an image:</span>
          <label class="btn btn--ghost btn--sm upload-btn">
            <input type="file" id="bg-file-input" accept="image/*" onchange="handleBackgroundUpload(this)" hidden>
            Choose File
          </label>
        </div>

        <div class="bg-gallery" id="bg-gallery">
          <!-- Populated by JS -->
        </div>

        <div class="bg-sliders">
          <div class="slider-group">
            <label for="bg-blur">Blur</label>
            <input type="range" id="bg-blur" min="0" max="50" value="0" oninput="updateBgBlur(this.value)">
            <span id="bg-blur-value">0px</span>
          </div>
          <div class="slider-group">
            <label for="bg-overlay">Overlay</label>
            <input type="range" id="bg-overlay" min="0" max="100" value="0" oninput="updateBgOverlay(this.value)">
            <span id="bg-overlay-value">0%</span>
          </div>
        </div>

        <button class="btn btn--ghost btn--sm" onclick="clearBackground()">Clear Background</button>
      </div>
    </section>

    <!-- Glass Effect Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Glass Effect</h3>
      <p class="theme-section-desc">Enable frosted glass effect on UI panels when background is active</p>
      <label class="toggle-label">
        <input type="checkbox" id="glass-toggle" onchange="toggleGlass(this.checked)">
        <span class="toggle-slider"></span>
        <span class="toggle-text">Enable Glass Effect</span>
      </label>
    </section>

  </div>
</div>

<style>
.theme-section {
  margin-bottom: var(--sp-6);
  padding: var(--sp-4);
  background: var(--c-bg-raised);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
}

.theme-section-title {
  margin: 0 0 var(--sp-1);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--c-fg);
}

.theme-section-desc {
  margin: 0 0 var(--sp-4);
  font-size: var(--font-size-sm);
  color: var(--c-fg-muted);
}

/* Theme swatch grid */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: var(--sp-3);
}

.theme-swatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--c-bg);
  border: 2px solid var(--c-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition);
}

.theme-swatch:hover {
  border-color: var(--swatch-color);
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.3);
}

.theme-swatch.active {
  border-color: var(--swatch-color);
  background: rgba(var(--swatch-color), 0.1);
  box-shadow: 0 0 12px var(--swatch-color);
}

.swatch-preview {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--swatch-color);
  box-shadow: 0 0 8px var(--swatch-color);
}

.swatch-name {
  font-size: var(--font-size-xs);
  color: var(--c-fg-muted);
  font-family: var(--font-sans);
}

/* Custom color input */
.custom-color-input {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.color-picker {
  width: 48px;
  height: 48px;
  padding: 0;
  border: 2px solid var(--c-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  background: transparent;
}

.color-picker::-webkit-color-swatch-wrapper {
  padding: 4px;
}

.color-picker::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}

.color-hex-input {
  width: 120px;
  padding: var(--sp-2) var(--sp-3);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-fg);
}

.color-hex-input:focus {
  outline: none;
  border-color: var(--c-accent);
  box-shadow: 0 0 0 2px var(--c-accent-subtle);
}

/* Background controls */
.bg-controls {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.bg-url-input {
  display: flex;
  gap: var(--sp-2);
}

.bg-url-input .input-field {
  flex: 1;
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--font-size-sm);
}

.bg-upload-area {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.bg-upload-label {
  font-size: var(--font-size-sm);
  color: var(--c-fg-muted);
}

.upload-btn {
  cursor: pointer;
}

/* Background gallery */
.bg-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: var(--sp-2);
  min-height: 0;
}

.bg-gallery-item {
  position: relative;
  aspect-ratio: 16/9;
  border-radius: var(--radius-sm);
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color var(--transition);
}

.bg-gallery-item:hover {
  border-color: var(--c-accent);
}

.bg-gallery-item.active {
  border-color: var(--c-accent);
  box-shadow: 0 0 8px var(--c-accent-glow);
}

.bg-gallery-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-gallery-item .delete-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
  border: none;
  border-radius: 50%;
  color: #ff4444;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition);
}

.bg-gallery-item:hover .delete-btn {
  opacity: 1;
}

/* Sliders */
.bg-sliders {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-3);
  background: var(--c-bg);
  border-radius: var(--radius-sm);
}

.slider-group {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.slider-group label {
  width: 60px;
  font-size: var(--font-size-sm);
  color: var(--c-fg-muted);
}

.slider-group input[type="range"] {
  flex: 1;
  height: 4px;
  background: var(--c-border);
  border-radius: 2px;
  outline: none;
  -webkit-appearance: none;
}

.slider-group input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  background: var(--c-accent);
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 8px var(--c-accent-glow);
}

.slider-group span {
  width: 40px;
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  color: var(--c-fg-muted);
  text-align: right;
}

/* Toggle */
.toggle-label {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  cursor: pointer;
}

.toggle-label input {
  display: none;
}

.toggle-slider {
  width: 44px;
  height: 24px;
  background: var(--c-border);
  border-radius: 12px;
  position: relative;
  transition: background var(--transition);
}

.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  background: var(--c-fg-muted);
  border-radius: 50%;
  transition: all var(--transition);
}

.toggle-label input:checked + .toggle-slider {
  background: var(--c-accent);
}

.toggle-label input:checked + .toggle-slider::after {
  transform: translateX(20px);
  background: #000;
}

.toggle-text {
  font-size: var(--font-size-sm);
  color: var(--c-fg);
}
</style>

<script>
// Initialize appearance settings from saved theme
(function() {
  const theme = Theme.get();

  // Update swatches
  document.querySelectorAll('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === theme.preset);
    el.onclick = () => {
      document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      Theme.setPreset(el.dataset.theme);
    };
  });

  // Update custom color
  const colorPicker = document.getElementById('custom-color-picker');
  const colorHex = document.getElementById('custom-color-hex');
  if (theme.customAccent) {
    colorPicker.value = theme.customAccent;
    colorHex.value = theme.customAccent;
  }
  colorPicker.oninput = () => {
    colorHex.value = colorPicker.value;
    document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
    Theme.setCustomAccent(colorPicker.value);
  };
  colorHex.onchange = () => {
    if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) {
      colorPicker.value = colorHex.value;
      document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      Theme.setCustomAccent(colorHex.value);
    }
  };

  // Update background controls
  const bgBlur = document.getElementById('bg-blur');
  const bgOverlay = document.getElementById('bg-overlay');
  const glassToggle = document.getElementById('glass-toggle');
  bgBlur.value = theme.bgBlur;
  bgOverlay.value = Math.round(theme.bgOverlayOpacity * 100);
  glassToggle.checked = theme.glassEnabled;
  document.getElementById('bg-blur-value').textContent = theme.bgBlur + 'px';
  document.getElementById('bg-overlay-value').textContent = Math.round(theme.bgOverlayOpacity * 100) + '%';

  // Load background gallery
  loadBackgroundGallery();
})();

function updateBgBlur(value) {
  document.getElementById('bg-blur-value').textContent = value + 'px';
  Theme.setBackgroundBlur(parseInt(value));
}

function updateBgOverlay(value) {
  document.getElementById('bg-overlay-value').textContent = value + '%';
  Theme.setBackgroundOverlay(parseInt(value) / 100);
}

function toggleGlass(enabled) {
  Theme.setGlassEnabled(enabled);
}

async function applyBackgroundUrl() {
  const url = document.getElementById('bg-url').value.trim();
  if (url) {
    Theme.setBackground(url);
    await loadBackgroundGallery();
  }
}

function handleBackgroundUpload(input) {
  if (input.files && input.files[0]) {
    uploadBackground(input.files[0]);
  }
}

async function uploadBackground(file) {
  const result = await Theme.uploadBackground(file);
  if (result.success) {
    Theme.setBackground(result.url);
    await loadBackgroundGallery();
  } else {
    alert('Upload failed: ' + result.error);
  }
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadBackgroundGallery() {
  const gallery = document.getElementById('bg-gallery');
  const backgrounds = await Theme.listBackgrounds();
  const currentTheme = Theme.get();

  gallery.innerHTML = backgrounds.map(bg => \`
    <div class="bg-gallery-item \${currentTheme.bgImage === bg.url ? 'active' : ''}" onclick="selectBackground('\${escapeAttr(bg.url)}')">
      <img src="\${escapeAttr(bg.url)}" alt="\${escapeAttr(bg.filename)}">
      <button class="delete-btn" onclick="event.stopPropagation(); deleteBackground('\${escapeAttr(bg.filename)}')" title="Delete">×</button>
    </div>
  \`).join('');
}

function selectBackground(url) {
  Theme.setBackground(url);
  document.querySelectorAll('.bg-gallery-item').forEach(el => {
    el.classList.toggle('active', el.querySelector('img').src === url);
  });
}

async function deleteBackground(filename) {
  if (confirm('Delete this background image?')) {
    const result = await Theme.deleteBackground(filename);
    if (result.success) {
      // Clear if it was active
      const theme = Theme.get();
      if (theme.bgImage && theme.bgImage.includes(filename)) {
        Theme.setBackground(null);
      }
      await loadBackgroundGallery();
    } else {
      alert('Delete failed: ' + result.error);
    }
  }
}

function clearBackground() {
  Theme.setBackground(null);
  document.getElementById('bg-url').value = '';
  document.querySelectorAll('.bg-gallery-item').forEach(el => el.classList.remove('active'));
}
</script>
`;
}

// =============================================================================
// LLM Settings Template
// =============================================================================

/**
 * Render the LLM settings view.
 */
export function renderLLMSettings(settings: LLMSettings): string {
  const maskedKey = maskApiKey(settings.apiKey);

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">LLM Settings</h1>
        <p class="settings-desc">Configure model connection, sampling parameters, and generation limits</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <!-- Connection Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Connection</h3>
      <p class="theme-section-desc">API endpoint, credentials, and model selection</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="llm-base-url">Base URL</label>
          <input type="url" id="llm-base-url" class="input-field llm-input" value="${escapeHtml(settings.baseUrl)}" placeholder="https://api.example.com/v1/chat/completions">
        </div>
        <div class="llm-field">
          <label for="llm-api-key">API Key</label>
          <div class="llm-api-key-row">
            <input type="password" id="llm-api-key" class="input-field llm-input" value="${escapeHtml(maskedKey)}" placeholder="Enter API key...">
            <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleApiKeyVisibility()" title="Show/hide key">
              <svg id="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="llm-field">
          <label for="llm-model">Model</label>
          <input type="text" id="llm-model" class="input-field llm-input" value="${escapeHtml(settings.model)}" placeholder="model-name">
        </div>
      </div>
    </section>

    <!-- Worker Model Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Worker Model</h3>
      <p class="theme-section-desc">Lighter model for auto-titling and summarization tasks</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="llm-worker-model">Worker Model</label>
          <input type="text" id="llm-worker-model" class="input-field llm-input" value="${escapeHtml(settings.workerModel)}" placeholder="lighter-model-name">
        </div>
      </div>
    </section>

    <!-- Sampling Parameters Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Sampling Parameters</h3>
      <p class="theme-section-desc">Control randomness and diversity of responses</p>
      <div class="llm-sliders">
        <div class="slider-group">
          <label for="llm-temperature">Temperature</label>
          <input type="range" id="llm-temperature" min="0" max="2" step="0.01" value="${settings.temperature}" oninput="document.getElementById('llm-temperature-val').textContent = this.value">
          <span id="llm-temperature-val">${settings.temperature}</span>
        </div>
        <div class="slider-group">
          <label for="llm-top-p">Top P</label>
          <input type="range" id="llm-top-p" min="0" max="1" step="0.01" value="${settings.topP}" oninput="document.getElementById('llm-top-p-val').textContent = this.value">
          <span id="llm-top-p-val">${settings.topP}</span>
        </div>
        <div class="llm-field-row">
          <div class="llm-field inline">
            <label for="llm-top-k">Top K <span class="label-hint">(0 = disabled)</span></label>
            <input type="number" id="llm-top-k" class="input-field llm-input sm" value="${settings.topK}" min="0" max="200" step="1">
          </div>
        </div>
        <div class="slider-group">
          <label for="llm-freq-penalty">Frequency Penalty</label>
          <input type="range" id="llm-freq-penalty" min="-2" max="2" step="0.01" value="${settings.frequencyPenalty}" oninput="document.getElementById('llm-freq-penalty-val').textContent = this.value">
          <span id="llm-freq-penalty-val">${settings.frequencyPenalty}</span>
        </div>
        <div class="slider-group">
          <label for="llm-pres-penalty">Presence Penalty</label>
          <input type="range" id="llm-pres-penalty" min="-2" max="2" step="0.01" value="${settings.presencePenalty}" oninput="document.getElementById('llm-pres-penalty-val').textContent = this.value">
          <span id="llm-pres-penalty-val">${settings.presencePenalty}</span>
        </div>
      </div>
    </section>

    <!-- Limits Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Generation Limits</h3>
      <p class="theme-section-desc">Maximum response length and context window</p>
      <div class="llm-fields">
        <div class="llm-field-row">
          <div class="llm-field inline">
            <label for="llm-max-tokens">Max Tokens</label>
            <input type="number" id="llm-max-tokens" class="input-field llm-input sm" value="${settings.maxTokens}" min="1" max="100000" step="1">
          </div>
          <div class="llm-field inline">
            <label for="llm-context-length">Context Window <span class="label-hint">(reference)</span></label>
            <input type="number" id="llm-context-length" class="input-field llm-input sm" value="${settings.contextLength}" min="1" max="1000000" step="1">
          </div>
        </div>
      </div>
    </section>

    <!-- Behavior Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Behavior</h3>
      <p class="theme-section-desc">Chain-of-thought and reasoning settings</p>
      <label class="toggle-label">
        <input type="checkbox" id="llm-thinking" ${settings.thinkingEnabled ? "checked" : ""}>
        <span class="toggle-slider"></span>
        <span class="toggle-text">Chain-of-Thought Reasoning</span>
      </label>
    </section>

    <!-- Actions -->
    <div class="llm-actions">
      <div class="llm-actions-left">
        <button class="btn btn--primary" onclick="saveLLMSettings()">Save Settings</button>
        <button class="btn btn--ghost" onclick="testLLMConnection()" id="test-connection-btn">Test Connection</button>
      </div>
      <button class="btn btn--ghost" onclick="resetLLMDefaults()">Reset to Defaults</button>
    </div>

    <!-- Status -->
    <div id="llm-status" class="llm-status" style="display:none;"></div>

  </div>
</div>

<style>
/* LLM Settings Form */
.llm-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.llm-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.llm-field label {
  font-size: var(--font-size-sm);
  color: var(--c-fg-muted);
  font-weight: var(--font-weight-medium);
}

.llm-field-row {
  display: flex;
  gap: var(--sp-4);
  flex-wrap: wrap;
}

.llm-field.inline {
  flex: 1;
  min-width: 150px;
}

.llm-input {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.llm-input.sm {
  max-width: 160px;
}

.llm-api-key-row {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}

.llm-api-key-row .llm-input {
  flex: 1;
}

.llm-toggle-key {
  flex-shrink: 0;
  color: var(--c-fg-muted);
}

.llm-toggle-key:hover {
  color: var(--c-accent);
}

.label-hint {
  font-weight: var(--font-weight-normal);
  color: var(--c-fg-subtle);
  font-size: var(--font-size-xs);
}

/* Sliders */
.llm-sliders {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.slider-group {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.slider-group label {
  font-size: var(--font-size-sm);
  color: var(--c-fg-muted);
  font-weight: var(--font-weight-medium);
  min-width: 140px;
}

.slider-group input[type="range"] {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--c-border);
  border-radius: 2px;
  outline: none;
}

.slider-group input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--c-accent);
  cursor: pointer;
  box-shadow: 0 0 6px var(--c-accent-glow);
}

.slider-group span {
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  color: var(--c-fg-muted);
  min-width: 40px;
  text-align: right;
}

/* Toggle switch */
.toggle-label {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  cursor: pointer;
}

.toggle-label input {
  display: none;
}

.toggle-slider {
  width: 44px;
  height: 24px;
  background: var(--c-border);
  border-radius: 12px;
  position: relative;
  transition: background var(--transition);
}

.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  background: var(--c-fg-muted);
  border-radius: 50%;
  transition: all var(--transition);
}

.toggle-label input:checked + .toggle-slider {
  background: var(--c-accent);
}

.toggle-label input:checked + .toggle-slider::after {
  transform: translateX(20px);
  background: #000;
}

.toggle-text {
  font-size: var(--font-size-sm);
  color: var(--c-fg);
}

/* Actions */
.llm-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--c-border);
  margin-top: var(--sp-4);
}

.llm-actions-left {
  display: flex;
  gap: var(--sp-2);
}

/* Status */
.llm-status {
  margin-top: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
}

.llm-status.success {
  background: rgba(57, 255, 20, 0.08);
  border: 1px solid rgba(57, 255, 20, 0.2);
  color: var(--c-accent);
}

.llm-status.error {
  background: rgba(255, 68, 68, 0.08);
  border: 1px solid rgba(255, 68, 68, 0.2);
  color: var(--c-error);
}

.llm-status.loading {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
  color: var(--c-fg-muted);
}
</style>

<script>
let apiKeyVisible = false;

function toggleApiKeyVisibility() {
  const input = document.getElementById('llm-api-key');
  if (!input) return;
  apiKeyVisible = !apiKeyVisible;
  input.type = apiKeyVisible ? 'text' : 'password';
}

function gatherSettings() {
  return {
    baseUrl: document.getElementById('llm-base-url').value.trim(),
    apiKey: document.getElementById('llm-api-key').value.trim(),
    model: document.getElementById('llm-model').value.trim(),
    workerModel: document.getElementById('llm-worker-model').value.trim(),
    temperature: parseFloat(document.getElementById('llm-temperature').value),
    topP: parseFloat(document.getElementById('llm-top-p').value),
    topK: parseInt(document.getElementById('llm-top-k').value) || 0,
    frequencyPenalty: parseFloat(document.getElementById('llm-freq-penalty').value),
    presencePenalty: parseFloat(document.getElementById('llm-pres-penalty').value),
    maxTokens: parseInt(document.getElementById('llm-max-tokens').value) || 4096,
    contextLength: parseInt(document.getElementById('llm-context-length').value) || 128000,
    thinkingEnabled: document.getElementById('llm-thinking').checked,
  };
}

function showStatus(type, message) {
  const el = document.getElementById('llm-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = message;
}

async function saveLLMSettings() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  showStatus('loading', 'Saving settings...');

  try {
    const settings = gatherSettings();
    const resp = await fetch('/api/llm-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus('success', 'Settings saved successfully.');
    } else {
      showStatus('error', 'Failed to save: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showStatus('error', 'Failed to save: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

async function testLLMConnection() {
  const btn = document.getElementById('test-connection-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Testing...';
  showStatus('loading', 'Sending test request...');

  try {
    const settings = gatherSettings();
    const resp = await fetch('/api/llm-settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus('success', 'Connection successful! (' + data.latency + 'ms)');
    } else {
      showStatus('error', 'Connection failed: ' + (data.error || 'Unknown error') + (data.latency ? ' (' + data.latency + 'ms)' : ''));
    }
  } catch (e) {
    showStatus('error', 'Connection failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

async function resetLLMDefaults() {
  if (!confirm('Reset all LLM settings to defaults? This will reload values from your .env file.')) return;
  showStatus('loading', 'Resetting...');

  try {
    const resp = await fetch('/api/llm-settings');
    const current = await resp.json();

    // Clear saved settings by saving the current env-based defaults
    // We just reload the page to pick up fresh values
    const settings = gatherSettings();
    // Reset to a known-good set - just reload the page
    window.location.reload();
  } catch (e) {
    showStatus('error', 'Failed to reset: ' + e.message);
  }
}
</script>
`;
}
