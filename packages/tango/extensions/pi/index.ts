import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
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
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let pendingEvents: any[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const deliveredEvents = loadDeliveredEvents();

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
  if (!expanded) return new Text(`${theme.fg("success", "✓")} ${theme.fg("accent", agent?.name ?? "agent")} result ${theme.fg("muted", firstLine(output))}`, 0, 0);
  return textBlock([`${theme.fg("toolTitle", "Tango result")} ${theme.fg("accent", agent?.name ?? "")}`, "", output || theme.fg("dim", "No result.")]);
}

async function updateFooterStatus(ctx: any, signal?: AbortSignal) {
  if (!ctx?.hasUI) return;
  const result = await runTango(["list", "--json"], signal);
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
  const jsonCommands = new Set(["start", "list", "look", "message", "stop", "delete", "status", "result", "roles", "children", "wait", "doctor", "metrics", "reconcile"]);
  return args[0] && jsonCommands.has(args[0]) ? [...args, "--json"] : args;
}

function addCwd(args: string[], cwd?: string): string[] {
  return cwd ? [...args, "--cwd", cwd] : args;
}

function deliveryStatePath(): string {
  const root = process.env.TANGO_HOME || join(process.env.HOME || process.cwd(), ".tango");
  const key = process.env.TANGO_RUN_DIR || process.cwd();
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(root, "deliveries", `pi-${hash}.json`);
}

function loadDeliveredEvents(): Set<string> {
  try {
    const path = deliveryStatePath();
    if (!existsSync(path)) return new Set();
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(data.eventIds) ? data.eventIds : []);
  } catch { return new Set(); }
}

function persistDeliveredEvents() {
  const path = deliveryStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const eventIds = [...deliveredEvents].slice(-1000);
  writeFileSync(path, JSON.stringify({ updatedAt: new Date().toISOString(), eventIds }, null, 2) + "\n", "utf8");
}

function startParentReconciler(ctx: any) {
  if (reconcileTimer || !process.env.TANGO_RUN_DIR) return;
  reconcileTimer = setInterval(() => {
    void runTango(["reconcile", "--children", "--json"], ctx?.signal).then(() => updateFooterStatus(ctx, ctx?.signal)).catch(() => {});
  }, 15_000);
}

function startEventWatcher(pi: ExtensionAPI, ctx: any) {
  if (watchProcess) return;
  const args = [distCli, "watch", "--json", "--from-start"];
  if (process.env.TANGO_RUN_DIR) args.push("--all");
  watchProcess = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env as Record<string, string>, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  watchProcess.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) handleTangoEventLine(pi, ctx, line);
  });
  watchProcess.on("close", () => { watchProcess = undefined; });
}

function handleTangoEventLine(pi: ExtensionAPI, ctx: any, line: string) {
  if (!line.trim()) return;
  let event: any;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== "agent.status") return;
  if (!event.eventId || deliveredEvents.has(event.eventId)) return;
  if (!["done", "blocked", "error"].includes(event.status)) return;
  const parentRunDir = process.env.TANGO_RUN_DIR;
  if (parentRunDir && event.parentRunDir !== parentRunDir) return;
  deliveredEvents.add(event.eventId);
  persistDeliveredEvents();
  pendingEvents.push(event);
  if (!flushTimer) flushTimer = setTimeout(() => flushTangoEvents(pi, ctx), 500);
}

function suggestedAction(event: any): string {
  if (event.status === "done") return `tango_result ${event.agent}`;
  return `tango_look ${event.agent} --lines 120`;
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
  const worst = events.some((e) => e.status === "error") ? "error" : events.some((e) => e.status === "blocked") ? "warning" : "success";
  const title = events.length === 1 ? `Tango agent ${eventText(events[0])}` : `${events.length} Tango agents updated: ${events.map((e) => `${e.agent}=${e.status}`).join(", ")}`;
  if (ctx?.hasUI) ctx.ui.notify(title, worst as NotifyLevel);
  const lines = events.map((event) => `- ${eventText(event)}\n  Suggested: ${suggestedAction(event)}`);
  pi.sendMessage({
    customType: "tango-agent-status",
    content: `Tango status update${events.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}\n\nTreat this as a wake-up only; inspect child output/result before summarizing or taking action.`,
    display: true,
    details: { events },
  }, { deliverAs: "followUp", triggerTurn: true });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("tango", ctx.ui.theme.fg("dim", "Tango: ready"));
    startEventWatcher(pi, ctx);
    startParentReconciler(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (watchProcess) watchProcess.kill("SIGTERM");
    watchProcess = undefined;
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
      role: Type.String({ description: "Role name, e.g. scout, planner, worker, team-lead" }),
      task: Type.String({ description: "Task for the child agent" }),
      mode: Type.Optional(StringEnum(["oneshot", "interactive"] as const)),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
      clean: Type.Optional(Type.Boolean({ default: false })),
      cwd: Type.Optional(Type.String({ description: "Working directory/project root for this agent. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = addCwd(["start", params.name, "--role", params.role, "--json"], params.cwd);
      if (params.mode) args.push("--mode", params.mode);
      if (params.thinking) args.push("--thinking", params.thinking);
      if (params.clean) args.push("--clean");
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
    name: "tango_list",
    label: "Tango List",
    description: "List Tango agents for the current project. Wraps `tango list --json`.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ default: false })),
      cwd: Type.Optional(Type.String({ description: "Project working directory to list agents for. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = addCwd(["list", "--json"], params.cwd);
      if (params.all) args.push("--all");
      const out = toolResult(await runTango(args, signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", "tango list"), 0, 0); },
    renderResult(result, options, theme) { return renderListResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_look",
    label: "Tango Look",
    description: "Inspect recent output from a Tango agent. Wraps `tango look ... --json`.",
    parameters: Type.Object({
      name: Type.String(),
      lines: Type.Optional(Type.Number({ default: 200 })),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const result = await runTango(addCwd(["look", params.name, "--lines", String(params.lines ?? 200), "--json"], params.cwd), signal);
      if (result.json?.output) {
        const truncated = truncateTail(String(result.json.output), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        result.json.output = truncated.content + (truncated.truncated ? "\n\n[Output truncated]" : "");
        result.stdout = JSON.stringify(result.json, null, 2);
      }
      return toolResult(result);
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango look")} ${theme.fg("accent", args.name)} ${theme.fg("dim", `--lines ${args.lines ?? 200}`)}`, 0, 0); },
    renderResult(result, options, theme) { return renderLookResult(result, options, theme); },
  });

  pi.registerTool({
    name: "tango_message",
    label: "Tango Message",
    description: "Send a follow-up message to an interactive Tango agent. Wraps `tango message ... --json`.",
    parameters: Type.Object({
      name: Type.String(),
      message: Type.String(),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) { return toolResult(await runTango(addCwd(["message", params.name, params.message, "--json"], params.cwd), signal)); },
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
      name: Type.String(),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const out = toolResult(await runTango(addCwd(["stop", params.name, "--json"], params.cwd), signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango stop")} ${theme.fg("accent", args.name)}`, 0, 0); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Stopped"); },
  });

  pi.registerTool({
    name: "tango_status",
    label: "Tango Status",
    description: "Update this Tango agent's status. Wraps `tango status ... --json`.",
    parameters: Type.Object({
      state: StringEnum(["running", "blocked", "done", "error", "stopped"] as const),
      message: Type.Optional(Type.String()),
      needs: Type.Optional(Type.String({ description: "Needed parent action for blocked/error statuses, e.g. decision, input, credentials, review, intervention." })),
      runDir: Type.Optional(Type.String({ description: "Optional run directory; defaults to TANGO_RUN_DIR." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["status", params.state];
      if (params.message) args.push(params.message);
      if (params.needs) args.push("--needs", params.needs);
      if (params.runDir) args.push("--run-dir", params.runDir);
      args.push("--json");
      const out = toolResult(await runTango(args, signal));
      await updateFooterStatus(ctx, signal);
      return out;
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", "tango status")} ${theme.fg(statusColor(args.state), `${statusIcon(args.state)} ${args.state}`)} ${theme.fg("dim", preview(args.message ?? ""))}`, 0, 0); },
    renderResult(result, options, theme) { return renderAgentResult(result, options, theme, "Status"); },
  });

  pi.registerTool({
    name: "tango_result",
    label: "Tango Result",
    description: "Read a completed Tango agent result. Wraps `tango result ... --json`.",
    parameters: Type.Object({
      name: Type.String(),
      cwd: Type.Optional(Type.String({ description: "Project working directory used to resolve the agent name. Defaults to the current Pi process cwd." })),
    }),
    async execute(_id, params, signal) {
      const result = await runTango(addCwd(["result", params.name, "--json"], params.cwd), signal);
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
    name: "tango_cli",
    label: "Tango CLI",
    description: "Generic safe wrapper for the Tango CLI. Use for Tango features not exposed by dedicated tools. Blocks interactive `attach`.",
    parameters: Type.Object({ args: Type.Array(Type.String({ description: "Argument passed to tango, excluding the tango binary." })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const command = params.args[0];
      const allowed = new Set(["start", "list", "look", "message", "stop", "delete", "status", "result", "roles", "children", "wait", "doctor", "metrics", "reconcile"]);
      if (!command || !allowed.has(command)) {
        return { content: [{ type: "text" as const, text: `Unsupported tango command: ${command ?? "<empty>"}` }], details: { ok: false, command }, isError: true };
      }
      const out = toolResult(await runTango(withJson(params.args), signal));
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

  pi.registerCommand("tango-list", {
    description: "List Tango agents",
    handler: async (_args, ctx) => {
      const result = await runTango(["list"], ctx.signal);
      ctx.ui.notify(result.stdout || result.stderr, result.code === 0 ? "info" : "error");
    },
  });
}
