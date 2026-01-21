/**
 * SBy Client JavaScript
 * Handles SSE streaming, sidebar toggle, input management, and service worker.
 */

// =============================================================================
// State
// =============================================================================

let currentConversationId = null;
let isStreaming = false;
const pendingToolCalls = new Map();
let currentAbortController = null;

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
  const match = window.location.pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    const conversationId = match[1];
    loadConversationFromUrl(conversationId);
  }

  // Focus input on load
  const input = document.getElementById('message-input');
  if (input) {
    input.focus();
  }
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
    const chat = document.getElementById('chat');
    if (chat) {
      chat.innerHTML = html;
    }

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

    // Reload conversation list
    htmx.trigger('#conv-list', 'load');

    // Clear chat and show empty state with input area
    const chat = document.getElementById('chat');
    if (chat) {
      chat.innerHTML = `
        <div class="messages" id="messages">
          <div class="empty-state" id="empty-state">
            <div class="empty-title">SBy</div>
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
              onkeydown="SBy.handleKeyDown(event)"
              oninput="SBy.autoResize(this)"
            ></textarea>
            <button class="send-btn" id="send-btn" onclick="SBy.sendMessage()">Send</button>
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

  // Update active state in list
  document.querySelectorAll('.conv-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.convId === id);
  });

  // Re-enable input
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  if (input) input.disabled = false;
  if (sendBtn) sendBtn.disabled = false;

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
  sendBtn.disabled = true;
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

      // Parse SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEventType = 'content';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          handleSSEEvent(currentEventType, data, assistantEl, {
            getThinking: () => currentThinking,
            setThinking: (el) => currentThinking = el,
            getContent: () => currentContent,
            setContent: (el) => currentContent = el
          });
          currentEventType = 'content';
        }
      }
    }

    // Reload conversations to update titles
    htmx.trigger('#conv-list', 'load');

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Request aborted');
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

    // Re-enable input
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
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

    case 'status': {
      const statusEl = document.createElement('div');
      statusEl.className = 'status';
      statusEl.textContent = data;
      contentContainer.appendChild(statusEl);
      break;
    }

    case 'done':
      // Collapse all thinking and tool sections after streaming completes
      contentContainer.querySelectorAll('.thinking.expanded, .tool.expanded').forEach(el => {
        el.classList.remove('expanded');
      });
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
  let rawArgs = toolCall.function?.arguments || toolCall.arguments || '{}';
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
// Global Export
// =============================================================================

globalThis.SBy = {
  toggleSidebar,
  newConversation,
  selectConversation,
  autoResize,
  handleKeyDown,
  sendMessage,
};
