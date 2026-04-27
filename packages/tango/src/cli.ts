#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOneshotFromRuntime, startAgent } from "./start.js";
import { projectSlug } from "./paths.js";
import { fail, printJson } from "./json.js";
import { listMetadata, readMetadata, removeRunDir, transitionStatus, updateStatus, writeMetadata } from "./metadata.js";
import { readMetrics, writeMetrics } from "./metrics.js";
import { appendEvent, eventMatchesLineage, initialEventOffset, readEvents, type TangoEvent } from "./events.js";
import { resolveTarget, isChildOf } from "./targetResolver.js";
import { getRecipientContext, markLatestDoneHandled, markSeen, shouldDeliverEvent, upsertAttentionFromEvent } from "./attention.js";
import { listRoles, loadRole, assembleSystemPrompt } from "./roles.js";
import { attachTmux, captureTmux, sendTmux, stopTmux } from "./runtime/tmux.js";
import { isTerminalStatus, reconcileAgentLifecycle } from "./lifecycle.js";
import type { AgentMetadata, AgentStatus, ThinkingLevel } from "./types.js";
import { listArtifacts, publishArtifact, readServerDiscovery, revokeArtifact, startTangoServer } from "./server.js";

interface Parsed { flags: Record<string, string | boolean | string[]>; positionals: string[] }

const BOOLEAN_FLAGS = new Set(["json", "clean", "attach", "dry-run", "all", "recursive", "no-recursive", "from-start", "tree", "children", "allow-private-bind"]);
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
      const val = eq > 0 ? a.slice(eq + 1) : BOOLEAN_FLAGS.has(key) ? true : (argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true);
      if (flags[key] !== undefined) flags[key] = Array.isArray(flags[key]) ? [...flags[key] as string[], String(val)] : [String(flags[key]), String(val)];
      else flags[key] = val;
    } else positionals.push(a);
  }
  return { flags, positionals };
}

function flagString(flags: Parsed["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
function flagBool(flags: Parsed["flags"], name: string): boolean { return flags[name] === true || flags[name] === "true"; }
function flagThinking(flags: Parsed["flags"], name: string): ThinkingLevel | undefined {
  const value = flagString(flags, name);
  if (value !== undefined && !THINKING_LEVELS.has(value as ThinkingLevel)) throw new Error(`Invalid --${name}: ${value}. Expected off, minimal, low, medium, high, or xhigh.`);
  return value as ThinkingLevel | undefined;
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const parsed = parse(rest);
  const json = flagBool(parsed.flags, "json");
  const cwd = resolve(flagString(parsed.flags, "cwd") ?? process.cwd());
  try {
    switch (cmd) {
      case "help": case "--help": case "-h": return help();
      case "server": return await cmdServer(parsed);
      case "start": return await cmdStart(parsed, cwd, json);
      case "list": return cmdList(cwd, json, flagBool(parsed.flags, "all"));
      case "look": return cmdLook(parsed, cwd, json);
      case "attach": return cmdAttach(parsed, cwd);
      case "message": return cmdMessage(parsed, cwd, json);
      case "stop": return cmdStop(parsed, cwd, json);
      case "delete": return cmdDelete(parsed, cwd, json);
      case "status": return cmdStatus(parsed, json);
      case "watch": return await cmdWatch(parsed, cwd, json);
      case "children": return await cmdChildren(parsed, cwd, json);
      case "wait": return await cmdWait(parsed, cwd, json);
      case "doctor": return cmdDoctor(parsed, cwd, json);
      case "metrics": return cmdMetrics(parsed, json);
      case "artifact": return await cmdArtifact(parsed, cwd, json);
      case "reconcile": return cmdReconcile(parsed, cwd, json);
      case "runner": return await cmdRunner(parsed);
      case "result": return cmdResult(parsed, cwd, json);
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
    port: flagString(parsed.flags, "port") ? Number(flagString(parsed.flags, "port")) : undefined,
    token: flagString(parsed.flags, "token"),
    allowPrivateBind: flagBool(parsed.flags, "allow-private-bind"),
  });
}

async function cmdStart(parsed: Parsed, cwd: string, json: boolean) {
  const [name, ...taskParts] = parsed.positionals;
  if (!name) throw new Error("Usage: tango start <name> --role <role> [task...]");
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
    json,
  });
  if (json) printJson({ ok: true, agent: result.meta, command: result.command });
  else {
    console.log(`${result.meta.name}: ${result.meta.status} (${result.meta.mode}/${result.meta.harness})`);
    console.log(result.meta.runDir);
  }
  if (flagBool(parsed.flags, "attach") && result.meta.mode === "interactive") attachTmux(result.meta.tmuxSocket, result.meta.tmuxSession);
}

function cmdList(cwd: string, json: boolean, all: boolean) {
  const agents = listMetadata(all ? undefined : cwd).map(refreshStatus).map(withMetrics);
  if (json) return printJson({ ok: true, agents });
  if (!agents.length) return console.log("No agents.");
  for (const a of agents) console.log(`${a.name.padEnd(18)} ${a.status.padEnd(8)} ${a.role ?? "-"} ${a.mode}/${a.harness} ${a.task}`);
}

function cmdLook(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango look <name>");
  const meta = withMetrics(resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any }));
  const lines = Number(flagString(parsed.flags, "lines") ?? "200");
  let text = "";
  if (meta.mode === "interactive" && meta.status === "running") text = captureTmux(meta.tmuxSocket, meta.tmuxSession, lines);
  else if (existsSync(join(meta.runDir, "output.log"))) text = readFileSync(join(meta.runDir, "output.log"), "utf8").split(/\r?\n/).slice(-lines).join("\n");
  else if (existsSync(join(meta.runDir, "result.md"))) text = readFileSync(join(meta.runDir, "result.md"), "utf8");
  if (json) printJson({ ok: true, agent: meta, output: text }); else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function cmdAttach(parsed: Parsed, cwd: string) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango attach <name>");
  const meta = resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any });
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
  if (!name) throw new Error("Usage: tango stop <name>");
  const meta = resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any });
  stopTmux(meta.tmuxSocket, meta.tmuxSession);
  transitionStatus(meta.runDir, "stopped");
  const stopped = readMetadata(meta.runDir);
  if (json) printJson({ ok: true, agent: stopped }); else console.log(`${name}: stopped`);
}

function cmdDelete(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango delete <name>");
  const meta = resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any });
  stopTmux(meta.tmuxSocket, meta.tmuxSession);
  removeRunDir(meta.runDir);
  if (json) printJson({ ok: true }); else console.log(`${name}: deleted`);
}

function cmdStatus(parsed: Parsed, json: boolean) {
  const [state, ...msg] = parsed.positionals;
  if (!state) throw new Error("Usage: tango status <running|blocked|done|error|stopped> [--result-file <path>] [message]");
  const runDir = flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR;
  if (!runDir) throw new Error("No run dir. Set TANGO_RUN_DIR or pass --run-dir.");
  if (!isAgentStatus(state)) throw new Error(`Invalid status: ${state}`);
  const summary = msg.join(" ");
  let meta = updateStatus(runDir, state, summary, { needs: flagString(parsed.flags, "needs") });
  const resultFileFlag = flagString(parsed.flags, "result-file");
  if (resultFileFlag) {
    if (state !== "done") throw new Error("--result-file is only valid with `tango status done`.");
    const source = resolve(resultFileFlag);
    if (!existsSync(source)) throw new Error(`Result file not found: ${resultFileFlag}`);
    const resultFile = join(runDir, "result.md");
    writeFileSync(resultFile, readFileSync(source, "utf8"), "utf8");
    meta = readMetadata(runDir);
    meta.resultFile = resultFile;
    meta.resultFinalizedAt = new Date().toISOString();
    delete meta.resultIssue;
    // Keep metadata.summary operational; result.md is the durable deliverable.
    writeMetadata(meta);
  }
  if (json) printJson({ ok: true, agent: meta }); else console.log(`${meta.name}: ${meta.status}`);
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
      const rec = getRecipientContext();
      upsertAttentionFromEvent(event, rec);
      markSeen(rec, event.runDir, event.eventId);
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

async function cmdWait(parsed: Parsed, cwd: string, json: boolean) {
  const names = parsed.positionals;
  if (!names.length) throw new Error("Usage: tango wait <name...>");
  const timeoutMs = Number(flagString(parsed.flags, "timeout") ?? "0") * 1000;
  const start = Date.now();
  // Resolve targets once so they cannot change mid-loop
  const targets = names.map((name) =>
    resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any })
  );
  while (true) {
    const agents = targets.map((meta) => withMetrics(refreshStatus(readMetadata(meta.runDir))));
    if (agents.every((a) => isTerminalStatus(a.status))) {
      const rec = getRecipientContext();
      for (const a of agents) {
        if (a.status === "done") markLatestDoneHandled(rec, a.runDir);
      }
      if (json) return printJson({ ok: true, agents });
      for (const a of agents) console.log(`${a.name}: ${a.status}${a.summary ? ` - ${a.summary}` : ""}`);
      return;
    }
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
      if (json) return printJson({ ok: false, timeout: true, agents });
      throw new Error(`Timed out waiting for ${names.join(", ")}`);
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

function cmdResult(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango result <name>");
  const meta = resolveTarget({ name, cwd, runId: flagString(parsed.flags, "run-id"), runDir: flagString(parsed.flags, "run-dir"), env: process.env as any });
  const file = join(meta.runDir, "result.md");
  const hasResultFile = existsSync(file);
  const finalized = meta.mode !== "oneshot" || !!meta.resultFinalizedAt;
  const result = hasResultFile ? readFileSync(file, "utf8") : "";
  const issue = resultIssue(meta, hasResultFile, finalized, result);
  const resultReady = hasResultFile && finalized && !issue;
  if (meta.mode === "oneshot" && isTerminalStatus(meta.status) && !finalized) {
    throw new Error("Result is still finalizing; try again shortly.");
  }
  markLatestDoneHandled(getRecipientContext(), meta.runDir);
  if (json) printJson({ ok: true, agent: meta, result, resultReady, resultIssue: issue });
  else {
    if (issue) process.stderr.write(`tango result: ${issue}\n`);
    if (result) process.stdout.write(result.endsWith("\n") ? result : `${result}\n`);
    else if (meta.summary) process.stdout.write(`[status summary only] ${meta.summary}\n`);
  }
}

function resultIssue(meta: AgentMetadata, hasResultFile: boolean, finalized: boolean, result: string): string | undefined {
  if (meta.resultIssue) return meta.resultIssue;
  if (meta.mode === "oneshot" && isTerminalStatus(meta.status) && hasResultFile && !finalized) return "Result is still finalizing; try again shortly.";
  if (!hasResultFile) {
    if (isTerminalStatus(meta.status)) return meta.summary ? "No deliverable result.md found; only metadata.summary is available." : "No deliverable result.md found.";
    return "Agent is not terminal; result is not ready.";
  }
  if (!result.trim()) return "Result deliverable is empty.";
  if (looksReportLike(meta.task) && result.trim().length < 240) return "Result deliverable is suspiciously short for a report/audit/planning task.";
  return undefined;
}

function looksReportLike(task: string): boolean {
  return /\b(report|audit|findings|investigat(?:e|ion)|research|plan|planning|review|analysis|analy[sz]e|root[- ]cause)\b/i.test(task);
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

function refreshStatus(meta: AgentMetadata): AgentMetadata {
  return reconcileAgentLifecycle(meta);
}

function help() {
  console.log(`tango - native/tmux agent orchestration\n\nUsage:\n  tango server [--host 127.0.0.1] [--port 43117] [--token TOKEN]
  tango server url\n  tango start <name> --role <role> [--harness pi|claude|generic] [--mode oneshot|interactive] [--model MODEL] [--thinking off|minimal|low|medium|high|xhigh] [--effort low|medium|high|xhigh|max] [--dry-run] [task...]\n  tango list [--json] [--all]\n  tango look <name> [--run-id <id>] [--run-dir <dir>] [--lines N] [--json]\n  tango attach <name> [--run-id <id>] [--run-dir <dir>]\n  tango message <name> [--run-id <id>] [--run-dir <dir>] <message>\n  tango stop <name> [--run-id <id>] [--run-dir <dir>]\n  tango delete <name> [--run-id <id>] [--run-dir <dir>]\n  tango status <state> [message] [--needs kind] [--result-file path]\n  tango watch [--json] [--all] [--from-start]\n  tango children [parent-name] [--run-id <id>] [--run-dir <dir>] [--tree] [--json]\n  tango wait <name...> [--run-id <id>] [--run-dir <dir>] [--timeout seconds] [--json]\n  tango doctor events [--json]\n  tango metrics update --run-dir <dir> --payload <json> [--json]\n  tango artifact publish <path> [--title title] [--entry file] [--mime type] [--json]\n  tango artifact list [--json]\n  tango artifact revoke <artifact-id> [--json]\n  tango reconcile [--json] [--all] [--children]\n  tango result <name> [--run-id <id>] [--run-dir <dir>]\n  tango roles list|show <name>\n`);
}

main();
