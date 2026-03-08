/**
 * Psycheros Client JavaScript
 * Handles SSE streaming, sidebar toggle, input management, and service worker.
 */

// =============================================================================
// State
// =============================================================================

let currentConversationId = null;
let isStreaming = false;
const pendingToolCalls = new Map();
let currentAbortController = null;
let persistentSSE = null;

// Selection mode state
let selectionMode = false;
const selectedConversations = new Set();
let pendingDeleteIds = null;

// Touch/swipe state
const touchState = {
  wrapper: null,
  startX: 0,
  startY: 0,
  currentX: 0,
  isDragging: false,
  longPressTimer: null,
};

// Context viewer state
let contextViewerOpen = false;
let currentContext = null;

// =============================================================================
// Persistent SSE Connection
// =============================================================================

/**
 * Initialize or reconnect the persistent SSE connection.
 * This connection receives DOM updates from background operations.
 */
function initPersistentSSE() {
  // Close existing connection if any
  if (persistentSSE) {
    persistentSSE.close();
    persistentSSE = null;
  }

  // Build URL with optional conversation filter
  const url = currentConversationId
    ? `/api/events?conversationId=${currentConversationId}`
    : '/api/events';

  persistentSSE = new EventSource(url);

  persistentSSE.addEventListener('connected', (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Persistent SSE connected:', data.clientId);
    } catch (e) {
      console.warn('Failed to parse connected event:', e);
    }
  });

  persistentSSE.addEventListener('dom_update', (event) => {
    try {
      const update = JSON.parse(event.data);
      const target = document.querySelector(update.target);
      if (target) {
        htmx.swap(target, update.html, { swapStyle: update.swap || 'innerHTML' });
      }
    } catch (e) {
      console.error('Failed to handle dom_update:', e);
    }
  });

  persistentSSE.onerror = (error) => {
    console.warn('Persistent SSE error, will reconnect:', error);
    // EventSource automatically reconnects on error
  };
}

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  }

  // Check if URL has a conversation ID (e.g., /c/abc123)
  const match = globalThis.location.pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    const conversationId = match[1];
    currentConversationId = conversationId;
    loadConversationFromUrl(conversationId);
  }

  // Initialize persistent SSE connection for background updates
  initPersistentSSE();

  // Event delegation for conversation list clicks
  // This avoids inline onclick handlers (XSS prevention)
  document.addEventListener('click', (e) => {
    // Handle checkbox clicks in selection mode
    if (e.target.classList.contains('conv-select-checkbox')) {
      const wrapper = e.target.closest('.conv-item-wrapper');
      if (wrapper) {
        toggleSelection(wrapper);
      }
      return;
    }

    const convItem = e.target.closest('.conv-item[data-conv-id]');
    if (convItem) {
      // In selection mode, toggle selection instead of navigating
      if (selectionMode) {
        e.preventDefault();
        const wrapper = convItem.closest('.conv-item-wrapper');
        if (wrapper) {
          toggleSelection(wrapper);
        }
        return;
      }

      const id = convItem.dataset.convId;
      if (id) {
        selectConversation(id);
      }
    }
  });

  // Right-click for selection mode (desktop)
  document.addEventListener('contextmenu', (e) => {
    const wrapper = e.target.closest('.conv-item-wrapper');
    if (wrapper) {
      e.preventDefault();
      enterSelectionMode(wrapper);
    }
  });

  // ESC key exits selection mode or closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('.modal-backdrop.visible')) {
        closeDeleteModal();
      } else if (selectionMode) {
        exitSelectionMode();
      }
    }
  });

  // Initialize touch handlers for swipe
  initConversationTouchHandlers();

  // Create selection bar and modal containers
  createUIContainers();

  // Focus input on load
  const input = document.getElementById('message-input');
  if (input) {
    input.focus();
  }

  // Scroll to bottom when chat content is swapped via HTMX (sidebar clicks)
  document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.detail.target.id === 'chat') {
      scrollToBottom();
    }
  });
});

// =============================================================================
// Sidebar
// =============================================================================

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');

  sidebar?.classList.toggle('open');
  overlay?.classList.toggle('open');
}

/**
 * Close sidebar after navigation (for settings links).
 */
function closeSidebarAfterNav() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');

  if (sidebar?.classList.contains('open')) {
    sidebar.classList.remove('open');
    overlay?.classList.remove('open');
  }
}

// =============================================================================
// Conversations
// =============================================================================

/**
 * Load a conversation from URL on initial page load.
 * Called when user navigates directly to /c/:id
 */
async function loadConversationFromUrl(conversationId) {
  currentConversationId = conversationId;

  try {
    // Fetch the chat fragment from the dedicated fragment endpoint
    const response = await fetch(`/fragments/chat/${conversationId}`);

    if (!response.ok) {
      if (response.status === 404) {
        showToast('Conversation not found');
        history.replaceState({}, '', '/');
        return;
      }
      throw new Error('Failed to load conversation');
    }

    const html = await response.text();

    // Parse the response to extract OOB elements
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Handle header title OOB swap
    const headerTitleOob = doc.querySelector('#header-title[hx-swap-oob]');
    if (headerTitleOob) {
      const headerTitle = document.getElementById('header-title');
      if (headerTitle) {
        headerTitle.innerHTML = headerTitleOob.innerHTML;
      }
      headerTitleOob.remove();
    }

    // Set the chat content (without OOB elements)
    const chat = document.getElementById('chat');
    if (chat) {
      chat.innerHTML = doc.body.innerHTML;
    }

    // Scroll to bottom to show most recent messages
    scrollToBottom();

    // Mark as active in sidebar after it loads
    // Use a small delay to wait for the sidebar conversation list to load
    setTimeout(() => {
      document.querySelectorAll('.conv-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.convId === conversationId);
      });
    }, 500);

    // Focus input
    document.getElementById('message-input')?.focus();

  } catch (error) {
    console.error('Failed to load conversation:', error);
    showToast('Failed to load conversation');
  }
}

async function newConversation() {
  try {
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      throw new Error('Failed to create conversation');
    }

    const conversation = await response.json();
    currentConversationId = conversation.id;

    // Reconnect persistent SSE for the new conversation
    initPersistentSSE();

    // Reset header title to default
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) {
      headerTitle.textContent = 'Psycheros';
    }

    // Reload conversation list
    htmx.trigger('#conv-list', 'load');

    // Clear chat and show empty state with input area
    const chat = document.getElementById('chat');
    if (chat) {
      chat.innerHTML = `
        <div class="messages" id="messages">
          <div class="empty-state" id="empty-state">
            <div class="empty-title">Psycheros</div>
            <p class="empty-text">What's on your mind?</p>
          </div>
        </div>
        <div class="input-area">
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
        </div>
      `;
    }

    // Update URL
    history.pushState({}, '', `/c/${conversation.id}`);

    // Close sidebar
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar?.classList.contains('open')) {
      sidebar.classList.remove('open');
      overlay?.classList.remove('open');
    }

    // Focus input
    document.getElementById('message-input')?.focus();

  } catch (error) {
    console.error('Failed to create conversation:', error);
    showToast('Failed to create conversation');
  }
}

function selectConversation(id) {
  // Abort any in-progress stream
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  // Reset state
  isStreaming = false;
  pendingToolCalls.clear();
  currentConversationId = id;

  // Reconnect persistent SSE for the new conversation
  initPersistentSSE();

  // Update active state in list
  document.querySelectorAll('.conv-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.convId === id);
  });

  // Re-enable input and restore send button
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  if (input) input.disabled = false;
  if (sendBtn) {
    sendBtn.textContent = 'Send';
    sendBtn.onclick = Psycheros.sendMessage;
    sendBtn.classList.remove('stop-btn');
    sendBtn.classList.add('send-btn');
    sendBtn.disabled = false;
  }

  // Close sidebar after selecting conversation
  toggleSidebar();
}

// =============================================================================
// Input Handling
// =============================================================================

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// Track if stop button has been pressed once (for double-tap confirmation)
let stopConfirmed = false;

/**
 * Handle first tap on stop button - require confirmation.
 * Shows a red confirm state, then stops on second tap.
 */
function requestStopGeneration() {
  const sendBtn = document.getElementById('send-btn');
  if (!sendBtn || !isStreaming) return;

  if (stopConfirmed) {
    // Second tap - actually stop
    stopGeneration();
  } else {
    // First tap - show confirmation state (orange warning)
    stopConfirmed = true;
    sendBtn.innerHTML = '<span class="stop-icon">&#9888;</span> Tap again';
    sendBtn.classList.add('stop-confirm');

    // Reset confirmation after 3 seconds if not tapped again
    setTimeout(() => {
      if (stopConfirmed && isStreaming) {
        stopConfirmed = false;
        sendBtn.innerHTML = '<span class="stop-icon">&#9888;</span> Stop';
        sendBtn.classList.remove('stop-confirm');
      }
    }, 3000);
  }
}

/**
 * Stop the current generation by aborting the request.
 * This prevents the partial assistant message from being persisted.
 */
function stopGeneration() {
  if (currentAbortController && isStreaming) {
    currentAbortController.abort();
    currentAbortController = null;
    stopConfirmed = false;
    // The finally block in sendMessage will handle cleanup
  }
}

// =============================================================================
// Messaging
// =============================================================================

async function sendMessage() {
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const message = input?.value.trim();

  if (!message || isStreaming) return;

  // Create conversation if needed
  if (!currentConversationId) {
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const conversation = await response.json();
      currentConversationId = conversation.id;
      htmx.trigger('#conv-list', 'load');
      history.pushState({}, '', `/c/${conversation.id}`);
    } catch (_error) {
      showToast('Failed to create conversation');
      return;
    }
  }

  // Clear input and disable
  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;

  // Switch send button to stop button (requires double-tap)
  stopConfirmed = false;
  sendBtn.innerHTML = '<span class="stop-icon">&#9888;</span> Stop';
  sendBtn.onclick = Psycheros.requestStopGeneration;
  sendBtn.classList.add('stop-btn');
  sendBtn.classList.remove('send-btn', 'stop-confirm');
  sendBtn.disabled = false; // Enable so user can click stop

  isStreaming = true;

  // Remove empty state if present
  document.getElementById('empty-state')?.remove();

  // Add user message
  const messages = document.getElementById('messages');
  if (messages) {
    messages.insertAdjacentHTML('beforeend', `
      <div class="msg msg--user">
        <div class="msg-header">You</div>
        <div class="msg-content">${escapeHtml(message)}</div>
      </div>
    `);
  }

  // Create assistant message container
  const assistantEl = document.createElement('div');
  assistantEl.className = 'msg msg--assistant';
  assistantEl.innerHTML = `
    <div class="msg-header">
      Assistant
      <div class="streaming"><span></span><span></span><span></span></div>
    </div>
    <div class="msg-content"></div>
  `;
  messages?.appendChild(assistantEl);
  scrollToBottom();

  let currentThinking = null;
  let currentContent = null;
  let currentRawContent = ""; // Buffer for raw markdown during streaming

  // Create abort controller
  currentAbortController = new AbortController();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: currentConversationId,
        message: message
      }),
      signal: currentAbortController.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events - accumulate data lines and dispatch on blank line
      // Per SSE spec, multiple data: lines should be joined with newlines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEventType = 'content';
      let dataLines = [];

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }

        if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
          continue;
        }

        // Empty line signals end of event - dispatch accumulated data
        if (line === '' && dataLines.length > 0) {
          const data = dataLines.join('\n');
          handleSSEEvent(currentEventType, data, assistantEl, {
            getThinking: () => currentThinking,
            setThinking: (el) => currentThinking = el,
            getContent: () => currentContent,
            setContent: (el) => currentContent = el,
            getRawContent: () => currentRawContent,
            setRawContent: (text) => currentRawContent = text,
            appendRawContent: (text) => currentRawContent += text
          });
          currentEventType = 'content';
          dataLines = [];
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Request aborted by user');
      // Show stopped indicator
      const stoppedEl = document.createElement('div');
      stoppedEl.className = 'stopped-indicator';
      stoppedEl.textContent = '[Stopped]';
      assistantEl.querySelector('.msg-content')?.appendChild(stoppedEl);
      return;
    }

    console.error('Stream error:', error);
    showToast('Failed to send message: ' + error.message);

    const errorEl = document.createElement('div');
    errorEl.style.color = 'var(--c-error)';
    errorEl.textContent = 'Error: ' + error.message;
    assistantEl.querySelector('.msg-content')?.appendChild(errorEl);

  } finally {
    // Remove streaming indicator
    assistantEl.querySelector('.streaming')?.remove();

    // Clear state
    pendingToolCalls.clear();
    currentAbortController = null;
    currentRawContent = ""; // Reset markdown buffer

    // Re-enable input
    if (input) input.disabled = false;

    // Restore send button from stop button
    if (sendBtn) {
      sendBtn.textContent = 'Send';
      sendBtn.onclick = Psycheros.sendMessage;
      sendBtn.classList.remove('stop-btn', 'stop-confirm');
      sendBtn.classList.add('send-btn');
      sendBtn.disabled = false;
    }

    isStreaming = false;
    input?.focus();
  }
}

// =============================================================================
// SSE Event Handling
// =============================================================================

function handleSSEEvent(eventType, data, messageEl, state) {
  const contentContainer = messageEl.querySelector('.msg-content');

  switch (eventType) {
    case 'thinking':
      if (!state.getThinking()) {
        const thinkingSection = document.createElement('div');
        thinkingSection.className = 'thinking expanded';
        thinkingSection.innerHTML = `
          <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="thinking-toggle">&#9660;</span>
            <span>Thinking</span>
          </div>
          <div class="thinking-content"></div>
        `;
        contentContainer.insertBefore(thinkingSection, contentContainer.firstChild);
        state.setThinking(thinkingSection.querySelector('.thinking-content'));
      }
      state.getThinking().textContent += data;
      break;

    case 'content':
      if (!state.getContent()) {
        const contentEl = document.createElement('div');
        contentEl.className = 'assistant-text';
        contentContainer.appendChild(contentEl);
        state.setContent(contentEl);
      }
      // Store raw markdown and show it during streaming
      state.appendRawContent(data);
      state.getContent().textContent += data;
      break;

    case 'tool_call':
      try {
        const toolCall = JSON.parse(data);
        const toolCard = createToolCard(toolCall);
        toolCard.dataset.toolCallId = toolCall.id;
        pendingToolCalls.set(toolCall.id, toolCard);
        contentContainer.appendChild(toolCard);
        state.setContent(null);
      } catch (e) {
        console.error('Failed to parse tool call:', e);
      }
      break;

    case 'tool_result':
      try {
        const result = JSON.parse(data);
        const toolCard = pendingToolCalls.get(result.toolCallId);
        if (toolCard) {
          addToolResult(toolCard, result.content, result.isError);
          pendingToolCalls.delete(result.toolCallId);
        }
      } catch (e) {
        console.error('Failed to parse tool result:', e);
      }
      break;

    case 'dom_update':
      try {
        const update = JSON.parse(data);
        const target = document.querySelector(update.target);
        if (target) {
          htmx.swap(target, update.html, { swapStyle: update.swap || 'innerHTML' });
        }
      } catch (e) {
        console.error('Failed to handle dom_update:', e);
      }
      break;

    case 'status': {
      const statusEl = document.createElement('div');
      statusEl.className = 'status';
      statusEl.textContent = data;
      contentContainer.appendChild(statusEl);
      break;
    }

    case 'metrics':
      try {
        const metrics = JSON.parse(data);
        const indicator = createMetricsIndicator(metrics);
        const header = messageEl.querySelector('.msg-header');
        if (header) {
          // Replace existing indicator to avoid duplicates from multi-iteration turns
          const existing = header.querySelector('.metrics-indicator');
          if (existing) {
            existing.remove();
          }
          header.appendChild(indicator);
        }
      } catch (e) {
        console.error('Failed to parse metrics:', e);
      }
      break;

    case 'context':
      try {
        currentContext = JSON.parse(data);
        if (contextViewerOpen) {
          renderContextViewer();
        }
      } catch (e) {
        console.error('Failed to parse context:', e);
      }
      break;

    case 'done':
      // Collapse all thinking and tool sections after streaming completes
      contentContainer.querySelectorAll('.thinking.expanded, .tool.expanded').forEach(el => {
        el.classList.remove('expanded');
      });
      // Render markdown in content element after streaming completes
      const contentEl = state.getContent();
      const rawContent = state.getRawContent();
      if (contentEl && rawContent) {
        try {
          const parsedHtml = marked.parse(rawContent);
          contentEl.innerHTML = DOMPurify.sanitize(parsedHtml);
        } catch (e) {
          console.error('Failed to parse markdown:', e);
          // Fallback: keep raw text
        }
      }
      break;
  }

  scrollToBottom();
}

// =============================================================================
// DOM Helpers
// =============================================================================

function createToolCard(toolCall) {
  const card = document.createElement('div');
  card.className = 'tool expanded';

  const name = toolCall.function?.name || toolCall.name || 'unknown';
  const rawArgs = toolCall.function?.arguments || toolCall.arguments || '{}';
  let args = rawArgs;

  // Generate brief summary for collapsed state
  let summary = '';
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed.command) {
      const cmd = parsed.command;
      summary = cmd.length > 50 ? cmd.substring(0, 50) + '...' : cmd;
    }
  } catch {
    // Keep summary empty
  }

  // Format JSON for expanded view
  try {
    if (typeof args === 'string') {
      args = JSON.stringify(JSON.parse(args), null, 2);
    } else {
      args = JSON.stringify(args, null, 2);
    }
  } catch {
    // Keep as-is
  }

  card.innerHTML = `
    <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-icon">&#9881;</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ''}
      <span class="tool-toggle">&#9660;</span>
    </div>
    <div class="tool-args">${escapeHtml(args)}</div>
  `;

  return card;
}

function addToolResult(card, content, isError = false) {
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-result' + (isError ? ' error' : '');

  let displayContent = content;
  try {
    if (typeof content === 'string' && (content.startsWith('{') || content.startsWith('['))) {
      displayContent = JSON.stringify(JSON.parse(content), null, 2);
    }
  } catch {
    // Keep as-is
  }

  resultEl.innerHTML = `
    <div class="tool-result-label">${isError ? 'Error' : 'Output'}</div>
    ${escapeHtml(displayContent)}
  `;

  card.appendChild(resultEl);
}

function scrollToBottom() {
  const messages = document.getElementById('messages');
  if (messages) {
    messages.scrollTop = messages.scrollHeight;
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 5000);
}

// =============================================================================
// Metrics Display
// =============================================================================

/**
 * Format milliseconds as a human-readable string.
 * @param {number|null} ms - Milliseconds to format
 * @returns {string} Formatted string (e.g., "1.2s", "850ms", "-")
 */
function formatMs(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms >= 1000) {
    return (ms / 1000).toFixed(1) + 's';
  }
  return Math.round(ms) + 'ms';
}

/**
 * Get CSS class for a metric value based on thresholds.
 * @param {string} metric - Metric name
 * @param {number|null} value - Metric value
 * @returns {string} CSS class name
 */
function getMetricClass(metric, value) {
  if (value === null || value === undefined) return '';

  switch (metric) {
    case 'ttfb':
      if (value > 2000) return 'slow';
      if (value > 1000) return 'warning';
      return '';
    case 'ttfc':
      if (value > 3000) return 'slow';
      if (value > 2000) return 'warning';
      return '';
    case 'maxChunkGap':
      if (value > 1000) return 'slow';
      if (value > 500) return 'warning';
      return '';
    case 'slowChunkCount':
      if (value > 5) return 'slow';
      if (value > 0) return 'warning';
      return '';
    default:
      return '';
  }
}

// Global click listener to handle metrics tooltip toggle and close (event delegation)
document.addEventListener('click', (e) => {
  const clickedIndicator = e.target.closest('.metrics-indicator');

  if (clickedIndicator) {
    // Close all other expanded indicators
    document.querySelectorAll('.metrics-indicator.expanded').forEach(el => {
      if (el !== clickedIndicator) {
        el.classList.remove('expanded');
      }
    });
    // Toggle the clicked indicator
    clickedIndicator.classList.toggle('expanded');
    return;
  }

  // Click outside - close all expanded metrics tooltips
  document.querySelectorAll('.metrics-indicator.expanded').forEach(el => {
    el.classList.remove('expanded');
  });
});

/**
 * Create the metrics indicator element with tooltip.
 * @param {Object} metrics - The TurnMetrics object
 * @returns {HTMLElement} The metrics indicator element
 */
function createMetricsIndicator(metrics) {
  const indicator = document.createElement('div');
  indicator.className = 'metrics-indicator';

  indicator.onclick = (e) => {
    e.stopPropagation();
    // Close any other expanded indicators first
    document.querySelectorAll('.metrics-indicator.expanded').forEach(el => {
      if (el !== indicator) {
        el.classList.remove('expanded');
      }
    });
    indicator.classList.toggle('expanded');
  };

  // Summary shows total duration
  const summary = formatMs(metrics.totalDuration);

  // Build tooltip rows
  const rows = [
    { label: 'TTFB', value: metrics.ttfb, metric: 'ttfb' },
    { label: 'TTFC', value: metrics.ttfc, metric: 'ttfc' },
    { label: 'Max Gap', value: metrics.maxChunkGap, metric: 'maxChunkGap' },
    { label: 'Slow Chunks', value: metrics.slowChunkCount, metric: 'slowChunkCount', raw: true },
    { label: 'Total', value: metrics.totalDuration, metric: 'total' },
    { label: 'Chunks', value: metrics.chunkCount, metric: 'chunks', raw: true },
  ];

  const tooltipRows = rows.map(row => {
    const valueClass = getMetricClass(row.metric, row.value);
    const displayValue = row.raw ? (row.value ?? '-') : formatMs(row.value);
    return `<div class="metrics-row">
      <span class="metrics-label">${row.label}</span>
      <span class="metrics-value ${valueClass}">${displayValue}</span>
    </div>`;
  }).join('');

  indicator.innerHTML = `
    <span class="metrics-indicator-icon">&#9201;</span>
    <span class="metrics-indicator-summary">${summary}</span>
    <div class="metrics-tooltip">${tooltipRows}</div>
  `;

  return indicator;
}

// =============================================================================
// UI Containers
// =============================================================================

/**
 * Create the selection bar and modal containers on page load.
 */
function createUIContainers() {
  // Selection bar
  if (!document.getElementById('selection-bar')) {
    const bar = document.createElement('div');
    bar.id = 'selection-bar';
    bar.className = 'selection-bar';
    bar.innerHTML = `
      <span class="selection-count"><span id="selection-count-num">0</span> selected</span>
      <button class="btn btn--ghost" onclick="Psycheros.exitSelectionMode()">Cancel</button>
      <button class="btn btn--danger" onclick="Psycheros.deleteSelected()">Delete</button>
    `;
    document.body.appendChild(bar);
  }

  // Modal backdrop
  if (!document.getElementById('modal-backdrop')) {
    const backdrop = document.createElement('div');
    backdrop.id = 'modal-backdrop';
    backdrop.className = 'modal-backdrop';
    backdrop.onclick = (e) => {
      if (e.target === backdrop) closeDeleteModal();
    };
    backdrop.innerHTML = `
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-title">Delete Conversation</div>
        <div class="modal-message" id="modal-message">Are you sure you want to delete this conversation?</div>
        <div class="modal-actions">
          <button class="btn btn--ghost" onclick="Psycheros.closeDeleteModal()">Cancel</button>
          <button class="btn btn--danger" onclick="Psycheros.confirmDelete()">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
  }
}

// =============================================================================
// Touch/Swipe Handlers
// =============================================================================

const SWIPE_THRESHOLD = 60;
const LONG_PRESS_DURATION = 500;

/**
 * Initialize touch event handlers for conversation list swipe.
 */
function initConversationTouchHandlers() {
  const convList = document.getElementById('conv-list');
  if (!convList) return;

  convList.addEventListener('touchstart', handleConvTouchStart, { passive: true });
  convList.addEventListener('touchmove', handleConvTouchMove, { passive: false });
  convList.addEventListener('touchend', handleConvTouchEnd);
  convList.addEventListener('touchcancel', handleConvTouchCancel);
}

function handleConvTouchStart(e) {
  const wrapper = e.target.closest('.conv-item-wrapper');
  if (!wrapper || selectionMode) return;

  const touch = e.touches[0];
  touchState.wrapper = wrapper;
  touchState.startX = touch.clientX;
  touchState.startY = touch.clientY;
  touchState.currentX = 0;
  touchState.isDragging = false;

  // Start long press timer for selection mode
  touchState.longPressTimer = setTimeout(() => {
    if (!touchState.isDragging && touchState.wrapper) {
      enterSelectionMode(touchState.wrapper);
      touchState.wrapper = null;
    }
  }, LONG_PRESS_DURATION);
}

function handleConvTouchMove(e) {
  if (!touchState.wrapper) return;

  const touch = e.touches[0];
  const deltaX = touch.clientX - touchState.startX;
  const deltaY = touch.clientY - touchState.startY;

  // Cancel long press if moving
  if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
    clearTimeout(touchState.longPressTimer);
  }

  // If vertical scroll is more prominent, don't start horizontal swipe
  if (!touchState.isDragging && Math.abs(deltaY) > Math.abs(deltaX)) {
    return;
  }

  // Start dragging if horizontal movement is significant
  if (!touchState.isDragging && Math.abs(deltaX) > 10) {
    touchState.isDragging = true;
    clearTimeout(touchState.longPressTimer);
  }

  if (touchState.isDragging) {
    e.preventDefault();
    touchState.currentX = deltaX;

    const convItem = touchState.wrapper.querySelector('.conv-item');
    if (convItem) {
      // Clamp the translation
      const clampedX = Math.max(-SWIPE_THRESHOLD * 1.5, Math.min(SWIPE_THRESHOLD * 1.5, deltaX));
      convItem.style.transform = `translateX(${clampedX}px)`;

      // Update swipe direction classes
      touchState.wrapper.classList.toggle('swiping-left', deltaX < -10);
      touchState.wrapper.classList.toggle('swiping-right', deltaX > 10);
    }
  }
}

function handleConvTouchEnd(_e) {
  clearTimeout(touchState.longPressTimer);

  if (!touchState.wrapper) return;

  const wrapper = touchState.wrapper;
  const convItem = wrapper.querySelector('.conv-item');
  const convId = wrapper.dataset.convId;

  if (touchState.isDragging && convItem) {
    // Reset transform with animation
    convItem.style.transform = '';
    wrapper.classList.remove('swiping-left', 'swiping-right');

    // Check if swipe was past threshold
    if (touchState.currentX > SWIPE_THRESHOLD) {
      // Swipe right - edit
      startTitleEdit(convId);
    }
    // Note: swipe-left for delete is intentionally disabled
    // to prevent accidental conversation deletion
  }

  // Reset state
  touchState.wrapper = null;
  touchState.isDragging = false;
  touchState.currentX = 0;
}

function handleConvTouchCancel() {
  clearTimeout(touchState.longPressTimer);

  if (touchState.wrapper) {
    const convItem = touchState.wrapper.querySelector('.conv-item');
    if (convItem) {
      convItem.style.transform = '';
    }
    touchState.wrapper.classList.remove('swiping-left', 'swiping-right');
  }

  touchState.wrapper = null;
  touchState.isDragging = false;
  touchState.currentX = 0;
}

// =============================================================================
// Selection Mode
// =============================================================================

/**
 * Enter selection mode, optionally selecting an initial item.
 */
function enterSelectionMode(initialWrapper = null) {
  selectionMode = true;
  selectedConversations.clear();

  const convList = document.getElementById('conv-list');
  convList?.classList.add('selection-mode');

  if (initialWrapper) {
    toggleSelection(initialWrapper);
  }

  updateSelectionBar();
}

/**
 * Exit selection mode and clear all selections.
 */
function exitSelectionMode() {
  selectionMode = false;
  selectedConversations.clear();

  const convList = document.getElementById('conv-list');
  convList?.classList.remove('selection-mode');

  // Clear all selection visual states
  document.querySelectorAll('.conv-item-wrapper.selected').forEach(el => {
    el.classList.remove('selected');
  });
  document.querySelectorAll('.conv-select-checkbox:checked').forEach(cb => {
    cb.checked = false;
  });

  updateSelectionBar();
}

/**
 * Toggle selection state for a conversation wrapper.
 */
function toggleSelection(wrapper) {
  const convId = wrapper.dataset.convId;
  if (!convId) return;

  const checkbox = wrapper.querySelector('.conv-select-checkbox');

  if (selectedConversations.has(convId)) {
    selectedConversations.delete(convId);
    wrapper.classList.remove('selected');
    if (checkbox) checkbox.checked = false;
  } else {
    selectedConversations.add(convId);
    wrapper.classList.add('selected');
    if (checkbox) checkbox.checked = true;
  }

  updateSelectionBar();

  // Auto-exit selection mode if no items selected
  if (selectedConversations.size === 0 && selectionMode) {
    exitSelectionMode();
  }
}

/**
 * Update the selection bar visibility and count.
 */
function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const countEl = document.getElementById('selection-count-num');

  if (bar) {
    bar.classList.toggle('visible', selectionMode && selectedConversations.size > 0);
  }
  if (countEl) {
    countEl.textContent = selectedConversations.size;
  }
}

/**
 * Delete all selected conversations.
 */
function deleteSelected() {
  if (selectedConversations.size === 0) return;
  showDeleteModal([...selectedConversations]);
}

// =============================================================================
// Delete Modal
// =============================================================================

/**
 * Show the delete confirmation modal.
 */
function showDeleteModal(ids) {
  if (!ids || ids.length === 0) return;

  pendingDeleteIds = ids;

  const backdrop = document.getElementById('modal-backdrop');
  const messageEl = document.getElementById('modal-message');

  if (messageEl) {
    const count = ids.length;
    messageEl.textContent = count === 1
      ? 'Are you sure you want to delete this conversation? This cannot be undone.'
      : `Are you sure you want to delete ${count} conversations? This cannot be undone.`;
  }

  backdrop?.classList.add('visible');
}

/**
 * Close the delete modal without deleting.
 */
function closeDeleteModal() {
  pendingDeleteIds = null;
  document.getElementById('modal-backdrop')?.classList.remove('visible');
}

/**
 * Confirm deletion of pending conversations.
 */
async function confirmDelete() {
  if (!pendingDeleteIds || pendingDeleteIds.length === 0) {
    closeDeleteModal();
    return;
  }

  const ids = [...pendingDeleteIds];
  const wasCurrentDeleted = ids.includes(currentConversationId);

  closeDeleteModal();

  try {
    let response;

    if (ids.length === 1) {
      // Single delete
      response = await fetch(`/api/conversations/${encodeURIComponent(ids[0])}`, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' },
      });
    } else {
      // Batch delete
      response = await fetch('/api/conversations', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ ids }),
      });
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete');
    }

    // Exit selection mode if active
    if (selectionMode) {
      exitSelectionMode();
    }

    // Server broadcasts UI update via SSE - no need to manually reload

    // If current conversation was deleted, reset to home
    if (wasCurrentDeleted) {
      currentConversationId = null;
      history.pushState({}, '', '/');

      // Reset header title
      const headerTitle = document.getElementById('header-title');
      if (headerTitle) {
        headerTitle.textContent = 'Psycheros';
      }

      // Show empty state
      const chat = document.getElementById('chat');
      if (chat) {
        chat.innerHTML = `
          <div class="messages" id="messages">
            <div class="empty-state" id="empty-state">
              <div class="empty-title">Psycheros</div>
              <p class="empty-text">Start a new conversation or select one from the sidebar.</p>
            </div>
          </div>
          <div class="input-area">
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
          </div>
        `;
      }
    }

    showToast(`Deleted ${ids.length} conversation${ids.length > 1 ? 's' : ''}`);

  } catch (error) {
    console.error('Delete failed:', error);
    showToast('Failed to delete: ' + error.message);
  }
}

// =============================================================================
// Inline Title Edit
// =============================================================================

/**
 * Start inline editing of a conversation title.
 */
function startTitleEdit(convId) {
  const wrapper = document.querySelector(`.conv-item-wrapper[data-conv-id="${convId}"]`);
  if (!wrapper) return;

  const convItem = wrapper.querySelector('.conv-item');
  const titleSpan = convItem?.querySelector('.conv-title');
  if (!titleSpan) return;

  const currentTitle = titleSpan.textContent || '';

  // Replace title span with input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conv-title-edit';
  input.value = currentTitle;
  input.dataset.originalTitle = currentTitle;
  input.dataset.convId = convId;

  // Handle completion
  input.onblur = () => finishTitleEdit(input);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = input.dataset.originalTitle;
      input.blur();
    }
  };

  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  // Prevent click from propagating
  input.onclick = (e) => e.stopPropagation();
}

/**
 * Finish inline editing and save the title if changed.
 */
async function finishTitleEdit(input) {
  const convId = input.dataset.convId;
  const originalTitle = input.dataset.originalTitle;
  const newTitle = input.value.trim();

  // Create new title span
  const titleSpan = document.createElement('span');
  titleSpan.className = 'conv-title';
  titleSpan.textContent = newTitle || 'Untitled';

  input.replaceWith(titleSpan);

  // If title changed, update it
  if (newTitle && newTitle !== originalTitle) {
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(convId)}/title`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ title: newTitle }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update title');
      }

      // Update header title if this is the current conversation
      if (convId === currentConversationId) {
        const headerTitle = document.getElementById('header-title');
        if (headerTitle) {
          headerTitle.textContent = newTitle;
        }
      }

    } catch (error) {
      console.error('Title update failed:', error);
      showToast('Failed to update title: ' + error.message);
      // Revert to original title
      titleSpan.textContent = originalTitle || 'Untitled';
    }
  }
}

// =============================================================================
// Context Viewer
// =============================================================================

/**
 * Toggle the context viewer panel open/closed.
 */
function toggleContextViewer() {
  contextViewerOpen = !contextViewerOpen;
  if (contextViewerOpen) {
    showContextViewer();
  } else {
    hideContextViewer();
  }
}

/**
 * Show the context viewer panel.
 */
function showContextViewer() {
  let viewer = document.getElementById('context-viewer');
  let backdrop = document.getElementById('context-viewer-backdrop');

  if (!viewer) {
    createContextViewer();
    viewer = document.getElementById('context-viewer');
    backdrop = document.getElementById('context-viewer-backdrop');
  }

  backdrop?.classList.add('visible');
  viewer?.classList.add('visible');

  if (currentContext) {
    renderContextViewer();
  }
}

/**
 * Hide the context viewer panel.
 */
function hideContextViewer() {
  contextViewerOpen = false;
  document.getElementById('context-viewer')?.classList.remove('visible');
  document.getElementById('context-viewer-backdrop')?.classList.remove('visible');
}

/**
 * Create the context viewer DOM structure.
 */
function createContextViewer() {
  const backdrop = document.createElement('div');
  backdrop.id = 'context-viewer-backdrop';
  backdrop.className = 'context-viewer-backdrop';
  backdrop.onclick = () => hideContextViewer();

  const viewer = document.createElement('div');
  viewer.id = 'context-viewer';
  viewer.className = 'context-viewer';
  viewer.onclick = (e) => e.stopPropagation();
  viewer.innerHTML = `
    <div class="context-viewer-header">
      <h2>Context Inspector</h2>
      <button class="context-viewer-close" onclick="Psycheros.hideContextViewer()">&times;</button>
    </div>
    <div class="context-viewer-tabs">
      <button class="context-tab active" data-tab="system">System</button>
      <button class="context-tab" data-tab="rag">RAG</button>
      <button class="context-tab" data-tab="messages">Messages</button>
      <button class="context-tab" data-tab="tools">Tools</button>
    </div>
    <div class="context-viewer-content" id="context-content">
      <div class="context-empty">Send a message to see the context</div>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(viewer);

  // Tab click handlers
  viewer.querySelectorAll('.context-tab').forEach(tab => {
    tab.onclick = () => switchContextTab(tab.dataset.tab);
  });
}

/**
 * Switch to a different context tab.
 */
function switchContextTab(tabName) {
  document.querySelectorAll('.context-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.context-tab[data-tab="${tabName}"]`)?.classList.add('active');
  renderContextTab(tabName);
}

/**
 * Render the current context in the viewer.
 */
function renderContextViewer() {
  if (!currentContext) return;
  const activeTab = document.querySelector('.context-tab.active')?.dataset.tab || 'system';
  renderContextTab(activeTab);
}

/**
 * Render a specific tab's content.
 */
function renderContextTab(tabName) {
  const content = document.getElementById('context-content');
  if (!content) return;

  if (!currentContext) {
    content.innerHTML = '<div class="context-empty">Send a message to see the context</div>';
    return;
  }

  switch (tabName) {
    case 'system':
      content.innerHTML = renderSystemTab();
      break;
    case 'rag':
      content.innerHTML = renderRagTab();
      break;
    case 'messages':
      content.innerHTML = renderMessagesTab();
      break;
    case 'tools':
      content.innerHTML = renderToolsTab();
      break;
  }
}

/**
 * Render the System tab content.
 */
function renderSystemTab() {
  return `
    <div class="context-section expanded">
      <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span>Full System Message</span>
        <span class="context-section-toggle">&#9660;</span>
      </div>
      <div class="context-section-content">
        <pre>${escapeHtml(currentContext.systemMessage)}</pre>
      </div>
    </div>
    <div class="context-metrics">
      <div>System Length: ${currentContext.metrics.systemMessageLength.toLocaleString()} chars</div>
      <div>Total Messages: ${currentContext.metrics.totalMessages}</div>
      <div>Estimated Tokens: ~${currentContext.metrics.estimatedTokens.toLocaleString()}</div>
    </div>
  `;
}

/**
 * Render the RAG tab content.
 */
function renderRagTab() {
  let html = '';

  if (currentContext.memoriesContent) {
    html += `
      <div class="context-section expanded">
        <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span>Retrieved Memories</span>
          <span class="context-section-toggle">&#9660;</span>
        </div>
        <div class="context-section-content">
          <pre>${escapeHtml(currentContext.memoriesContent)}</pre>
        </div>
      </div>
    `;
  }

  if (currentContext.chatHistoryContent) {
    html += `
      <div class="context-section expanded">
        <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span>Chat History Context</span>
          <span class="context-section-toggle">&#9660;</span>
        </div>
        <div class="context-section-content">
          <pre>${escapeHtml(currentContext.chatHistoryContent)}</pre>
        </div>
      </div>
    `;
  }

  if (!html) {
    html = '<div class="context-empty">No RAG context retrieved for this message</div>';
  }

  return html;
}

/**
 * Render the Messages tab content.
 */
function renderMessagesTab() {
  let html = `<div class="context-info">Total Messages: ${currentContext.messages.length}</div>`;

  if (currentContext.messages.length === 0) {
    html += '<div class="context-empty">No messages in context</div>';
    return html;
  }

  currentContext.messages.forEach((msg, i) => {
    const roleClass = msg.role === 'user' ? 'role-user' : msg.role === 'assistant' ? 'role-assistant' : 'role-other';
    html += `
      <div class="context-message">
        <div class="context-message-header">
          <span class="context-message-role ${roleClass}">${escapeHtml(msg.role)}</span>
          <span class="context-message-index">#${i + 1}</span>
        </div>
        <pre class="context-message-content">${escapeHtml(msg.content || '')}</pre>
        ${msg.toolCalls && msg.toolCalls.length > 0 ? `<div class="context-tool-calls">Tool Calls: ${msg.toolCalls.length}</div>` : ''}
      </div>
    `;
  });

  return html;
}

/**
 * Render the Tools tab content.
 */
function renderToolsTab() {
  let html = `<div class="context-info">Available Tools: ${currentContext.toolDefinitions.length}</div>`;

  if (currentContext.toolDefinitions.length === 0) {
    html += '<div class="context-empty">No tools available</div>';
    return html;
  }

  currentContext.toolDefinitions.forEach(tool => {
    html += `
      <div class="context-section">
        <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span>${escapeHtml(tool.function.name)}</span>
          <span class="context-section-toggle">&#9660;</span>
        </div>
        <div class="context-section-content">
          <p class="tool-description">${escapeHtml(tool.function.description)}</p>
          <pre>${escapeHtml(JSON.stringify(tool.function.parameters, null, 2))}</pre>
        </div>
      </div>
    `;
  });

  return html;
}

// =============================================================================
// Custom File Management
// =============================================================================

/**
 * Create a new custom file from the filename input.
 */
async function createCustomFile() {
  const input = document.getElementById('custom-filename-input');
  if (!input) {
    showToast('Input not found');
    return;
  }

  let filename = input.value.trim();
  if (!filename) {
    showToast('Please enter a filename');
    return;
  }

  // Add .md extension if not present
  if (!filename.endsWith('.md')) {
    filename = filename + '.md';
  }

  // Validate filename format (single word: letters, numbers, underscores only)
  const baseName = filename.slice(0, -3); // Remove .md
  if (!/^[a-zA-Z0-9_]+$/.test(baseName)) {
    showToast('Invalid filename. Use only letters, numbers, and underscores (no spaces).');
    return;
  }

  try {
    const response = await fetch('/api/settings/custom/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename }),
    });

    const result = await response.json();

    if (result.success) {
      showToast(`Created ${result.filename}`);
      // Clear input
      input.value = '';
      // Reload file list
      htmx.trigger('#settings-content', 'load');
      // Navigate to edit the new file
      const editUrl = `/fragments/settings/file/custom/${encodeURIComponent(result.filename)}`;
      setTimeout(() => {
        htmx.ajax('GET', editUrl, { target: '#settings-content', swap: 'innerHTML' });
      }, 100);
    } else {
      showToast(result.error || 'Failed to create file');
    }
  } catch (error) {
    console.error('Failed to create custom file:', error);
    showToast('Failed to create file');
  }
}

/**
 * Delete a custom file after confirmation.
 */
async function deleteCustomFile(filename) {
  if (!confirm(`Delete "${filename}"? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/settings/file/custom/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
      },
    });

    const result = await response.json();

    if (result.success) {
      showToast(`Deleted ${filename}`);
      // Reload file list
      htmx.ajax('GET', '/fragments/settings/core-prompts/custom', {
        target: '#settings-content',
        swap: 'innerHTML',
      });
    } else {
      showToast(result.error || 'Failed to delete file');
    }
  } catch (error) {
    console.error('Failed to delete custom file:', error);
    showToast('Failed to delete file');
  }
}

// =============================================================================
// Global Export
// =============================================================================

globalThis.Psycheros = {
  toggleSidebar,
  closeSidebarAfterNav,
  newConversation,
  selectConversation,
  autoResize,
  handleKeyDown,
  sendMessage,
  requestStopGeneration,
  stopGeneration,
  // Selection mode
  enterSelectionMode,
  exitSelectionMode,
  deleteSelected,
  // Modal
  showDeleteModal,
  closeDeleteModal,
  confirmDelete,
  // Inline edit
  startTitleEdit,
  // Context viewer
  toggleContextViewer,
  hideContextViewer,
  // Custom file management
  createCustomFile,
  deleteCustomFile,
};
