/**
 * Admin Panel Client-Side Logic
 *
 * Handles log filtering and auto-refresh for the admin panel.
 * Loaded lazily — only when the admin panel fragment is active.
 */

(function () {
  let autoRefreshTimer = null;

  /**
   * Refresh the log entries by fetching filtered data from the API.
   */
  window.adminRefreshLogs = function () {
    const level = document.getElementById("admin-log-level")?.value || "";
    const component = document.getElementById("admin-log-component")?.value || "";
    const limit = document.getElementById("admin-log-limit")?.value || "100";

    const params = new URLSearchParams();
    if (level) params.set("level", level);
    if (component) params.set("component", component);
    params.set("limit", limit);

    const target = document.getElementById("admin-log-entries");
    if (target) {
      htmx.ajax("GET", `/api/admin/logs/entries?${params}`, { target, swap: "innerHTML" });
    }
  };

  /**
   * Toggle auto-refresh of log entries (every 5 seconds).
   */
  window.adminToggleAutoRefresh = function (enabled) {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (enabled) {
      autoRefreshTimer = setInterval(window.adminRefreshLogs, 5000);
    }
  };

  // Start auto-refresh by default
  window.adminToggleAutoRefresh(true);

  // Cleanup when navigating away from admin panel
  document.body.addEventListener("htmx:beforeSwap", function (event) {
    if (event.detail.target?.id === "chat") {
      window.adminToggleAutoRefresh(false);
    }
  });
})();
