/**
 * Admin Panel Client-Side Logic
 *
 * Handles log filtering, manual refresh, clipboard copy,
 * and local timezone formatting.
 * Loaded lazily — only when the admin panel fragment is active.
 */

(function () {
  /**
   * Format all <time class="admin-local-time"> elements to the browser's local timezone.
   */
  function formatLocalTimes(root) {
    (root || document).querySelectorAll("time.admin-local-time").forEach(function (el) {
      if (el.dataset.formatted) return;
      el.textContent = new Date(el.getAttribute("datetime")).toLocaleTimeString();
      el.dataset.formatted = "1";
    });
  }

  /**
   * Flash a button's text briefly to confirm an action.
   */
  function flashButton(btn, text, ms) {
    var original = btn.innerHTML;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () {
      btn.innerHTML = original;
      btn.disabled = false;
    }, ms || 1500);
  }

  /**
   * Refresh the log entries by fetching filtered data from the API.
   */
  window.adminRefreshLogs = function () {
    var level = document.getElementById("admin-log-level")?.value || "";
    var component = document.getElementById("admin-log-component")?.value || "";
    var limit = document.getElementById("admin-log-limit")?.value || "100";

    var params = new URLSearchParams();
    if (level) params.set("level", level);
    if (component) params.set("component", component);
    params.set("limit", limit);

    var target = document.getElementById("admin-log-entries");
    if (target) {
      htmx.ajax("GET", "/api/admin/logs/entries?" + params, { target: target, swap: "innerHTML" });
    }
  };

  /**
   * Copy current log entries to clipboard as formatted text.
   * Fetches from the JSON API using current filter state.
   */
  window.adminCopyLogs = async function (btn) {
    var level = document.getElementById("admin-log-level")?.value || "";
    var component = document.getElementById("admin-log-component")?.value || "";
    var limit = document.getElementById("admin-log-limit")?.value || "100";

    var params = new URLSearchParams();
    if (level) params.set("level", level);
    if (component) params.set("component", component);
    params.set("limit", limit);

    try {
      var res = await fetch("/api/admin/logs?" + params);
      var data = await res.json();

      var filters = [];
      if (level) filters.push("level=" + level);
      if (component) filters.push("component=" + component);
      var filterLine = filters.length ? " (filtered: " + filters.join(", ") + ")" : "";

      var text = "# Psycheros Logs" + filterLine + "\n";
      text += "Entries: " + data.entries.length + " | Counts: error=" + data.counts.error + " warn=" + data.counts.warn + " info=" + data.counts.info + "\n\n";
      text += "```\n";
      for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        var ts = new Date(e.timestamp).toISOString();
        text += ts + " [" + e.level.toUpperCase().padEnd(5) + "] [" + e.component + "] " + e.message + "\n";
      }
      text += "```\n";

      await navigator.clipboard.writeText(text);
      flashButton(btn, "Copied!");
    } catch (_) {
      flashButton(btn, "Failed");
    }
  };

  /**
   * Copy diagnostics snapshot to clipboard as formatted markdown.
   * Fetches from the JSON API for structured data.
   */
  window.adminCopyDiagnostics = async function (btn) {
    try {
      var res = await fetch("/api/admin/diagnostics");
      var s = await res.json();

      var uptime = formatUptimeText(s.uptime);
      var dbSize = s.database.dbSizeBytes !== null ? formatBytesText(s.database.dbSizeBytes) : "unknown";
      var vecStatus = s.vector.available ? "loaded (" + s.vector.version + ")" : "not loaded";
      var msgSync = s.vector.messageSyncOk ? "OK" : "DESYNC";
      var memSync = s.vector.memorySyncOk ? "OK" : "DESYNC";
      var mcpStatus = s.mcp.enabled ? (s.mcp.connected ? "connected" : "disconnected") : "disabled";
      var graphInfo = s.knowledgeGraph.stats
        ? s.knowledgeGraph.stats.totalNodes + " nodes, " + s.knowledgeGraph.stats.totalEdges + " edges"
        : "unavailable";

      var text = "# Psycheros Diagnostics\n";
      text += "Timestamp: " + s.timestamp + "\n\n";
      text += "## Overview\n";
      text += "- Uptime: " + uptime + "\n";
      text += "- SSE Clients: " + s.sse.connectedClients + "\n";
      text += "- Database Size: " + dbSize + "\n\n";
      text += "## Database\n";
      text += "| Table | Rows |\n|-------|------|\n";
      text += "| conversations | " + s.database.conversations + " |\n";
      text += "| messages | " + s.database.messages + " |\n";
      text += "| lorebooks | " + s.database.lorebooks + " |\n";
      text += "| lorebook_entries | " + s.database.lorebookEntries + " |\n";
      text += "| memory_summaries | " + s.database.memorySummaries + " |\n\n";
      text += "## Vector System\n";
      text += "- sqlite-vec: " + vecStatus + "\n";
      text += "- message_embeddings: " + s.vector.messageEmbeddings + " main / " + s.vector.vecMessages + " vec — " + msgSync + "\n";
      text += "- memory_chunks: " + s.vector.memoryChunks + " main / " + s.vector.vecMemoryChunks + " vec — " + memSync + "\n\n";
      text += "## RAG\n";
      text += "- Status: " + (s.rag.enabled ? "enabled" : "disabled") + "\n";
      text += "- Indexed Files: " + s.rag.indexedFiles + "\n";
      text += "- Chunks: " + s.rag.indexedChunks + "\n\n";
      text += "## Memory Consolidation\n";
      text += "- Status: " + (s.memory.enabled ? "enabled" : "disabled") + "\n";
      text += "- Daily: " + s.memory.dailySummaries + " | Weekly: " + s.memory.weeklySummaries + " | Monthly: " + s.memory.monthlySummaries + " | Yearly: " + s.memory.yearlySummaries + "\n";
      text += "- Chats Summarized: " + s.memory.summarizedChats + "\n\n";
      text += "## MCP (entity-core)\n";
      text += "- Status: " + mcpStatus + "\n";
      text += "- Last Sync: " + (s.mcp.lastSync || "never") + "\n";
      text += "- Pending Identity: " + s.mcp.pendingIdentity + " | Pending Memories: " + s.mcp.pendingMemories + "\n\n";
      text += "## Knowledge Graph\n";
      text += "- " + graphInfo + "\n";

      await navigator.clipboard.writeText(text);
      flashButton(btn, "Copied!");
    } catch (_) {
      flashButton(btn, "Failed");
    }
  };

  function formatUptimeText(seconds) {
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    if (m > 0) parts.push(m + "m");
    if (parts.length === 0) parts.push(s + "s");
    return parts.join(" ");
  }


  function formatBytesText(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  // Format timestamps already on the page
  formatLocalTimes();

  // Register htmx:afterSettle listener once (guard against re-execution)
  if (!window._adminAfterSettleRegistered) {
    window._adminAfterSettleRegistered = true;
    document.body.addEventListener("htmx:afterSettle", function (event) {
      formatLocalTimes(event.detail.elt);
    });
  }
})();
