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
import { getAllJobs, triggerJob } from "./cron-tracker.ts";
import { renderAdminHub, renderAdminLogs, renderLogEntries, renderAdminDiagnostics, renderAdminJobs, renderAdminJobRows, renderAdminActions } from "./admin-templates.ts";

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

/**
 * GET /fragments/admin/jobs — Scheduled jobs dashboard fragment.
 */
export function handleAdminJobsFragment(_ctx: RouteContext): Response {
  const jobs = getAllJobs();
  return new Response(renderAdminJobs(jobs), { headers: HTML_HEADERS });
}

/**
 * GET /api/admin/jobs/rows — HTML partial of job table rows only.
 * Used by HTMX to refresh just the table body without a full panel re-render.
 */
export function handleAdminJobRowsFragment(_ctx: RouteContext): Response {
  const jobs = getAllJobs();
  return new Response(renderAdminJobRows(jobs), { headers: HTML_HEADERS });
}

/**
 * GET /api/admin/jobs — JSON scheduled jobs status.
 */
export function handleAdminJobsAPI(_ctx: RouteContext): Response {
  const jobs = getAllJobs();
  return new Response(JSON.stringify({ jobs }), { headers: JSON_HEADERS });
}

/**
 * POST /api/admin/jobs/:id/trigger — Manually trigger a scheduled job.
 * Returns updated job rows HTML for HTMX to swap into the tbody.
 */
export async function handleAdminJobTriggerAPI(_ctx: RouteContext, jobId: string): Promise<Response> {
  await triggerJob(jobId);
  const jobs = getAllJobs();
  return new Response(renderAdminJobRows(jobs), { headers: HTML_HEADERS });
}

/**
 * GET /fragments/admin/actions — Actions panel fragment.
 */
export function handleAdminActionsFragment(_ctx: RouteContext): Response {
  return new Response(renderAdminActions(), { headers: HTML_HEADERS });
}

/**
 * POST /api/admin/actions/batch-populate — Run the batch-populate-graph script.
 * Accepts JSON body with { days, granularity, dryRun, verbose }.
 * Spawns the entity-core script as a subprocess and streams output.
 */
export async function handleAdminBatchPopulate(_ctx: RouteContext, body: Record<string, unknown>): Promise<Response> {
  const days = typeof body.days === "number" ? body.days : 30;
  const granularity = typeof body.granularity === "string" ? body.granularity : "daily";
  const dryRun = body.dryRun === true;
  const verbose = body.verbose === true;

  const entityCoreRoot = Deno.env.get("PSYCHEROS_ENTITY_CORE_PATH") ||
    new URL("../../entity-core", import.meta.url).pathname;

  const args = [
    "run", "-A",
    `${entityCoreRoot}/scripts/batch-populate-graph.ts`,
    `--days`, String(days),
    `--granularity`, granularity,
  ];
  if (dryRun) args.push("--dry-run");
  if (verbose) args.push("--verbose");

  try {
    const cmd = new Deno.Command("deno", {
      args,
      env: {
        ENTITY_CORE_DATA_DIR: Deno.env.get("PSYCHEROS_ENTITY_CORE_DATA_DIR") || `${entityCoreRoot}/data`,
        ENTITY_CORE_LLM_API_KEY: Deno.env.get("ENTITY_CORE_LLM_API_KEY") || Deno.env.get("ZAI_API_KEY") || "",
        ENTITY_CORE_LLM_BASE_URL: Deno.env.get("ENTITY_CORE_LLM_BASE_URL") || Deno.env.get("ZAI_BASE_URL") || "",
        ENTITY_CORE_LLM_MODEL: Deno.env.get("ENTITY_CORE_LLM_MODEL") || Deno.env.get("ZAI_MODEL") || "",
        ZAI_API_KEY: Deno.env.get("ZAI_API_KEY") || "",
        ZAI_BASE_URL: Deno.env.get("ZAI_BASE_URL") || "",
        ZAI_MODEL: Deno.env.get("ZAI_MODEL") || "",
      },
      stdout: "piped",
      stderr: "piped",
    });

    const process = cmd.spawn();
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const status = await process.status;

    const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");
    const success = status.success;

    return new Response(JSON.stringify({ success, exitCode: status.code, output }), {
      headers: JSON_HEADERS,
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      exitCode: -1,
      output: `Failed to spawn script: ${error instanceof Error ? error.message : String(error)}`,
    }), { headers: JSON_HEADERS });
  }
}
