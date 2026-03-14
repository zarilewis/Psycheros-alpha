/**
 * Admin Panel Routes
 *
 * Route handlers for the admin/debug panel.
 * Fragment routes return HTML partials for HTMX; API routes return JSON.
 *
 * @module
 */

import type { RouteContext } from "./routes.ts";
import { queryLogs, getLogComponents, getLogLevelCounts, type LogLevel } from "./logger.ts";
import { collectDiagnostics } from "./diagnostics.ts";
import { renderAdminHub, renderAdminLogs, renderLogEntries, renderAdminDiagnostics } from "./admin-templates.ts";

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const VALID_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

/**
 * GET /fragments/admin — Admin hub with sub-navigation.
 */
export function handleAdminFragment(_ctx: RouteContext): Response {
  return new Response(renderAdminHub(), { headers: HTML_HEADERS });
}

/**
 * GET /fragments/admin/logs — Log viewer fragment.
 * Renders the shell with filter controls and initial log data.
 */
export function handleAdminLogsFragment(_ctx: RouteContext): Response {
  const entries = queryLogs({ limit: 100 });
  const components = getLogComponents();
  return new Response(renderAdminLogs(entries, components), { headers: HTML_HEADERS });
}

/**
 * GET /fragments/admin/diagnostics — Diagnostics dashboard fragment.
 */
export async function handleAdminDiagnosticsFragment(ctx: RouteContext): Promise<Response> {
  const snapshot = await collectDiagnostics(ctx);
  return new Response(renderAdminDiagnostics(snapshot), { headers: HTML_HEADERS });
}

/**
 * GET /api/admin/logs — JSON log entries with optional filtering.
 * Query params: level, component, limit, since
 */
export function handleAdminLogsAPI(_ctx: RouteContext, url: URL): Response {
  const rawLevel = url.searchParams.get("level");
  const level: LogLevel | undefined = rawLevel && VALID_LEVELS.has(rawLevel as LogLevel) ? rawLevel as LogLevel : undefined;
  const component = url.searchParams.get("component");
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const since = url.searchParams.get("since");

  const entries = queryLogs({
    level,
    component: component || undefined,
    limit: isNaN(limit) ? 100 : limit,
    since: since || undefined,
  });

  return new Response(JSON.stringify({ entries, counts: getLogLevelCounts() }), {
    headers: JSON_HEADERS,
  });
}

/**
 * GET /api/admin/logs/entries — HTML partial of log entries only.
 * Used by HTMX to refresh just the log list without the filter controls.
 * Query params: level, component, limit, since
 */
export function handleAdminLogEntriesAPI(_ctx: RouteContext, url: URL): Response {
  const rawLevel = url.searchParams.get("level");
  const level: LogLevel | undefined = rawLevel && VALID_LEVELS.has(rawLevel as LogLevel) ? rawLevel as LogLevel : undefined;
  const component = url.searchParams.get("component");
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const since = url.searchParams.get("since");

  const entries = queryLogs({
    level,
    component: component || undefined,
    limit: isNaN(limit) ? 100 : limit,
    since: since || undefined,
  });

  return new Response(renderLogEntries(entries), { headers: HTML_HEADERS });
}

/**
 * GET /api/admin/diagnostics — JSON diagnostics snapshot.
 */
export async function handleAdminDiagnosticsAPI(ctx: RouteContext): Promise<Response> {
  const snapshot = await collectDiagnostics(ctx);
  return new Response(JSON.stringify(snapshot), { headers: JSON_HEADERS });
}
