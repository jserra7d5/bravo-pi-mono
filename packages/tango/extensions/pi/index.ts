import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const distCli = join(packageRoot, "dist", "cli.js");
const includeRoot = join(packageRoot, "includes");

type ExecResult = { code: number; stdout: string; stderr: string; json?: any };
type NotifyLevel = "info" | "error" | "warning" | "success";

let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let liveWidgetTimer: ReturnType<typeof setInterval> | undefined;

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

function renderBoardResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const counts = result.details?.counts ?? {};
  const summary = `Tango board: ${counts.active ?? 0} running · ${counts.blocked ?? 0} blocked · ${counts.unread ?? 0} unread`;
  if (!expanded) return new Text(theme.fg("toolTitle", summary), 0, 0);
  const lines = [theme.fg("toolTitle", summary), ""];
  for (const section of ["active", "blocked", "unreadResults", "recentErrors"]) {
    const items = result.details?.[section] ?? [];
    if (!items.length) continue;
    lines.push(theme.fg("accent", section));
    for (const item of items) lines.push(`  ${theme.fg(statusColor(item.status), statusIcon(item.status))} ${item.name} ${theme.fg("muted", item.summary ?? item.activity ?? "")}`);
  }
  return new Text(lines.join("\n"), 0, 0);
}

function renderInboxResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  if (result.isError) return errorText(result, theme);
  const items = result.details?.inbox ?? (result.details?.item ? [result.details.item] : []);
  const unread = items.filter((item: any) => item.state === "unread").length;
  const summary = `Tango inbox: ${unread} unread · ${items.length} total`;
  if (!expanded) return new Text(theme.fg("toolTitle", summary), 0, 0);
  const lines = [theme.fg("toolTitle", summary), ""];
  for (const item of items) lines.push(`${theme.fg("accent", item.inboxId)} ${item.state} ${item.type} ${item.source?.agentName ?? ""}: ${preview(item.summary ?? item.body ?? "", 160)}`);
  if (!items.length) lines.push(theme.fg("dim", "No inbox items."));
  return new Text(lines.join("\n"), 0, 0);
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
  if (Array.isArray(result.details?.results)) return renderResultListResult(result, { expanded }, theme);
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

function renderResultListResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
  const results = result.details?.results ?? [];
  const count = results.length;
  if (!expanded) {
    const label = count === 1 ? "1 result" : `${count} results`;
    const first = results[0];
    const suffix = first ? ` · ${first.agent?.name ?? "agent"}: ${firstLine(first.result ?? first.agent?.summary ?? "")}` : "";
    return new Text(`${theme.fg(count ? "success" : "muted", count ? "✓" : "○")} ${theme.fg("accent", "Tango results")} ${theme.fg("muted", label + suffix)}`, 0, 0);
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
  return `tango_activity(${target}, lines: 120) or tango_inbox(action: "handled", inboxId: "${item.inboxId}")`;
}

function inboxWakeText(item: any): string {
  const name = item.source?.agentName ?? item.source?.runId ?? item.source?.runDir ?? "Tango agent";
  const summary = item.summary ?? item.body ?? item.type;
  return `Tango ${item.type}: ${name} — ${summary}\nNext: ${inboxAction(item)}`;
}

function inboxNotifyLevel(item: any): NotifyLevel {
  if (item.type === "error" || item.type === "offline") return "error";
  if (item.type === "blocked" || item.type === "stalled" || item.urgent) return "warning";
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
  const title = `${theme.fg(color, "◆ Tango")} ${theme.fg("muted", channel)} ${theme.fg(color, type)} ${theme.fg("dim", agent)}`;
  const lines = [title];
  if (item.summary) lines.push(`  ${item.summary}`);
  if (item.body && (expanded || !item.summary)) lines.push(`  ${theme.fg("muted", preview(item.body, expanded ? 500 : 160))}`);
  if (expanded) {
    if (item.inboxId) lines.push(theme.fg("dim", `  inbox: ${item.inboxId} (${item.state ?? "unknown"})`));
    if (item.source?.runId) lines.push(theme.fg("dim", `  run: ${item.source.runId}`));
    lines.push(theme.fg("dim", `  next: ${inboxAction(item)}`));
  } else {
    lines.push(theme.fg("dim", `  ${inboxAction(item)}`));
  }
  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

async function checkInboxOnce(pi: ExtensionAPI, ctx: any, signal?: AbortSignal) {
  const recipient = currentRecipient();
  if (!ownsCurrentLease(recipient)) return;
  const result = await runTango(["inbox", "--json"], signal);
  if (result.code !== 0) return;
  const items = Array.isArray(result.json?.inbox) ? result.json.inbox : [];
  for (const item of items) {
    if (!ownsCurrentLease(recipient)) return;
    if (item.state === "handled" || item.state === "dismissed") continue;
    if (!isLocalWakeItem(item)) continue;
    if (deliveredInboxIds.has(item.inboxId)) continue;
    try {
      const level = inboxNotifyLevel(item);
      if (ctx?.hasUI) ctx.ui.notify(`${item.source?.agentName ?? "Tango agent"}: ${item.summary ?? item.type}`, level);
      pi.sendMessage({
        customType: "tango-message",
        content: inboxWakeText(item),
        display: true,
        details: { channel: "inbox", item },
      }, { deliverAs: "followUp", triggerTurn: true });
      deliveredInboxIds.add(item.inboxId);
    } catch {}
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
    void runTango(["reconcile", "--children", "--json"], ctx?.signal).then(() => updateFooterStatus(ctx, ctx?.signal)).catch(() => {});
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

function isLiveVisible(item: any, now = Date.now()): boolean {
  if (["running", "created", "blocked", "stalled", "offline", "error"].includes(item.status)) return true;
  if (item.unread || item.resultReady) return true;
  const updated = Date.parse(item.updatedAt ?? "");
  if (!Number.isFinite(updated)) return false;
  const age = now - updated;
  if (item.status === "done") return age <= terminalHandledGraceMs;
  if (item.status === "stopped") return age <= terminalUnactionableGraceMs;
  return false;
}

function livePriority(item: any): number {
  if (item.status === "blocked" || item.status === "error") return 0;
  if (item.unread || item.resultReady) return 1;
  if (item.status === "running" || item.status === "created") return 2;
  return 3;
}

function boardRow(item: any, theme?: any): string {
  const effective = item.unread || item.resultReady ? "done" : item.status;
  const icon = statusIcon(effective);
  const marker = `${item.modeMarker ?? (item.mode === "interactive" ? "↔" : "→")}${item.delegationMarker ? ` ${item.delegationMarker}` : ""}`;
  const status = item.unread || item.resultReady ? "result" : item.status;
  const summary = item.needs ?? item.summary ?? item.activity ?? "";
  const name = `${item.name ?? "agent"}`;
  const role = item.role ? `${item.role} ` : "";
  const base = `${icon} ${marker} ${role}${name}`;
  const tail = `${status}${summary ? ` · ${preview(summary, 52)}` : ""}${aggregateText(item.descendantAggregate)}`;
  if (!theme) return `${base} ${tail}`;
  return `${theme.fg(statusColor(effective), icon)} ${theme.fg("accent", marker)} ${theme.fg("toolTitle", role)}${theme.fg("accent", name)} ${theme.fg(statusColor(effective), status)}${tail.replace(status, "")}`;
}

async function refreshLiveWidget(ctx: any, signal?: AbortSignal) {
  if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
  const args = ["board", "--json"];
  if (process.env.TANGO_RUN_ID) args.push("--run-id", process.env.TANGO_RUN_ID);
  else if (process.env.TANGO_RUN_DIR) args.push("--run-dir", process.env.TANGO_RUN_DIR);
  const result = await runTango(args, signal);
  if (result.code !== 0) return;
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
  const results = local.filter((item: any) => item.unread || item.resultReady).length;
  ctx.ui.setWidget("tango-live", (_tui: any, theme: any) => ({
    invalidate() {},
    render() {
      const header = `${theme.fg("accent", "◆ Tango")} ${theme.fg("muted", `${active} active · ${blocked} blocked · ${results} result`)}`;
      return [header, ...local.slice(0, 3).map((item: any) => `  ${boardRow(item, theme)}`)];
    },
  }), { placement: "belowEditor" });
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
      const suffix = args.thinking ? `as ${args.role}, thinking ${args.thinking}` : `as ${args.role}`;
      return textBlock([`${theme.fg("toolTitle", "tango start")} ${theme.fg("accent", targetLabel(args))} ${theme.fg("muted", suffix)}`, `  ${theme.fg("dim", preview(args.task))}`]);
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
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", "tango board"), 0, 0); },
    renderResult(result, options, theme) { return renderBoardResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_inbox",
    label: "Tango Inbox",
    description: "List or update Tango inbox items. Wraps `tango inbox --json` and `tango inbox read|handled|dismiss`.",
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
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango inbox")} ${theme.fg("accent", args.action ?? "list")}`, 0, 0); },
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
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango inspect")} ${theme.fg("accent", targetLabel(args))}`, 0, 0); },
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
      const out = toolResult(result);
      return out;
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango activity")} ${theme.fg("accent", targetLabel(args))} ${theme.fg("dim", `--lines ${args.lines ?? 200}`)}`, 0, 0); },
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
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango follow")} ${theme.fg("accent", targetLabel(args))} ${theme.fg("dim", `--until ${args.until}`)}`, 0, 0); },
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
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango wait")} ${theme.fg("accent", args.until)} ${theme.fg("dim", args.mode ?? "all")}`, 0, 0); },
    renderResult(result, _options, theme) {
      if ((result as any).isError) return errorText(result, theme);
      const d = (result as any).details ?? {};
      return new Text(`${theme.fg(d.timeout ? "warning" : "success", d.timeout ? "…" : "✓")} tango wait ${d.condition}: ${d.matched?.length ?? 0} matched · ${d.pending?.length ?? 0} pending`, 0, 0);
    },
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
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango message")} ${theme.fg("accent", targetLabel(args))} ${theme.fg("dim", preview(args.message))}`, 0, 0); },
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
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango stop")} ${theme.fg("accent", targetLabel(args))}`, 0, 0); },
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
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango result")} ${theme.fg("accent", targetLabel(args))}`, 0, 0); },
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
