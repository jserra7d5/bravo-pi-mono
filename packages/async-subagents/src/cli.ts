#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { archiveRuns } from "./archive.js";
import { claudeChildMcpMain } from "./claudeChildMcp.js";
import { writeFastTrackState } from "./fastTrack.js";
import { listRuns } from "./list.js";
import { createRootSession, readRootSession } from "./rootSession.js";
import type { RootSessionIdentity } from "./types.js";
import { RunStore } from "./runStore.js";
import { supervisorMain } from "./supervisor.js";
import { discoverAgentDefinitions } from "./agentDefinitions.js";
import { waitSubagents } from "./wait.js";
import { watchSubagents } from "./watch.js";
import { buildSubagentTools } from "../extensions/pi/tools.js";

const VERSION = "0.1.0";
const SKILL_NAME = "pi-async-subagents";

const USAGE = `async-subagents ${VERSION}

Usage:
  async-subagents agents [--cwd DIR]
  async-subagents start --agent NAME (--task TEXT|--task-file PATH) [options]
  async-subagents run   --agent NAME (--task TEXT|--task-file PATH) [options]
  async-subagents watch  --run-id ID (repeatable) [--cwd DIR] [--interval-seconds N] [--no-result-body]
  async-subagents status [--run-id ID] [--all] [--limit N] [--cwd DIR]   (no --run-id lists runs newest-first)
  async-subagents wait   --run-id ID [--cwd DIR] [--timeout-seconds N]
  async-subagents result --run-id ID [--cwd DIR]
  async-subagents continue --run-id ID [--task TEXT|--task-file PATH] [options]
  async-subagents message --run-id ID (--task TEXT|--task-file PATH) [--type answer|instruction|context] [--file PATH]
  async-subagents pause|cancel --run-id ID [--reason TEXT] [--cwd DIR]
  async-subagents archive [--older-than-days N (default 7)] [--cap N] [--dry-run]   (global across all projects)
  async-subagents install [--claude-dir DIR] [--force]

  async-subagents supervisor --input PATH          (internal: child lifecycle entrypoint)
  async-subagents claude-child-mcp --run-dir DIR   (internal)

watch emits one NDJSON line per lifecycle transition (buckets: terminal|attention|busy),
reconciles dead runs, inlines each result once, and exits when all runs are terminal-or-attention.

Start/run options:
  --cwd DIR  --variant NAME  --thinking LEVEL
  --file PATH_OR_GLOB (repeatable write scope; prefer ownership-boundary roots)
  --protect PATH (repeatable; never-write paths inside the scope)
  --fast-track (priority service tier; only with operator authorization, critical-path lanes only)
  --skill NAME (repeatable)  --root-session-id ID  --timeout-seconds N
Continue options:
  --file PATH (repeatable; additively widens write scope)
  --additional-run-seconds N  --thinking LEVEL  --timeout-seconds N

run is start followed by a terminal wait. Output is JSON (watch: NDJSON).
`;

interface ParsedArgs {
  _: string[];
  file: string[];
  skill: string[];
  protect: string[];
  runId?: string[];
  [key: string]: unknown;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [], file: [], skill: [], protect: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
    if (key === "help" || key === "noResultBody" || key === "dryRun" || key === "fastTrack" || key === "all" || key === "force") {
      parsed[key] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    if (key === "file" || key === "skill" || key === "protect") (parsed[key] as string[]).push(value);
    else if (key === "runId") (parsed.runId ??= []).push(value);
    else parsed[key] = value;
  }
  return parsed;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function numberOption(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${field} must be a number`);
  return parsed;
}

/**
 * Link the packaged skill into the Claude skills directory.
 *
 * A symlink rather than a copy so the skill and the CLI it documents can never drift:
 * the flags in SKILL.md are the flags this binary parses, in the same commit.
 */
function install(args: ParsedArgs, packageRoot: string): unknown {
  const claudeDir = typeof args.claudeDir === "string" ? resolve(args.claudeDir) : join(homedir(), ".claude");
  const source = join(packageRoot, "skills", SKILL_NAME);
  if (!existsSync(source)) throw new Error(`packaged skill is missing: ${source}`);
  const skillsDir = join(claudeDir, "skills");
  const target = join(skillsDir, SKILL_NAME);
  mkdirSync(skillsDir, { recursive: true });
  let replaced: string | undefined;
  if (existsSync(target) || isSymlink(target)) {
    // Only ever reclaim a symlink automatically. A real directory there is someone's
    // hand-authored skill, and silently deleting it would be unrecoverable.
    if (!isSymlink(target) && args.force !== true) {
      throw new Error(`${target} exists and is not a symlink; move it aside or pass --force`);
    }
    replaced = isSymlink(target) ? "symlink" : "directory";
    rmSync(target, { recursive: true, force: true });
  }
  symlinkSync(source, target, "dir");
  return {
    ok: true,
    skill: SKILL_NAME,
    linked: { from: target, to: source },
    replaced,
    cli: process.argv[1],
    note: "Ensure the async-subagents binary is on PATH (npm link, or add node_modules/.bin to PATH).",
  };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function packageRootFrom(entry: string): string {
  let current = dirname(entry);
  while (true) {
    if (existsSync(join(current, "package.json"))) {
      try {
        const name = (JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as { name?: string }).name;
        if (name === "@bravo/async-subagents") return current;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("could not locate the @bravo/async-subagents package root");
    current = parent;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "supervisor") return supervisorMain(argv.slice(1));
  if (command === "claude-child-mcp") return claudeChildMcpMain(argv.slice(1));

  const args = parseArgs(argv.slice(1));
  if (args.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const cwd = typeof args.cwd === "string" ? resolve(args.cwd) : process.cwd();
  const packageRoot = packageRootFrom(fileURLToPath(import.meta.url));

  const taskBody = (): string | undefined => {
    if (typeof args.taskFile === "string") return readFileSync(resolve(args.taskFile), "utf8");
    return typeof args.task === "string" ? args.task : undefined;
  };

  if (command === "install") return void emit(install(args, packageRoot));

  if (command === "archive") {
    const olderThanDays = args.olderThanDays === undefined ? 7 : Number(args.olderThanDays);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new Error("--older-than-days must be a non-negative number");
    const cap = args.cap === undefined ? undefined : Number(args.cap);
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 0)) throw new Error("--cap must be a non-negative integer");
    return void emit(await archiveRuns(new RunStore(), { olderThanDays, cap, dryRun: args.dryRun === true }));
  }

  if (command === "agents") {
    const definitions = discoverAgentDefinitions({ cwd });
    return void emit({
      cwd,
      agents: [...definitions.values()]
        .map((definition) => ({
          name: definition.name,
          description: definition.description,
          source: definition.source,
          harness: definition.harness,
          model: definition.model,
          thinkingLevel: definition.thinkingLevel,
          mode: definition.mode,
          context: definition.context,
          session: definition.session,
          maxRunSeconds: definition.maxRunSeconds,
          maxSubagentDepth: definition.maxSubagentDepth,
          tools: definition.tools,
          skills: definition.skills,
          variants: Object.keys(definition.variants).sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  const store = new RunStore({ cwd });
  const runId = args.runId?.at(-1);

  if (command === "watch") {
    if (!args.runId?.length) throw new Error("watch requires at least one --run-id");
    await watchSubagents({
      cwd,
      runIds: args.runId,
      intervalSeconds: numberOption(args.intervalSeconds, "interval-seconds"),
      includeResultBody: args.noResultBody === undefined,
    });
    return;
  }

  let root: RootSessionIdentity | undefined;
  if (typeof args.rootSessionId === "string") {
    root = readRootSession({ cwd, rootSessionId: args.rootSessionId }) || createRootSession({ cwd, rootSessionId: args.rootSessionId });
  }
  if (runId) {
    const status = store.readStatus(runId);
    root = readRootSession({ cwd, rootSessionId: status.rootSessionId }) || createRootSession({ cwd, rootSessionId: status.rootSessionId });
  }
  root ??= createRootSession({ cwd });

  const tools = buildSubagentTools({
    getRootIdentity: () => root,
    setRootIdentity: (value: RootSessionIdentity) => {
      root = value;
    },
  });
  const call = async (name: string, params: Record<string, unknown>): Promise<any> => {
    const tool = tools.find((candidate: { name: string }) => candidate.name === name);
    if (!tool) throw new Error(`tool unavailable: ${name}`);
    const response = await tool.execute("cli", params, undefined, undefined, { cwd });
    if (response?.isError) throw Object.assign(new Error(response.content?.[0]?.text || `${name} failed`), { details: response.details });
    return response.details;
  };
  const waitFor = async (target: string) =>
    waitSubagents(store, {
      runIds: [target],
      mode: "all",
      until: "result",
      includeResult: true,
      includeStatus: true,
      timeoutMs: (numberOption(args.timeoutSeconds, "timeout-seconds") ?? 0) * 1000 || 1_800_000,
      pollIntervalMs: 250,
    });

  if (command === "start" || command === "run") {
    const body = taskBody();
    if (typeof args.agent !== "string" || !body) throw new Error(`${command} requires --agent and --task or --task-file`);
    if (args.fastTrack === true) writeFastTrackState(store.runRoot, root.rootSessionId, true);
    const started = await call("subagent_start", {
      agent: args.agent,
      variant: args.variant,
      task: body,
      cwd,
      files: args.file,
      protect: args.protect.length ? args.protect : undefined,
      skills: args.skill,
      thinkingLevel: args.thinking,
      fastTrack: args.fastTrack,
      context: "fresh",
      session: "record",
    });
    // runId first so a truncated read still carries the handle: losing it strands a live
    // write-lane and invites a duplicate dispatch into the same checkout.
    if (command === "start") return void emit({ runId: started.runId, ...started, rootSessionId: root.rootSessionId });
    return void emit({ start: { ...started, rootSessionId: root.rootSessionId }, wait: await waitFor(started.runId) });
  }

  if (command === "status") {
    if (!runId) return void emit({ runs: listRuns(store, { all: args.all === true, limit: args.limit === undefined ? 20 : Number(args.limit) }) });
    return void emit(await call("subagent_status", { runIds: args.runId, includeEvents: true, includeInbox: true, maxEvents: 10 }));
  }

  if (command === "wait") {
    if (!runId) throw new Error("wait requires --run-id");
    return void emit(await waitFor(runId));
  }

  if (command === "result") {
    if (!runId) throw new Error("result requires --run-id");
    return void emit(await call("subagent_result", { runId, includeBody: true, includeArtifacts: true }));
  }

  if (command === "continue") {
    if (!runId) throw new Error("continue requires --run-id");
    const continued = await call("subagent_continue", {
      runId,
      body: taskBody(),
      files: args.file,
      type: "instruction",
      additionalRunSeconds: numberOption(args.additionalRunSeconds, "additional-run-seconds"),
      thinkingLevel: args.thinking,
      notifyOn: ["question", "blocked", "liveness", "result", "completed", "failed", "cancelled", "expired"],
    });
    const target = continued.runId || runId;
    if (args.timeoutSeconds !== undefined) return void emit({ continue: continued, wait: await waitFor(target) });
    return void emit(continued);
  }

  if (command === "message") {
    if (!runId) throw new Error("message requires --run-id");
    const body = taskBody();
    if (!body) throw new Error("message requires --task or --task-file");
    return void emit(await call("subagent_message", { runId, type: args.type || "answer", body, files: args.file.length ? args.file : undefined, requiresAck: false }));
  }

  if (command === "pause" || command === "cancel") {
    if (!runId) throw new Error(`${command} requires --run-id`);
    return void emit(await call("subagent_interrupt", { runId, action: command, reason: args.reason }));
  }

  process.stderr.write(USAGE);
  process.exitCode = 2;
}

/**
 * Errors go to STDOUT as JSON and set a non-zero exit. Writing only to stderr made a failed
 * `start` indistinguishable from a silent success for anyone reading stdout, which is how a
 * lane gets believed-running when it never launched.
 */
function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const details = (error as { details?: unknown } | undefined)?.details;
  process.stdout.write(`${JSON.stringify({ ok: false, error: { message, ...(details ? { details } : {}) } }, null, 2)}\n`);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.on("unhandledRejection", fail);
  process.on("uncaughtException", fail);
  main().catch(fail);
}
