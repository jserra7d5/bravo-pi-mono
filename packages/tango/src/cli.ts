#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOneshotFromRuntime, startAgent } from "./start.js";
import { dataRoot, projectSlug } from "./paths.js";
import { fail, printJson } from "./json.js";
import { listMetadata, readMetadata, removeRunDir, writeMetadata } from "./metadata.js";
import { readMetrics, writeMetrics } from "./metrics.js";
import { appendEvent, eventMatchesLineage, initialEventOffset, readEvents, type TangoEvent } from "./events.js";
import { resolveTarget, isChildOf } from "./targetResolver.js";
import { getRecipientContext, markLatestDoneHandled, markResultHandled } from "./attention.js";
import { listRoles, loadRole, assembleSystemPrompt } from "./roles.js";
import { attachTmux, captureTmux, stopTmux, tmuxAlive } from "./runtime/tmux.js";
import { reconcileAgentLifecycle } from "./lifecycle.js";
import { assessResultDeliverable, validateResultContent } from "./result.js";
import type { AgentMetadata, AgentStatus, ThinkingLevel } from "./types.js";
import { listArtifacts, publishArtifact, readServerDiscovery, revokeArtifact, serverDiscoveryPath, startTangoServer, type ServerDiscovery } from "./server.js";
import { buildRunState as cpBuildRunState, messageRun, readActivity, reportRun, stopRun, waitRuns, type WaitCondition, type WaitMode } from "./controlPlane.js";
import { readCheckpointBody, readCheckpoints } from "./checkpoints.js";

interface Parsed { flags: Record<string, string | boolean | string[]>; positionals: string[] }

const cliPath = fileURLToPath(import.meta.url);
const DEFAULT_SERVER_PORT = 43117;
const BOOLEAN_FLAGS = new Set(["json", "clean", "attach", "dry-run", "all", "active", "problems", "health", "full", "recursive", "no-recursive", "from-start", "tree", "children", "allow-private-bind", "summary-only", "no-result", "watch", "result-required", "no-result-required", "raw", "events", "urgent", "unread", "peek", "force-terminal", "latest"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

class ServerRequestError extends Error {
  constructor(public status: number, message: string, public payload?: any) {
    super(message);
  }
}

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
  ps: new Set(["all", "active", "problems", "health", "full", "limit", "state"]),
  inspect: new Set(["run-id", "run-dir"]),
  activity: new Set(["run-id", "run-dir", "lines", "raw", "events", "peek"]),
  checkpoint: new Set(["run-id", "run-dir", "latest", "all"]),
  list: new Set(["all"]),
  look: new Set(["run-id", "run-dir", "lines"]),
  attach: new Set(["run-id", "run-dir"]),
  message: new Set(["run-id", "run-dir", "type", "urgent", "attachment", "force-terminal"]),
  stop: new Set(["run-id", "run-dir"]),
  delete: new Set(["run-id", "run-dir"]),
  report: new Set(["run-dir", "needs", "result-file", "summary-only", "no-result", "checkpoint", "checkpoint-file"]),
  status: new Set(["run-dir", "needs", "result-file", "summary-only", "no-result", "checkpoint", "checkpoint-file"]),
  watch: new Set(["all", "from-start"]),
  children: new Set(["run-id", "run-dir", "tree"]),
  follow: new Set(["run-id", "run-dir", "timeout", "until"]),
  wait: new Set(["run-id", "run-dir", "timeout", "until", "mode"]),
  doctor: new Set(["run-dir", "parent-run-dir"]),
  metrics: new Set(["run-dir", "payload"]),
  artifact: new Set(["title", "entry", "mime", "run-dir"]),
  reconcile: new Set(["all", "children", "parent-run-dir"]),
  runner: new Set(["run-dir"]),
  result: new Set(["run-id", "run-dir", "watch", "timeout", "unread", "inbox", "peek", "root-session-id", "workstream-id"]),
  board: new Set(["root-session-id", "workstream-id", "run-id", "run-dir"]),
  inbox: new Set(["root-session-id", "workstream-id", "run-id", "run-dir", "all"]),
  "collect-results": new Set(["root-session-id", "workstream-id", "run-id", "run-dir"]),
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
function flagStrings(flags: Parsed["flags"], name: string): string[] {
  const v = flags[name];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v;
  return [];
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
function parsePort(flags: Parsed["flags"]): number | undefined {
  const raw = flagString(flags, "port");
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("Invalid --port: expected 0-65535.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error("Invalid --port: expected 0-65535.");
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
    const parts = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (parts[parts.length - 1] === "") parts.pop();
    return prefix + parts.slice(-lines).join("\n");
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
      case "ps": return await cmdList(parsed, cwd, json);
      case "inspect": return await cmdInspect(parsed, cwd, json);
      case "activity": return await cmdActivity(parsed, cwd, json);
      case "checkpoint": return cmdCheckpoint(parsed, cwd, json);
      case "list": return legacyCommand("list", "ps", json);
      case "look": return legacyCommand("look", "activity", json);
      case "attach": return cmdAttach(parsed, cwd);
      case "message": return await cmdMessage(parsed, cwd, json);
      case "stop": return await cmdStop(parsed, cwd, json);
      case "delete": return cmdDelete(parsed, cwd, json);
      case "report": return await cmdReport(parsed, json);
      case "status": return legacyCommand("status", "report", json);
      case "watch": return await cmdWatch(parsed, cwd, json);
      case "children": return await cmdChildren(parsed, cwd, json);
      case "follow": return await cmdFollow(parsed, cwd, json);
      case "wait": return await cmdWait(parsed, cwd, json);
      case "doctor": return await cmdDoctor(parsed, cwd, json);
      case "metrics": return cmdMetrics(parsed, json);
      case "artifact": return await cmdArtifact(parsed, cwd, json);
      case "reconcile": return cmdReconcile(parsed, cwd, json);
      case "runner": return await cmdRunner(parsed);
      case "result": return await cmdResult(parsed, cwd, json);
      case "board": return await cmdBoard(parsed, json);
      case "inbox": return await cmdInbox(parsed, json);
      case "collect-results": return legacyCommand("collect-results", "result --unread", json);
      case "recover": return cmdRecover(parsed, json);
      case "roles": return cmdRoles(parsed, json);
      default: return fail(`Unknown command: ${cmd}`, json);
    }
  } catch (error) {
    if (error instanceof ServerRequestError && json && error.payload) {
      process.exitCode = 1;
      return printJson({ ...error.payload, ok: false, status: error.status });
    }
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
    port: parsePort(parsed.flags),
    token: flagString(parsed.flags, "token"),
    allowPrivateBind: flagBool(parsed.flags, "allow-private-bind"),
  });
}

async function cmdStart(parsed: Parsed, cwd: string, json: boolean) {
  const [name, ...taskParts] = parsed.positionals;
  if (!name) throw new Error("Usage: tango start <name> --role <role> [task...]");
  if (parsed.flags["result-required"] !== undefined && parsed.flags["no-result-required"] !== undefined) throw new Error("Use either --result-required or --no-result-required, not both.");
  const task = taskParts.join(" ").trim();
  const result = await serverRequest("POST", "/api/v1/runs/start", {
    name,
    role: flagString(parsed.flags, "role"),
    harness: flagString(parsed.flags, "harness"),
    mode: flagString(parsed.flags, "mode") as any,
    model: flagString(parsed.flags, "model"),
    thinking: flagThinking(parsed.flags, "thinking"),
    effort: flagString(parsed.flags, "effort"),
    cwd,
    task,
    clean: flagBool(parsed.flags, "clean"),
    dryRun: flagBool(parsed.flags, "dry-run"),
    recursive: parsed.flags.recursive === undefined ? undefined : flagBool(parsed.flags, "recursive"),
    parentRunId: process.env.TANGO_RUN_ID,
    parentRunDir: process.env.TANGO_RUN_DIR,
    rootSessionId: process.env.TANGO_ROOT_SESSION_ID,
    workstreamId: process.env.TANGO_WORKSTREAM_ID,
    resultRequired: parsed.flags["result-required"] !== undefined
      ? true
      : parsed.flags["no-result-required"] !== undefined
        ? false
        : undefined,
  });
  if (json) printJson(result);
  else {
    console.log(`${result.agent.name}: ${result.agent.status} (${result.agent.mode}/${result.agent.harness})`);
    console.log(result.agent.runDir);
  }
  if (flagBool(parsed.flags, "attach") && result.agent.mode === "interactive") attachTmux(result.agent.tmuxSocket, result.agent.tmuxSession);
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

async function ensureServer(): Promise<NonNullable<ReturnType<typeof readServerDiscovery>>> {
  const lockPath = `${serverDiscoveryPath()}.start.lock`;
  const existing = readServerDiscovery();
  if (existing) {
    const existingDeadline = Date.now() + 15_000;
    let lastHealth: any;
    while (Date.now() < existingDeadline) {
      lastHealth = await serverHealth(existing);
      if (serverHealthSupportsRunApi(lastHealth)) {
        rmSync(lockPath, { force: true });
        return existing;
      }
      if (lastHealth?.ok === true) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (process.env.TANGO_SERVER_URL) throw new Error(lastHealth?.ok === true ? "Configured Tango server is not compatible with this Tango CLI." : "Configured Tango server is not reachable.");
    if (lastHealth?.ok === true) rmSync(serverDiscoveryPath(), { force: true });
    else throw new Error(`Discovered Tango server at ${existing.url} did not answer health checks; refusing to autostart a duplicate while PID ${existing.pid} is alive. Run \`tango doctor server\` or stop the stale server.`);
  }
  if (process.env.TANGO_SERVER_URL) throw new Error("Configured Tango server is not reachable.");
  const preferredPort = preferredServerPort();
  const fixedProbe = await discoverFixedLocalServer(preferredPort);
  if (fixedProbe.discovery) {
    rmSync(lockPath, { force: true });
    return fixedProbe.discovery;
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15000;
  let startedByThisProcess = false;
  let spawnPort = preferredPort === 0 || fixedProbe.occupied ? "0" : String(preferredPort);
  while (Date.now() < deadline) {
    const discovery = readServerDiscovery();
    if (discovery && await serverSupportsRunApi(discovery)) {
      if (startedByThisProcess) rmSync(lockPath, { force: true });
      return discovery;
    }

    let lockFd: number | undefined;
    try {
      lockFd = openSync(lockPath, "wx");
      writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      closeSync(lockFd);
      lockFd = undefined;
      startedByThisProcess = true;
      const child = spawn(process.execPath, [cliPath, "server", "--port", spawnPort], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
    } catch (error: any) {
      if (lockFd !== undefined) closeSync(lockFd);
      if (error?.code !== "EEXIST") throw error;
      reapStaleServerStartLock(lockPath);
    }

    await new Promise((resolve) => setTimeout(resolve, startedByThisProcess ? 100 : 150));
  }
  if (startedByThisProcess) rmSync(lockPath, { force: true });
  throw new Error("Timed out starting Tango server for active command after 15s.");
}

function reapStaleServerStartLock(lockPath: string): void {
  try {
    const stat = statSync(lockPath);
    const [pidText] = readFileSync(lockPath, "utf8").split(/\r?\n/);
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
      rmSync(lockPath, { force: true });
      return;
    }
    if (Date.now() - stat.mtimeMs > 15_000) rmSync(lockPath, { force: true });
  } catch {}
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function preferredServerPort(): number {
  const raw = process.env.TANGO_SERVER_PORT;
  if (raw === undefined || raw === "") return DEFAULT_SERVER_PORT;
  if (!/^\d+$/.test(raw)) throw new Error("TANGO_SERVER_PORT must be an integer between 0 and 65535.");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("TANGO_SERVER_PORT must be an integer between 0 and 65535.");
  return port;
}

async function discoverFixedLocalServer(port: number): Promise<{ discovery?: ServerDiscovery; occupied: boolean }> {
  if (port === 0) return { occupied: false };
  const discovery: ServerDiscovery = { schemaVersion: 1, url: `http://127.0.0.1:${port}`, pid: 0, startedAt: new Date().toISOString(), dataRoot: dataRoot() };
  const health = await serverHealth(discovery);
  if (!health.ok) return { occupied: await localPortListening(port) };
  const expectedRoot = dataRoot();
  const healthRoot = typeof health.dataRoot === "string" ? resolve(health.dataRoot) : undefined;
  const defaultRoot = join(homedir(), ".tango");
  if (healthRoot && healthRoot !== expectedRoot) return { occupied: true };
  if (!healthRoot && expectedRoot !== defaultRoot) return { occupied: true };
  const found = { ...discovery, pid: typeof health.pid === "number" ? health.pid : 0, ...(healthRoot ? { dataRoot: healthRoot } : {}) };
  mkdirSync(dirname(serverDiscoveryPath()), { recursive: true });
  writeFileSync(serverDiscoveryPath(), `${JSON.stringify(found, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { discovery: found, occupied: true };
}

async function localPortListening(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (occupied: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(true));
    socket.once("error", (error: any) => done(error?.code !== "ECONNREFUSED"));
  });
}

async function serverHealth(discovery: ServerDiscovery): Promise<any> {
  const headers: Record<string, string> = { "accept": "application/json" };
  if (discovery.token) headers.authorization = `Bearer ${discovery.token}`;
  try {
    const healthUrl = new URL("/api/v1/health", discovery.url);
    const res = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false };
    return await res.json().catch(() => ({ ok: false }));
  } catch {
    return { ok: false };
  }
}

async function serverSupportsRunApi(discovery: ServerDiscovery): Promise<boolean> {
  return serverHealthSupportsRunApi(await serverHealth(discovery));
}

function serverHealthSupportsRunApi(payload: any): boolean {
  return payload?.ok === true && payload?.schemaVersion === 1 && Array.isArray(payload.capabilities) && payload.capabilities.includes("runs");
}

async function serverRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const discovery = await ensureServer();
  const url = new URL(path, discovery.url);
  const headers: Record<string, string> = { "accept": "application/json" };
  if (discovery.token) headers.authorization = `Bearer ${discovery.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let payload: any;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { ok: false, error: text }; }
  if (!res.ok) throw new ServerRequestError(res.status, payload?.error ?? `Tango server request failed (${res.status})`, payload);
  return payload;
}

function targetQuery(cwd: string, name?: string, runId?: string, runDir?: string): string {
  const params = new URLSearchParams();
  params.set("cwd", cwd);
  if (name) params.set("name", name);
  if (runId) params.set("runId", runId);
  if (runDir) params.set("runDir", runDir);
  return params.toString();
}

function legacyCommand(oldName: string, replacement: string, json: boolean) {
  const message = `tango ${oldName} has been removed. Use tango ${replacement}.`;
  if (json) {
    process.exitCode = 1;
    return printJson({ ok: false, error: message, removed: oldName, replacement });
  }
  throw new Error(message);
}

async function cmdList(parsed: Parsed, cwd: string, json: boolean) {
  const all = flagBool(parsed.flags, "all");
  const path = all ? "/api/v1/runs" : `/api/v1/runs?${new URLSearchParams({ cwd }).toString()}`;
  const payload = await serverRequest("GET", path);
  let states = all ? payload.runs : payload.runs.filter((state: any) => {
    const rootSessionId = process.env.TANGO_ROOT_SESSION_ID;
    const workstreamId = process.env.TANGO_WORKSTREAM_ID;
    if (rootSessionId && workstreamId) return state.identity.rootSessionId === rootSessionId && state.identity.workstreamId === workstreamId;
    if (rootSessionId) return state.identity.rootSessionId === rootSessionId;
    if (workstreamId) return state.identity.workstreamId === workstreamId;
    return true;
  });
  const requestedStates = new Set(flagStrings(parsed.flags, "state"));
  if (flagBool(parsed.flags, "active")) for (const s of ["running", "idle", "created"]) requestedStates.add(s);
  if (flagBool(parsed.flags, "problems") || flagBool(parsed.flags, "health")) for (const s of ["blocked", "error"]) requestedStates.add(s);
  if (flagBool(parsed.flags, "health")) for (const s of ["running", "idle", "created"]) requestedStates.add(s);
  if (requestedStates.size) states = states.filter((s: any) => requestedStates.has(s.agent.state));
  const counts = countStates(states);
  const total = states.length;
  states = sortRunStatesForList(states);
  const full = flagBool(parsed.flags, "full");
  const limit = full ? total : flagPositiveInt(parsed.flags, "limit", flagBool(parsed.flags, "health") ? 50 : 100, 1000);
  const returnedStates = states.slice(0, limit);
  const truncated = returnedStates.length < total;
  const agents = returnedStates.map((s: any) => summarizeRunStateForList(s));
  if (json) return printJson({ ok: true, total, returned: agents.length, truncated, counts, agents, ...(truncated ? { hint: "Narrow with --state/--active/--problems/--health or pass --limit/--full for more." } : {}) });
  if (!states.length) return console.log("No agents.");
  if (truncated) console.log(`Showing ${agents.length}/${total} agents. Narrow with --state/--active/--problems/--health or pass --limit/--full.`);
  for (const a of agents) console.log(`${a.name.padEnd(18)} ${a.status.padEnd(8)} ${a.role ?? "-"} ${a.mode}/${a.harness} ${a.task}`);
}

function countStates(states: any[]): Record<string, number> {
  return states.reduce((acc: Record<string, number>, state: any) => {
    const key = state.agent?.state ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function sortRunStatesForList(states: any[]): any[] {
  const rank: Record<string, number> = { error: 0, blocked: 1, running: 2, idle: 3, created: 4, stopped: 5, done: 6 };
  return [...states].sort((a, b) => {
    const ar = rank[a.agent?.state] ?? 9;
    const br = rank[b.agent?.state] ?? 9;
    if (ar !== br) return ar - br;
    const at = Date.parse(a.agent?.updatedAt ?? a.identity?.updatedAt ?? a.identity?.createdAt ?? "") || 0;
    const bt = Date.parse(b.agent?.updatedAt ?? b.identity?.updatedAt ?? b.identity?.createdAt ?? "") || 0;
    return bt - at;
  });
}

function summarizeRunStateForList(s: any) {
  const task = String(s.identity.task ?? "").replace(/\s+/g, " ").trim();
  return { ...s.identity, task: task.length > 240 ? `${task.slice(0, 239)}…` : task, taskTruncated: task.length > 240 || task !== s.identity.task, status: s.agent.state, summary: s.agent.summary, needs: s.agent.needs, result: s.result, metrics: s.metrics };
}

async function cmdInspect(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango inspect [name] [--run-id <id>|--run-dir <dir>]");
  const payload = await serverRequest("GET", `/api/v1/runs/state?${targetQuery(cwd, name, runId, runDir)}`);
  const state = payload.state;
  if (json) return printJson(payload);
  console.log(`${state.identity.name}: ${state.agent.state} (${state.identity.mode}/${state.identity.harness})`);
  console.log(`process: ${state.process.state}`);
  console.log(`result: ${state.result.state} ready=${state.result.ready} safeToRead=${state.result.safeToRead} deliverable=${state.result.deliverable}`);
  if (state.agent.summary) console.log(`summary: ${state.agent.summary}`);
  if (state.agent.needs) console.log(`needs: ${state.agent.needs}`);
  console.log(`runDir: ${state.identity.runDir}`);
}

async function cmdActivity(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango activity [name] [--run-id <id>|--run-dir <dir>]");
  const lines = flagPositiveInt(parsed.flags, "lines", 200, 5000);
  const params = new URLSearchParams(targetQuery(cwd, name, runId, runDir));
  params.set("limit", String(lines));
  if (flagBool(parsed.flags, "raw")) params.set("raw", "true");
  if (flagBool(parsed.flags, "events")) params.set("events", "true");
  if (flagBool(parsed.flags, "peek")) params.set("peek", "true");
  const payload = await serverRequest("GET", `/api/v1/runs/activity?${params.toString()}`);
  if (json) printJson(payload);
  else process.stdout.write(payload.output.endsWith("\n") ? payload.output : `${payload.output}\n`);
}

function cmdLook(parsed: Parsed, cwd: string, json: boolean) {
  return cmdActivity(parsed, cwd, json);
}

function cmdCheckpoint(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango checkpoint [name] [--run-id <id>|--run-dir <dir>] [--latest|--all] [--json]");
  const meta = resolveTarget({ name, cwd, runId, runDir, env: process.env as any });
  const checkpoints = readCheckpoints(meta.runDir);
  const selected = flagBool(parsed.flags, "all") ? checkpoints : checkpoints.slice(-1);
  if (json) return printJson({ ok: true, schemaVersion: 1, agent: meta, checkpoints: selected });
  if (!selected.length) return console.log("No checkpoints.");
  const text = selected.map((checkpoint) => {
    const body = readCheckpointBody(checkpoint).trim();
    const header = `${checkpoint.createdAt} ${checkpoint.checkpointId}: ${checkpoint.summary}`;
    return body && body !== checkpoint.summary ? `${header}\n${body}` : header;
  }).join("\n\n");
  console.log(text);
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

async function cmdMessage(parsed: Parsed, cwd: string, json: boolean) {
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  const type = flagString(parsed.flags, "type");
  const [first, ...rest] = parsed.positionals;
  const broadcast = type === "broadcast";
  const name = broadcast ? undefined : (runId || runDir) && rest.length === 0 ? undefined : first;
  const msg = broadcast ? parsed.positionals : (runId || runDir) && rest.length === 0 ? parsed.positionals : rest;
  if (((!broadcast && !name && !runId && !runDir)) || msg.length === 0) throw new Error("Usage: tango message [name] <message> [--run-id <id>|--run-dir <dir>] [--type instruction|ask|update|broadcast]");
  const attachments = flagStrings(parsed.flags, "attachment");
  const forceTerminal = flagBool(parsed.flags, "force-terminal");
  const payload = type || flagBool(parsed.flags, "urgent") || attachments.length
    ? await serverRequest("POST", "/api/v1/messages", { name, cwd, runId, runDir, type: type ?? "instruction", body: msg.join(" "), urgent: flagBool(parsed.flags, "urgent"), attachments, forceTerminal })
    : await serverRequest("POST", "/api/v1/runs/message", { name, cwd, runId, runDir, message: msg.join(" "), forceTerminal });
  if (json) printJson(payload); else console.log("sent");
}

async function cmdStop(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  const runId = flagString(parsed.flags, "run-id");
  const runDir = flagString(parsed.flags, "run-dir");
  if (!name && !runId && !runDir) throw new Error("Usage: tango stop <name> [--run-id <id>|--run-dir <dir>]");
  const payload = await serverRequest("POST", "/api/v1/runs/stop", { name, cwd, runId, runDir });
  if (json) printJson(payload); else console.log(`${payload.agent.name}: stopped`);
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

async function cmdReport(parsed: Parsed, json: boolean) {
  const [state, ...msg] = parsed.positionals;
  if (!state) throw new Error("Usage: tango report <running|idle|blocked|done|error|stopped> [--result-file <path>|--summary-only] [--checkpoint <summary> --checkpoint-file <path>] [message]");
  const runDir = flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR;
  if (!runDir) throw new Error("No run dir. Set TANGO_RUN_DIR or pass --run-dir.");
  if (!isAgentStatus(state)) throw new Error(`Invalid status: ${state}`);
  const resultFileFlag = flagString(parsed.flags, "result-file");
  const summaryOnly = flagBool(parsed.flags, "summary-only") || flagBool(parsed.flags, "no-result");
  if (resultFileFlag && summaryOnly) throw new Error("Use either --result-file or --summary-only/--no-result, not both.");
  if (resultFileFlag && state !== "done" && state !== "idle") throw new Error("--result-file is only valid with `tango report done` or reusable `tango report idle`.");
  if (summaryOnly && state !== "done" && state !== "idle") throw new Error("--summary-only/--no-result is only valid with `tango report done` or reusable `tango report idle`.");
  const checkpointSummary = flagString(parsed.flags, "checkpoint");
  const checkpointFile = flagString(parsed.flags, "checkpoint-file");
  const payload = await serverRequest("POST", "/api/v1/runs/report", { runDir, state, summary: msg.join(" "), needs: flagString(parsed.flags, "needs"), resultFile: resultFileFlag, summaryOnly, checkpointSummary, checkpointFile });
  if (json) printJson(payload); else console.log(`${payload.agent.name}: ${payload.agent.status}`);
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
  if (!parentMeta) {
    const rootSessionId = process.env.TANGO_ROOT_SESSION_ID;
    const workstreamId = process.env.TANGO_WORKSTREAM_ID;
    if (!rootSessionId && !workstreamId) throw new Error("Usage: tango children [parent-name] (or run inside a Tango agent, pass --run-dir, or run inside a Tango root session)");
    const agents = listMetadata(undefined).map(refreshStatus).map(withMetrics).filter((a) => {
      const rootMatch = rootSessionId ? a.rootSessionId === rootSessionId : true;
      const wsMatch = workstreamId ? a.workstreamId === workstreamId : true;
      return rootMatch && wsMatch;
    });
    const tree = rootSessionForest(agents);
    if (json) return printJson({ ok: true, rootSessionId, workstreamId, agents, tree });
    if (flagBool(parsed.flags, "tree")) return console.log(renderChildTree(tree));
    if (!agents.length) return console.log("No child agents.");
    for (const a of agents) console.log(`${a.name.padEnd(18)} ${a.status.padEnd(8)} ${a.role ?? "-"} ${a.mode}/${a.harness} ${a.task}`);
    return;
  }
  const agents = listMetadata(undefined).map(refreshStatus).map(withMetrics).filter((a) => isChildOf(a, parentMeta!));
  const tree = childTree(parentMeta);
  if (json) return printJson({ ok: true, parentRunDir: parentMeta.runDir, agents, tree });
  if (flagBool(parsed.flags, "tree")) return console.log(renderChildTree(tree));
  if (!agents.length) return console.log("No child agents.");
  for (const a of agents) console.log(`${a.name.padEnd(18)} ${a.status.padEnd(8)} ${a.role ?? "-"} ${a.mode}/${a.harness} ${a.task}`);
}

function rootSessionForest(agents: AgentMetadata[]): any[] {
  const byRunId = new Map(agents.filter((a) => a.runId).map((a) => [a.runId, a]));
  const byRunDir = new Map(agents.map((a) => [resolve(a.runDir), a]));
  const roots = agents.filter((a) => {
    if (a.parentRunId && byRunId.has(a.parentRunId)) return false;
    if (a.parentRunDir && byRunDir.has(resolve(a.parentRunDir))) return false;
    return true;
  });
  const rec = (p: AgentMetadata): any => ({ agent: p, children: agents.filter((a) => isChildOf(a, p)).map(rec) });
  return roots.map(rec);
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
  try {
    const payload = await serverRequest("POST", "/api/v1/runs/follow", { name, cwd, runId, runDir, until, timeoutMs });
    if (json) return printJson(payload);
    console.log(`${payload.agent.name}: ${payload.agent.status}${payload.agent.summary ? ` - ${payload.agent.summary}` : ""}`);
    console.log(`result: ${payload.resultAssessment.resultState} ready=${payload.resultAssessment.resultReady} safeToRead=${payload.resultAssessment.safeToRead}`);
  } catch (error) {
    if (json && error instanceof ServerRequestError && error.status === 504) {
      const statePayload = await serverRequest("GET", `/api/v1/runs/state?${targetQuery(cwd, name, runId, runDir)}`);
      const stateResult = statePayload.state?.result;
      const resultAssessment = stateResult ? {
        ...stateResult,
        resultReady: stateResult.ready,
        resultIssue: stateResult.issue,
        resultWarning: stateResult.warning,
      } : undefined;
      process.exitCode = 0;
      return printJson({ ok: false, timeout: true, condition: until, state: statePayload.state, agent: statePayload.state?.identity, resultAssessment });
    }
    throw error;
  }
}

async function cmdWait(parsed: Parsed, cwd: string, json: boolean) {
  const condition = (flagString(parsed.flags, "until") ?? "terminal") as WaitCondition;
  if (!["terminal", "result-ready", "attention", "blocked", "error", "settled", "inbox"].includes(condition)) throw new Error(`Invalid --until ${condition}. Expected terminal, result-ready, attention, blocked, error, settled, or inbox.`);
  const mode = (flagString(parsed.flags, "mode") ?? "all") as WaitMode;
  if (!["any", "all"].includes(mode)) throw new Error("Invalid --mode. Expected any or all.");
  const timeoutMs = flagNonNegativeNumber(parsed.flags, "timeout", 0) * 1000;
  const names = parsed.positionals;
  const runIds = flagStrings(parsed.flags, "run-id");
  const runDirs = flagStrings(parsed.flags, "run-dir");
  const targets = [
    ...names.map((name) => resolveTarget({ name, cwd, env: process.env as any })),
    ...runIds.map((id) => resolveTarget({ cwd, runId: id, env: process.env as any })),
    ...runDirs.map((dir) => resolveTarget({ cwd, runDir: dir, env: process.env as any })),
  ];
  if (!targets.length) throw new Error("Usage: tango wait <targets...> [--run-id <id>] [--run-dir <dir>] --until <terminal|result-ready|attention> [--mode any|all] [--timeout seconds]");
  const result = await waitRuns(targets, condition, mode, timeoutMs);
  if (json) {
    process.exitCode = result.timedOut ? 1 : 0;
    return printJson({ ok: !result.timedOut, schemaVersion: 1, timeout: result.timedOut || undefined, ...result });
  }
  if (result.timedOut) process.stderr.write(`tango wait: timed out waiting for ${mode} ${condition}\n`);
  console.log(`${result.matched.length} matched, ${result.pending.length} pending`);
  for (const item of result.matched) console.log(`  ✓ ${item.name} [${item.status}]`);
  for (const item of result.pending) console.log(`  … ${item.name} [${item.status}]`);
  if (result.timedOut) process.exitCode = 1;
}

async function cmdDoctor(parsed: Parsed, cwd: string, json: boolean) {
  const [sub] = parsed.positionals;
  if (sub === "server") return await cmdDoctorServer(json);
  if (sub !== "events") throw new Error("Usage: tango doctor events|server");
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

async function cmdDoctorServer(json: boolean) {
  const discovery = readRawServerDiscovery();
  const health = discovery ? await serverHealth(discovery) : undefined;
  const lock = readServerStartLock();
  const serverProcesses = serverProcessesForDataRoot(dataRoot());
  const healthy = serverHealthSupportsRunApi(health) && (!health?.dataRoot || resolve(health.dataRoot) === dataRoot());
  const issues: string[] = [];
  if (!discovery) issues.push("No server discovery file found.");
  else if (!processAlive(discovery.pid)) issues.push(`Discovery PID ${discovery.pid} is not alive.`);
  if (discovery && !healthy) issues.push(health?.ok === true ? "Discovered server is not compatible with this CLI/dataRoot." : "Discovered server did not answer health checks.");
  if (lock?.stale) issues.push("Server start lock appears stale.");
  if (serverProcesses.length > 1) issues.push(`Multiple Tango server processes found for this TANGO_HOME: ${serverProcesses.map((p) => p.pid).join(", ")}.`);
  const recommendation = issues.length === 0 ? "Server discovery looks healthy." : "Inspect or clean up stale server processes/locks, then rerun an active Tango command to autostart one canonical server.";
  const result = { ok: issues.length === 0, dataRoot: dataRoot(), discovery, health, lock, serverProcesses, issues, recommendation };
  if (json) return printJson(result);
  console.log(`TANGO_HOME: ${result.dataRoot}`);
  console.log(`discovery: ${discovery ? `${discovery.url} pid=${discovery.pid}` : "missing"}`);
  console.log(`health: ${healthy ? "ok" : "not healthy"}`);
  console.log(`start lock: ${lock ? `${lock.path} pid=${lock.pid ?? "?"}${lock.stale ? " stale" : ""}` : "none"}`);
  console.log(`server processes: ${serverProcesses.length ? serverProcesses.map((p) => `${p.pid} ${p.cmd}`).join("\n  ") : "none"}`);
  if (issues.length) console.log(`issues:\n  ${issues.join("\n  ")}`);
  console.log(`recommendation: ${recommendation}`);
}

function readRawServerDiscovery(): ServerDiscovery | undefined {
  try {
    if (!existsSync(serverDiscoveryPath())) return undefined;
    return JSON.parse(readFileSync(serverDiscoveryPath(), "utf8")) as ServerDiscovery;
  } catch { return undefined; }
}

function readServerStartLock(): { path: string; pid?: number; mtimeMs: number; stale: boolean } | undefined {
  const path = `${serverDiscoveryPath()}.start.lock`;
  try {
    const stat = statSync(path);
    const [pidText] = readFileSync(path, "utf8").split(/\r?\n/);
    const pid = Number(pidText);
    const hasPid = Number.isInteger(pid) && pid > 0;
    return { path, ...(hasPid ? { pid } : {}), mtimeMs: stat.mtimeMs, stale: (hasPid && !processAlive(pid)) || Date.now() - stat.mtimeMs > 15_000 };
  } catch { return undefined; }
}

function serverProcessesForDataRoot(root: string): Array<{ pid: number; cmd: string }> {
  if (!existsSync("/proc")) return [];
  const processes: Array<{ pid: number; cmd: string }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdlineRaw = readFileSync(join("/proc", entry, "cmdline"), "utf8");
      const argv = cmdlineRaw.split("\0").filter(Boolean);
      const cliIndex = argv.findIndex((arg) => arg.endsWith("/cli.js") || arg.endsWith("cli.js"));
      if (cliIndex < 0 || argv[cliIndex + 1] !== "server") continue;
      const cmd = argv.join(" ");
      const env = readFileSync(join("/proc", entry, "environ"), "utf8").split("\0");
      const tangoHome = env.find((item) => item.startsWith("TANGO_HOME="))?.slice("TANGO_HOME=".length);
      const home = env.find((item) => item.startsWith("HOME="))?.slice("HOME=".length);
      const processRoot = tangoHome || (home ? join(home, ".tango") : undefined);
      if (processRoot && resolve(processRoot) === root) processes.push({ pid: Number(entry), cmd });
    } catch {}
  }
  return processes.sort((a, b) => a.pid - b.pid);
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
  const inboxId = flagString(parsed.flags, "inbox");
  const unread = flagBool(parsed.flags, "unread");
  const peek = flagBool(parsed.flags, "peek");
  const targetCount = [!!name || !!runId || !!runDir, !!inboxId, unread].filter(Boolean).length;
  if (targetCount !== 1) throw new Error("Usage: tango result <target>|--run-id <id>|--run-dir <dir>|--unread|--inbox <id> [--peek] [--watch] [--timeout seconds]");
  if (unread || inboxId) return await cmdResultInbox(parsed, cwd, json, peek, inboxId);
  let timedOut = false;
  if (flagBool(parsed.flags, "watch")) {
    const timeoutMs = flagNonNegativeNumber(parsed.flags, "timeout", 0) * 1000;
    try { await serverRequest("POST", "/api/v1/runs/follow", { name, cwd, runId, runDir, until: "result-resolved", timeoutMs }); }
    catch (error) {
      if (!(error instanceof ServerRequestError && error.status === 504)) throw error;
      timedOut = true;
    }
  }
  const query = new URLSearchParams(targetQuery(cwd, name, runId, runDir));
  if (peek) query.set("peek", "true");
  const payload = await serverRequest("GET", `/api/v1/runs/result?${query.toString()}`);
  return printResult(payload.agent, payload.assessment, json, timedOut);
}

async function cmdResultInbox(parsed: Parsed, cwd: string, json: boolean, peek: boolean, inboxId?: string) {
  const inboxPath = inboxId ? "/api/v1/inbox" : `/api/v1/inbox${scopeQuery(parsed)}`;
  const inboxPayload = await serverRequest("GET", inboxPath);
  const resultItems = (inboxPayload.inbox ?? []).filter((item: any) => item.type === "result" && item.state !== "handled" && item.state !== "dismissed" && (!inboxId || item.inboxId === inboxId));
  if (inboxId && !resultItems.length) throw new Error(`Inbox result item not found or already handled: ${inboxId}`);
  const results = [];
  for (const item of resultItems) {
    const sourceRunDir = item.source?.runDir;
    if (!sourceRunDir) continue;
    const query = new URLSearchParams(targetQuery(cwd, undefined, undefined, sourceRunDir));
    query.set("peek", "true");
    const payload = await serverRequest("GET", `/api/v1/runs/result?${query.toString()}`);
    if (!peek) await serverRequest("POST", `/api/v1/inbox/${encodeURIComponent(item.inboxId)}/handled`);
    results.push({ inboxId: item.inboxId, agent: payload.agent, result: payload.assessment?.result || (payload.assessment?.resultState === "summary-only" ? payload.agent?.summary : ""), resultReady: payload.assessment?.resultReady, resultState: payload.assessment?.resultState, safeToRead: payload.assessment?.safeToRead, assessment: payload.assessment });
  }
  if (json) return printJson({ ok: true, results });
  if (!results.length) return console.log("No unread results.");
  for (const r of results) {
    console.log(`\n## ${r.agent.name}`);
    process.stdout.write(r.result ? (r.result.endsWith("\n") ? r.result : `${r.result}\n`) : `[summary] ${r.agent.summary ?? ""}\n`);
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

function scopeQuery(parsed: Parsed): string {
  const params = new URLSearchParams();
  const hasExplicitScope = ["root-session-id", "workstream-id", "run-id", "run-dir"].some((name) => parsed.flags[name] !== undefined);
  const rootSessionId = flagString(parsed.flags, "root-session-id") ?? (!hasExplicitScope ? process.env.TANGO_ROOT_SESSION_ID : undefined);
  const workstreamId = flagString(parsed.flags, "workstream-id") ?? (!hasExplicitScope ? process.env.TANGO_WORKSTREAM_ID : undefined);
  const runId = flagString(parsed.flags, "run-id") ?? (!hasExplicitScope ? process.env.TANGO_RUN_ID : undefined);
  const runDir = flagString(parsed.flags, "run-dir") ?? (!hasExplicitScope ? process.env.TANGO_RUN_DIR : undefined);
  if (rootSessionId) params.set("rootSessionId", rootSessionId);
  if (workstreamId) params.set("workstreamId", workstreamId);
  if (runId) params.set("runId", runId);
  if (runDir) params.set("runDir", runDir);
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function cmdBoard(parsed: Parsed, json: boolean) {
  const payload = await serverRequest("GET", `/api/v1/board${scopeQuery(parsed)}`);
  if (json) return printJson(payload);
  console.log(`Tango board: ${payload.counts.active} running · ${payload.counts.blocked} blocked · ${payload.counts.unread} unread`);
  for (const section of ["active", "blocked", "unreadResults", "recentErrors"] as const) {
    const items = payload[section] ?? [];
    if (!items.length) continue;
    console.log(`\n${section}:`);
    for (const item of items) console.log(`  ${item.name} [${item.status}] ${item.summary ?? item.activity ?? ""}`.trimEnd());
  }
}

async function cmdInbox(parsed: Parsed, json: boolean) {
  const [sub, inboxId] = parsed.positionals;
  if (["read", "handled", "dismiss"].includes(sub ?? "")) {
    if (!inboxId) throw new Error(`Usage: tango inbox ${sub} <inbox-id>`);
    const payload = await serverRequest("POST", `/api/v1/inbox/${encodeURIComponent(inboxId)}/${sub}`);
    if (json) return printJson(payload);
    return console.log(`${payload.item.inboxId}: ${payload.item.state}`);
  }
  if (sub) throw new Error("Usage: tango inbox [--json] [--all] | tango inbox read|handled|dismiss <inbox-id>");
  const query = scopeQuery(parsed);
  const includeAll = flagBool(parsed.flags, "all");
  const sep = query ? "&" : "?";
  const payload = await serverRequest("GET", `/api/v1/inbox${query}${includeAll ? `${sep}include=all` : ""}`);
  if (json) return printJson(payload);
  const items = payload.inbox ?? [];
  if (!items.length) return console.log("No inbox items.");
  for (const item of items) console.log(`${item.inboxId} ${item.state.padEnd(8)} ${item.type.padEnd(8)} ${item.source.agentName}: ${item.summary ?? ""}`);
}

async function cmdCollectResults(parsed: Parsed, cwd: string, json: boolean) {
  const inboxPayload = await serverRequest("GET", `/api/v1/inbox${scopeQuery(parsed)}`);
  const resultItems = (inboxPayload.inbox ?? []).filter((item: any) => item.type === "result" && item.state !== "handled" && item.state !== "dismissed");
  const results = [];
  for (const item of resultItems) {
    const runDir = item.source?.runDir;
    if (!runDir) continue;
    const payload = await serverRequest("GET", `/api/v1/runs/result?${targetQuery(cwd, undefined, undefined, runDir)}`);
    await serverRequest("POST", `/api/v1/inbox/${encodeURIComponent(item.inboxId)}/handled`);
    results.push({ inboxId: item.inboxId, agent: payload.agent, result: payload.result || (payload.assessment?.resultState === "summary-only" ? payload.agent?.summary : ""), assessment: payload.assessment });
  }
  if (json) return printJson({ ok: true, results });
  if (!results.length) return console.log("No unread results.");
  for (const r of results) {
    console.log(`\n## ${r.agent.name}`);
    console.log(r.result || `[summary] ${r.agent.summary ?? ""}`);
  }
}

function cmdRecover(parsed: Parsed, json: boolean) {
  const runDir = flagString(parsed.flags, "run-dir") ?? parsed.positionals[0];
  if (!runDir) throw new Error("Usage: tango recover --run-dir <dir>");
  const meta = readMetadata(runDir);
  const state = cpBuildRunState(meta);
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
  return status === "created" || status === "running" || status === "idle" || status === "done" || status === "error" || status === "blocked" || status === "stopped" || status === "unknown";
}

function isFinalStatus(status: AgentStatus): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

function refreshStatus(meta: AgentMetadata): AgentMetadata {
  return reconcileAgentLifecycle(meta);
}

function help() {
  console.log(`tango - native/tmux agent orchestration\n\nUsage:\n  tango server [--host 127.0.0.1] [--port 43117] [--token TOKEN]
  tango server url\n  tango start <name> --role <role> [--harness pi|claude|gemini|generic] [--mode oneshot|interactive] [--model MODEL] [--thinking off|minimal|low|medium|high|xhigh] [--effort low|medium|high|xhigh|max] [--dry-run] [--no-result-required] [task...]\n  tango ps [--json] [--all]\n  tango inspect [name] [--run-id <id>] [--run-dir <dir>] [--json]\n  tango activity [name] [--run-id <id>] [--run-dir <dir>] [--lines N] [--json] [--raw] [--peek]\n  tango checkpoint [name] [--run-id <id>] [--run-dir <dir>] [--latest|--all] [--json]\n  tango follow <name> --until terminal|result-resolved|attention [--run-id <id>] [--run-dir <dir>] [--timeout seconds] [--json]\n  tango wait <targets...> [--run-id <id>] [--run-dir <dir>] --until terminal|result-ready|attention [--mode any|all] [--timeout seconds] [--json]\n  tango attach [name] [--run-id <id>] [--run-dir <dir>]\n  tango message <name> [--run-id <id>] [--run-dir <dir>] [--force-terminal] <message>\n  tango stop <name> [--run-id <id>] [--run-dir <dir>]\n  tango delete <name> [--run-id <id>] [--run-dir <dir>]\n  tango report <running|idle|blocked|done|error|stopped> [message] [--needs kind] [--result-file path|--summary-only] [--checkpoint summary] [--checkpoint-file path]\n  tango watch [--json] [--all] [--from-start]\n  tango children [parent-name] [--run-id <id>] [--run-dir <dir>] [--tree] [--json]\n  tango doctor events [--json]
  tango doctor server [--json]\n  tango metrics update --run-dir <dir> --payload <json> [--json]\n  tango artifact publish <path> [--title title] [--entry file] [--mime type] [--json]\n  tango artifact list [--json]\n  tango artifact revoke <artifact-id> [--json]\n  tango reconcile [--json] [--all] [--children]\n  tango result <target>|--run-id <id>|--run-dir <dir>|--unread|--inbox <id> [--peek] [--watch] [--timeout seconds] [--json]\n  tango board [--root-session-id id|--workstream-id id|--run-id id|--run-dir dir] [--json]\n  tango inbox [--root-session-id id|--workstream-id id|--run-id id|--run-dir dir] [--all] [--json]\n  tango inbox read|handled|dismiss <inbox-id> [--json]\n  tango recover --run-dir <dir> [--json]\n  tango roles list|show <name>\n\nRemoved active protocol commands fail fast: tango status, tango look, tango list, tango collect-results.\n\nNotes:\n  Final statuses (done, error, stopped) are immutable; duplicate done is only accepted as an exact no-op.\n  Interactive idle is non-terminal/reusable and means awaiting another task; done closes/finalizes normal retasking.\n  Use --checkpoint/--checkpoint-file for durable progress updates that do not finalize a result.\n  Blocked agents can be moved back to running after the blocker is resolved.\n  tango result marks finalized and summary-only results handled so duplicate completion notifications are suppressed.\n`);
}

main();
