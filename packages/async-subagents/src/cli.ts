#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
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
import { applyInstall, installerLinks, planInstall, InstallApplyError } from "./installer.js";

/**
 * Read from the manifest rather than a literal, so `--version` cannot claim a release the
 * repo did not cut. `npm run version:set` writes every manifest at once; a constant here
 * would be an eighteenth place to remember.
 */
const VERSION: string = (() => {
  const manifest = join(packageRootFrom(fileURLToPath(import.meta.url)), "package.json");
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "0.0.0";
})();

const USAGE = `async-subagents ${VERSION}

Usage:
  async-subagents agents [--cwd DIR]
  async-subagents start --agent NAME (--task TEXT|--task-file PATH) [--store-cwd DIR] [--cwd DIR] [options]
  async-subagents run   --agent NAME (--task TEXT|--task-file PATH) [--store-cwd DIR] [--cwd DIR] [options]
  async-subagents watch  --run-id ID (repeatable) [--store-cwd DIR] [--interval-seconds N] [--no-result-body]
  async-subagents status [--run-id ID] [--all] [--limit N] [--store-cwd DIR]   (no --run-id lists runs newest-first)
  async-subagents wait   --run-id ID [--store-cwd DIR] [--timeout-seconds N]
  async-subagents result --run-id ID [--store-cwd DIR]
  async-subagents continue --run-id ID [--task TEXT|--task-file PATH] [--store-cwd DIR] [options]
  async-subagents message --run-id ID (--task TEXT|--task-file PATH) [--store-cwd DIR] [--type answer|instruction|context] [--file PATH]
  async-subagents pause|cancel --run-id ID [--reason TEXT] [--store-cwd DIR]
  async-subagents archive [--older-than-days N (default 7)] [--cap N] [--dry-run]   (global across all projects)
  async-subagents install [--claude-dir DIR] [--home DIR] [--force]
    links the skill into ~/.claude/skills and the CLI to ~/.async-subagents/bin/async-subagents

  async-subagents supervisor --input PATH          (internal: child lifecycle entrypoint)
  async-subagents claude-child-mcp --run-dir DIR   (internal)

watch emits one NDJSON line per lifecycle transition (buckets: terminal|attention|busy),
reconciles dead runs, inlines each result once, and exits when all runs are terminal-or-attention.

Start/run options:
  --store-cwd DIR (canonical storage)  --cwd DIR (child execution/discovery)  --variant NAME  --thinking LEVEL
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
  const storeCwd = typeof args.storeCwd === "string" ? resolve(args.storeCwd) : process.cwd();
  const packageRoot = packageRootFrom(fileURLToPath(import.meta.url));

  const taskBody = (): string | undefined => {
    if (typeof args.taskFile === "string") return readFileSync(resolve(args.taskFile), "utf8");
    return typeof args.task === "string" ? args.task : undefined;
  };

  if (command === "install") {
    const claudeDir = typeof args.claudeDir === "string" ? resolve(args.claudeDir) : join(homedir(), ".claude");
    const home = typeof args.home === "string" ? resolve(args.home) : homedir();
    let result;
    try { result = applyInstall(planInstall(installerLinks(packageRoot, home, claudeDir), args.force === true)); }
    catch (error) {
      if (error instanceof InstallApplyError) throw Object.assign(error, { details: error.result });
      throw error;
    }
    const byName = Object.fromEntries(result.results.map((item) => [item.name, item]));
    const runtimeSkill = byName["pi-async-subagents"] as Record<string, unknown>;
    const launcher = byName.launcher as Record<string, unknown>;
    const replaced = runtimeSkill.action === "unchanged" ? "symlink" : runtimeSkill.replaced === "conflict" ? "directory" : runtimeSkill.replaced;
    const replacedLauncher = launcher.action === "unchanged" ? "symlink" : launcher.replaced === "conflict" ? "file" : launcher.replaced;
    return void emit({ ok: true, skill: "pi-async-subagents", results: result.results, launcher, linked: runtimeSkill, budgetSkill: byName["budget-auto-swarm"], replaced, replacedLauncher });
  }


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

  const store = new RunStore({ cwd: storeCwd });
  const runId = args.runId?.at(-1);

  if (command === "watch") {
    if (!args.runId?.length) throw new Error("watch requires at least one --run-id");
    await watchSubagents({
      cwd: storeCwd,
      runIds: args.runId,
      intervalSeconds: numberOption(args.intervalSeconds, "interval-seconds"),
      includeResultBody: args.noResultBody === undefined,
    });
    return;
  }

  let root: RootSessionIdentity | undefined;
  if (typeof args.rootSessionId === "string") {
    root = readRootSession({ cwd: storeCwd, rootSessionId: args.rootSessionId }) || createRootSession({ cwd: storeCwd, rootSessionId: args.rootSessionId });
  }
  if (runId) {
    const status = store.readStatus(runId);
    root = readRootSession({ cwd: storeCwd, rootSessionId: status.rootSessionId }) || createRootSession({ cwd: storeCwd, rootSessionId: status.rootSessionId });
  }
  root ??= createRootSession({ cwd: storeCwd });

  const tools = buildSubagentTools({
    getRootIdentity: () => root,
    setRootIdentity: (value: RootSessionIdentity) => {
      root = value;
    },
  });
  const call = async (name: string, params: Record<string, unknown>): Promise<any> => {
    const tool = tools.find((candidate: { name: string }) => candidate.name === name);
    if (!tool) throw new Error(`tool unavailable: ${name}`);
    const response = await tool.execute("cli", params, undefined, undefined, { cwd: storeCwd });
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
      storageCwd: storeCwd,
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

/**
 * Compare real paths, not raw strings.
 *
 * The documented entrypoint is a symlink (`~/.async-subagents/bin/async-subagents`), so
 * `process.argv[1]` is the link while `import.meta.url` is what Node resolved it to. A
 * string compare fails, `main()` never runs, and every command exits 0 having printed
 * nothing — which reads as a silent success.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.on("unhandledRejection", fail);
  process.on("uncaughtException", fail);
  main().catch(fail);
}
