/**
 * HTML Templates
 *
 * Server-side template functions for rendering HTML components.
 * Used by routes to serve HTMX-compatible HTML fragments.
 *
 * @module
 */

import type { Conversation, Message, ToolCall, ToolResult } from "../types.ts";

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
  const accentColor = Deno.env.get("SBY_ACCENT_COLOR");
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
  <title>SBy</title>
  <link rel="stylesheet" href="/css/main.css?v=6">
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
      <div class="sidebar-overlay" onclick="SBy.toggleSidebar()"></div>
      ${renderSidebar([])}
      <div class="chat" id="chat">
        ${renderEmptyState()}
        ${renderInputArea()}
      </div>
    </div>
  </div>
  <script type="module" src="/js/sby.js?v=6"></script>
</body>
</html>`;
}

/**
 * Render the header component.
 */
export function renderHeader(): string {
  return `<header class="header">
  <div class="header-left">
    <button class="sidebar-toggle" onclick="SBy.toggleSidebar()" aria-label="Toggle sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12h18M3 6h18M3 18h18"/>
      </svg>
    </button>
    <div class="logo">SBy<span class="logo-sub" id="header-title">Strauberry Tavern</span></div>
  </div>
</header>`;
}

/**
 * Render just the header title/subtitle text.
 * Returns the conversation title if available, otherwise "Untitled".
 * Note: "Strauberry Tavern" is shown when no conversation is selected,
 * which is handled by the initial template and newConversation() in JS.
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
    <button class="btn btn--primary btn--sm" onclick="SBy.newConversation()">+ New</button>
  </div>
  <nav class="conv-list" id="conv-list" hx-get="/fragments/conv-list" hx-trigger="load" hx-swap="innerHTML">
    ${renderConversationList(conversations)}
  </nav>
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
 * Render a single conversation list item.
 */
export function renderConversationItem(
  conv: Conversation,
  isActive = false
): string {
  const title = escapeHtml(conv.title || "Untitled");
  const date = formatDate(conv.updatedAt || conv.createdAt);

  return `<a class="conv-item${isActive ? " active" : ""}"
  data-conv-id="${conv.id}"
  hx-get="/fragments/chat/${conv.id}"
  hx-target="#chat"
  hx-swap="innerHTML"
  hx-push-url="/c/${conv.id}"
  onclick="SBy.selectConversation('${conv.id}')">
  <span class="conv-title">${title}</span>
  <span class="conv-date">${date}</span>
</a>`;
}

// =============================================================================
// Chat View Templates
// =============================================================================

/**
 * Render the chat view for a conversation.
 * Includes messages and input area.
 */
export function renderChatView(messages: Message[]): string {
  return `<div class="messages" id="messages">
  ${messages.length === 0 ? "" : renderMessages(messages)}
</div>
${renderInputArea()}`;
}

/**
 * Render all messages.
 */
export function renderMessages(messages: Message[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => renderMessage(m))
    .join("");
}

/**
 * Render a single message based on role.
 */
export function renderMessage(msg: Message): string {
  if (msg.role === "user") {
    return renderUserMessage(msg.content);
  } else if (msg.role === "assistant") {
    return renderAssistantMessage(msg);
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
 * Render an assistant message with optional thinking and tool calls.
 */
export function renderAssistantMessage(msg: Message): string {
  let html = `<div class="msg msg--assistant">
  <div class="msg-header">Assistant</div>
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
 * Render the empty state when no conversation is selected.
 */
export function renderEmptyState(): string {
  return `<div class="messages" id="messages">
  <div class="empty-state" id="empty-state">
    <div class="empty-title">SBy</div>
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
      onkeydown="SBy.handleKeyDown(event)"
      oninput="SBy.autoResize(this)"
    ></textarea>
    <button class="send-btn" id="send-btn" onclick="SBy.sendMessage()">Send</button>
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
  try {
    const parsed = JSON.parse(args);
    if (parsed.command) {
      // For shell commands, show abbreviated command
      const cmd = parsed.command as string;
      summary = cmd.length > 50 ? cmd.substring(0, 50) + "..." : cmd;
    }
  } catch {
    // Keep summary empty
  }

  // Try to format JSON for expanded view
  try {
    args = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    // Keep as-is
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

  // Try to format JSON
  try {
    if (content.startsWith("{") || content.startsWith("[")) {
      content = JSON.stringify(JSON.parse(content), null, 2);
    }
  } catch {
    // Keep as-is
  }

  return `<div class="tool-result${isError ? " error" : ""}">
  <div class="tool-result-label">${isError ? "Error" : "Output"}</div>
  ${escapeHtml(content)}
</div>`;
}

/**
 * Render a status message.
 */
export function renderStatus(message: string): string {
  return `<div class="status">${escapeHtml(message)}</div>`;
}

/**
 * Render an error toast.
 */
export function renderToast(message: string): string {
  return `<div class="toast">${escapeHtml(message)}</div>`;
}
