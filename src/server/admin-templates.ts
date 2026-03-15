/**
 * Admin Panel Templates
 *
 * HTML rendering functions for the admin/debug panel.
 * Returns server-rendered HTML fragments for HTMX swap.
 *
 * @module
 */

import type { LogEntry } from "./logger.ts";
import type { DiagnosticsSnapshot } from "./diagnostics.ts";
import { escapeHtml } from "./templates.ts";

/**
 * Render the admin hub — top-level view with sub-navigation cards.
 */
export function renderAdminHub(): string {
  return `<div class="settings-view">
  <script src="/js/admin.js"></script>
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn"
        hx-get="/fragments/settings"
        hx-target="#chat"
        hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </a>
      <div>
        <h1 class="settings-title">System Admin</h1>
        <p class="settings-desc">System health monitoring, logs, and diagnostics</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    <div class="admin-nav">
      <button class="admin-nav-tab active"
        hx-get="/fragments/admin/diagnostics"
        hx-target="#admin-content"
        hx-swap="innerHTML"
        onclick="document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active')); this.classList.add('active')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        Diagnostics
      </button>
      <button class="admin-nav-tab"
        hx-get="/fragments/admin/logs"
        hx-target="#admin-content"
        hx-swap="innerHTML"
        onclick="document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active')); this.classList.add('active')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        Logs
      </button>
    </div>
    <div id="admin-content"
      hx-get="/fragments/admin/diagnostics"
      hx-trigger="load"
      hx-swap="innerHTML">
    </div>
  </div>
</div>`;
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format seconds into a human-readable uptime string.
 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Render a status indicator dot.
 */
function statusDot(ok: boolean): string {
  return `<span class="admin-status-dot ${ok ? "admin-status-ok" : "admin-status-error"}"></span>`;
}

/**
 * Render the diagnostics dashboard.
 */
export function renderAdminDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const dbSize = snapshot.database.dbSizeBytes !== null
    ? formatBytes(snapshot.database.dbSizeBytes)
    : "unknown";

  const graphInfo = snapshot.knowledgeGraph.stats
    ? `${snapshot.knowledgeGraph.stats.totalNodes} nodes, ${snapshot.knowledgeGraph.stats.totalEdges} edges`
    : "unavailable";

  return `<div class="admin-diagnostics">

  <div class="admin-section">
    <h3 class="admin-section-title">Overview</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Uptime</span>
        <span class="admin-stat-value">${formatUptime(snapshot.uptime)}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">SSE Clients</span>
        <span class="admin-stat-value">${snapshot.sse.connectedClients}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Database Size</span>
        <span class="admin-stat-value">${dbSize}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Database</h3>
    <table class="admin-table">
      <thead><tr><th>Table</th><th>Rows</th></tr></thead>
      <tbody>
        <tr><td>conversations</td><td>${snapshot.database.conversations}</td></tr>
        <tr><td>messages</td><td>${snapshot.database.messages}</td></tr>
        <tr><td>lorebooks</td><td>${snapshot.database.lorebooks}</td></tr>
        <tr><td>lorebook_entries</td><td>${snapshot.database.lorebookEntries}</td></tr>
        <tr><td>memory_summaries</td><td>${snapshot.database.memorySummaries}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Vector System</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">sqlite-vec</span>
        <span class="admin-stat-value">${statusDot(snapshot.vector.available)} ${snapshot.vector.version ?? "not loaded"}</span>
      </div>
    </div>
    <table class="admin-table">
      <thead><tr><th>Table Pair</th><th>Main</th><th>Vec</th><th>Sync</th></tr></thead>
      <tbody>
        <tr>
          <td>message_embeddings / vec_messages</td>
          <td>${snapshot.vector.messageEmbeddings}</td>
          <td>${snapshot.vector.vecMessages}</td>
          <td>${statusDot(snapshot.vector.messageSyncOk)} ${snapshot.vector.messageSyncOk ? "OK" : "DESYNC"}</td>
        </tr>
        <tr>
          <td>memory_chunks / vec_memory_chunks</td>
          <td>${snapshot.vector.memoryChunks}</td>
          <td>${snapshot.vector.vecMemoryChunks}</td>
          <td>${statusDot(snapshot.vector.memorySyncOk)} ${snapshot.vector.memorySyncOk ? "OK" : "DESYNC"}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">RAG</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Status</span>
        <span class="admin-stat-value">${statusDot(snapshot.rag.enabled)} ${snapshot.rag.enabled ? "enabled" : "disabled"}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Indexed Files</span>
        <span class="admin-stat-value">${snapshot.rag.indexedFiles}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Chunks</span>
        <span class="admin-stat-value">${snapshot.rag.indexedChunks}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Memory Consolidation</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Status</span>
        <span class="admin-stat-value">${statusDot(snapshot.memory.enabled)} ${snapshot.memory.enabled ? "enabled" : "disabled"}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Daily</span>
        <span class="admin-stat-value">${snapshot.memory.dailySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Weekly</span>
        <span class="admin-stat-value">${snapshot.memory.weeklySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Monthly</span>
        <span class="admin-stat-value">${snapshot.memory.monthlySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Yearly</span>
        <span class="admin-stat-value">${snapshot.memory.yearlySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Chats Summarized</span>
        <span class="admin-stat-value">${snapshot.memory.summarizedChats}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">MCP (entity-core)</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Status</span>
        <span class="admin-stat-value">${statusDot(snapshot.mcp.connected)} ${snapshot.mcp.enabled ? (snapshot.mcp.connected ? "connected" : "disconnected") : "disabled"}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Last Sync</span>
        <span class="admin-stat-value">${snapshot.mcp.lastSync ?? "never"}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Pending Identity</span>
        <span class="admin-stat-value">${snapshot.mcp.pendingIdentity}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Pending Memories</span>
        <span class="admin-stat-value">${snapshot.mcp.pendingMemories}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Knowledge Graph</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Graph Data</span>
        <span class="admin-stat-value">${graphInfo}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Graph Vec Search</span>
        <span class="admin-stat-value">${statusDot(snapshot.knowledgeGraph.vectorSearchAvailable)} ${snapshot.knowledgeGraph.vectorSearchAvailable ? "active" : "off"}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Write Tools</span>
        <span class="admin-stat-value">${statusDot(snapshot.knowledgeGraph.writeToolsEnabled)} ${snapshot.knowledgeGraph.writeToolsEnabled ? "enabled" : "disabled"}</span>
      </div>
    </div>${snapshot.knowledgeGraph.stats ? `
    <table class="admin-table">
      <thead><tr><th>Node Type</th><th>Count</th></tr></thead>
      <tbody>
        ${Object.entries(snapshot.knowledgeGraph.stats.nodesByType).map(([type, count]) =>
          `<tr><td>${type}</td><td>${count}</td></tr>`
        ).join('')}
      </tbody>
    </table>` : ''}
  </div>

  <div class="admin-footer">
    <span class="admin-footer-ts">Last updated: <time class="admin-local-time" datetime="${snapshot.timestamp}">${snapshot.timestamp}</time></span>
    <button class="admin-refresh-btn"
      hx-get="/fragments/admin/diagnostics"
      hx-target="#admin-content"
      hx-swap="innerHTML">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Refresh
    </button>
    <button class="admin-refresh-btn" onclick="window.adminCopyDiagnostics(this)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      Copy
    </button>
  </div>
</div>`;
}

/**
 * Render the log viewer fragment.
 * The shell includes filter controls; log data is loaded via HTMX from /api/admin/logs.
 */
export function renderAdminLogs(entries: LogEntry[], components: string[]): string {
  const componentOptions = components
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join("");

  return `<div class="admin-logs">
  <div class="admin-log-controls">
    <select id="admin-log-level" class="admin-select"
      onchange="window.adminRefreshLogs()">
      <option value="">All Levels</option>
      <option value="error">Error</option>
      <option value="warn">Warning</option>
      <option value="info">Info</option>
    </select>
    <select id="admin-log-component" class="admin-select"
      onchange="window.adminRefreshLogs()">
      <option value="">All Components</option>
      ${componentOptions}
    </select>
    <select id="admin-log-limit" class="admin-select"
      onchange="window.adminRefreshLogs()">
      <option value="50">50 entries</option>
      <option value="100" selected>100 entries</option>
      <option value="250">250 entries</option>
      <option value="500">500 entries</option>
    </select>
    <button class="admin-refresh-btn" onclick="window.adminRefreshLogs()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Refresh
    </button>
    <button class="admin-refresh-btn" onclick="window.adminCopyLogs(this)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      Copy
    </button>
  </div>
  <div class="admin-log-list" id="admin-log-entries">
    ${renderLogEntries(entries)}
  </div>
</div>`;
}

/**
 * Render log entries as HTML row divs.
 * Used both in initial render and HTMX partial updates.
 */
export function renderLogEntries(entries: LogEntry[]): string {
  if (entries.length === 0) {
    return `<div class="admin-empty">No log entries match the current filters.</div>`;
  }

  const rows = entries.map((entry) => {
    const levelClass = `admin-log-${entry.level}`;
    return `<div class="admin-log-row ${levelClass}">
      <span class="admin-log-time"><time class="admin-local-time" datetime="${entry.timestamp}">${entry.timestamp}</time></span>
      <span class="admin-log-level-badge">${entry.level.toUpperCase()}</span>
      <span class="admin-log-component">${escapeHtml(entry.component)}</span>
      <span class="admin-log-message">${escapeHtml(entry.message)}</span>
    </div>`;
  }).join("");

  return rows;
}
