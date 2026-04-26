#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startAgent } from "./start.js";
import { projectSlug } from "./paths.js";
import { fail, printJson } from "./json.js";
import { findRunDir, listMetadata, readMetadata, removeRunDir, transitionStatus, updateStatus } from "./metadata.js";
import { readMetrics, writeMetrics } from "./metrics.js";
import { appendEvent, eventMatchesCwd, initialEventOffset, readEvents, type TangoEvent } from "./events.js";
import { listRoles, loadRole, assembleSystemPrompt } from "./roles.js";
import { attachTmux, captureTmux, sendTmux, stopTmux, tmuxAlive } from "./runtime/tmux.js";
import type { AgentMetadata, AgentStatus, ThinkingLevel } from "./types.js";

interface Parsed { flags: Record<string, string | boolean | string[]>; positionals: string[] }

const BOOLEAN_FLAGS = new Set(["json", "clean", "attach", "dry-run", "all", "recursive", "no-recursive", "from-start", "tree"]);
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
      case "result": return cmdResult(parsed, cwd, json);
      case "roles": return cmdRoles(parsed, json);
      default: return fail(`Unknown command: ${cmd}`, json);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), json);
  }
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
  const meta = withMetrics(loadByName(name, cwd));
  const lines = Number(flagString(parsed.flags, "lines") ?? "200");
  let text = "";
  if (meta.mode === "interactive" && tmuxAlive(meta.tmuxSocket, meta.tmuxSession)) text = captureTmux(meta.tmuxSocket, meta.tmuxSession, lines);
  else if (existsSync(join(meta.runDir, "output.log"))) text = readFileSync(join(meta.runDir, "output.log"), "utf8").split(/\r?\n/).slice(-lines).join("\n");
  else if (existsSync(join(meta.runDir, "result.md"))) text = readFileSync(join(meta.runDir, "result.md"), "utf8");
  if (json) printJson({ ok: true, agent: meta, output: text }); else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function cmdAttach(parsed: Parsed, cwd: string) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango attach <name>");
  const meta = loadByName(name, cwd);
  attachTmux(meta.tmuxSocket, meta.tmuxSession);
}

function cmdMessage(parsed: Parsed, cwd: string, json: boolean) {
  const [name, ...msg] = parsed.positionals;
  if (!name || msg.length === 0) throw new Error("Usage: tango message <name> <message>");
  const meta = loadByName(name, cwd);
  sendTmux(meta.tmuxSocket, meta.tmuxSession, msg.join(" "));
  if (json) printJson({ ok: true }); else console.log("sent");
}

function cmdStop(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango stop <name>");
  const meta = loadByName(name, cwd);
  stopTmux(meta.tmuxSocket, meta.tmuxSession);
  transitionStatus(meta.runDir, "stopped");
  const stopped = readMetadata(meta.runDir);
  if (json) printJson({ ok: true, agent: stopped }); else console.log(`${name}: stopped`);
}

function cmdDelete(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango delete <name>");
  const meta = loadByName(name, cwd);
  stopTmux(meta.tmuxSocket, meta.tmuxSession);
  removeRunDir(meta.runDir);
  if (json) printJson({ ok: true }); else console.log(`${name}: deleted`);
}

function cmdStatus(parsed: Parsed, json: boolean) {
  const [state, ...msg] = parsed.positionals;
  if (!state) throw new Error("Usage: tango status <running|blocked|done|error|stopped> [message]");
  const runDir = flagString(parsed.flags, "run-dir") ?? process.env.TANGO_RUN_DIR;
  if (!runDir) throw new Error("No run dir. Set TANGO_RUN_DIR or pass --run-dir.");
  if (!isAgentStatus(state)) throw new Error(`Invalid status: ${state}`);
  const summary = msg.join(" ");
  const meta = updateStatus(runDir, state, summary, { needs: flagString(parsed.flags, "needs") });
  if (state === "done" && msg.length) writeFileSync(join(runDir, "result.md"), `${summary}\n`, { flag: "a" });
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
      if (!all && !eventMatchesCwd(event, cwd)) continue;
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
  const parentRunDir = name ? loadByName(name, cwd).runDir : process.env.TANGO_RUN_DIR;
  if (!parentRunDir) throw new Error("Usage: tango children [parent-name] (or run inside a Tango agent)");
  const agents = listMetadata(undefined).map(refreshStatus).map(withMetrics).filter((a) => a.parentRunDir === parentRunDir);
  if (json) return printJson({ ok: true, parentRunDir, agents, tree: childTree(agents, parentRunDir) });
  if (flagBool(parsed.flags, "tree")) return console.log(renderChildTree(agents, parentRunDir));
  if (!agents.length) return console.log("No child agents.");
  for (const a of agents) console.log(`${a.name.padEnd(18)} ${a.status.padEnd(8)} ${a.role ?? "-"} ${a.mode}/${a.harness} ${a.task}`);
}

async function cmdWait(parsed: Parsed, cwd: string, json: boolean) {
  const names = parsed.positionals;
  if (!names.length) throw new Error("Usage: tango wait <name...>");
  const timeoutMs = Number(flagString(parsed.flags, "timeout") ?? "0") * 1000;
  const start = Date.now();
  while (true) {
    const agents = names.map((name) => withMetrics(loadByName(name, cwd)));
    if (agents.every((a) => isTerminal(a.status))) {
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

function childTree(agents: AgentMetadata[], parentRunDir: string): any[] {
  const byParent = new Map<string, AgentMetadata[]>();
  for (const a of listMetadata(undefined).map(refreshStatus).map(withMetrics)) if (a.parentRunDir) byParent.set(a.parentRunDir, [...(byParent.get(a.parentRunDir) ?? []), a]);
  const rec = (runDir: string): any[] => (byParent.get(runDir) ?? []).map((a) => ({ agent: a, children: rec(a.runDir) }));
  return rec(parentRunDir);
}

function renderChildTree(agents: AgentMetadata[], parentRunDir: string): string {
  const tree = childTree(agents, parentRunDir);
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

function isTerminal(status: AgentStatus): boolean {
  return status === "done" || status === "error" || status === "blocked" || status === "stopped";
}

function cmdResult(parsed: Parsed, cwd: string, json: boolean) {
  const [name] = parsed.positionals;
  if (!name) throw new Error("Usage: tango result <name>");
  const meta = loadByName(name, cwd);
  const file = join(meta.runDir, "result.md");
  const result = existsSync(file) ? readFileSync(file, "utf8") : (meta.summary ?? "");
  if (json) printJson({ ok: true, agent: meta, result }); else process.stdout.write(result.endsWith("\n") ? result : `${result}\n`);
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

function loadByName(name: string, cwd: string) {
  const runDir = findRunDir(name, cwd);
  if (!runDir) throw new Error(`Agent not found: ${name}`);
  return refreshStatus(readMetadata(runDir));
}

function refreshStatus(meta: any) {
  if (meta.mode === "interactive" && meta.status === "running" && !tmuxAlive(meta.tmuxSocket, meta.tmuxSession)) {
    return transitionStatus(meta.runDir, "stopped");
  }
  return meta;
}

function help() {
  console.log(`tango - native/tmux agent orchestration\n\nUsage:\n  tango start <name> --role <role> [--harness pi|claude|generic] [--mode oneshot|interactive] [--model MODEL] [--thinking off|minimal|low|medium|high|xhigh] [--effort low|medium|high|xhigh|max] [--dry-run] [task...]\n  tango list [--json] [--all]\n  tango look <name> [--lines N] [--json]\n  tango attach <name>\n  tango message <name> <message>\n  tango stop <name>\n  tango delete <name>\n  tango status <state> [message] [--needs kind]\n  tango watch [--json] [--all] [--from-start]\n  tango children [parent-name] [--tree] [--json]\n  tango wait <name...> [--timeout seconds] [--json]\n  tango doctor events [--json]\n  tango metrics update --run-dir <dir> --payload <json> [--json]\n  tango result <name>\n  tango roles list|show <name>\n`);
}

main();
