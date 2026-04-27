#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOneshotFromRuntime, startAgent } from "./start.js";
import { projectSlug } from "./paths.js";
import { fail, printJson } from "./json.js";
import { listMetadata, readMetadata, removeRunDir, transitionStatus, updateStatus, writeMetadata } from "./metadata.js";
import { readMetrics, writeMetrics } from "./metrics.js";
import { appendEvent, eventMatchesLineage, initialEventOffset, readEvents, type TangoEvent } from "./events.js";
import { resolveTarget, isChildOf } from "./targetResolver.js";
import { getRecipientContext, markLatestDoneHandled, markResultHandled } from "./attention.js";
import { listRoles, loadRole, assembleSystemPrompt } from "./roles.js";
import { attachTmux, captureTmux, sendTmux, stopTmux, tmuxAlive } from "./runtime/tmux.js";
import { isTerminalStatus, reconcileAgentLifecycle } from "./lifecycle.js";
import { assessResultDeliverable, validateResultContent } from "./result.js";
import type { AgentMetadata, AgentStatus, ThinkingLevel } from "./types.js";
import { listArtifacts, publishArtifact, readServerDiscovery, revokeArtifact, startTangoServer } from "./server.js";

interface Parsed { flags: Record<string, string | boolean | string[]>; positionals: string[] }

const BOOLEAN_FLAGS = new Set(["json", "clean", "attach", "dry-run", "all", "recursive", "no-recursive", "from-start", "tree", "children", "allow-private-bind", "summary-only", "no-result", "watch", "result-required", "no-result-required", "raw", "events"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parse(argv: string[]): Parsed {
  const flags: Parsed["flags"] = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!key) throw new Error("Invalid empty flag name.");
      if (!BOOLEAN_FLAGS.has(key) && eq < 0 && (!argv[i + 1] || argv[i + 1].startsWith("-"))) throw new Error(`Missing value for --${key}.`);
      const val = eq > 0 ? a.slice(eq + 1) : BOOLEAN_FLAGS.has(key) ? true : argv[++i];
      if (flags[key] !== undefined) flags[key] = Array.isArray(flags[key]) ? [...flags[key] as string[], String(val)] : [String(flags[key]), String(val)];
      else flags[key] = val;
    } else positionals.push(a);
  }
  return { flags, positionals };
}

const GLOBAL_FLAGS = new Set(["json", "cwd"]);
const COMMAND_FLAGS: Record<string, Set<string>> = {
  server: new Set(["host", "port", "token", "allow-private-bind"]),
  start: new Set(["role", "harness", "mode", "model", "thinking", "effort", "clean", "attach", "dry-run", "recursive", "no-recursive", "result-required", "no-result-required"]),
  ps: new Set(["all"]),
  inspect: new Set(["run-id", "run-dir"]),
  activity: new Set(["run-id", "run-dir", "lines", "raw", "events"]),
  list: new Set(["all"]),
  look: new Set(["run-id", "run-dir", "lines"]),
  attach: new Set(["run-id", "run-dir"]),
  message: new Set(["run-id", "run-dir"]),
  stop: new Set(["run-id", "run-dir"]),
  delete: new Set(["run-id", "run-dir"]),
  report: new Set(["run-dir", "needs", "result-file", "summary-only", "no-result", "checkpoint"]),
  status: new Set(["run-dir", "needs", "result-file", "summary-only", "no-result"]),
  watch: new Set(["all", "from-start"]),
  children: new Set(["run-id", "run-dir", "tree"]),
  follow: new Set(["run-id", "run-dir", "timeout", "until"]),
  wait: new Set(["run-id", "run-dir", "timeout"]),
  doctor: new Set(["run-dir", "parent-run-dir"]),
  metrics: new Set(["run-dir", "payload"]),
  artifact: new Set(["title", "entry", "mime", "run-dir"]),
  reconcile: new Set(["all", "children", "parent-run-dir"]),
  runner: new Set(["run-dir"]),
  result: new Set(["run-id", "run-dir", "watch", "timeout"]),
  recover: new Set(["run-dir"]),
  roles: new Set(),
};

function validateParsed(cmd: string, parsed: Parsed): void {
  const allowed = COMMAND_FLAGS[cmd] ?? new Set<string>();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return;
  for (const key of Object.keys(parsed.flags)) {
    if (!GLOBAL_FLAGS.has(key) && !allowed.has(key)) throw new Error(`Unknown flag for ${cmd}: --${key}`);
  }
}

function flagString(flags: Parsed["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
function flagBool(flags: Parsed["flags"], name: string): boolean { return flags[name] === true || flags[name] === "true"; }
function flagPositiveInt(flags: Parsed["flags"], name: string, fallback: number, max: number): number {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid --${name}: expected a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${name}: expected 1-${max}.`);
  return value;
}
function flagNonNegativeNumber(flags: Parsed["flags"], name: string, fallback: number): number {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}: expected a non-negative number.`);
  return value;
}
function flagThinking(flags: Parsed["flags"], name: string): ThinkingLevel | undefined {
  const value = flagString(flags, name);
  if (value !== undefined && !THINKING_LEVELS.has(value as ThinkingLevel)) throw new Error(`Invalid --${name}: ${value}. Expected off, minimal, low, medium, high, or xhigh.`);
  return value as ThinkingLevel | undefined;
}

function tailFileByLines(path: string, lines: number, maxBytes = 512 * 1024): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const prefix = start > 0 ? "[output truncated to tail]\n" : "";
    return prefix + buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/).slice(-lines).join("\n");
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  let json = false;
  try {
    const parsed = parse(rest);
    json = flagBool(parsed.flags, "json");
    const cwd = resolve(flagString(parsed.flags, "cwd") ?? process.cwd());
    validateParsed(cmd, parsed);
    switch (cmd) {
      case "help": case "--help": case "-h": return help();
      case "server": return await cmdServer(parsed);
      case "start": return await cmdStart(parsed, cwd, json);
      case "ps": return cmdList(cwd, json, flagBool(parsed.flags, "all"));
      case "inspect": return cmdInspect(parsed, cwd, json);
      case "activity": return cmdActivity(parsed, cwd, json);
      case "list": return legacyCommand("list", "ps", json);
      case "look": return legacyCommand("look", "activity", json);
      case "attach": return cmdAttach(parsed, cwd);
      case "message": return cmdMessage(parsed, cwd, json);
      case "stop": return cmdStop(parsed, cwd, json);
      case "delete": return cmdDelete(parsed, cwd, json);
      case "report": return cmdReport(parsed, json);
      case "status": return legacyCommand("status", "report", json);
      case "watch": return await cmdWatch(parsed, cwd, json);
      case "children": return await cmdChildren(parsed, cwd, json);
      case "follow": return await cmdFollow(parsed, cwd, json);
      case "wait": return legacyCommand("wait", "follow --until terminal", json);
      case "doctor": return cmdDoctor(parsed, cwd, json);
      case "metrics": return cmdMetrics(parsed, json);
      case "artifact": return await cmdArtifact(parsed, cwd, json);
      case "reconcile": return cmdReconcile(parsed, cwd, json);
      case "runner": return await cmdRunner(parsed);
      case "result": return await cmdResult(parsed, cwd, json);
      case "recover": return cmdRecover(parsed, json);
      case "roles": return cmdRoles(parsed, json);
      default: return fail(`Unknown command: ${cmd}`, json);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), json);
  }
}

async function cmdServer(parsed: Parsed) {
  const [subcommand, ...extra] = parsed.positionals;
  if (subcommand === "url") {
    if (extra.length > 0) throw new Error("Usage: tango server url");
    const discovery = readServerDiscovery();
    if (!discovery) throw new Error("No Tango server discovery found. Start one with `tango server`.");
    if (discovery.token) {
      console.log(discovery.url);
      console.log(`token: ${discovery.token}`);
      console.log("Use the token as a Bearer token, or paste it into the dashboard once prompted.");
    } else console.log(discovery.url);
    return;
  }
  if (subcommand) throw new Error("Usage: tango server [--host 127.0.0.1] [--port 43117] [--token TOKEN] or tango server url");
  await startTangoServer({
    host: flagString(parsed.flags, "host"),
    port: flagString(parsed.flags, "port") ? flagPositiveInt(parsed.flags, "port", 43117, 65535) : undefined,
    token: flagString(parsed.flags, "token"),
    allowPrivateBind: flagBool(parsed.flags, "allow-private-bind"),
  });
}

async function cmdStart(parsed: Parsed, cwd: string, json: boolean) {
  const [name, ...taskParts] = parsed.positionals;
  if (!name) throw new Error("Usage: tango start <name> --role <role> [task...]");
  if (parsed.flags["result-required"] !== undefined && parsed.flags["no-result-required"] !== undefined) throw new Error("Use either --result-required or --no-result-required, not both.");
  const task = taskParts.join(" ").trim();
  const result = await startAgent({
    name,
    roleName: flagString(parsed.flags, "role"),
    harness: flagString(parsed.flags, "harness"),
    mode: flagString(parsed.flags, "mode") as any,
    model: flagString(parsed.flags, "model"),
    thinking: flagThinking(parsed.flags, "thinking"),
    effort: flagString(parsed.flags, "effort"),
    cwd,
    task,
    clean: flagBool(parsed.flags, "clean"),
    attach: flagBool(parsed.flags, "attach"),
    dryRun: flagBool(parsed.flags, "dry-run"),
    recursive: parsed.flags.recursive === undefined ? undefined : flagBool(parsed.flags, "recursive"),
    resultRequired: parsed.flags["result-required"] !== undefined
      ? true
      : parsed.flags["no-result-required"] !== undefined
        ? false
        : undefined,
    json,
  });
  if (json) printJson({ ok: true, agent: result.meta, command: result.command });
  else {
    console.log(`${result.meta.name}: ${result.meta.status} (${result.meta.mode}/${result.meta.harness})`);
    console.log(result.meta.runDir);
  }
  if (flagBool(parsed.flags, "attach") && result.meta.mode === "interactive") attachTmux(result.meta.tmuxSocket, result.meta.tmuxSession);
}

function listAgentSummary(a: AgentMetadata) {
  const task = a.task.replace(/\s+/g, " ").trim();
  return {
    name: a.name,
    role: a.role,
    status: a.status,
    mode: a.mode,
    harness: a.harness,
    runId: a.runId,
    parentRunId: a.parentRunId,
    rootSessionId: a.rootSessionId,
    workstreamId: a.workstreamId,
    cwd: a.cwd,
    runDir: a.runDir,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    summary: a.summary,
    needs: a.needs,
    resultRequired: a.resultRequired,
    resultIssue: a.resultIssue,
    task: task.length > 240 ? `${task.slice(0, 239)}…` : task,
    taskTruncated: task.length > 240 || task !== a.task,
    metrics: a.metrics ? {
      toolCalls: a.metrics.toolCalls,
      activeToolCalls: a.metrics.activeToolCalls,
      lastTool: a.metrics.lastTool,
      tokens: a.metrics.tokens?.total,
      contextPercent: a.metrics.context?.percent,
      cost: a.metrics.cost?.total,
    } : undefined,
  };
}

function scopedListAgents(cwd: string, all: boolean): AgentMetadata[] {
  const agents = listMetadata(all ? undefined : cwd).map(refreshStatus).map(withMetrics);
  if (all) return agents;

  const rootSessionId = process.env.TANGO_ROOT_SESSION_ID;
  const workstreamId = process.env.TANGO_WORKSTREAM_ID;
  if (!rootSessionId && !workstreamId) return agents;

  const scoped = agents.filter((a) => {
    if (rootSessionId && workstreamId) return a.rootSessionId === rootSessionId && a.workstreamId === workstreamId;
    if (rootSessionId) return a.rootSessionId === rootSessionId;
    if (workstreamId) return a.workstreamId === workstreamId;
    return true;
  });
  return scoped;
}

function legacyCommand(oldName: string, replacement: string, json: boolean) {
  const message = `tango ${oldName} has been removed. Use tango ${replacement}.`;
  if (json) {
    process.exitCode = 1;
    return printJson({ ok: false, error: message, removed: oldName, replacement });
  }
  throw new Error(message);
}

function cmdList(cwd: string, json: boolean, all: boolean) {
  const agents = scopedListAgents(cwd, all);
  if (json) return printJson({ ok: true, agents: agents.map(listAgentSummary) });
  if (!agents.length) return console.log("No agents.");
  for (const a of agents) console.log(`${a.name.padEnd(18)} ${a.status.padEnd(8)} ${a.role ?? "-"} ${a.mode}/${a.harness} ${a.task}`);
}

function buildRunState(meta: AgentMetadata) {
  const refreshed = withMetrics(refreshStatus(meta));
  const assessment = assessResultDeliverable(refreshed);
  const processState = isTerminalStatus(refreshed.status)
    ? "exited"
    : refreshed.mode === "interactive" && tmuxAlive(refreshed.tmuxSocket, refreshed.tmuxSession)
      ? "running"
      : refreshed.mode === "oneshot" && (refreshed.pid || refreshed.supervisorPid)
        ? "running"
        : "unknown";
  return {
    schemaVersion: 1,
    identity: {
      runId: refreshed.runId,
      runDir: refreshed.runDir,
      name: refreshed.name,
      role: refreshed.role,
      mode: refreshed.mode,
      harness: refreshed.harness,
      parentRunId: refreshed.parentRunId,
      rootSessionId: refreshed.rootSessionId,
      workstreamId: refreshed.workstreamId,
      cwd: refreshed.cwd,
      task: refreshed.task,
    },
    process: {
      state: processState,
      pid: refreshed.pid,
      supervisorPid: refreshed.supervisorPid,
      tmuxSocket: refreshed.tmuxSocket,
      tmuxSession: refreshed.tmuxSession,
      exitCode: refreshed.exitCode,
      observedAt: new Date().toISOString(),
    },
    agent: {
      state: refreshed.status,
      terminal: isTerminalStatus(refreshed.status),
      attentionRequired: refreshed.status === "blocked" || refreshed.status === "error",
      summary: refreshed.summary,
      needs: refreshed.needs,
      updatedAt: refreshed.updatedAt,
    },
    result: {
      state: assessment.resultState,
      ready: assessment.resultReady,
      safeToRead: assessment.safeToRead,
      deliverable: assessment.deliverable,
      path: assessment.hasResultFile ? assessment.resultFile : undefined,
      finalizedAt: refreshed.resultFinalizedAt ?? refreshed.resultSummaryOnlyAt,
      issue: assessment.resultIssue,
      warning: assessment.resultWarning,
    },
    activity: {
      available: true,
      recommended: "tango activity",
    },
    attention: {
      requested: refreshed.status === "blocked" || refreshed.status === "error",
      needs: refreshed.needs,
    },
    metrics: refreshed.metrics,
    next: nextAction(refreshed, assessment),
  };
}

function nextAction(meta: AgentMetadata, assessment: ReturnType<typeof assessResultDeliverable>) {
  if (meta.status === "blocked") return { recommended: "message", reason: meta.needs ?? "agent is blocked" };
  if (!assessment.safeToRead) return { recommended: "follow", until: "result-resolved" };
  if (assessment.safeToRead) return { recommended: "result" };
  return { recommended: "inspect" };
}

function cmdInspect(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango inspect [name] [--run-id <id>|--run-dir <dir>]");
  const meta = resolveTarget({ name, cwd, runId, runDir, env: process.env as any });
  const state = buildRunState(meta);
  if (json) return printJson({ ok: true, state, agent: withMetrics(refreshStatus(meta)) });
  console.log(`${state.identity.name}: ${state.agent.state} (${state.identity.mode}/${state.identity.harness})`);
  console.log(`process: ${state.process.state}`);
  console.log(`result: ${state.result.state} ready=${state.result.ready} safeToRead=${state.result.safeToRead} deliverable=${state.result.deliverable}`);
  if (state.agent.summary) console.log(`summary: ${state.agent.summary}`);
  if (state.agent.needs) console.log(`needs: ${state.agent.needs}`);
  console.log(`runDir: ${state.identity.runDir}`);
}

function cmdActivity(parsed: Parsed, cwd: string, json: boolean) {
  return cmdLook(parsed, cwd, json);
}

function cmdLook(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango activity [name] [--run-id <id>|--run-dir <dir>]");
  const lines = flagPositiveInt(parsed.flags, "lines", 200, 5000);
  const meta = withMetrics(resolveTarget({ name, cwd, runId, runDir, env: process.env as any }));
  let text = "";
  if (meta.mode === "interactive" && tmuxAlive(meta.tmuxSocket, meta.tmuxSession)) text = captureTmux(meta.tmuxSocket, meta.tmuxSession, lines);
  else if (meta.mode === "interactive" && existsSync(join(meta.runDir, "final-pane.log"))) text = tailFileByLines(join(meta.runDir, "final-pane.log"), lines);
  else if (meta.mode === "interactive" && existsSync(join(meta.runDir, "tmux.log"))) text = tailFileByLines(join(meta.runDir, "tmux.log"), lines);
  else if (existsSync(join(meta.runDir, "output.log"))) text = tailFileByLines(join(meta.runDir, "output.log"), lines);
  else if (existsSync(join(meta.runDir, "result.md"))) text = readFileSync(join(meta.runDir, "result.md"), "utf8");
  if (json) printJson({ ok: true, agent: meta, output: text }); else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function cmdAttach(parsed: Parsed, cwd: string) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango attach [name] [--run-id <id>|--run-dir <dir>]");
  const meta = resolveTarget({ name, cwd, runId, runDir, env: process.env as any });
  if (meta.mode !== "interactive") throw new Error(`Agent ${meta.name} is not interactive (mode=${meta.mode}). Attach only works with interactive agents.`);
  attachTmux(meta.tmuxSocket, meta.tmuxSession);
}

function cmdMessage(parsed: Parsed, cwd: string, json: boolean) {
  const [name, ...msg] = parsed.positionals;
  if (!name || msg.length === 0) throw new Error("Usage: tango message <name> <message>");
  const meta = resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any });
  if (meta.mode !== "interactive") throw new Error(`Agent ${meta.name} is not interactive (mode=${meta.mode}). Message only works with interactive agents.`);
  sendTmux(meta.tmuxSocket, meta.tmuxSession, msg.join(" "));
  if (json) printJson({ ok: true }); else console.log("sent");
}

function cmdStop(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango stop <name> [--run-id <id>|--run-dir <dir>]");
  const meta = resolveTarget({ name, cwd, runId, runDir, env: process.env as any });
  if (meta.mode === "oneshot") stopOneshot(meta);
  else stopTmux(meta.tmuxSocket, meta.tmuxSession);
  transitionStatus(meta.runDir, "stopped");
  const stopped = readMetadata(meta.runDir);
  if (json) printJson({ ok: true, agent: stopped }); else console.log(`${meta.name}: stopped`);
}

function stopOneshot(meta: AgentMetadata): void {
  const log = join(meta.runDir, "supervisor.log");
  const note = (message: string) => writeFileSync(log, `${new Date().toISOString()} stop: ${message}\n`, { flag: "a" });
  for (const pid of [meta.pid, meta.supervisorPid]) {
    if (!pid) continue;
    try { process.kill(pid, "SIGTERM"); note(`sent SIGTERM to pid ${pid}`); }
    catch (error) { note(`pid ${pid} SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (meta.supervisorPid) {
    try { process.kill(-meta.supervisorPid, "SIGTERM"); note(`sent SIGTERM to process group ${meta.supervisorPid}`); }
    catch (error) { note(`process group ${meta.supervisorPid} SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const resultFile = join(meta.runDir, "result.md");
  if (!meta.resultFinalizedAt) {
    const current = readMetadata(meta.runDir);
    current.resultFile = resultFile;
    current.resultFinalizedAt = new Date().toISOString();
    current.resultIssue = "Oneshot agent was stopped before producing a finalized result.";
    if (!existsSync(resultFile)) writeFileSync(resultFile, "", "utf8");
    writeMetadata(current);
  }
}

function cmdDelete(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango delete <name>");
  const meta = resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any });
  stopTmux(meta.tmuxSocket, meta.tmuxSession);
  removeRunDir(meta.runDir);
  if (json) printJson({ ok: true }); else console.log(`${name}: deleted`);
}

function cmdReport(parsed: Parsed, json: boolean) {
  const [state, ...msg] = parsed.positionals;
  if (!state) throw new Error("Usage: tango report <running|blocked|done|error|stopped> [--result-file <path>|--summary-only] [message]");
  const runDir = flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR;
  if (!runDir) throw new Error("No run dir. Set TANGO_RUN_DIR or pass --run-dir.");
  if (!isAgentStatus(state)) throw new Error(`Invalid status: ${state}`);
  const summary = msg.join(" ");
  const resultFileFlag = flagString(parsed.flags, "result-file");
  const summaryOnly = flagBool(parsed.flags, "summary-only") || flagBool(parsed.flags, "no-result");
  if (resultFileFlag && summaryOnly) throw new Error("Use either --result-file or --summary-only/--no-result, not both.");
  if (resultFileFlag && state !== "done") throw new Error("--result-file is only valid with `tango report done`.");
  if (summaryOnly && state !== "done") throw new Error("--summary-only/--no-result is only valid with `tango report done`.");
  if (state === "done") enforceDoneResultPolicy(runDir, { resultFile: resultFileFlag, summaryOnly });
  if (resultFileFlag) finalizeResultFileBeforeDone(runDir, resultFileFlag);
  else if (state === "done" && summaryOnly) markSummaryOnlyResult(runDir);
  if (state === "done") captureInteractiveTranscript(runDir);
  const meta = updateStatus(runDir, state, summary, { needs: flagString(parsed.flags, "needs") });
  if (json) printJson({ ok: true, agent: meta }); else console.log(`${meta.name}: ${meta.status}`);
}

function enforceDoneResultPolicy(runDir: string, options: { resultFile?: string; summaryOnly: boolean }): void {
  const meta = readMetadata(runDir);
  if (isFinalStatus(meta.status)) {
    if (meta.status !== "done") throw new Error(`Cannot transition terminal agent status from ${meta.status} to done. Terminal statuses are sticky.`);
    if (options.resultFile || options.summaryOnly) throw new Error("Cannot finalize a result for an agent that is already done; done finalization is immutable.");
  }
  if (options.resultFile) return;
  if (options.summaryOnly) {
    if (meta.resultRequired) throw new Error("This agent was started with a required deliverable. Finish with `tango report done --result-file <path> \"summary\"`; --summary-only is not allowed for this run.");
    return;
  }
  if (meta.mode === "interactive") {
    throw new Error("Report summary is not a deliverable. Interactive agents must finish with `tango report done --result-file <path> \"summary\"`; use explicit --summary-only only when no deliverable is intended.");
  }
}

function markSummaryOnlyResult(runDir: string): void {
  const meta = readMetadata(runDir);
  meta.resultSummaryOnlyAt = new Date().toISOString();
  delete meta.resultFinalizedAt;
  delete meta.resultFile;
  delete meta.resultIssue;
  writeMetadata(meta);
}

function finalizeResultFileBeforeDone(runDir: string, resultFileFlag: string): void {
  const source = resolve(resultFileFlag);
  if (!existsSync(source)) throw new Error(`Result file not found: ${resultFileFlag}`);
  const resultText = readFileSync(source, "utf8");
  const meta = readMetadata(runDir);
  const validation = validateResultContent(meta, resultText, { enforceRequired: true });
  if (!validation.ok) throw new Error(validation.issue ?? "Invalid result deliverable.");
  const resultFile = join(runDir, "result.md");
  writeFileSync(resultFile, resultText, "utf8");
  meta.resultFile = resultFile;
  meta.resultFinalizedAt = new Date().toISOString();
  delete meta.resultIssue;
  // Keep metadata.summary operational; result.md is the durable deliverable.
  writeMetadata(meta);
}

function captureInteractiveTranscript(runDir: string): void {
  const meta = readMetadata(runDir);
  if (meta.mode !== "interactive") return;
  if (!tmuxAlive(meta.tmuxSocket, meta.tmuxSession)) return;
  try {
    writeFileSync(join(runDir, "final-pane.log"), captureTmux(meta.tmuxSocket, meta.tmuxSession, 5000), "utf8");
  } catch {}
}

async function cmdWatch(parsed: Parsed, cwd: string, json: boolean) {
  const all = flagBool(parsed.flags, "all");
  let state = { offset: initialEventOffset(flagBool(parsed.flags, "from-start")), carry: "" };
  while (true) {
    const next = readEvents(state);
    state = next.state;
    for (const error of next.errors) if (!json) console.error(`tango watch: skipped malformed event: ${error}`);
    for (const event of next.events) {
      if (!all && !eventMatchesLineage(event, cwd)) continue;
      printEvent(event, json);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function printEvent(event: TangoEvent, json: boolean) {
  if (json) console.log(JSON.stringify(event));
  else console.log(`${event.time} ${event.agent} ${event.previousStatus ?? "?"} -> ${event.status}${event.summary ? `: ${event.summary}` : ""}`);
}

async function cmdChildren(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  let parentMeta: AgentMetadata | undefined;
  if (name) {
    parentMeta = resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any });
  } else {
    const runDir = flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR;
    if (runDir) {
      try { parentMeta = readMetadata(runDir); } catch {}
    }
  }
  if (!parentMeta) throw new Error("Usage: tango children [parent-name] (or run inside a Tango agent, or pass --run-dir)");
  const agents = listMetadata(undefined).map(refreshStatus).map(withMetrics).filter((a) => isChildOf(a, parentMeta!));
  const tree = childTree(parentMeta);
  if (json) return printJson({ ok: true, parentRunDir: parentMeta.runDir, agents, tree });
  if (flagBool(parsed.flags, "tree")) return console.log(renderChildTree(tree));
  if (!agents.length) return console.log("No child agents.");
  for (const a of agents) console.log(`${a.name.padEnd(18)} ${a.status.padEnd(8)} ${a.role ?? "-"} ${a.mode}/${a.harness} ${a.task}`);
}

async function cmdFollow(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango follow <name> --until <terminal|result-resolved|attention> [--run-id <id>|--run-dir <dir>] [--timeout seconds]");
  const until = flagString(parsed.flags, "until");
  if (!until) throw new Error("tango follow requires --until <terminal|result-resolved|attention>.");
  if (!["terminal", "result-resolved", "attention"].includes(until)) throw new Error(`Invalid --until ${until}. Expected terminal, result-resolved, or attention.`);
  const timeoutMs = flagNonNegativeNumber(parsed.flags, "timeout", 0) * 1000;
  const start = Date.now();
  const target = resolveTarget({ name, cwd, runId, runDir, env: process.env as any });
  while (true) {
    const meta = withMetrics(refreshStatus(readMetadata(target.runDir)));
    const assessment = assessResultDeliverable(meta);
    const matched = until === "terminal"
      ? isTerminalStatus(meta.status)
      : until === "result-resolved"
        ? assessment.safeToRead || !!assessment.resultIssue
        : meta.status === "blocked" || meta.status === "error";
    if (matched) {
      if (until === "terminal" && meta.status === "done" && assessment.resultReady) markLatestDoneHandled(getRecipientContext(), meta.runDir);
      if (until === "result-resolved" && assessment.resultReady && (meta.resultFinalizedAt || meta.resultSummaryOnlyAt)) markResultHandled(getRecipientContext(), meta.runDir, meta.resultFinalizedAt ?? meta.resultSummaryOnlyAt!);
      const state = buildRunState(meta);
      if (json) return printJson({ ok: true, condition: until, state, agent: meta, resultAssessment: assessment });
      console.log(`${meta.name}: ${meta.status}${meta.summary ? ` - ${meta.summary}` : ""}`);
      console.log(`result: ${assessment.resultState} ready=${assessment.resultReady} safeToRead=${assessment.safeToRead}`);
      return;
    }
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
      const state = buildRunState(meta);
      if (json) return printJson({ ok: false, timeout: true, condition: until, state, agent: meta, resultAssessment: assessment });
      throw new Error(`Timed out following ${name || runId || runDir} until ${until}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function cmdDoctor(parsed: Parsed, cwd: string, json: boolean) {
  const [sub] = parsed.positionals;
  if (sub !== "events") throw new Error("Usage: tango doctor events");
  const event: TangoEvent = {
    schemaVersion: 1,
    eventId: `te_doctor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "agent.status",
    time: new Date().toISOString(),
    agent: "doctor-events",
    role: "doctor",
    status: "done",
    previousStatus: "running",
    summary: "Synthetic Tango event notification test",
    needs: "inspection",
    cwd,
    projectSlug: projectSlug(cwd),
    runDir: flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR ?? cwd,
    parentRunDir: flagString(parsed.flags, "parent-run-dir") ?? process.env.TANGO_RUN_DIR,
  };
  appendEvent(event);
  if (json) printJson({ ok: true, event }); else console.log(`emitted ${event.eventId}`);
}

function childTree(parent: AgentMetadata): any[] {
  const all = listMetadata(undefined).map(refreshStatus).map(withMetrics);
  const rec = (p: AgentMetadata): any[] => all.filter((a) => isChildOf(a, p)).map((a) => ({ agent: a, children: rec(a) }));
  return rec(parent);
}

function renderChildTree(tree: any[]): string {
  const lines: string[] = [];
  const rec = (nodes: any[], depth = 0) => {
    for (const n of nodes) {
      const a = n.agent as AgentMetadata;
      lines.push(`${"  ".repeat(depth)}${a.name} [${a.status}] ${a.role ?? "-"} ${a.summary ? `- ${a.summary}` : ""}`.trimEnd());
      rec(n.children, depth + 1);
    }
  };
  rec(tree);
  return lines.join("\n") || "No child agents.";
}

async function cmdResult(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango result [name] [--run-id <id>|--run-dir <dir>] [--watch] [--timeout seconds]");
  const target = resolveTarget({ name, cwd, runId, runDir, env: process.env as any });
  const timeoutMs = flagNonNegativeNumber(parsed.flags, "timeout", 0) * 1000;
  const start = Date.now();
  while (true) {
    const meta = refreshStatus(readMetadata(target.runDir));
    const assessment = assessResultDeliverable(meta);
    if (assessment.resultReady && (meta.resultFinalizedAt || meta.resultSummaryOnlyAt)) markResultHandled(getRecipientContext(), meta.runDir, meta.resultFinalizedAt ?? meta.resultSummaryOnlyAt!);
    if (!flagBool(parsed.flags, "watch") || assessment.resultReady || (isTerminalStatus(meta.status) && assessment.resultIssue)) return printResult(meta, assessment, json);
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) return printResult(meta, assessment, json, true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function printResult(meta: AgentMetadata, assessment: ReturnType<typeof assessResultDeliverable>, json: boolean, timeout = false) {
  if (json) return printJson({ ok: !timeout, timeout: timeout || undefined, agent: meta, result: assessment.result || (assessment.resultState === "summary-only" ? meta.summary : ""), resultReady: assessment.resultReady, resultState: assessment.resultState, safeToRead: assessment.safeToRead, deliverable: assessment.deliverable, resultIssue: assessment.resultIssue, resultWarning: assessment.resultWarning, resultAssessment: assessment });
  if (timeout) process.stderr.write("tango result: timed out waiting for result readiness\n");
  if (assessment.resultIssue) process.stderr.write(`tango result: ${assessment.resultIssue}\n`);
  if (assessment.resultWarning) process.stderr.write(`tango result warning: ${assessment.resultWarning}\n`);
  if (assessment.result) process.stdout.write(assessment.result.endsWith("\n") ? assessment.result : `${assessment.result}\n`);
  else if (assessment.resultState === "summary-only" && meta.summary) process.stdout.write(`${meta.summary.endsWith("\n") ? meta.summary : `${meta.summary}\n`}`);
  else if (meta.summary) process.stdout.write(`[summary] ${meta.summary}\n`);
}

function cmdRecover(parsed: Parsed, json: boolean) {
  const runDir = flagString(parsed.flags, "run-dir") ?? parsed.positionals[0];
  if (!runDir) throw new Error("Usage: tango recover --run-dir <dir>");
  const meta = readMetadata(runDir);
  const state = buildRunState(meta);
  const payload = { ok: true, degraded: true, nonAckable: true, state, agent: meta, note: "Explicit recovery view from run directory; not active protocol state." };
  if (json) return printJson(payload);
  console.log(`${meta.name}: ${meta.status} [degraded recovery]`);
  console.log(`runDir: ${meta.runDir}`);
  console.log(`result: ${state.result.state} ready=${state.result.ready} safeToRead=${state.result.safeToRead}`);
  if (meta.summary) console.log(`summary: ${meta.summary}`);
}

function cmdRoles(parsed: Parsed, json: boolean) {
  const [sub = "list", name] = parsed.positionals;
  if (sub === "list") {
    const roles = listRoles().map((r) => ({ name: r.name, description: r.description, harness: r.harness, mode: r.mode, model: r.model, thinking: r.thinking, effort: r.effort, filePath: r.filePath }));
    if (json) printJson({ ok: true, roles }); else for (const r of roles) console.log(`${r.name.padEnd(16)} ${r.description ?? ""}`);
    return;
  }
  if (sub === "show" && name) {
    const role = loadRole(name);
    const system = assembleSystemPrompt(role);
    if (json) printJson({ ok: true, role, system }); else console.log(system);
    return;
  }
  throw new Error("Usage: tango roles list|show <name>");
}

async function cmdRunner(parsed: Parsed) {
  const [sub] = parsed.positionals;
  if (sub !== "oneshot") throw new Error("Usage: tango runner oneshot --run-dir <dir>");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!runDir) throw new Error("Usage: tango runner oneshot --run-dir <dir>");
  await runOneshotFromRuntime(runDir);
}

function cmdReconcile(parsed: Parsed, cwd: string, json: boolean) {
  const agents = selectReconcileAgents(parsed, cwd).map((meta) => ({ before: meta.status, after: withMetrics(refreshStatus(meta)) }));
  const changed = agents.filter((a) => a.before !== a.after.status).map((a) => a.after);
  if (json) return printJson({ ok: true, checked: agents.length, changed: changed.length, agents: changed });
  if (!changed.length) return console.log(`Checked ${agents.length} agent${agents.length === 1 ? "" : "s"}; no changes.`);
  for (const a of changed) console.log(`${a.name}: ${a.status}${a.summary ? ` - ${a.summary}` : ""}`);
}

function selectReconcileAgents(parsed: Parsed, cwd: string): AgentMetadata[] {
  if (flagBool(parsed.flags, "children")) {
    const parentRunDir = flagString(parsed.flags, "parent-run-dir") ?? process.env.TANGO_RUN_DIR;
    if (!parentRunDir) throw new Error("No parent run dir. Set TANGO_RUN_DIR or pass --parent-run-dir.");
    let parentMeta: AgentMetadata | undefined;
    try { parentMeta = readMetadata(parentRunDir); } catch {}
    if (parentMeta) {
      return listMetadata(undefined).filter((a) => isChildOf(a, parentMeta!));
    }
    const norm = resolve(parentRunDir);
    return listMetadata(undefined).filter((a) => a.parentRunDir && resolve(a.parentRunDir) === norm);
  }
  return listMetadata(flagBool(parsed.flags, "all") ? undefined : cwd);
}

async function cmdArtifact(parsed: Parsed, cwd: string, json: boolean) {
  const [sub, artifactPath] = parsed.positionals;
  if (sub === "publish") {
    if (!artifactPath) throw new Error("Usage: tango artifact publish <path> [--title title] [--entry file] [--mime type]");
    const artifact = await publishArtifact(artifactPath, {
      title: flagString(parsed.flags, "title"),
      entry: flagString(parsed.flags, "entry"),
      mime: flagString(parsed.flags, "mime"),
      ownerRunDir: flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR,
      cwd,
    });
    if (json) return printJson({ ok: true, artifact });
    console.log(artifact.url ?? artifact.artifactId);
    return;
  }
  if (sub === "list") {
    const artifacts = listArtifacts();
    if (json) return printJson({ ok: true, artifacts });
    if (!artifacts.length) return console.log("No artifacts.");
    for (const a of artifacts) console.log(`${a.artifactId.padEnd(18)} ${a.revokedAt ? "revoked" : "active"} ${a.title ?? a.entry}`);
    return;
  }
  if (sub === "revoke") {
    const artifactId = artifactPath;
    if (!artifactId) throw new Error("Usage: tango artifact revoke <artifact-id>");
    const artifact = revokeArtifact(artifactId);
    if (json) return printJson({ ok: true, artifact });
    console.log(`${artifactId}: revoked`);
    return;
  }
  throw new Error("Usage: tango artifact publish|list|revoke ...");
}

function cmdMetrics(parsed: Parsed, json: boolean) {
  const [sub] = parsed.positionals;
  if (sub !== "update") throw new Error("Usage: tango metrics update --run-dir <dir> --payload <json>");
  const runDir = flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR;
  if (!runDir) throw new Error("No run dir. Set TANGO_RUN_DIR or pass --run-dir.");
  const raw = flagString(parsed.flags, "payload") ?? parsed.positionals.slice(1).join(" ");
  if (!raw) throw new Error("Usage: tango metrics update --run-dir <dir> --payload <json>");
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch (error) { throw new Error(`Invalid metrics JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const metrics = writeMetrics(runDir, payload);
  if (json) printJson({ ok: true, metrics }); else console.log(`${metrics.agent}: metrics updated`);
}

function withMetrics<T extends AgentMetadata>(meta: T): T {
  const metrics = readMetrics(meta.runDir);
  if (metrics) meta.metrics = metrics;
  return meta;
}

function isAgentStatus(status: string): status is AgentStatus {
  return status === "created" || status === "running" || status === "done" || status === "error" || status === "blocked" || status === "stopped" || status === "unknown";
}

function isFinalStatus(status: AgentStatus): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

function refreshStatus(meta: AgentMetadata): AgentMetadata {
  return reconcileAgentLifecycle(meta);
}

function help() {
  console.log(`tango - native/tmux agent orchestration\n\nUsage:\n  tango server [--host 127.0.0.1] [--port 43117] [--token TOKEN]
  tango server url\n  tango start <name> --role <role> [--harness pi|claude|gemini|generic] [--mode oneshot|interactive] [--model MODEL] [--thinking off|minimal|low|medium|high|xhigh] [--effort low|medium|high|xhigh|max] [--dry-run] [--no-result-required] [task...]\n  tango ps [--json] [--all]\n  tango inspect [name] [--run-id <id>] [--run-dir <dir>] [--json]\n  tango activity [name] [--run-id <id>] [--run-dir <dir>] [--lines N] [--json] [--raw]\n  tango follow <name> --until terminal|result-resolved|attention [--run-id <id>] [--run-dir <dir>] [--timeout seconds] [--json]\n  tango attach [name] [--run-id <id>] [--run-dir <dir>]\n  tango message <name> [--run-id <id>] [--run-dir <dir>] <message>\n  tango stop <name> [--run-id <id>] [--run-dir <dir>]\n  tango delete <name> [--run-id <id>] [--run-dir <dir>]\n  tango report <state> [message] [--needs kind] [--result-file path|--summary-only]\n  tango watch [--json] [--all] [--from-start]\n  tango children [parent-name] [--run-id <id>] [--run-dir <dir>] [--tree] [--json]\n  tango doctor events [--json]\n  tango metrics update --run-dir <dir> --payload <json> [--json]\n  tango artifact publish <path> [--title title] [--entry file] [--mime type] [--json]\n  tango artifact list [--json]\n  tango artifact revoke <artifact-id> [--json]\n  tango reconcile [--json] [--all] [--children]\n  tango result [name] [--run-id <id>] [--run-dir <dir>] [--watch] [--timeout seconds]\n  tango recover --run-dir <dir> [--json]\n  tango roles list|show <name>\n\nRemoved active protocol commands fail fast: tango status, tango look, tango list, bare tango wait.\n\nNotes:\n  Final statuses (done, error, stopped) are immutable; duplicate done is only accepted as an exact no-op.\n  Blocked agents can be moved back to running after the blocker is resolved.\n  tango result marks finalized and summary-only results handled so duplicate completion notifications are suppressed.\n`);
}

main();
