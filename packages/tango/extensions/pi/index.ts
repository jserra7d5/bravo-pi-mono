import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const distCli = join(packageRoot, "dist", "cli.js");
const includeRoot = join(packageRoot, "includes");

type ExecResult = { code: number; stdout: string; stderr: string; json?: any };
type NotifyLevel = "info" | "error" | "warning" | "success";

let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let liveWidgetTimer: ReturnType<typeof setInterval> | undefined;

function signalWithTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const cleanup = () => clearTimeout(timer);
  controller.signal.addEventListener("abort", cleanup, { once: true });
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function passiveDelayMs(failures: number): number {
  return Math.min(30_000, 2_000 * Math.max(1, 2 ** Math.min(failures, 4)));
}

async function runPassiveTango(args: string[], parentSignal?: AbortSignal, timeoutMs = 1500): Promise<ExecResult> {
  return runTango(args, signalWithTimeout(parentSignal, timeoutMs));
}

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
    { command: process.execPath, args: [distCli, ...args] },
    { command: "tango", args },
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

function conciseToolContent(json: any, fallback: string): string {
  if (!json || typeof json !== "object") return fallback;
  if (typeof json.result === "string" && json.agent) return json.result;
  if (Array.isArray(json.results)) return json.results.length ? `${json.results.length} Tango result${json.results.length === 1 ? "" : "s"}` : "No unread Tango results.";
  if (json.output !== undefined && json.agent) {
    const status = json.agent.status ?? "unknown";
    const summary = json.agent.summary ?? json.activity?.latestSource ?? "activity available";
    return `${json.agent.name ?? "agent"}: ${status}${summary ? ` — ${preview(summary, 68)}` : ""}`;
  }
  if (Array.isArray(json.agents)) return preview(`Tango agents: ${json.agents.length}${json.counts ? ` · ${Object.entries(json.counts).map(([k, v]) => `${v} ${k}`).join(" · ")}` : ""}`, 88);
  if (json.counts) return `Tango board: ${json.counts.active ?? 0} active · ${json.counts.blocked ?? 0} blocked · ${json.counts.unreadResults ?? 0} result`;
  if (json.condition && Array.isArray(json.matched)) return `tango wait ${json.condition}: ${json.matched.length} matched · ${json.pending?.length ?? 0} pending`;
  if (json.agent?.name) return `${json.agent.name}: ${json.agent.status ?? json.state?.agent?.state ?? "ok"}`;
  if (json.ok === true) return "Tango command completed.";
  return fallback;
}

function toolResult(result: ExecResult) {
  if (result.code !== 0) {
    return {
      content: [{ type: "text" as const, text: result.stderr || result.stdout || `tango exited ${result.code}` }],
      details: result.json ?? { ok: false, code: result.code, stdout: result.stdout, stderr: result.stderr },
      isError: true,
    };
  }
  const fallback = result.stdout;
  return {
    content: [{ type: "text" as const, text: result.json ? conciseToolContent(result.json, fallback) : fallback }],
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
    case "idle": return "○";
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
    case "idle": return "success";
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
  return {
    invalidate() {},
    render(width: number) {
      return lines.map((line) => trunc(line, width));
    },
  };
}

function safeWidth(width: unknown): number {
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
}

function trunc(line: string, width: unknown): string {
  return truncateToWidth(line, safeWidth(width), "");
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
  const end = ["done", "blocked", "idle", "error", "stopped"].includes(agent.status) ? Date.parse(agent?.updatedAt ?? "") : Date.now();
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
  return `${agent?.role ?? "agent"} · ${agent?.mode ?? "?"}/${agent?.harness ?? "?"}${metrics ? ` · ${metrics}` : ""}`;
}

function commandLine(theme: any, command: string, target?: string, meta?: string): any {
  return textBlock([`${theme.fg("muted", "▸")} ${theme.fg("toolTitle", command)}${target ? ` ${theme.fg("accent", target)}` : ""}${meta ? ` ${theme.fg("dim", meta)}` : ""}`]);
}

function renderAgentResult(result: any, { expanded }: { expanded: boolean }, theme: any, title: string) {
  if (result.isError) return errorText(result, theme);
  const agent = result.details?.agent;
  if (!agent) return textBlock([theme.fg("success", `✓ ${title}`)]);
  const icon = statusIcon(agent.status);
  const color = statusColor(agent.status);
  const meta = agentSummary(agent);
  const task = firstLine(agent.summary ?? agent.task ?? "");
  const head = `${theme.fg(color, icon)} ${theme.fg("toolTitle", agent.name)} ${theme.fg(color, agent.status)} ${theme.fg("dim", `· ${meta}`)}${task ? theme.fg("muted", ` — ${preview(task, 72)}`) : ""}`;
  if (!expanded) return textBlock([head]);
  return textBlock([
    head,
    `  ${theme.fg("muted", "task")} ${preview(agent.task ?? "", 220)}`,
    agent.needs ? `  ${theme.fg("warning", "needs")} ${agent.needs}` : "",
    agent.metrics ? `  ${theme.fg("muted", "metrics")} ${metricsSummary(agent)}` : "",
    `  ${theme.fg("muted", "run")} ${theme.fg("dim", agent.runId ?? agent.runDir ?? "")}`,
  ].filter(Boolean));
}

function renderBoardResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const counts = result.details?.counts ?? {};
  const summary = `Tango board · ${counts.active ?? 0} active · ${counts.blocked ?? 0} blocked · ${counts.unreadResults ?? 0} results · ${counts.unread ?? 0} updates`;
  if (!expanded) return textBlock([`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", summary)}`]);
  const lines = [`${theme.fg("accent", "◆ Tango board")} ${theme.fg("muted", `${counts.active ?? 0} active · ${counts.blocked ?? 0} blocked · ${counts.unread ?? 0} updates`)}`];
  for (const [label, section] of [["Running", "active"], ["Needs attention", "blocked"], ["Results", "unreadResults"], ["Errors", "recentErrors"]] as const) {
    const items = result.details?.[section] ?? [];
    if (!items.length) continue;
    lines.push("", theme.fg("accent", label));
    for (const item of items.slice(0, 8)) lines.push(`  ${boardRow(item, theme)}`);
  }
  return textBlock(lines);
}

function renderInboxResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const items = result.details?.inbox ?? (result.details?.item ? [result.details.item] : []);
  const unread = items.filter((item: any) => item.state === "unread").length;
  const summary = `Tango updates · ${unread} unread · ${items.length} actionable`;
  if (!expanded) return textBlock([`${theme.fg(items.length ? "warning" : "success", items.length ? "◆" : "✓")} ${theme.fg("toolTitle", summary)}`]);
  const lines = [`${theme.fg("accent", "◆ Tango updates")} ${theme.fg("muted", `${unread} unread · ${items.length} actionable`)}`];
  for (const item of items) {
    const level = inboxNotifyLevel(item);
    const color = level === "error" ? "error" : level === "warning" ? "warning" : level === "success" ? "success" : "accent";
    lines.push(`${theme.fg(color, statusIcon(item.type === "result" ? "done" : item.type === "error" ? "error" : item.type === "blocked" ? "blocked" : "running"))} ${theme.fg("toolTitle", item.source?.agentName ?? "agent")} ${theme.fg(color, item.type)} ${theme.fg("muted", preview(item.summary ?? item.body ?? "", 110))}`);
    if (expanded) lines.push(`  ${theme.fg("dim", inboxAction(item))}`);
  }
  if (!items.length) lines.push(theme.fg("dim", "No actionable Tango updates."));
  return textBlock(lines);
}

function renderListResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const agents = result.details?.agents ?? [];
  const counts = agents.reduce((acc: Record<string, number>, a: any) => {
    acc[a.status ?? "unknown"] = (acc[a.status ?? "unknown"] ?? 0) + 1;
    return acc;
  }, {});
  const summary = `Tango agents · ${counts.running ?? 0} running · ${counts.blocked ?? 0} blocked · ${counts.done ?? 0} done · ${counts.error ?? 0} error`;
  if (!expanded) return textBlock([`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", summary)}`]);
  const lines = [`${theme.fg("accent", "◆ Tango agents")} ${theme.fg("muted", `${agents.length} shown`)}`];
  for (const a of agents) {
    const icon = theme.fg(statusColor(a.status), statusIcon(a.status));
    const metrics = metricsSummary(a);
    lines.push(`${icon} ${theme.fg("toolTitle", String(a.name))} ${theme.fg("muted", `${a.role ?? "-"} · ${a.mode}/${a.harness}`)} ${theme.fg(statusColor(a.status), a.status ?? "unknown")}${metrics ? ` ${theme.fg("dim", `· ${metrics}`)}` : ""}`);
  }
  if (!agents.length) lines.push(theme.fg("dim", "No Tango agents."));
  return textBlock(lines);
}

function parseActivityText(text: string): any | undefined {
  const trimmed = text.trim().replace(/^\[tool\]\s*/, "");
  if (!trimmed.startsWith("{")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function activitySummaryText(event: any): string | undefined {
  const text = String(event?.text ?? "").trim();
  if (!text || text.includes("[redacted reasoning signature]")) return undefined;
  const parsed = parseActivityText(text);
  if (!parsed) return text;
  if (parsed.type === "session") return `session started · ${parsed.cwd ?? ""}`.trim();
  if (parsed.type === "agent_start") return "agent started";
  if (parsed.type === "turn_start") return "turn started";
  const message = parsed.message ?? parsed.assistantMessageEvent?.partial;
  const role = message?.role;
  const content = Array.isArray(message?.content) ? message.content : [];
  const textPart = content.find((part: any) => part?.type === "text" && part.text)?.text;
  if (textPart) return `${role ?? "message"}: ${firstLine(textPart)}`;
  const eventType = parsed.assistantMessageEvent?.type ?? parsed.type;
  if (eventType === "thinking_start") return "assistant thinking";
  if (eventType === "message_start" || eventType === "message_end" || eventType === "message_update") return undefined;
  return undefined;
}

function renderActivityEventLine(event: any, theme: any): string {
  const kind = event?.kind ?? "log";
  const icon = kind === "tool" ? "▸" : kind === "assistant" ? "●" : kind === "user" ? "◌" : "·";
  const color = kind === "tool" ? "accent" : kind === "assistant" ? "success" : kind === "user" ? "warning" : "dim";
  return `${theme.fg(color, icon)} ${theme.fg("muted", kind)} ${preview(activitySummaryText(event) ?? "activity", 120)}`;
}

function renderLookResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const agent = result.details?.agent;
  const events = Array.isArray(result.details?.events) ? result.details.events : [];
  const activity = result.details?.activity;
  const status = agent?.status ?? "unknown";
  const headline = agent?.summary ?? (activity?.latestSource ? `latest: ${activity.latestSource}` : "activity available");
  if (!expanded) {
    return textBlock([`${theme.fg(statusColor(status), statusIcon(status))} ${theme.fg("toolTitle", agent?.name ?? "Tango activity")} ${theme.fg(statusColor(status), status)} ${theme.fg("muted", `· ${preview(headline, 90)}`)}`]);
  }
  const meaningful = events.map((event: any) => ({ event, text: activitySummaryText(event) })).filter((item: any) => item.text).slice(-80);
  return textBlock([
    `${theme.fg("accent", "◆ Tango activity")} ${theme.fg("toolTitle", agent?.name ?? "")}`,
    `${theme.fg(statusColor(status), statusIcon(status))} ${theme.fg(statusColor(status), status)}${headline ? theme.fg("muted", ` · ${preview(headline, 100)}`) : ""}`,
    activity?.sources?.length ? `${theme.fg("dim", "sources")} ${activity.sources.join(", ")}` : "",
    "",
    ...(meaningful.length ? meaningful.map((item: any) => renderActivityEventLine(item.event, theme)) : [theme.fg("dim", "No meaningful activity output.")]),
  ].filter(Boolean));
}

function renderResultResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  if (Array.isArray(result.details?.results)) return renderResultListResult(result, { expanded }, theme);
  const agent = result.details?.agent;
  const output = result.details?.result ?? "";
  const ready = result.details?.resultReady === true;
  const issue = result.details?.resultIssue;
  const warning = result.details?.resultWarning;
  const color = issue || !ready ? "warning" : warning ? "warning" : "success";
  const icon = issue || !ready ? "⚠" : warning ? "⚠" : "✓";
  const status = issue || !ready ? (issue || "not ready") : warning ? warning : "ready";
  const first = firstLine(output);
  if (!expanded) return textBlock([`${theme.fg(color, icon)} ${theme.fg("toolTitle", agent?.name ?? "agent")} ${theme.fg(color, "result")} ${theme.fg("muted", status)}${first && ready ? theme.fg("dim", ` · ${preview(first, 70)}`) : ""}`]);
  return textBlock([
    `${theme.fg("accent", "◆ Tango result")} ${theme.fg("toolTitle", agent?.name ?? "")}`,
    issue ? theme.fg("warning", `Result issue: ${issue}`) : "",
    warning ? theme.fg("warning", `Result warning: ${warning}`) : "",
    ready ? theme.fg("success", "Result ready") : theme.fg("warning", "Result not ready"),
    "",
    output || theme.fg("dim", "No result."),
  ].filter(Boolean));
}

function renderResultListResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  const results = result.details?.results ?? [];
  const count = results.length;
  if (!expanded) {
    const label = count === 1 ? "1 result" : `${count} results`;
    const first = results[0];
    const suffix = first ? ` · ${first.agent?.name ?? "agent"}: ${firstLine(first.result ?? first.agent?.summary ?? "")}` : "";
    return textBlock([`${theme.fg(count ? "success" : "muted", count ? "✓" : "○")} ${theme.fg("accent", "Tango results")} ${theme.fg("muted", label + suffix)}`]);
  }
  const lines = [`${theme.fg("toolTitle", "Tango results")} ${theme.fg("accent", String(count))}`];
  for (const item of results) {
    lines.push("", `${theme.fg("accent", item.agent?.name ?? "agent")} ${theme.fg("muted", item.resultState ?? "")}`);
    lines.push(item.result || item.agent?.summary || theme.fg("dim", "No result."));
  }
  if (!count) lines.push("", theme.fg("dim", "No unread results."));
  return textBlock(lines);
}

async function updateFooterStatus(ctx: any, signal?: AbortSignal) {
  if (!ctx?.hasUI) return;
  if (footerUpdateInFlight || Date.now() < footerUpdateSkipUntil) return;
  footerUpdateInFlight = true;
  try {
    const result = await runPassiveTango(["ps", "--json"], signal, 1500);
    if (result.code !== 0) throw new Error(result.stderr || `tango ps exited ${result.code}`);
    footerUpdateFailures = 0;
    footerUpdateSkipUntil = 0;
    const agents = result.json?.agents ?? [];
    const running = agents.filter((a: any) => a.status === "running").length;
    const idle = agents.filter((a: any) => a.status === "idle").length;
    const done = agents.filter((a: any) => a.status === "done").length;
    const tools = agents.reduce((sum: number, a: any) => sum + (typeof a.metrics?.toolCalls === "number" ? a.metrics.toolCalls : 0), 0);
    const tokens = agents.reduce((sum: number, a: any) => sum + (typeof a.metrics?.tokens?.total === "number" ? a.metrics.tokens.total : 0), 0);
    const suffix = [`${running} running`, idle ? `${idle} idle` : "", `${done} done`, tools ? `${tools} tools` : "", tokens ? formatTokens(tokens) : ""].filter(Boolean).join(" · ");
    ctx.ui.setStatus("tango", ctx.ui.theme.fg("dim", `Tango: ${suffix}`));
  } catch {
    footerUpdateFailures += 1;
    footerUpdateSkipUntil = Date.now() + passiveDelayMs(footerUpdateFailures);
  } finally {
    footerUpdateInFlight = false;
  }
}

function withJson(args: string[]): string[] {
  if (args.includes("--json")) return args;
  const jsonCommands = new Set(["start", "ps", "inspect", "activity", "follow", "wait", "message", "stop", "delete", "report", "result", "roles", "children", "doctor", "metrics", "reconcile", "recover"]);
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

function targetLabel(args: { name?: string; runId?: string; runDir?: string }): string {
  return args.name ?? args.runId ?? args.runDir ?? "<target>";
}

// Import durable lease store from compiled dist to keep the Pi extension
// aligned with the CLI runtime modules it already executes.
// @ts-ignore: dist has no declarations, but the module exists after build.
import { acquireRootOwnerLease, heartbeatRootOwnerLease, ownsRootLease, type RootOwnerLease } from "../../dist/leases.js";

let ownerId = `pi_${process.pid}_${randomBytes(4).toString("hex")}`;
let ownerLease: RootOwnerLease | undefined;
let leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
let inboxPollTimer: ReturnType<typeof setInterval> | undefined;
let footerUpdateInFlight = false;
let footerUpdateFailures = 0;
let footerUpdateSkipUntil = 0;
let inboxPollInFlight = false;
let inboxPollFailures = 0;
let inboxPollSkipUntil = 0;
let liveWidgetInFlight = false;
let liveWidgetFailures = 0;
let liveWidgetSkipUntil = 0;
let reconcileInFlight = false;
let reconcileFailures = 0;
let reconcileSkipUntil = 0;
const deliveredInboxIds = new Set<string>();
const localWakeRunIds = new Set<string>();
const localWakeRunDirs = new Set<string>();

type RootRecipient = {
  rootSessionId?: string;
  workstreamId?: string;
  cwd: string;
};

function currentRecipient(cwd = process.cwd()): RootRecipient {
  return {
    rootSessionId: process.env.TANGO_ROOT_SESSION_ID,
    workstreamId: process.env.TANGO_WORKSTREAM_ID,
    cwd: resolve(cwd),
  };
}

function acquireCurrentLease() {
  const recipient = currentRecipient();
  ownerLease = acquireRootOwnerLease({ ...recipient, ownerId, ttlMs: 10_000 });
}

function startLeaseHeartbeat() {
  if (leaseHeartbeatTimer) return;
  leaseHeartbeatTimer = setInterval(() => {
    try {
      const recipient = currentRecipient();
      ownerLease = heartbeatRootOwnerLease({ ...recipient, ownerId, ttlMs: 10_000 });
    } catch {}
  }, 3_000);
}

function stopLeaseHeartbeat() {
  if (leaseHeartbeatTimer) clearInterval(leaseHeartbeatTimer);
  leaseHeartbeatTimer = undefined;
}

function ownsCurrentLease(recipient = currentRecipient()): boolean {
  try { return ownsRootLease({ ...recipient, ownerId }); } catch { return false; }
}

function inboxAction(item: any): string {
  const runId = item.source?.runId;
  const runDir = item.source?.runDir;
  if (item.type === "result") return runId ? `tango_result(runId: ${runId})` : `tango_result(runDir: ${runDir})`;
  const target = runId ? `runId: ${runId}` : `runDir: ${runDir}`;
  const activity = `tango_activity(${target}, lines: 120)`;
  if (item.type === "blocked" || item.type === "ask") return `${activity} then tango_message(${target}, message: ...)`;
  return activity;
}

function inboxWakeText(item: any): string {
  const name = item.source?.agentName ?? item.source?.runId ?? item.source?.runDir ?? "Tango agent";
  const summary = item.summary ?? item.body ?? item.type;
  return `Tango ${item.type}: ${name} — ${summary}\nNext: ${inboxAction(item)}`;
}

function inboxNotifyLevel(item: any): NotifyLevel {
  if (item.type === "error" || item.type === "offline") return "error";
  if (item.type === "blocked" || item.urgent) return "warning";
  if (item.type === "stalled") return "info";
  if (item.type === "result") return "success";
  return "info";
}

function rememberLocalWakeTarget(result: ExecResult) {
  const meta = result.json?.agent ?? result.json?.metadata ?? result.json?.meta;
  const runId = meta?.runId ?? result.json?.runId ?? result.json?.identity?.runId;
  const runDir = meta?.runDir ?? result.json?.runDir ?? result.json?.identity?.runDir;
  if (runId) localWakeRunIds.add(runId);
  if (runDir) localWakeRunDirs.add(resolve(runDir));
}

function isLocalWakeItem(item: any): boolean {
  const parentRunId = process.env.TANGO_RUN_ID;
  const parentRunDir = process.env.TANGO_RUN_DIR ? resolve(process.env.TANGO_RUN_DIR) : undefined;
  if (parentRunId && item.recipient?.runId === parentRunId) return true;
  if (parentRunDir && item.recipient?.runDir && resolve(item.recipient.runDir) === parentRunDir) return true;
  if (item.source?.runId && localWakeRunIds.has(item.source.runId)) return true;
  if (item.source?.runDir && localWakeRunDirs.has(resolve(item.source.runDir))) return true;
  return false;
}

function renderTangoMessage(message: any, { expanded }: { expanded: boolean }, theme: any) {
  const details = message.details ?? {};
  const item = details.item ?? {};
  const channel = details.channel ?? "message";
  const type = item.type ?? details.type ?? "update";
  const level = inboxNotifyLevel(item);
  const color = level === "error" ? "error" : level === "warning" ? "warning" : level === "success" ? "success" : "accent";
  const agent = item.source?.agentName ?? item.source?.runId ?? item.source?.runDir ?? details.agent ?? "Tango";
  const title = `${theme.fg(color, "◆ Tango")} ${theme.fg(color, type)} ${theme.fg("toolTitle", agent)} ${theme.fg("muted", channel)}`;
  const lines = [title];
  if (item.summary) lines.push(`  ${theme.fg("muted", preview(item.summary, expanded ? 180 : 100))}`);
  if (item.body && (expanded || !item.summary)) lines.push(`  ${theme.fg("dim", preview(item.body, expanded ? 220 : 120))}`);
  lines.push(`  ${theme.fg("accent", "next")} ${theme.fg("dim", inboxAction(item))}`);
  if (expanded && item.source?.runId) lines.push(theme.fg("dim", `  run ${item.source.runId}`));
  return textBlock(lines);
}

async function refreshUnresolvedInboxItem(inboxId: string, signal?: AbortSignal): Promise<any | undefined> {
  const result = await runPassiveTango(["inbox", "--json"], signal, 1500);
  if (result.code !== 0) return undefined;
  const items = Array.isArray(result.json?.inbox) ? result.json.inbox : [];
  return items.find((item: any) => item.inboxId === inboxId && item.state === "unread");
}

async function checkInboxOnce(pi: ExtensionAPI, ctx: any, signal?: AbortSignal) {
  if (inboxPollInFlight || Date.now() < inboxPollSkipUntil) return;
  const recipient = currentRecipient();
  if (!ownsCurrentLease(recipient)) return;
  inboxPollInFlight = true;
  try {
    const result = await runPassiveTango(["inbox", "--json"], signal, 1500);
    if (result.code !== 0) throw new Error(result.stderr || `tango inbox exited ${result.code}`);
    inboxPollFailures = 0;
    inboxPollSkipUntil = 0;
    const items = Array.isArray(result.json?.inbox) ? result.json.inbox : [];
    for (const item of items) {
      if (!ownsCurrentLease(recipient)) return;
      if (item.state !== "unread") continue;
      if (!isLocalWakeItem(item)) continue;
      if (deliveredInboxIds.has(item.inboxId)) continue;
      const current = await refreshUnresolvedInboxItem(item.inboxId, signal);
      if (!current || !isLocalWakeItem(current)) continue;
      try {
        const level = inboxNotifyLevel(current);
        if (ctx?.hasUI) ctx.ui.notify(`${current.source?.agentName ?? "Tango agent"}: ${current.summary ?? current.type}`, level);
        pi.sendMessage({
          customType: "tango-message",
          content: inboxWakeText(current),
          display: true,
          details: { channel: "inbox", item: current },
        }, { deliverAs: "followUp", triggerTurn: true });
        deliveredInboxIds.add(current.inboxId);
      } catch {}
    }
  } catch {
    inboxPollFailures += 1;
    inboxPollSkipUntil = Date.now() + passiveDelayMs(inboxPollFailures);
  } finally {
    inboxPollInFlight = false;
  }
}

function startInboxPoller(pi: ExtensionAPI, ctx: any) {
  if (inboxPollTimer) return;
  void checkInboxOnce(pi, ctx, ctx?.signal);
  inboxPollTimer = setInterval(() => {
    void checkInboxOnce(pi, ctx, ctx?.signal).catch(() => {});
  }, 2_000);
}

function stopInboxPoller() {
  if (inboxPollTimer) clearInterval(inboxPollTimer);
  inboxPollTimer = undefined;
}

function startParentReconciler(ctx: any) {
  if (reconcileTimer || !process.env.TANGO_RUN_DIR) return;
  reconcileTimer = setInterval(() => {
    if (reconcileInFlight || Date.now() < reconcileSkipUntil) return;
    reconcileInFlight = true;
    void runPassiveTango(["reconcile", "--children", "--json"], ctx?.signal, 3000)
      .then((result) => {
        if (result.code !== 0) throw new Error(result.stderr || `tango reconcile exited ${result.code}`);
        reconcileFailures = 0;
        reconcileSkipUntil = 0;
        return updateFooterStatus(ctx, ctx?.signal);
      })
      .catch(() => {
        reconcileFailures += 1;
        reconcileSkipUntil = Date.now() + passiveDelayMs(reconcileFailures);
      })
      .finally(() => { reconcileInFlight = false; });
  }, 15_000);
}

function aggregateText(aggregate: any): string {
  if (!aggregate || !aggregate.total) return "";
  const parts = [
    aggregate.active ? `${aggregate.active} active` : "",
    aggregate.blocked ? `${aggregate.blocked} blocked` : "",
    aggregate.ready ? `${aggregate.ready} ready` : "",
    aggregate.error ? `${aggregate.error} error` : "",
    aggregate.stalled ? `${aggregate.stalled} stalled` : "",
    aggregate.offline ? `${aggregate.offline} offline` : "",
  ].filter(Boolean).join(" · ");
  return ` managing ${aggregate.total}${parts ? `: ${parts}` : ""}`;
}

const terminalHandledGraceMs = 2 * 60_000;
const terminalUnactionableGraceMs = 60_000;

function isLocalBoardItem(item: any): boolean {
  if (item.runId && localWakeRunIds.has(item.runId)) return true;
  if (item.runDir && localWakeRunDirs.has(resolve(item.runDir))) return true;
  if (process.env.TANGO_RUN_ID && item.parentRunId === process.env.TANGO_RUN_ID) return true;
  if (process.env.TANGO_RUN_DIR && item.parentRunDir && resolve(item.parentRunDir) === resolve(process.env.TANGO_RUN_DIR)) return true;
  return false;
}

function hasUnreadResult(item: any): boolean {
  return item.unread === true;
}

function isLiveVisible(item: any, now = Date.now()): boolean {
  if (["running", "created", "idle", "blocked", "stalled", "offline", "error"].includes(item.status)) return true;
  if (hasUnreadResult(item)) return true;
  const updated = Date.parse(item.updatedAt ?? "");
  if (!Number.isFinite(updated)) return false;
  const age = now - updated;
  if (item.status === "done") return age <= terminalHandledGraceMs;
  if (item.status === "stopped") return age <= terminalUnactionableGraceMs;
  return false;
}

function livePriority(item: any): number {
  if (item.status === "blocked" || item.status === "error") return 0;
  if (hasUnreadResult(item)) return 1;
  if (item.status === "running" || item.status === "created") return 2;
  return 3;
}

function boardRow(item: any, theme?: any): string {
  const effective = hasUnreadResult(item) ? "done" : item.status;
  const icon = statusIcon(effective);
  const marker = `${item.modeMarker ?? (item.mode === "interactive" ? "↔" : "→")}${item.delegationMarker ? ` ${item.delegationMarker}` : ""}`;
  const status = hasUnreadResult(item) ? "result" : item.status;
  const summary = item.needs ?? item.summary ?? item.activity ?? "";
  const name = `${item.name ?? "agent"}`;
  const role = item.role ? `${item.role}` : "agent";
  const plain = `${icon} ${marker} ${name} ${status} · ${role}${summary ? ` · ${preview(summary, 52)}` : ""}${aggregateText(item.descendantAggregate)}`;
  if (!theme) return plain;
  return `${theme.fg(statusColor(effective), icon)} ${theme.fg("accent", marker)} ${theme.fg("toolTitle", name)} ${theme.fg(statusColor(effective), status)} ${theme.fg("dim", `· ${role}`)}${summary ? theme.fg("muted", ` · ${preview(summary, 52)}`) : ""}${theme.fg("dim", aggregateText(item.descendantAggregate))}`;
}

function liveAgentCard(item: any, theme: any): string[] {
  const effective = hasUnreadResult(item) ? "done" : item.status;
  const color = statusColor(effective);
  const icon = statusIcon(effective);
  const marker = item.modeMarker ?? (item.mode === "interactive" ? "↔" : "→");
  const status = hasUnreadResult(item) ? "result" : item.status;
  const meta = [item.role, marker, item.activity].filter(Boolean).join(" · ");
  const summary = item.needs ?? item.summary ?? "";
  return [`${theme.fg(color, icon)} ${theme.fg("toolTitle", item.name ?? "agent")} ${theme.fg(color, status)} ${theme.fg("dim", `· ${meta}`)}${summary ? theme.fg("muted", ` — ${preview(summary, 64)}`) : ""}`];
}

async function refreshLiveWidget(ctx: any, signal?: AbortSignal) {
  if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
  if (liveWidgetInFlight || Date.now() < liveWidgetSkipUntil) return;
  liveWidgetInFlight = true;
  try {
    const args = ["board", "--json"];
    if (process.env.TANGO_RUN_ID) args.push("--run-id", process.env.TANGO_RUN_ID);
    else if (process.env.TANGO_RUN_DIR) args.push("--run-dir", process.env.TANGO_RUN_DIR);
    const result = await runPassiveTango(args, signal, 1500);
    if (result.code !== 0) throw new Error(result.stderr || `tango board exited ${result.code}`);
    liveWidgetFailures = 0;
    liveWidgetSkipUntil = 0;
    const direct = result.json?.tree?.directChildren ?? [];
    const now = Date.now();
    const local = direct
      .filter(isLocalBoardItem)
      .filter((item: any) => isLiveVisible(item, now))
      .sort((a: any, b: any) => livePriority(a) - livePriority(b) || Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
    if (!local.length) {
      ctx.ui.setWidget("tango-live", undefined);
      return;
    }
    const active = local.filter((item: any) => item.status === "running" || item.status === "created").length;
    const blocked = local.filter((item: any) => item.status === "blocked").length;
    const results = local.filter((item: any) => hasUnreadResult(item)).length;
    ctx.ui.setWidget("tango-live", (_tui: any, theme: any) => ({
      invalidate() {},
      render(width: number) {
        const header = `${theme.fg("accent", "◆ Tango")} ${theme.fg("muted", `${active} active · ${blocked} blocked · ${results} result`)}`;
        const lines = [header];
        for (const item of local.slice(0, 4)) lines.push(...liveAgentCard(item, theme));
        if (local.length > 4) lines.push(theme.fg("dim", `+${local.length - 4} more`));
        return lines.map((line) => trunc(line, width));
      },
    }), { placement: "belowEditor" });
  } catch {
    liveWidgetFailures += 1;
    liveWidgetSkipUntil = Date.now() + passiveDelayMs(liveWidgetFailures);
  } finally {
    liveWidgetInFlight = false;
  }
}

function startLiveWidget(ctx: any) {
  if (liveWidgetTimer || !ctx?.hasUI) return;
  void refreshLiveWidget(ctx, ctx?.signal).catch(() => {});
  liveWidgetTimer = setInterval(() => void refreshLiveWidget(ctx, ctx?.signal).catch(() => {}), 2_000);
}

function stopLiveWidget() {
  if (liveWidgetTimer) clearInterval(liveWidgetTimer);
  liveWidgetTimer = undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("tango-message", renderTangoMessage);

  pi.on("session_start", async (_event, ctx) => {
    try { ensureRootSessionRecord(); } catch {}
    if (ctx.hasUI) ctx.ui.setStatus("tango", ctx.ui.theme.fg("dim", "Tango: ready"));
    try { acquireCurrentLease(); } catch {}
    startLeaseHeartbeat();
    startInboxPoller(pi, ctx);
    startParentReconciler(ctx);
    startLiveWidget(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopInboxPoller();
    stopLiveWidget();
    stopLeaseHeartbeat();
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
      const result = await runTango(args, signal);
      if (result.code === 0) rememberLocalWakeTarget(result);
      const out = toolResult(result);
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) {
      const meta = `${args.role}${args.mode ? ` · ${args.mode}` : ""}${args.thinking ? ` · ${args.thinking}` : ""}`;
      return textBlock([`${theme.fg("muted", "▸")} ${theme.fg("toolTitle", "tango start")} ${theme.fg("accent", targetLabel(args))} ${theme.fg("dim", meta)}${args.task ? theme.fg("muted", ` — ${preview(args.task, 90)}`) : ""}`]);
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
    renderCall(_args, theme) { return commandLine(theme, "tango ps"); },
    renderResult(result, options, theme) { return renderListResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_board",
    label: "Tango Board",
    description: "Show the current Tango coordination board. Wraps `tango board --json`.",
    parameters: Type.Object({
      rootSessionId: Type.Optional(Type.String()),
      workstreamId: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String()),
      runDir: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["board", "--json"];
      if (params.rootSessionId) args.push("--root-session-id", params.rootSessionId);
      if (params.workstreamId) args.push("--workstream-id", params.workstreamId);
      if (params.runId) args.push("--run-id", params.runId);
      if (params.runDir) args.push("--run-dir", params.runDir);
      const out = toolResult(await runTango(args, signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(_args, theme) { return commandLine(theme, "tango board"); },
    renderResult(result, options, theme) { return renderBoardResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_inbox",
    label: "Tango Inbox",
    description: "List Tango update items. Manual read/handled/dismiss actions are admin/debug escape hatches; normal Pi UX should consume updates via tango_result or tango_activity.",
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["list", "read", "handled", "dismiss"] as const)),
      inboxId: Type.Optional(Type.String()),
      rootSessionId: Type.Optional(Type.String()),
      workstreamId: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String()),
      runDir: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const action = params.action ?? "list";
      const args = ["inbox"];
      if (action !== "list") {
        if (!params.inboxId) return { content: [{ type: "text" as const, text: "inboxId is required for inbox actions" }], details: { ok: false }, isError: true };
        args.push(action, params.inboxId);
      }
      args.push("--json");
      if (params.rootSessionId) args.push("--root-session-id", params.rootSessionId);
      if (params.workstreamId) args.push("--workstream-id", params.workstreamId);
      if (params.runId) args.push("--run-id", params.runId);
      if (params.runDir) args.push("--run-dir", params.runDir);
      const out = toolResult(await runTango(args, signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return commandLine(theme, "tango updates", args.action ?? "list"); },
    renderResult(result, options, theme) { return renderInboxResult(result, options, theme); },
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
    renderCall(args, theme) { return commandLine(theme, "tango inspect", targetLabel(args)); },
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
      peek: Type.Optional(Type.Boolean({ description: "Inspect without marking matching inbox items read/handled." })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      const activityArgs = addTarget(["activity"], params).concat(["--lines", String(params.lines ?? 200), "--json"]);
      if (params.peek) activityArgs.push("--peek");
      const result = await runTango(addCwd(activityArgs, params.cwd), signal);
      if (result.json?.output) {
        const truncated = truncateTail(String(result.json.output), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        result.json.output = truncated.content + (truncated.truncated ? "\n\n[Output truncated]" : "");
        result.stdout = JSON.stringify(result.json, null, 2);
      }
      const out = toolResult(result);
      return out;
    },
    renderCall(args, theme) { return commandLine(theme, "tango activity", targetLabel(args), `${args.lines ?? 200} lines${args.peek ? " · peek" : ""}`); },
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
    renderCall(args, theme) { return commandLine(theme, "tango follow", targetLabel(args), args.until); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Follow"); },
  });

  pi.registerTool({
    name: "tango_wait",
    label: "Tango Wait",
    description: "Wait for one or more Tango agents until a synchronization condition. Wraps `tango wait ... --json`.",
    parameters: Type.Object({
      names: Type.Optional(Type.Array(Type.String())),
      runIds: Type.Optional(Type.Array(Type.String({ description: "Stable Tango run IDs." }))),
      runDirs: Type.Optional(Type.Array(Type.String({ description: "Stable Tango run directories." }))),
      until: StringEnum(["terminal", "result-ready", "attention", "blocked", "error", "settled", "inbox"] as const),
      mode: Type.Optional(StringEnum(["any", "all"] as const)),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve agent names. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["wait", ...(params.names ?? [])];
      for (const runId of params.runIds ?? []) args.push("--run-id", runId);
      for (const runDir of params.runDirs ?? []) args.push("--run-dir", runDir);
      args.push("--until", params.until, "--mode", params.mode ?? "all", "--json");
      if (params.timeout !== undefined) args.push("--timeout", String(params.timeout));
      const out = toolResult(await runTango(addCwd(args, params.cwd), signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return commandLine(theme, "tango wait", args.until, args.mode ?? "all"); },
    renderResult(result, _options, theme) {
      if ((result as any).isError) return errorText(result, theme);
      const d = (result as any).details ?? {};
      return textBlock([`${theme.fg(d.timeout ? "warning" : "success", d.timeout ? "…" : "✓")} ${theme.fg("toolTitle", "tango wait")} ${theme.fg("muted", `${d.condition}: ${d.matched?.length ?? 0} matched · ${d.pending?.length ?? 0} pending`)}`]);
    },
  });

  pi.registerTool({
    name: "tango_message",
    label: "Tango Message",
    description: "Send a follow-up message to a non-terminal interactive Tango agent. Terminal done/error/stopped runs reject messages by default; use a new reusable idle session/task instead."
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      message: Type.String(),
      type: Type.Optional(StringEnum(["instruction", "ask", "update", "broadcast"] as const)),
      urgent: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const error = requireNameOrTarget(params);
      if (error) return { content: [{ type: "text" as const, text: error }], details: { ok: false, error }, isError: true };
      const args = addTarget(["message"], params).concat([params.message, "--json"]);
      if (params.type) args.push("--type", params.type);
      if (params.urgent) args.push("--urgent");
      return toolResult(await runTango(addCwd(args, params.cwd), signal));
    },
    renderCall(args, theme) { return commandLine(theme, "tango message", targetLabel(args), preview(args.message, 90)); },
    renderResult(result, _options, theme) {
      if ((result as any).isError) return errorText(result, theme);
      return textBlock([`${theme.fg("success", "→")} ${theme.fg("toolTitle", "message sent")}`]);
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
    renderCall(args, theme) { return commandLine(theme, "tango stop", targetLabel(args)); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Stopped"); },
  });

  pi.registerTool({
    name: "tango_report",
    label: "Tango Report",
    description: "Report this Tango agent's state. `done` terminalizes the run/session; reusable interactive agents should use checkpoints while working and `idle` when a task is complete but the session should remain retaskable.",
    parameters: Type.Object({
      state: StringEnum(["running", "idle", "blocked", "done", "error", "stopped"] as const),
      message: Type.Optional(Type.String()),
      needs: Type.Optional(Type.String({ description: "Needed parent action for blocked/error statuses, e.g. decision, input, credentials, review, intervention." })),
      resultFile: Type.Optional(Type.String({ description: "Path to a full deliverable to copy into result.md when state is done or idle. Use idle for reusable interactive task completion without closing the session." })),
      summaryOnly: Type.Optional(Type.Boolean({ description: "Explicitly complete without a result.md deliverable. Only valid with state=done or state=idle for agents started with noResultRequired/no-result-required." })),
      checkpoint: Type.Optional(Type.String({ description: "Durable non-terminal checkpoint summary. Typically use with state=running." })),
      checkpointFile: Type.Optional(Type.String({ description: "Path to a checkpoint body/file to surface in tango activity without finalizing a result." })),
      runDir: Type.Optional(Type.String({ description: "Optional run directory; defaults to TANGO_RUN_DIR." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["report", params.state];
      if (params.message) args.push(params.message);
      if (params.needs) args.push("--needs", params.needs);
      if (params.resultFile) args.push("--result-file", params.resultFile);
      if (params.summaryOnly) args.push("--summary-only");
      if (params.checkpoint) args.push("--checkpoint", params.checkpoint);
      if (params.checkpointFile) args.push("--checkpoint-file", params.checkpointFile);
      if (params.runDir) args.push("--run-dir", params.runDir);
      args.push("--json");
      const out = toolResult(await runTango(args, signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return commandLine(theme, "tango report", `${statusIcon(args.state)} ${args.state}`, preview(args.message ?? "", 90)); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Report"); },
  });

  pi.registerTool({
    name: "tango_result",
    label: "Tango Result",
    description: "Read Tango result content. Supports one target, --unread, or --inbox. Wraps `tango result ... --json`; result content is not Tango-truncated.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String({ description: "Stable Tango run ID. Preferred when known." })),
      runDir: Type.Optional(Type.String({ description: "Stable Tango run directory. Preferred when known." })),
      inboxId: Type.Optional(Type.String({ description: "Read the result associated with one inbox item." })),
      unread: Type.Optional(Type.Boolean({ description: "Read all unread result inbox items in scope." })),
      peek: Type.Optional(Type.Boolean({ description: "Read without marking result inbox items handled." })),
      rootSessionId: Type.Optional(Type.String()),
      workstreamId: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const targetCount = [!!params.name || !!params.runId || !!params.runDir, !!params.inboxId, !!params.unread].filter(Boolean).length;
      if (targetCount !== 1) return { content: [{ type: "text" as const, text: "Provide exactly one of name/runId/runDir, inboxId, or unread." }], details: { ok: false }, isError: true };
      const args = addTarget(["result"], params);
      if (params.inboxId) args.push("--inbox", params.inboxId);
      if (params.unread) args.push("--unread");
      if (params.peek) args.push("--peek");
      if (params.rootSessionId) args.push("--root-session-id", params.rootSessionId);
      if (params.workstreamId) args.push("--workstream-id", params.workstreamId);
      args.push("--json");
      return toolResult(await runTango(addCwd(args, params.cwd), signal));
    },
    renderCall(args, theme) { return commandLine(theme, "tango result", args.unread ? "unread" : args.inboxId ? "inbox" : targetLabel(args), args.peek ? "peek" : undefined); },
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
    renderCall(args, theme) { return commandLine(theme, "tango children", args.name ?? args.runId ?? args.runDir ?? "current"); },
    renderResult(result, options, theme) { return renderListResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_cli",
    label: "Tango CLI",
    description: "Generic safe wrapper for the Tango CLI. Use for Tango features not exposed by dedicated tools. Blocks interactive `attach`.",
    parameters: Type.Object({ args: Type.Array(Type.String({ description: "Argument passed to tango, excluding the tango binary." })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const command = params.args[0];
      const allowed = new Set(["start", "ps", "inspect", "activity", "follow", "wait", "message", "stop", "delete", "report", "result", "board", "inbox", "roles", "children", "doctor", "metrics", "reconcile", "recover"]);
      if (!command || !allowed.has(command)) {
        return { content: [{ type: "text" as const, text: `Unsupported tango command: ${command ?? "<empty>"}` }], details: { ok: false, command }, isError: true };
      }
      const result = await runTango(withJson(params.args), signal);
      if (command === "start" && result.code === 0) rememberLocalWakeTarget(result);
      const out = toolResult(command === "ps" ? compactPsResult(result) : result);
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return commandLine(theme, "tango", undefined, args.args.join(" ")); },
    renderResult(result, options, theme) {
      if ((result as any).isError) return errorText(result, theme);
      if (!options.expanded) return textBlock([theme.fg("success", "✓ tango command completed")]);
      const details = (result.details ?? {}) as any;
      return textBlock(String(details.stdout ?? JSON.stringify(details, null, 2)).split(/\r?\n/));
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
