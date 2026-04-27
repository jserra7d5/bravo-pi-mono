import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const distCli = join(packageRoot, "dist", "cli.js");
const includeRoot = join(packageRoot, "includes");

type ExecResult = { code: number; stdout: string; stderr: string; json?: any };
type NotifyLevel = "info" | "error" | "warning" | "success";

let watchProcess: ChildProcessWithoutNullStreams | undefined;
let watcherKey: string | undefined;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let pendingEvents: any[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function tangoHome(): string {
  return process.env.TANGO_HOME || join(process.env.TANGO_REAL_HOME || process.env.HOME || process.cwd(), ".tango");
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function ensureRootSessionRecord() {
  const now = new Date().toISOString();
  const cwd = process.cwd();
  const rootSessionId = process.env.TANGO_ROOT_SESSION_ID || `sess_${randomBytes(8).toString("base64url")}`;
  const workstreamId = process.env.TANGO_WORKSTREAM_ID || `ws_${createHash("sha1").update(`${cwd}:${rootSessionId}`).digest("hex").slice(0, 12)}`;
  process.env.TANGO_ROOT_SESSION_ID = rootSessionId;
  process.env.TANGO_WORKSTREAM_ID = workstreamId;

  const dir = join(tangoHome(), "server", "root-sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeId(rootSessionId)}.json`);
  let existing: any = {};
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, "utf8")); } catch {}
  }
  const record = {
    schemaVersion: 1,
    rootSessionId,
    workstreamId,
    kind: "pi",
    cwd,
    title: existing.title || cwd,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastSeenAt: now,
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function runTango(args: string[], signal?: AbortSignal): Promise<ExecResult> {
  const candidates: Array<{ command: string; args: string[] }> = [
    { command: "tango", args },
    { command: process.execPath, args: [distCli, ...args] },
  ];
  let last: ExecResult = { code: 1, stdout: "", stderr: "tango not found" };
  for (const c of candidates) {
    last = await run(c.command, c.args, signal);
    if (!(last.code === 127 || /ENOENT|not found/i.test(last.stderr))) break;
  }
  if (last.stdout.trim()) {
    try { last.json = JSON.parse(last.stdout); } catch {}
  }
  return last;
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => stdout += d.toString());
    proc.stderr.on("data", (d) => stderr += d.toString());
    proc.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (signal) {
      if (signal.aborted) proc.kill("SIGTERM");
      else signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
    }
  });
}

function toolResult(result: ExecResult) {
  if (result.code !== 0) {
    return {
      content: [{ type: "text" as const, text: result.stderr || result.stdout || `tango exited ${result.code}` }],
      details: result.json ?? { ok: false, code: result.code, stdout: result.stdout, stderr: result.stderr },
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: result.json ? JSON.stringify(result.json, null, 2) : result.stdout }],
    details: result.json ?? { ok: true, stdout: result.stdout },
  };
}

function compactPsResult(result: ExecResult, maxAgents = 50): ExecResult {
  if (result.code !== 0 || !result.json?.agents || !Array.isArray(result.json.agents)) return result;
  const total = typeof result.json.total === "number" ? result.json.total : result.json.agents.length;
  const agents = result.json.agents.slice(0, maxAgents);
  const compact = {
    ...result.json,
    agents,
    returned: agents.length,
    truncated: result.json.truncated || agents.length < total,
    hint: result.json.hint || (agents.length < total ? "Tango ps output was compacted for model safety. Narrow with active/problems/health/state/limit." : undefined),
  };
  result.json = compact;
  result.stdout = JSON.stringify(compact, null, 2);
  return result;
}

function readInclude(name: string): string {
  const path = join(includeRoot, `${name}.md`);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function parentPrompt(): string {
  return ["orchestration-core", "orchestration-pi-tools", "orchestration-cli"]
    .map(readInclude)
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function statusIcon(status?: string): string {
  switch (status) {
    case "done": return "✓";
    case "running": return "⏳";
    case "error": return "✗";
    case "blocked": return "◐";
    case "stopped": return "■";
    default: return "•";
  }
}

function statusColor(status?: string): "success" | "warning" | "error" | "muted" {
  switch (status) {
    case "done": return "success";
    case "running":
    case "blocked": return "warning";
    case "error": return "error";
    default: return "muted";
  }
}

function firstLine(value: unknown): string {
  return String(value ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
}

function preview(value: unknown, max = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textBlock(lines: string[]) {
  return new Text(lines.join("\n"), 0, 0);
}

function errorText(result: any, theme: any) {
  const details = result.details ?? {};
  const msg = details.stderr || details.error || firstLine(result.content?.[0]?.text) || "Tango command failed";
  return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function formatTokens(total: unknown): string | undefined {
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}m tok`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}k tok`;
  return `${total} tok`;
}

function agentRuntime(agent: any): string | undefined {
  const start = Date.parse(agent?.createdAt ?? agent?.metrics?.startedAt ?? "");
  if (!Number.isFinite(start)) return undefined;
  const end = ["done", "blocked", "error", "stopped"].includes(agent.status) ? Date.parse(agent?.updatedAt ?? "") : Date.now();
  return formatDuration((Number.isFinite(end) ? end : Date.now()) - start);
}

function metricsSummary(agent: any): string {
  const m = agent?.metrics;
  const parts: string[] = [];
  if (m) {
    parts.push(`${m.toolCalls ?? 0} tools`);
    if (agent.status === "running" && m.activeToolCalls > 0) parts.push(`${m.activeToolCalls} active`);
    if (m.lastTool) parts.push(String(m.lastTool));
    const tokens = formatTokens(m.tokens?.total);
    if (tokens) parts.push(tokens);
    if (typeof m.context?.percent === "number") parts.push(`ctx ${Math.round(m.context.percent)}%`);
  }
  const runtime = agentRuntime(agent);
  if (runtime) parts.push(runtime);
  return parts.join(" · ");
}

function agentSummary(agent: any): string {
  const metrics = metricsSummary(agent);
  return `${agent?.role ?? "agent"} · ${agent?.mode ?? "?"}/${agent?.harness ?? "?"} · ${agent?.status ?? "unknown"}${metrics ? ` · ${metrics}` : ""}`;
}

function renderAgentResult(result: any, { expanded }: { expanded: boolean }, theme: any, title: string) {
  if (result.isError) return errorText(result, theme);
  const agent = result.details?.agent;
  if (!agent) return new Text(theme.fg("success", `✓ ${title}`), 0, 0);
  const icon = statusIcon(agent.status);
  const head = `${theme.fg(statusColor(agent.status), icon)} ${theme.fg("toolTitle", title)} ${theme.fg("accent", agent.name)}`;
  if (!expanded) return textBlock([head, `  ${theme.fg("muted", agentSummary(agent))}`]);
  return textBlock([
    head,
    `  ${theme.fg("muted", "Role:")} ${agent.role ?? "-"}`,
    `  ${theme.fg("muted", "Harness:")} ${agent.harness}`,
    `  ${theme.fg("muted", "Mode:")} ${agent.mode}`,
    `  ${theme.fg("muted", "Status:")} ${agent.status}`,
    agent.metrics ? `  ${theme.fg("muted", "Metrics:")} ${metricsSummary(agent)}` : "",
    `  ${theme.fg("muted", "Run dir:")} ${theme.fg("dim", agent.runDir ?? "")}`,
    agent.task ? `  ${theme.fg("muted", "Task:")} ${preview(agent.task, 180)}` : "",
  ].filter(Boolean));
}

function renderListResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const agents = result.details?.agents ?? [];
  const counts = agents.reduce((acc: Record<string, number>, a: any) => {
    acc[a.status ?? "unknown"] = (acc[a.status ?? "unknown"] ?? 0) + 1;
    return acc;
  }, {});
  const summary = `Tango agents: ${counts.running ?? 0} running · ${counts.done ?? 0} done · ${counts.error ?? 0} error`;
  if (!expanded) return new Text(theme.fg("toolTitle", summary), 0, 0);
  const lines = [theme.fg("toolTitle", summary), ""];
  for (const a of agents) {
    const icon = theme.fg(statusColor(a.status), statusIcon(a.status));
    const metrics = metricsSummary(a);
    lines.push(`${icon} ${theme.fg("accent", String(a.name).padEnd(18))} ${String(a.role ?? "-").padEnd(10)} ${a.mode}/${a.harness} ${theme.fg("muted", a.status ?? "unknown")}${metrics ? ` ${theme.fg("dim", metrics)}` : ""}`);
  }
  if (!agents.length) lines.push(theme.fg("dim", "No Tango agents."));
  return new Text(lines.join("\n"), 0, 0);
}

function renderLookResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const agent = result.details?.agent;
  const output = result.details?.output ?? "";
  if (!expanded) {
    return textBlock([
      `${theme.fg("toolTitle", agent?.name ?? "Tango output")}: ${theme.fg("muted", firstLine(output) || "no output")}`,
    ]);
  }
  const c = new Container();
  c.addChild(new Text(`${theme.fg("toolTitle", "Tango output")} ${theme.fg("accent", agent?.name ?? "")}`, 0, 0));
  c.addChild(new Spacer(1));
  c.addChild(new Text(output || theme.fg("dim", "No output."), 0, 0));
  return c;
}

function renderResultResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const agent = result.details?.agent;
  const output = result.details?.result ?? "";
  const ready = result.details?.resultReady === true;
  const issue = result.details?.resultIssue;
  const warning = result.details?.resultWarning;
  const color = issue || !ready ? "warning" : warning ? "warning" : "success";
  const icon = issue || !ready ? "⚠" : warning ? "⚠" : "✓";
  const status = issue || !ready ? (issue || "result not ready") : warning ? warning : firstLine(output);
  if (!expanded) return new Text(`${theme.fg(color, icon)} ${theme.fg("accent", agent?.name ?? "agent")} result ${theme.fg("muted", status)}`, 0, 0);
  return textBlock([
    `${theme.fg("toolTitle", "Tango result")} ${theme.fg("accent", agent?.name ?? "")}`,
    issue ? theme.fg("warning", `Result issue: ${issue}`) : "",
    warning ? theme.fg("warning", `Result warning: ${warning}`) : "",
    ready ? theme.fg("success", "Result ready") : theme.fg("warning", "Result not ready"),
    "",
    output || theme.fg("dim", "No result."),
  ].filter(Boolean));
}

async function updateFooterStatus(ctx: any, signal?: AbortSignal) {
  if (!ctx?.hasUI) return;
  const result = await runTango(["ps", "--json"], signal);
  const agents = result.json?.agents ?? [];
  const running = agents.filter((a: any) => a.status === "running").length;
  const done = agents.filter((a: any) => a.status === "done").length;
  const tools = agents.reduce((sum: number, a: any) => sum + (typeof a.metrics?.toolCalls === "number" ? a.metrics.toolCalls : 0), 0);
  const tokens = agents.reduce((sum: number, a: any) => sum + (typeof a.metrics?.tokens?.total === "number" ? a.metrics.tokens.total : 0), 0);
  const suffix = [`${running} running`, `${done} done`, tools ? `${tools} tools` : "", tokens ? formatTokens(tokens) : ""].filter(Boolean).join(" · ");
  ctx.ui.setStatus("tango", ctx.ui.theme.fg("dim", `Tango: ${suffix}`));
}

function withJson(args: string[]): string[] {
  if (args.includes("--json")) return args;
  const jsonCommands = new Set(["start", "ps", "inspect", "activity", "follow", "message", "stop", "delete", "report", "result", "roles", "children", "doctor", "metrics", "reconcile", "recover"]);
  return args[0] && jsonCommands.has(args[0]) ? [...args, "--json"] : args;
}

function addCwd(args: string[], cwd?: string): string[] {
  return cwd ? [...args, "--cwd", cwd] : args;
}

function addTarget(args: string[], params: { name?: string; runId?: string; runDir?: string }): string[] {
  const out = [...args];
  if (params.name) out.push(params.name);
  if (params.runId) out.push("--run-id", params.runId);
  if (params.runDir) out.push("--run-dir", params.runDir);
  return out;
}

function requireNameOrTarget(params: { name?: string; runId?: string; runDir?: string }): string | undefined {
  if (params.name || params.runId || params.runDir) return undefined;
  return "Provide name, runId, or runDir.";
}

// Import durable attention store from compiled dist to avoid duplicating logic.
// The extension already depends on dist/cli.js at runtime; this is consistent.
// @ts-ignore: dist has no declarations, but the module exists at runtime.
import {
  attentionStorePath,
  upsertAttentionFromEvent,
  shouldDeliverEvent,
  shouldFlushClaimedEvent,
  markAttentionState,
  getRecipientContext,
  type AttentionRecord,
  type RecipientContext,
  type AttentionState,
} from "../../dist/attention.js";
// @ts-ignore: dist has no declarations, but the module exists at runtime.
import { readRecentEvents } from "../../dist/events.js";

function startParentReconciler(ctx: any) {
  if (reconcileTimer || !process.env.TANGO_RUN_DIR) return;
  reconcileTimer = setInterval(() => {
    void runTango(["reconcile", "--children", "--json"], ctx?.signal).then(() => updateFooterStatus(ctx, ctx?.signal)).catch(() => {});
  }, 15_000);
}

function currentWatcherKey(): string {
  return [
    process.env.TANGO_ROOT_SESSION_ID ?? "",
    process.env.TANGO_WORKSTREAM_ID ?? "",
    process.env.TANGO_RUN_ID ?? "",
    process.env.TANGO_RUN_DIR ? resolve(process.env.TANGO_RUN_DIR) : "",
  ].join("|");
}

function stopEventWatcher() {
  if (watchProcess) watchProcess.kill("SIGTERM");
  watchProcess = undefined;
  watcherKey = undefined;
  pendingEvents = [];
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
}

function reapDuplicateEventWatchers() {
  const rootSessionId = process.env.TANGO_ROOT_SESSION_ID;
  const workstreamId = process.env.TANGO_WORKSTREAM_ID;
  if (!rootSessionId || !workstreamId) return;
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isFinite(pid) || pid === process.pid || pid === watchProcess?.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!cmdline.includes(distCli) || !cmdline.includes(" watch ") || !cmdline.includes(" --json")) continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (resolve(cwd) !== resolve(process.cwd())) continue;
      // A stale watcher from an older root/workstream can claim same-cwd child
      // completions before the current session sees them. Reap all same-cwd
      // Tango watchers on reload/startup; the active extension will start one
      // fresh watcher for this session immediately after this scan.
      try { process.kill(pid, "SIGTERM"); } catch {}
    } catch {
      // Process may have exited or belong to another user; ignore.
    }
  }
}

function startEventWatcher(pi: ExtensionAPI, ctx: any) {
  const key = currentWatcherKey();
  if (watchProcess && watcherKey !== key) stopEventWatcher();
  if (watchProcess) return;
  reapDuplicateEventWatchers();
  watcherKey = key;
  const args = [distCli, "watch", "--json"];
  watchProcess = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env as Record<string, string>, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  watchProcess.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) handleTangoEventLine(pi, ctx, line);
  });
  watchProcess.on("close", () => { watchProcess = undefined; watcherKey = undefined; });
}

function handleTangoEventLine(pi: ExtensionAPI, ctx: any, line: string) {
  if (!line.trim()) return;
  let event: any;
  try { event = JSON.parse(line); } catch { return; }
  handleTangoEvent(pi, ctx, event);
}

function handleTangoEvent(pi: ExtensionAPI, ctx: any, event: any) {
  if (event.type !== "agent.status") return;
  if (!["done", "blocked", "error"].includes(event.status)) return;
  // Pi delivery uses direct-child filtering when the recipient is itself a Tango run.
  // Root Pi sessions do not have a run identity, so they receive same root/workstream
  // child completions even though those children have no parentRunId edge.
  const parentRunDir = process.env.TANGO_RUN_DIR;
  const parentRunId = process.env.TANGO_RUN_ID;
  const hasRunLineage = !!(parentRunDir || parentRunId);
  let isDirectChild = false;
  if (parentRunId && event.parentRunId === parentRunId) isDirectChild = true;
  if (parentRunDir && event.parentRunDir) {
    if (resolve(event.parentRunDir) === resolve(parentRunDir)) isDirectChild = true;
  }
  if (hasRunLineage && !isDirectChild) return;
  if (!hasRunLineage) {
    const rootSessionId = process.env.TANGO_ROOT_SESSION_ID;
    const workstreamId = process.env.TANGO_WORKSTREAM_ID;
    const rootMatches = (!rootSessionId || event.rootSessionId === rootSessionId) && (!workstreamId || event.workstreamId === workstreamId);
    const sameCwd = typeof event.cwd === "string" && resolve(event.cwd) === resolve(process.cwd());
    // Prefer root/workstream identity, but tolerate same-cwd events because
    // starts may be proxied through a long-lived Tango server or stale Pi tool
    // process whose env no longer matches the visible root session.
    if (!rootMatches && !sameCwd) return;
  }
  const rec = getRecipientContext();
  upsertAttentionFromEvent(event, rec);
  if (!shouldDeliverEvent(event, rec)) return;
  markAttentionState(rec, event.runDir, event.eventId, "delivered");
  pendingEvents.push(event);
  if (!flushTimer) flushTimer = setTimeout(() => flushTangoEvents(pi, ctx), 500);
}

function backfillRecentTangoEvents(pi: ExtensionAPI, ctx: any) {
  // Backfill is only a short startup safety net, not historical replay. A broad
  // replay can flood the parent with old done agents and mark stale events seen.
  const startedAt = Date.now();
  setTimeout(() => {
    const cutoffMs = startedAt - 15 * 1000;
    let recent: any[] = [];
    try { recent = readRecentEvents(200, 256 * 1024).events ?? []; } catch { return; }
    for (const event of recent) {
      const time = Date.parse(event.time ?? "");
      if (!Number.isFinite(time) || time < cutoffMs) continue;
      handleTangoEvent(pi, ctx, event);
    }
  }, 1000);
}

function suggestedAction(event: any): string {
  if (event.runId) {
    if (event.status === "done") return `tango result --run-id ${event.runId}`;
    return `tango activity --run-id ${event.runId} --lines 120`;
  }
  if (event.status === "done") return `tango_result ${event.agent}`;
  return `tango_activity ${event.agent} --lines 120`;
}

function eventText(event: any): string {
  const needs = event.needs ? ` [needs: ${event.needs}]` : "";
  return `${event.agent} (${event.role ?? "agent"}) is ${event.status}${needs}${event.summary ? `: ${event.summary}` : ""}`;
}

function flushTangoEvents(pi: ExtensionAPI, ctx: any) {
  const events = pendingEvents;
  pendingEvents = [];
  flushTimer = undefined;
  if (!events.length) return;
  const rec = getRecipientContext();

  // Re-filter stale/superseded events against current claimed delivery state and
  // coalesce by target runDir to the latest unresolved event per target.
  const seenRunDirs = new Set<string>();
  const deliverable: typeof events = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!shouldFlushClaimedEvent(event, rec)) continue;
    if (seenRunDirs.has(event.runDir)) continue;
    seenRunDirs.add(event.runDir);
    deliverable.unshift(event);
  }

  if (!deliverable.length) return;

  const worst = deliverable.some((e) => e.status === "error") ? "error" : deliverable.some((e) => e.status === "blocked") ? "warning" : "success";
  const title = deliverable.length === 1 ? `Tango agent ${eventText(deliverable[0])}` : `${deliverable.length} Tango agents updated: ${deliverable.map((e) => `${e.agent}=${e.status}`).join(", ")}`;
  if (ctx?.hasUI) ctx.ui.notify(title, worst as NotifyLevel);
  const lines = deliverable.map((event) => `- ${eventText(event)}\n  Next step: ${suggestedAction(event)}`);
  const wakeup = `Tango internal wake-up${deliverable.length > 1 ? "s" : ""} (not a user request):\n\n${lines.join("\n")}\n\nInstructions for the parent agent:\n- Do not summarize this notification to the user.\n- Continue the active user task/autonomous workstream.\n- For done agents, inspect the result if it is relevant and integrate it into the ongoing work.\n- For blocked/error agents, inspect output and either resolve the blocker or report only if user input/intervention is actually needed.\n- Respond to the user only when the original task is complete, blocked, or requires a decision.`;
  try {
    // Use a user-message wake-up rather than a custom-message prompt. In practice
    // custom messages were recorded as delivered/seen but did not reliably start
    // a new root-agent turn from this background watcher path.
    pi.sendUserMessage(wakeup, { deliverAs: "followUp" });
    for (const event of deliverable) markAttentionState(rec, event.runDir, event.eventId, "seen");
  } catch (error) {
    if (ctx?.hasUI) ctx.ui.notify(`Tango wake-up delivery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try { ensureRootSessionRecord(); } catch {}
    if (ctx.hasUI) ctx.ui.setStatus("tango", ctx.ui.theme.fg("dim", "Tango: ready"));
    startEventWatcher(pi, ctx);
    backfillRecentTangoEvents(pi, ctx);
    startParentReconciler(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopEventWatcher();
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const prompt = parentPrompt();
    if (!prompt || event.systemPrompt.includes("## Tango Agent Orchestration")) return {};
    return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${prompt}` };
  });

  pi.registerTool({
    name: "tango_start",
    label: "Tango Start",
    description: "Start a Tango child agent. Wraps `tango start ... --json`; prefer this tool in Pi sessions.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent instance name" }),
      role: Type.String({ description: "Role name, e.g. scout, planner, reviewer, worker, fast-worker, lead, generalist" }),
      task: Type.String({ description: "Task for the child agent" }),
      mode: Type.Optional(StringEnum(["oneshot", "interactive"] as const)),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
      clean: Type.Optional(Type.Boolean({ default: false })),
      noResultRequired: Type.Optional(Type.Boolean({ description: "Opt out of the default interactive-agent deliverable requirement. Use only for status-only child agents where no result.md deliverable is intended." })),
      cwd: Type.Optional(Type.String({ description: "Working directory/project root for this agent. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = addCwd(["start", params.name, "--role", params.role, "--json"], params.cwd);
      if (params.mode) args.push("--mode", params.mode);
      if (params.thinking) args.push("--thinking", params.thinking);
      if (params.clean) args.push("--clean");
      if (params.noResultRequired) args.push("--no-result-required");
      args.push(params.task);
      const out = toolResult(await runTango(args, signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) {
      const suffix = args.thinking ? `as ${args.role}, thinking ${args.thinking}` : `as ${args.role}`;
      return textBlock([`${theme.fg("toolTitle", "tango start")} ${theme.fg("accent", args.name)} ${theme.fg("muted", suffix)}`, `  ${theme.fg("dim", preview(args.task))}`]);
    },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Started"); },
  });

  pi.registerTool({
    name: "tango_ps",
    label: "Tango Ps",
    description: "List Tango agents for the current project/session. Wraps `tango ps --json`.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ default: false })),
      active: Type.Optional(Type.Boolean({ description: "Show active agents (running/created)." })),
      problems: Type.Optional(Type.Boolean({ description: "Show blocked/error agents." })),
      health: Type.Optional(Type.Boolean({ description: "Compact health view of active/problem agents." })),
      state: Type.Optional(Type.Array(Type.String({ description: "Filter by one or more states." }))),
      limit: Type.Optional(Type.Number({ description: "Maximum agents to return; defaults are model-safe." })),
      cwd: Type.Optional(Type.String({ description: "Project working directory to list agents for. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = addCwd(["ps", "--json"], params.cwd);
      if (params.all) args.push("--all");
      if (params.active) args.push("--active");
      if (params.problems) args.push("--problems");
      if (params.health) args.push("--health");
      for (const state of params.state ?? []) args.push("--state", state);
      if (params.limit !== undefined) args.push("--limit", String(params.limit));
      const out = toolResult(compactPsResult(await runTango(args, signal)));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", "tango ps"), 0, 0); },
    renderResult(result, options, theme) { return renderListResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_inspect",
    label: "Tango Inspect",
    description: "Inspect canonical Tango RunState for an agent. Wraps `tango inspect ... --json`.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      return toolResult(await runTango(addCwd(addTarget(["inspect"], params).concat("--json"), params.cwd), signal));
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango inspect")} ${theme.fg("accent", args.name)}`, 0, 0); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Inspect"); },
  });

  pi.registerTool({
    name: "tango_activity",
    label: "Tango Activity",
    description: "Inspect recent activity from a Tango agent. Wraps `tango activity ... --json`.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      lines: Type.Optional(Type.Number({ default: 200 })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      const result = await runTango(addCwd(addTarget(["activity"], params).concat(["--lines", String(params.lines ?? 200), "--json"]), params.cwd), signal);
      if (result.json?.output) {
        const truncated = truncateTail(String(result.json.output), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        result.json.output = truncated.content + (truncated.truncated ? "\n\n[Output truncated]" : "");
        result.stdout = JSON.stringify(result.json, null, 2);
      }
      return toolResult(result);
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango activity")} ${theme.fg("accent", args.name)} ${theme.fg("dim", `--lines ${args.lines ?? 200}`)}`, 0, 0); },
    renderResult(result, options, theme) { return renderLookResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_follow",
    label: "Tango Follow",
    description: "Follow a Tango agent until an explicit condition. Wraps `tango follow ... --json`.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      until: StringEnum(["terminal", "result-resolved", "attention"] as const),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      const args = addTarget(["follow"], params).concat(["--until", params.until, "--json"]);
      if (params.timeout !== undefined) args.push("--timeout", String(params.timeout));
      const out = toolResult(await runTango(addCwd(args, params.cwd), signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango follow")} ${theme.fg("accent", args.name)} ${theme.fg("dim", `--until ${args.until}`)}`, 0, 0); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Follow"); },
  });

  pi.registerTool({
    name: "tango_message",
    label: "Tango Message",
    description: "Send a follow-up message to an interactive Tango agent. Wraps `tango message ... --json`.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      message: Type.String(),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      const args = addTarget(["message"], params).concat([params.message, "--json"]);
      return toolResult(await runTango(addCwd(args, params.cwd), signal));
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango message")} ${theme.fg("accent", args.name)} ${theme.fg("dim", preview(args.message))}`, 0, 0); },
    renderResult(result, _options, theme) {
      if ((result as any).isError) return errorText(result, theme);
      return new Text(`${theme.fg("success", "→ Sent message")}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "tango_stop",
    label: "Tango Stop",
    description: "Stop a Tango agent. Wraps `tango stop ... --json`.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      const out = toolResult(await runTango(addCwd(addTarget(["stop"], params).concat("--json"), params.cwd), signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango stop")} ${theme.fg("accent", args.name)}`, 0, 0); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Stopped"); },
  });

  pi.registerTool({
    name: "tango_report",
    label: "Tango Report",
    description: "Report this Tango agent's state. Wraps `tango report ... --json`.",
    parameters: Type.Object({
      state: StringEnum(["running", "blocked", "done", "error", "stopped"] as const),
      message: Type.Optional(Type.String()),
      needs: Type.Optional(Type.String({ description: "Needed parent action for blocked/error statuses, e.g. decision, input, credentials, review, intervention." })),
      resultFile: Type.Optional(Type.String({ description: "Path to a full deliverable to copy into result.md when state is done. Required for interactive agents. The status message remains only a short operational summary." })),
      summaryOnly: Type.Optional(Type.Boolean({ description: "Explicitly complete without a result.md deliverable. Only valid with state=done for agents started with noResultRequired/no-result-required." })),
      runDir: Type.Optional(Type.String({ description: "Optional run directory; defaults to TANGO_RUN_DIR." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["report", params.state];
      if (params.message) args.push(params.message);
      if (params.needs) args.push("--needs", params.needs);
      if (params.resultFile) args.push("--result-file", params.resultFile);
      if (params.summaryOnly) args.push("--summary-only");
      if (params.runDir) args.push("--run-dir", params.runDir);
      args.push("--json");
      const out = toolResult(await runTango(args, signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango report")} ${theme.fg(statusColor(args.state), `${statusIcon(args.state)} ${args.state}`)} ${theme.fg("dim", preview(args.message ?? ""))}`, 0, 0); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Report"); },
  });

  pi.registerTool({
    name: "tango_result",
    label: "Tango Result",
    description: "Read a completed Tango agent result. Wraps `tango result ... --json`.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      const result = await runTango(addCwd(addTarget(["result"], params).concat("--json"), params.cwd), signal);
      if (result.json?.result) {
        const truncated = truncateTail(String(result.json.result), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        result.json.result = truncated.content + (truncated.truncated ? "\n\n[Result truncated]" : "");
        result.stdout = JSON.stringify(result.json, null, 2);
      }
      return toolResult(result);
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango result")} ${theme.fg("accent", args.name)}`, 0, 0); },
    renderResult(result, options, theme) { return renderResultResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_children",
    label: "Tango Children",
    description: "List child agents by Tango lineage. Wraps `tango children --json`.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Parent agent name. Optional inside a Tango agent when runDir/env identifies the parent." })),
      runId: Type.Optional(Type.String({ description: "Stable parent run ID." })),
      runDir: Type.Optional(Type.String({ description: "Stable parent run directory." })),
      tree: Type.Optional(Type.Boolean({ default: false })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the parent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const args = addTarget(["children"], params).concat("--json");
      if (params.tree) args.push("--tree");
      return toolResult(await runTango(addCwd(args, params.cwd), signal));
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango children")} ${theme.fg("accent", args.name ?? args.runId ?? args.runDir ?? "current")}`, 0, 0); },
    renderResult(result, options, theme) { return renderListResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_cli",
    label: "Tango CLI",
    description: "Generic safe wrapper for the Tango CLI. Use for Tango features not exposed by dedicated tools. Blocks interactive `attach`.",
    parameters: Type.Object({ args: Type.Array(Type.String({ description: "Argument passed to tango, excluding the tango binary." })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const command = params.args[0];
      const allowed = new Set(["start", "ps", "inspect", "activity", "follow", "message", "stop", "delete", "report", "result", "roles", "children", "doctor", "metrics", "reconcile", "recover"]);
      if (!command || !allowed.has(command)) {
        return { content: [{ type: "text" as const, text: `Unsupported tango command: ${command ?? "<empty>"}` }], details: { ok: false, command }, isError: true };
      }
      const result = await runTango(withJson(params.args), signal);
      const out = toolResult(command === "ps" ? compactPsResult(result) : result);
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango")} ${theme.fg("muted", args.args.join(" "))}`, 0, 0); },
    renderResult(result, options, theme) {
      if ((result as any).isError) return errorText(result, theme);
      if (!options.expanded) return new Text(theme.fg("success", "✓ tango command completed"), 0, 0);
      const details = (result.details ?? {}) as any;
      return new Text(details.stdout ?? JSON.stringify(details, null, 2), 0, 0);
    },
  });

  pi.registerCommand("tango-ps", {
    description: "List Tango agents",
    handler: async (_args, ctx) => {
      const result = await runTango(["ps"], ctx.signal);
      ctx.ui.notify(result.stdout || result.stderr, result.code === 0 ? "info" : "error");
    },
  });
}
