import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAgentVariant, resolveAgentDefinition } from "./agentDefinitions.js";
import { loadAsyncSubagentsConfig, type CodexAuthBalancerConfig } from "./config.js";
import { buildClaudeCommand, prepareClaudeHome, type ClaudeSkillInstallRequest } from "./claudeHarness.js";
import { buildPiCommand, childControlEventTool, childControlExtensionPath, inheritedExtensionPathsFromEnv, writeLaunchLogWithMetadata, type PiCommand } from "./piHarness.js";
import { assemblePrompt } from "./promptAssembly.js";
import { SubagentError } from "./errors.js";
import { evaluateFastTrack, readFastTrackState } from "./fastTrack.js";
import { finalizeTerminalRun } from "./lifecycle.js";
import { assignDisplayName } from "./namePacks.js";
import { branchPiSession, type BranchPiSession, type ParentPiSessionRef } from "./piSession.js";
import { createRootSession, readRootSession } from "./rootSession.js";
import { RunStore } from "./runStore.js";
import { createInitialStatus, updateRunStatus } from "./status.js";
import { codexBalancerSyncBackAndCleanup, runSupervisor, type SupervisorFakeInput, type SupervisorInput } from "./supervisor.js";
import type { ContextPolicy, SessionPolicy, SubagentStartResult, TerminalRunState, ThinkingLevel, TaskRecord } from "./types.js";
import { prepareLaunch } from "@bravo/codex-auth-balancer";

export interface StartFakeChildInput {
  mode: "child";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  effectiveMaxRunMs?: number;
}

export interface StartFakeImmediateInput extends SupervisorFakeInput {
  mode: "immediate";
}

export interface StartSubagentInput {
  runId?: string;
  agent: string;
  variant?: string;
  task: string;
  cwd?: string;
  runRoot?: string;
  parentRunId?: string;
  rootRunId?: string;
  rootSessionId?: string;
  depth?: number;
  files?: string[];
  skills?: string[];
  context?: ContextPolicy;
  session?: SessionPolicy;
  allowFreshFallback?: boolean;
  parentPiSessionRef?: ParentPiSessionRef | null;
  branchSession?: BranchPiSession;
  piSessionPathOverride?: string;
  requestedPiSessionPathOverride?: string;
  continuation?: {
    continuedFromRunId: string;
    continuationRootRunId?: string;
    continuationSequence?: number;
    continuationOfPiSessionPath?: string;
  };
  thinkingLevel?: ThinkingLevel;
  piBin?: string;
  env?: Record<string, string>;
  fake?: StartFakeImmediateInput | StartFakeChildInput;
  taskAssignment?: { task: TaskRecord; dependencies?: TaskRecord[] };
  fastTrack?: boolean;
}

export function normalizeAllowedFilePaths(files: string[] | undefined): string[] | undefined {
  if (!files?.length) return undefined;
  for (const file of files) {
    if (typeof file !== "string" || !file.trim() || /[\r\n]/.test(file)) {
      throw new SubagentError("INVALID_ALLOWED_FILE", "Allowed file paths must be non-empty single-line strings", { file });
    }
  }
  const unique = [...new Set(files)];
  return unique.length ? unique : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));

function findPackageRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      if (basename(current) === "async-subagents") return current;
    } catch {
      // Continue walking; basename cannot normally throw for a resolved path.
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start, "..");
    current = parent;
  }
}

const childFastTrackExtensionPath = join(findPackageRoot(here), "extensions", "child-fast-track", "index.ts");

function resolveRootIdentity(input: StartSubagentInput, cwd: string): { parentRunId: string; rootRunId: string; rootSessionId: string } {
  if (input.parentRunId) {
    return {
      parentRunId: input.parentRunId,
      rootRunId: input.rootRunId ?? input.parentRunId,
      rootSessionId: input.rootSessionId ?? input.parentRunId,
    };
  }
  const existing = readRootSession({ cwd, rootSessionId: input.rootSessionId });
  const identity = existing ?? createRootSession({ cwd, rootSessionId: input.rootSessionId });
  return {
    parentRunId: identity.parentRunId,
    rootRunId: input.rootRunId ?? identity.parentRunId,
    rootSessionId: identity.rootSessionId,
  };
}

function fakeChildCommand(input: StartFakeChildInput, cwd: string): PiCommand {
  const script = `
const delay = Number(process.env.ASYNC_SUBAGENTS_FAKE_DELAY_MS || "0");
setTimeout(() => {
  console.log(process.env.ASYNC_SUBAGENTS_FAKE_BODY || "Fake child completed");
  process.exit(Number(process.env.ASYNC_SUBAGENTS_FAKE_EXIT_CODE || "0"));
}, delay);
`;
  return {
    command: input.command ?? process.execPath,
    args: input.args ?? ["-e", script],
    cwd: resolve(input.cwd ?? cwd),
    env: input.env ?? {},
  };
}

function writeSupervisorInput(runDir: string, input: SupervisorInput): string {
  const path = join(runDir, "logs", "supervisor-input.json");
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return path;
}

function writeLauncherFailure(store: RunStore, input: SupervisorInput, message: string): void {
  finalizeTerminalRun(store, {
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    state: "failed",
    writerRole: "launcher",
    summary: "Supervisor launch failed",
    body: message,
    error: { code: "SUPERVISOR_LAUNCH_FAILED", message },
  });
}

function extensionArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-e" || args[i] === "--extension") && args[i + 1]) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

function isCodexModel(model?: string, onlyForProviders: string[] = ["openai-codex", "openai-codex-responses"]): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  const provider = lower.includes("/") ? lower.split("/")[0] : "";
  if (provider) return onlyForProviders.includes(provider);
  return onlyForProviders.includes(lower) || lower.includes("codex");
}

function isCodexBalancedProviderModel(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  const provider = lower.includes("/") ? lower.split("/")[0] : lower;
  return provider === "bravo-codex-balanced";
}

const BALANCED_REMAP_PROVIDERS = ["openai-codex", "openai-codex-responses"] as const;

/**
 * Pure helper. Maps `openai-codex/<X>` and `openai-codex-responses/<X>` to
 * `bravo-codex-balanced/<X>` so the launch flows through the per-request lease
 * provider instead of the copied-credential path. `bravo-codex-balanced/*` and
 * non-codex models are returned unchanged; `undefined` input returns `undefined`.
 * The provider segment is matched case-sensitively against the canonical ids;
 * only the provider prefix is rewritten, the model id is preserved verbatim.
 */
export function balancedModelId(model?: string): string | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  const provider = model.slice(0, slash);
  if (!(BALANCED_REMAP_PROVIDERS as readonly string[]).includes(provider)) return model;
  return `bravo-codex-balanced/${model.slice(slash + 1)}`;
}

/**
 * Resolve the codex-auth-balancer provider Pi extension to a loadable module
 * file path, robustly relative to the installed package (honors the workspace
 * symlink and the package `exports` map). Returns `undefined` if it cannot be
 * resolved so callers fail closed via the preflight rather than crashing.
 */
function resolveBalancedProviderExtensionPath(): string | undefined {
  try {
    const resolved = import.meta.resolve("@bravo/codex-auth-balancer/extensions/pi");
    const path = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

const PI_MODEL_HEADER = ["provider", "model", "context", "max-out", "thinking", "images"] as const;
const ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const TOKEN_COUNT = /^\d+(?:\.\d+)?(?:[KMGTP])?$/i;
const YES_NO = /^(?:yes|no)$/;

export interface PiModelTableRow {
  provider: string;
  model: string;
  context: string;
  maxOut: string;
  thinking: "yes" | "no";
  images: "yes" | "no";
}

/** Parse only rows authorized by an exact Pi six-column model-table header. */
export function parsePiModelTable(stream: string): PiModelTableRow[] {
  const rows: PiModelTableRow[] = [];
  let sawHeader = false;
  for (const rawLine of stream.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s+/);
    if (columns.length === PI_MODEL_HEADER.length && columns.every((column, index) => column === PI_MODEL_HEADER[index])) {
      sawHeader = true;
      continue;
    }
    if (!sawHeader || columns.length !== PI_MODEL_HEADER.length) continue;
    const [provider, model, context, maxOut, thinking, images] = columns;
    if (!provider || !model || !context || !maxOut || !thinking || !images) continue;
    if (!TOKEN_COUNT.test(context) || !TOKEN_COUNT.test(maxOut) || !YES_NO.test(thinking) || !YES_NO.test(images)) continue;
    rows.push({ provider, model, context, maxOut, thinking: thinking as "yes" | "no", images: images as "yes" | "no" });
  }
  return rows;
}

function modelListed(stdout: string, stderr: string, requested: string): boolean {
  const identities = new Map<string, PiModelTableRow>();
  // Streams authorize their own rows. In particular, a stdout header cannot
  // turn arbitrary stderr prose into a model row (or vice versa).
  for (const row of [...parsePiModelTable(stdout), ...parsePiModelTable(stderr)]) {
    const modelId = row.model.startsWith(`${row.provider}/`) ? row.model.slice(row.provider.length + 1) : row.model;
    identities.set(`${row.provider}\u0000${modelId}`, { ...row, model: modelId });
  }
  const slash = requested.indexOf("/");
  if (slash < 0) return [...identities.values()].filter((row) => row.model === requested).length === 1;
  if (slash === 0 || slash === requested.length - 1) return false;
  const provider = requested.slice(0, slash);
  const model = requested.slice(slash + 1);
  return identities.has(`${provider}\u0000${model}`);
}

export interface SubprocessTerminationDiagnostics {
  timedOut?: boolean;
  strategy?: "posix-process-group" | "windows-taskkill";
  termSent?: boolean;
  killSent?: boolean;
  taskkillExitCode?: number | null;
  taskkillTimedOut?: boolean;
  directChildFallback?: boolean;
  outputTruncated?: boolean;
  hardDeadlineReached?: boolean;
  errors?: string[];
}

export interface ModelPreflightResult {
  ok: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  message?: string;
  termination?: SubprocessTerminationDiagnostics;
}

function providerExtensionHint(model: string): string {
  return [
    `Model "${model}" is not available in the isolated child Pi launch.`,
    "Async subagents launch child Pi with --no-extensions and then load only extensions declared on the agent or selected variant.",
    "If this model is registered by a Pi provider extension, add that extension to the agent/variant extensions list.",
    "Use a loadable extension module path, for example /path/to/package/extensions/pi/index.ts or /path/to/package/dist/extensions/pi/index.js; a package extension directory may not be enough for the child -e launch path.",
  ].join(" ");
}

const PREFLIGHT_OUTPUT_LIMIT = 1024 * 1024;
const PREFLIGHT_TERM_GRACE_MS = 250;
const PREFLIGHT_HARD_SETTLEMENT_GRACE_MS = 750;
const TASKKILL_TIMEOUT_MS = 500;

export function windowsTaskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

function appendBounded(chunks: Buffer[], chunk: Buffer, captured: { bytes: number }, diagnostics: SubprocessTerminationDiagnostics): void {
  const remaining = PREFLIGHT_OUTPUT_LIMIT - captured.bytes;
  if (remaining <= 0) {
    diagnostics.outputTruncated = true;
    return;
  }
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  captured.bytes += Math.min(chunk.length, remaining);
  if (chunk.length > remaining) diagnostics.outputTruncated = true;
}

function destroyAndUnrefStdio(child: ReturnType<typeof spawn>): void {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.removeAllListeners();
    stream?.destroy();
    (stream as NodeJS.ReadableStream & { unref?: () => void } | null)?.unref?.();
  }
  child.unref();
}

function runBoundedPreflight(command: PiCommand, args: string[], timeoutMs: number): Promise<Omit<ModelPreflightResult, "ok" | "message"> & { timedOut: boolean; failureMessage?: string }> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutCapture = { bytes: 0 };
    const stderrCapture = { bytes: 0 };
    const diagnostics: SubprocessTerminationDiagnostics = {};
    let settled = false;
    let exitCode: number | null | undefined;
    let exitSignal: NodeJS.Signals | null | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let taskkillTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;
    let childClosed = false;
    let treeTerminationDone = false;
    let failureMessage: string | undefined;
    const renderedCommand = [command.command, ...args].join(" ");
    const child = spawn(command.command, args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(hardDeadline);
      if (killTimer) clearTimeout(killTimer);
      if (taskkillTimer) clearTimeout(taskkillTimer);
      if (groupPollTimer) clearTimeout(groupPollTimer);
    };
    const snapshot = () => ({
      command: renderedCommand,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
      signal: exitSignal,
      timedOut: diagnostics.timedOut === true,
      failureMessage,
      termination: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
    });
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(snapshot());
    };
    const settleIfTerminationComplete = () => {
      if (!diagnostics.timedOut || (childClosed && treeTerminationDone)) settle();
    };
    const recordError = (error: unknown) => {
      (diagnostics.errors ??= []).push(error instanceof Error ? error.message : String(error));
    };
    const directChildFallback = () => {
      diagnostics.directChildFallback = true;
      try { child.kill("SIGKILL"); } catch (error) { recordError(error); }
    };
    const terminateWindowsTree = () => {
      diagnostics.strategy = "windows-taskkill";
      if (child.pid === undefined) return directChildFallback();
      let taskkillSettled = false;
      const taskkill = spawn("taskkill", windowsTaskkillArgs(child.pid), { stdio: "ignore", windowsHide: true });
      const finishTaskkill = (code?: number | null) => {
        if (taskkillSettled) return;
        taskkillSettled = true;
        if (taskkillTimer) clearTimeout(taskkillTimer);
        if (code !== undefined) diagnostics.taskkillExitCode = code;
        if (code !== 0) directChildFallback();
        treeTerminationDone = true;
        settleIfTerminationComplete();
      };
      taskkill.once("error", (error) => { recordError(error); finishTaskkill(); });
      taskkill.once("close", finishTaskkill);
      taskkillTimer = setTimeout(() => {
        diagnostics.taskkillTimedOut = true;
        try { taskkill.kill("SIGKILL"); } catch (error) { recordError(error); }
        finishTaskkill();
      }, TASKKILL_TIMEOUT_MS);
    };
    const terminatePosixGroup = (signal: NodeJS.Signals) => {
      diagnostics.strategy = "posix-process-group";
      if (signal === "SIGTERM") diagnostics.termSent = true;
      else diagnostics.killSent = true;
      try {
        if (child.pid === undefined) throw new Error("preflight child pid is unavailable");
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") recordError(error);
        try { child.kill(signal); } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") recordError(fallbackError);
        }
      }
    };
    const waitForPosixGroupExit = () => {
      if (settled) return;
      try {
        if (child.pid === undefined) throw new Error("preflight child pid is unavailable");
        process.kill(-child.pid, 0);
        groupPollTimer = setTimeout(waitForPosixGroupExit, 25);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") recordError(error);
        treeTerminationDone = true;
        settleIfTerminationComplete();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => appendBounded(stdoutChunks, chunk, stdoutCapture, diagnostics));
    child.stderr?.on("data", (chunk: Buffer) => appendBounded(stderrChunks, chunk, stderrCapture, diagnostics));
    child.once("error", (error) => { failureMessage = error.message; recordError(error); settle(); });
    child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      childClosed = true;
      settleIfTerminationComplete();
    });

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      diagnostics.timedOut = true;
      if (process.platform === "win32") terminateWindowsTree();
      else {
        terminatePosixGroup("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) {
            terminatePosixGroup("SIGKILL");
            waitForPosixGroupExit();
          }
        }, PREFLIGHT_TERM_GRACE_MS);
      }
    }, timeoutMs);
    // `close` waits for all inherited pipe handles, not merely the direct child.
    // This deadline is deliberately absolute: even a descendant which escaped
    // tree termination cannot retain this launcher's stdio or promise forever.
    const hardDeadline = setTimeout(() => {
      if (settled) return;
      diagnostics.timedOut = true;
      diagnostics.hardDeadlineReached = true;
      if (process.platform === "win32") directChildFallback();
      else if (!diagnostics.killSent) terminatePosixGroup("SIGKILL");
      destroyAndUnrefStdio(child);
      settle();
    }, timeoutMs + PREFLIGHT_TERM_GRACE_MS + PREFLIGHT_HARD_SETTLEMENT_GRACE_MS);
  });
}

export async function preflightPiModelAvailability(command: PiCommand, model: string, timeoutMs = 15_000): Promise<ModelPreflightResult> {
  const extensions = extensionArgs(command.args);
  const args = [
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    ...extensions.flatMap((extension) => ["-e", extension]),
    "--list-models",
    model,
  ];
  const result = await runBoundedPreflight(command, args, timeoutMs);
  const ok = !result.timedOut && result.exitCode === 0 && modelListed(result.stdout ?? "", result.stderr ?? "", model);
  const { timedOut, failureMessage, ...publicResult } = result;
  return {
    ...publicResult,
    ok,
    message: timedOut ? `model preflight timed out after ${timeoutMs}ms` : ok ? undefined : failureMessage ?? providerExtensionHint(model),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchHarnessFor(harness: "pi" | "claude" | undefined, mode: "oneshot" | "interactive"): "pi" | "claude-tmux-interactive" | "claude-stdio-oneshot" {
  if (harness === "claude") return mode === "interactive" ? "claude-tmux-interactive" : "claude-stdio-oneshot";
  return "pi";
}

function resultParserFor(harness: "pi" | "claude" | undefined, mode: "oneshot" | "interactive"): "mcp-terminal" | "stdio-exit" {
  return harness === "claude" && mode === "interactive" ? "mcp-terminal" : "stdio-exit";
}

function resolveClaudeSkillInstallRequests(skillNames: string[], cwd: string): ClaudeSkillInstallRequest[] {
  const roots = [
    resolve(homedir(), ".async-subagents", "skills"),
    resolve(findPackageRoot(here), "skills"),
    resolve(cwd, ".agents", "skills"),
    resolve(cwd, ".pi", "skills"),
    resolve(homedir(), ".agents", "skills"),
    resolve(homedir(), ".pi", "skills"),
  ];
  return [...new Set(skillNames)].map((name) => {
    const candidates = roots.flatMap((root) => [join(root, name, "claude"), join(root, name)]);
    const sourceDir = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
    if (!sourceDir) {
      throw new SubagentError("CLAUDE_SKILL_NOT_FOUND", `Claude skill not found or missing SKILL.md: ${name}`, { name, searchedRoots: roots });
    }
    return { name, sourceDir, approvedRoots: roots.filter((root) => existsSync(root)) };
  });
}

interface CodexBalancerLaunch {
  enabled: true;
  isolatedDir: string;
  selectedSlot: string;
  env: Record<string, string>;
  metadata: Record<string, unknown>;
}

const BALANCED_PI_CONFIG_ENTRIES = [
  "AGENTS.md",
  "APPEND_SYSTEM.md",
  "SYSTEM.md",
  "keybindings.json",
  "models.json",
  "npm",
  "git",
  "prompts",
  "settings.json",
  "skills",
  "themes",
  "tools",
  "extensions",
];

function sourcePiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function linkIfPresent(source: string, dest: string): void {
  if (!existsSync(source) || existsSync(dest)) return;
  symlinkSync(source, dest, lstatSync(source).isDirectory() ? "dir" : "file");
}

function mirrorPiAgentConfig(piAgentDir: string): void {
  const sourceAgentDir = sourcePiAgentDir();
  for (const entry of BALANCED_PI_CONFIG_ENTRIES) linkIfPresent(join(sourceAgentDir, entry), join(piAgentDir, entry));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function prepareCodexBalancer(config: CodexAuthBalancerConfig, model: string | undefined, runDir: string, runId: string, rootRunId: string, ttlMs: number): Promise<CodexBalancerLaunch | undefined> {
  // Dormant by default: the copied-credential branch (copy a refresh token into
  // an isolated child that rotates it lock-free) is the OAuth rotation race class
  // we are retiring. With the model remap every codex launch arrives here as a
  // `bravo-codex-balanced/*` model and short-circuits below. The belt-and-
  // suspenders guard ensures the copy branch is never taken for any odd codex
  // provider string unless the operator explicitly opts back in.
  if (config.copiedCredentialsLegacy !== true) return undefined;
  if (!config.enabled || isCodexBalancedProviderModel(model) || !isCodexModel(model, config.onlyForProviders)) return undefined;
  const isolatedDir = join(runDir, "auth", "codex-balancer");
  mkdirSync(isolatedDir, { recursive: true, mode: 0o700 });
  try { if ((statSync(isolatedDir).mode & 0o777) !== 0o700) chmodSync(isolatedDir, 0o700); } catch { /* mkdir already failed if unavailable */ }
  const prepared = await withTimeout(prepareLaunch(isolatedDir, { stateRoot: config.stateDir, runId, rootRunId, reservationTtlMs: ttlMs }), config.timeoutMs, "codex auth balancer prepare-launch");
  mirrorPiAgentConfig(prepared.pi_agent_dir);
  return { enabled: true, isolatedDir, selectedSlot: prepared.selected_slot, env: prepared.env, metadata: { enabled: true, provider: "bravo", mode: "process-env", selectedSlot: prepared.selected_slot, reservationId: prepared.metadata.reservation_id, launchId: prepared.metadata.launch_id, policyVersion: prepared.selection?.policy_version, label: prepared.label, reason: prepared.reason, status: prepared.status, primaryRemainingPercent: prepared.primary_remaining_percent, secondaryRemainingPercent: prepared.secondary_remaining_percent } };
}

async function spawnDetachedSupervisor(inputPath: string): Promise<string | undefined> {
  const cliPath = join(findPackageRoot(here), "dist", "src", "cli.js");
  if (!existsSync(cliPath)) return `supervisor CLI is not built: ${cliPath}`;
  let spawnError: string | undefined;
  const child = spawn(process.execPath, [cliPath, "supervisor", "--input", inputPath], { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    spawnError = error.message;
  });
  child.unref();
  await delay(150);
  if (spawnError) return spawnError;
  if (child.exitCode !== null) return `supervisor exited before taking ownership with code ${child.exitCode}`;
  return undefined;
}

export async function startSubagent(input: StartSubagentInput): Promise<SubagentStartResult> {
  const allowedFiles = normalizeAllowedFilePaths(input.files);
  const cwd = resolve(input.cwd ?? process.cwd());
  const store = new RunStore({ cwd, runRoot: input.runRoot });
  const root = resolveRootIdentity(input, cwd);
  const baseDefinition = resolveAgentDefinition(input.agent, { cwd, env: process.env });
  const definition = applyAgentVariant(baseDefinition, input.variant);
  const selectedThinkingLevel = input.thinkingLevel ?? definition.thinkingLevel;
  const requestedContextPolicy = input.context ?? definition.context ?? "fresh";
  const requestedSessionPolicy = input.session ?? definition.session ?? "record";
  const { runId, paths } = store.createRunDirectory({
    runId: input.runId,
    cwd,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    rootSessionId: root.rootSessionId,
    contextPolicy: requestedContextPolicy,
    sessionPolicy: requestedSessionPolicy,
    piSessionPath: input.piSessionPathOverride,
    requestedPiSessionPath: input.requestedPiSessionPathOverride,
    continuedFromRunId: input.continuation?.continuedFromRunId,
    continuationRootRunId: input.continuation?.continuationRootRunId,
    continuationSequence: input.continuation?.continuationSequence,
    continuationOfPiSessionPath: input.continuation?.continuationOfPiSessionPath,
  });
  const display = assignDisplayName({ runRoot: store.runRoot });
  let contextPolicy = requestedContextPolicy;
  const sessionPolicy = requestedSessionPolicy;
  const requestedPiSessionPath = sessionPolicy === "record" ? input.requestedPiSessionPathOverride ?? paths.requestedPiSessionPath : undefined;
  let piSessionPath = sessionPolicy === "record" ? input.piSessionPathOverride ?? paths.requestedPiSessionPath : undefined;
  let forkSourceSessionFile: string | undefined;
  let forkSourceLeafId: string | undefined;
  let forkFallback: { allowed: boolean; used: boolean; reason?: string } | null = null;

  const runtimeBuiltinTools = definition.harness === "claude" ? [] : [childControlEventTool];
  const runtimeExtensionPaths = definition.harness === "claude" ? [] : [childControlExtensionPath];
  const launchLogPath = join(paths.logsDir, "launch.json");
  const asyncSubagentsConfig = loadAsyncSubagentsConfig({ cwd, env: { ...process.env, ...(input.env ?? {}) } });
  const maxRunSeconds = definition.maxRunSeconds ?? asyncSubagentsConfig.defaultMaxRunSeconds;
  if (!Number.isFinite(maxRunSeconds) || maxRunSeconds <= 0) throw new SubagentError("INVALID_AGENT_DEFINITION", "maxRunSeconds must be a positive finite number");
  const effectiveMaxRunMs = Math.ceil(maxRunSeconds * 1000);
  const fastTrack = evaluateFastTrack({ requested: input.fastTrack, enabled: readFastTrackState(store.runRoot, root.rootSessionId).enabled, agentName: definition.name, model: definition.model });
  if (fastTrack.applied && !existsSync(childFastTrackExtensionPath)) throw new SubagentError("FAST_TRACK_EXTENSION_MISSING", `fast-track child extension is missing: ${childFastTrackExtensionPath}`);

  const initialStatus = createInitialStatus({
    runId,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    rootSessionId: root.rootSessionId,
    runRoot: store.runRoot,
    displayName: display.displayName,
    namePack: display.namePack,
    agentName: definition.name,
    agentSource: definition.source,
    definitionPath: definition.definitionPath,
    mode: definition.mode,
    variant: input.variant,
    harness: definition.harness,
    launchHarness: launchHarnessFor(definition.harness, definition.mode),
    resultParser: resultParserFor(definition.harness, definition.mode),
    model: definition.model,
    thinkingLevel: definition.harness === "claude" ? undefined : selectedThinkingLevel,
    effort: definition.harness === "claude" ? definition.effort ?? "high" : undefined,
    executionMode: definition.harness === "claude" ? "dangerous-auth" : undefined,
    contextPolicy,
    sessionPolicy,
    piSessionPath,
    requestedPiSessionPath,
    continuedFromRunId: input.continuation?.continuedFromRunId,
    continuationRootRunId: input.continuation?.continuationRootRunId,
    continuationSequence: input.continuation?.continuationSequence,
    continuationOfPiSessionPath: input.continuation?.continuationOfPiSessionPath,
    forkFallback,
    fastTrack,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    resolvedSkills: definition.skills,
    notInheritedAcrossHarness: definition.notInheritedAcrossHarness,
    excludedAcrossHarness: definition.excludedAcrossHarness,
    inheritedAcrossHarness: definition.inheritedAcrossHarness,
    launchLogPath,
    inboxPath: paths.inboxPath,
    allowedFiles,
    effectiveMaxRunMs,
    cwd,
    state: "queued",
  });
  store.writeStatus(initialStatus);

  const failBeforeLaunch = (code: string, message: string, details?: unknown): SubagentStartResult => {
    const result = finalizeTerminalRun(store, {
      runId,
      parentRunId: root.parentRunId,
      agentName: definition.name,
      state: "failed",
      writerRole: "launcher",
      summary: message,
      body: message,
      error: { code, message, details },
    });
    return {
      runId,
      runDir: paths.runDir,
      agentName: definition.name,
      displayName: display.displayName,
      namePack: display.namePack,
      variant: input.variant,
      state: result.state,
      started: false,
      waited: false,
      contextPolicy,
      sessionPolicy,
      model: definition.model,
      thinkingLevel: selectedThinkingLevel,
      piSessionPath,
      requestedPiSessionPath,
      continuedFromRunId: input.continuation?.continuedFromRunId,
      continuationRootRunId: input.continuation?.continuationRootRunId,
      continuationSequence: input.continuation?.continuationSequence,
      continuationOfPiSessionPath: input.continuation?.continuationOfPiSessionPath,
      skills: definition.skills,
      tools: definition.tools,
      maxRunSeconds,
      effectiveMaxRunMs,
      maxSubagentDepth: definition.maxSubagentDepth,
      fastTrack,
      task: input.taskAssignment ? { taskId: input.taskAssignment.task.id, title: input.taskAssignment.task.title } : undefined,
      next: [{ tool: "subagent_result", args: { runId } }],
    };
  };

  if (fastTrack.requested && !fastTrack.enabled) {
    return failBeforeLaunch("FAST_TRACK_DISABLED", "fastTrack requested but /fast-track is off; run /fast-track on first or remove fastTrack", fastTrack);
  }

  if (requestedContextPolicy === "fork" && sessionPolicy !== "record") {
    return failBeforeLaunch("INVALID_SESSION_POLICY", "context: fork requires session: record", { context: requestedContextPolicy, session: sessionPolicy });
  }

  if (definition.harness === "claude" && input.thinkingLevel) {
    return failBeforeLaunch("CLAUDE_THINKING_LEVEL_UNSUPPORTED", "thinkingLevel is Pi-only and cannot be passed to a Claude harness run", { thinkingLevel: input.thinkingLevel });
  }

  if (requestedContextPolicy === "fork") {
    const ref = input.parentPiSessionRef;
    if (!ref) {
      if (!input.allowFreshFallback) {
        return failBeforeLaunch("PARENT_PI_SESSION_UNAVAILABLE", "context: fork requires parent Pi session file and leaf id", { allowFreshFallback: false });
      }
      contextPolicy = "fresh";
      forkFallback = { allowed: true, used: true, reason: "parent Pi session reference unavailable" };
    } else {
      forkSourceSessionFile = ref.sessionFile;
      forkSourceLeafId = ref.leafId;
      try {
        piSessionPath = (input.branchSession ?? branchPiSession)({
          parentSessionFile: ref.sessionFile,
          leafId: ref.leafId,
          piSessionDir: paths.piSessionDir,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!input.allowFreshFallback) {
          const failedFork = store.readStatus(runId);
          store.writeStatus({
            ...failedFork,
            forkSourceSessionFile,
            forkSourceLeafId,
            updatedAt: new Date().toISOString(),
          });
          return failBeforeLaunch("PI_SESSION_BRANCH_FAILED", "failed to create branched Pi session", { reason, parentSessionFile: ref.sessionFile, leafId: ref.leafId });
        }
        contextPolicy = "fresh";
        piSessionPath = requestedPiSessionPath;
        forkFallback = { allowed: true, used: true, reason };
      }
    }
    const branched = store.readStatus(runId);
    store.writeStatus({
      ...branched,
      contextPolicy,
      piSessionPath,
      requestedPiSessionPath,
      forkSourceSessionFile,
      forkSourceLeafId,
      forkFallback,
      updatedAt: new Date().toISOString(),
    });
  }

  const prompt = assemblePrompt({
    definition,
    runPaths: paths,
    task: input.task,
    contextPolicy,
    cwd,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    depth: input.depth ?? 0,
    files: allowedFiles,
    skills: input.skills,
    taskAssignment: input.taskAssignment ? { task: input.taskAssignment.task, dependencies: input.taskAssignment.dependencies } : undefined,
  });

  if (definition.harness === "claude") {
    const mode = definition.mode === "oneshot" ? "oneshot" : "interactive";
    const launchHarness = launchHarnessFor("claude", mode);
    const resultParser = resultParserFor("claude", mode);
    const cliPath = join(findPackageRoot(here), "dist", "src", "cli.js");
    const claudeSkills = resolveClaudeSkillInstallRequests(prompt.skills, cwd);
    const home = prepareClaudeHome({
      runDir: paths.runDir,
      mode,
      cwd,
      mcpServerCommand: mode === "interactive" ? process.execPath : undefined,
      mcpServerArgs: mode === "interactive" ? [cliPath, "claude-child-mcp", "--run-dir", paths.runDir] : undefined,
      authHome: definition.claude?.authHome,
      skills: claudeSkills,
    });
    const command = buildClaudeCommand({
      runDir: paths.runDir,
      cwd,
      systemPath: prompt.systemPath,
      displayName: display.displayName,
      mode,
      model: prompt.model,
      effort: definition.effort ?? "high",
      settingsPath: home.settingsPath,
      mcpConfigPath: home.mcpConfigPath,
      homeDir: home.homeDir,
      shellHomeDir: home.shellHomeDir,
      shellWrapperPath: home.shellWrapperPath,
      extraEnv: { ...(input.env ?? {}), ASYNC_SUBAGENTS_RUN_ID: runId, ASYNC_SUBAGENTS_PARENT_RUN_ID: root.parentRunId, ASYNC_SUBAGENTS_ROOT_SESSION_ID: root.rootSessionId },
    });
    writeLaunchLogWithMetadata(paths.runDir, command, {
      harness: "claude",
      launchHarness,
      resultParser,
      model: prompt.model,
      requestedModel: command.requestedModel,
      resolvedModel: command.resolvedModel,
      effort: definition.effort ?? "high",
      executionMode: command.executionMode,
      authHome: home.authHome,
      memoryIsolation: home.memoryIsolation,
      claudeHomeDir: home.homeDir,
      claudeSettingsPath: home.settingsPath,
      claudeMcpConfigPath: home.mcpConfigPath,
      claudeShellHomeDir: home.shellHomeDir,
      claudeShellWrapperPath: home.shellWrapperPath,
      claudeTransport: mode === "interactive" ? "mcp" : "none",
      claudeInstalledSkills: home.installedSkills,
      skills: prompt.skills,
      resolvedSkills: definition.skills,
      notInheritedAcrossHarness: definition.notInheritedAcrossHarness,
      excludedAcrossHarness: definition.excludedAcrossHarness,
      inheritedAcrossHarness: definition.inheritedAcrossHarness,
      contextPolicy,
      sessionPolicy,
      rootSessionId: root.rootSessionId,
      parentRunId: root.parentRunId,
    });
    store.writeStatus(updateRunStatus(store.readStatus(runId), {
      harness: "claude",
      launchHarness,
      resultParser,
      model: prompt.model,
      requestedModel: command.requestedModel,
      resolvedModel: command.resolvedModel,
      effort: definition.effort ?? "high",
      executionMode: command.executionMode,
      thinkingLevel: undefined,
      resolvedSkills: definition.skills,
      notInheritedAcrossHarness: definition.notInheritedAcrossHarness,
      excludedAcrossHarness: definition.excludedAcrossHarness,
      inheritedAcrossHarness: definition.inheritedAcrossHarness,
      userBuiltinTools: [],
      runtimeBuiltinTools: [],
      runtimeExtensionPaths: [],
      claudeHomeDir: home.homeDir,
      claudeSettingsPath: home.settingsPath,
      claudeMcpConfigPath: home.mcpConfigPath,
      claudeAuthHome: home.authHome,
      claudeMemoryIsolation: home.memoryIsolation,
      claudeShellHomeDir: home.shellHomeDir,
      claudeShellWrapperPath: home.shellWrapperPath,
      claudeTransport: mode === "interactive" ? "mcp" : "none",
      claudeInstalledSkills: home.installedSkills,
    }));
    const supervisorInput: SupervisorInput = {
      runId,
      runRoot: store.runRoot,
      cwd,
      parentRunId: root.parentRunId,
      agentName: definition.name,
      command,
      transport: mode === "interactive" ? "mcp" : "stdio",
      supervisorAdapter: mode === "interactive" ? "tmux" : "stdio",
      effectiveMaxRunMs,
    };
    const supervisorInputPath = writeSupervisorInput(paths.runDir, supervisorInput);
    if (input.fake?.mode === "immediate") {
      await runSupervisor({ ...supervisorInput, supervisorAdapter: "stdio", fake: input.fake });
    } else {
      const spawnError = await spawnDetachedSupervisor(supervisorInputPath);
      if (spawnError && !store.readResult(runId)) writeLauncherFailure(store, supervisorInput, spawnError);
      for (let i = 0; i < 20 && store.readStatus(runId).state === "queued" && !store.readResult(runId); i++) await delay(50);
    }
    const status = store.readStatus(runId);
    const terminalStates: TerminalRunState[] = ["completed", "failed", "cancelled", "expired"];
    const terminal = terminalStates.includes(status.state as TerminalRunState);
    return {
      runId,
      runDir: paths.runDir,
      agentName: definition.name,
      displayName: display.displayName,
      namePack: display.namePack,
      harness: status.harness,
      launchHarness: status.launchHarness,
      resultParser: status.resultParser,
      variant: status.variant,
      state: status.state,
      model: status.model,
      requestedModel: status.requestedModel,
      resolvedModel: status.resolvedModel,
      thinkingLevel: status.thinkingLevel,
      effort: status.effort,
      executionMode: status.executionMode,
      claudeHomeDir: status.claudeHomeDir,
      claudeSettingsPath: status.claudeSettingsPath,
      claudeMcpConfigPath: status.claudeMcpConfigPath,
      claudeAuthHome: status.claudeAuthHome,
      claudeMemoryIsolation: status.claudeMemoryIsolation,
      claudeShellHomeDir: status.claudeShellHomeDir,
      claudeShellWrapperPath: status.claudeShellWrapperPath,
      claudeTransport: status.claudeTransport,
      claudeInstalledSkills: status.claudeInstalledSkills,
      livenessState: status.livenessState,
      lastTerminalOutputAt: status.lastTerminalOutputAt,
      terminalOutputBytes: status.terminalOutputBytes,
      lastMcpCallAt: status.lastMcpCallAt,
      lastNudgeAt: status.lastNudgeAt,
      pendingAckMessageIds: status.pendingAckMessageIds,
      livenessReason: status.livenessReason,
      supervisorPid: status.supervisorPid,
      childPid: status.childPid,
      panePid: status.panePid,
      processGroupId: status.processGroupId,
      tmuxSocket: status.tmuxSocket,
      tmuxSession: status.tmuxSession,
      tmuxPane: status.tmuxPane,
      transcriptPath: status.transcriptPath,
      started: status.state === "running" || terminal,
      waited: false,
      contextPolicy: status.contextPolicy,
      sessionPolicy: status.sessionPolicy,
      piSessionPath: status.piSessionPath,
      requestedPiSessionPath: status.requestedPiSessionPath,
      continuedFromRunId: status.continuedFromRunId,
      continuationRootRunId: status.continuationRootRunId,
      continuationSequence: status.continuationSequence,
      continuationOfPiSessionPath: status.continuationOfPiSessionPath,
      skills: prompt.skills,
      resolvedSkills: status.resolvedSkills,
      tools: [],
      maxRunSeconds,
      effectiveMaxRunMs,
      maxSubagentDepth: definition.maxSubagentDepth,
      fastTrack,
      task: input.taskAssignment ? { taskId: input.taskAssignment.task.id, title: input.taskAssignment.task.title } : undefined,
      next: terminal ? [{ tool: "subagent_result", args: { runId } }] : [],
    };
  }

  // The originally-requested model (prompt.model) is preserved for user-facing
  // status/metadata; effectiveModel is the model the child actually launches/execs.
  // When the balancer is enabled we remap openai-codex/* and openai-codex-responses/*
  // to bravo-codex-balanced/* so the launch goes through the per-request lease path.
  // The remap is suppressed under the legacy escape hatch so the copied-credential
  // path sees the original codex model end to end.
  const balancerEnabled = asyncSubagentsConfig.codexAuthBalancer.enabled;
  const remapEnabled = balancerEnabled && asyncSubagentsConfig.codexAuthBalancer.copiedCredentialsLegacy !== true;
  const effectiveModel = remapEnabled ? (balancedModelId(prompt.model) ?? prompt.model) : prompt.model;

  let codexAuthBalancer: CodexBalancerLaunch | undefined;
  try {
    codexAuthBalancer = await prepareCodexBalancer(asyncSubagentsConfig.codexAuthBalancer, effectiveModel, paths.runDir, runId, root.rootRunId, effectiveMaxRunMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (asyncSubagentsConfig.codexAuthBalancer.failClosed) return failBeforeLaunch("CODEX_AUTH_BALANCER_FAILED", message);
  }
  const taskEnv: Record<string, string> = {
    ASYNC_SUBAGENTS_RUN_ID: runId,
    ASYNC_SUBAGENTS_PARENT_RUN_ID: root.parentRunId,
    ASYNC_SUBAGENTS_ROOT_SESSION_ID: root.rootSessionId,

  };
  const balancedProviderEnv: Record<string, string> = !codexAuthBalancer && isCodexBalancedProviderModel(effectiveModel) && asyncSubagentsConfig.codexAuthBalancer.stateDir
    ? { CODEX_AUTH_BALANCER_HOME: asyncSubagentsConfig.codexAuthBalancer.stateDir }
    : {};
  const effectiveExtraEnv = codexAuthBalancer ? { ...(input.env ?? {}), ...taskEnv, ...codexAuthBalancer.env } : { ...(input.env ?? {}), ...taskEnv, ...balancedProviderEnv };
  const inheritedExtensionPaths = inheritedExtensionPathsFromEnv({ ...process.env, ...effectiveExtraEnv });
  const fastTrackExtensions = fastTrack.applied ? [childFastTrackExtensionPath] : [];
  // The child launches with --no-extensions, so a bravo-codex-balanced/* model
  // only resolves if the codex-auth-balancer provider extension is on the -e list.
  // Add it programmatically for balanced launches; the preflight still fails closed
  // (MODEL_PREFLIGHT_FAILED + providerExtensionHint) if it cannot be resolved.
  const balancedProviderExtensions = isCodexBalancedProviderModel(effectiveModel)
    ? (() => { const p = resolveBalancedProviderExtensionPath(); return p ? [p] : []; })()
    : [];

  const piCommand = buildPiCommand({
    piBin: input.piBin,
    systemPath: prompt.systemPath,
    taskPath: prompt.taskPath,
    runDir: paths.runDir,
    cwd,
    sessionPolicy,
    piSessionPath,
    requestedPiSessionPath,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    skills: prompt.skills,
    defaultExtensionPaths: asyncSubagentsConfig.defaultExtensions.map((extension) => extension.realPath),
    defaultExtensionTools: asyncSubagentsConfig.defaultExtensions.flatMap((extension) => extension.tools),
    inheritedExtensionPaths,
    extensions: [...prompt.extensions, ...fastTrackExtensions, ...balancedProviderExtensions],
    model: effectiveModel,
    thinkingLevel: selectedThinkingLevel,
    contextPolicy,
    forkSourceSessionFile,
    forkSourceLeafId,
    forkFallback,
    rootSessionId: root.rootSessionId,
    parentRunId: root.parentRunId,
    continuation: input.continuation,
    extraEnv: effectiveExtraEnv,
  });
  const command = input.fake?.mode === "child" ? fakeChildCommand(input.fake, cwd) : piCommand;
  writeLaunchLogWithMetadata(paths.runDir, command, {
    variant: input.variant,
    model: prompt.model,
    launchedModel: effectiveModel,
    thinkingLevel: selectedThinkingLevel,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    skills: prompt.skills,
    defaultExtensionsConfigPath: asyncSubagentsConfig.configPath,
    defaultExtensions: asyncSubagentsConfig.defaultExtensions,
    defaultExtensionTools: asyncSubagentsConfig.defaultExtensions.flatMap((extension) => extension.tools),
    inheritedExtensions: inheritedExtensionPaths,
    extensions: [...prompt.extensions, ...fastTrackExtensions, ...balancedProviderExtensions],
    fastTrack,
    contextPolicy,
    sessionPolicy,
    requestedPiSessionPath,
    piSessionPath,
    forkSourceSessionFile,
    forkSourceLeafId,
    forkFallback,
    rootSessionId: root.rootSessionId,
    parentRunId: root.parentRunId,
    continuation: input.continuation,
    codexAuthBalancer: codexAuthBalancer?.metadata,
  });

  if (effectiveModel && !input.fake) {
    const preflight = await preflightPiModelAvailability(command, effectiveModel);
    writeFileSync(join(paths.logsDir, "model-preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`, "utf8");
    if (!preflight.ok) {
      await codexBalancerSyncBackAndCleanup({ codexAuthBalancer: codexAuthBalancer ? { isolatedDir: codexAuthBalancer.isolatedDir, selectedSlot: codexAuthBalancer.selectedSlot, stateDir: asyncSubagentsConfig.codexAuthBalancer.stateDir, timeoutMs: asyncSubagentsConfig.codexAuthBalancer.timeoutMs, metadata: codexAuthBalancer.metadata } : undefined });
      return failBeforeLaunch("MODEL_PREFLIGHT_FAILED", preflight.message ?? `model preflight failed for ${effectiveModel}`, preflight);
    }
  }

  const supervisorInput: SupervisorInput = {
    runId,
    runRoot: store.runRoot,
    cwd,
    parentRunId: root.parentRunId,
    agentName: definition.name,
    command,
    effectiveMaxRunMs: input.fake?.mode === "child" ? input.fake.effectiveMaxRunMs ?? effectiveMaxRunMs : effectiveMaxRunMs,
    fake: input.fake?.mode === "immediate" ? input.fake : undefined,
    codexAuthBalancer: codexAuthBalancer ? { isolatedDir: codexAuthBalancer.isolatedDir, selectedSlot: codexAuthBalancer.selectedSlot, stateDir: asyncSubagentsConfig.codexAuthBalancer.stateDir, timeoutMs: asyncSubagentsConfig.codexAuthBalancer.timeoutMs, metadata: codexAuthBalancer.metadata } : undefined,
  };
  const supervisorInputPath = writeSupervisorInput(paths.runDir, supervisorInput);

  if (input.fake?.mode === "immediate") {
    await runSupervisor(supervisorInput);
  } else {
    const spawnError = await spawnDetachedSupervisor(supervisorInputPath);
    if (spawnError && !store.readResult(runId)) writeLauncherFailure(store, supervisorInput, spawnError);
  }

  const status = store.readStatus(runId);
  const terminalStates: TerminalRunState[] = ["completed", "failed", "cancelled", "expired"];
  const terminal = terminalStates.includes(status.state as TerminalRunState);
  return {
    runId,
    runDir: paths.runDir,
    agentName: definition.name,
    displayName: display.displayName,
    namePack: display.namePack,
    variant: status.variant,
    state: status.state,
    model: status.model,
    thinkingLevel: status.thinkingLevel,
    started: status.state === "running" || terminal,
    waited: false,
    contextPolicy: status.contextPolicy,
    sessionPolicy: status.sessionPolicy,
    piSessionPath: status.piSessionPath,
    requestedPiSessionPath: status.requestedPiSessionPath,
    continuedFromRunId: status.continuedFromRunId,
    continuationRootRunId: status.continuationRootRunId,
    continuationSequence: status.continuationSequence,
    continuationOfPiSessionPath: status.continuationOfPiSessionPath,
    skills: prompt.skills,
    tools: definition.tools,
    maxRunSeconds,
    effectiveMaxRunMs,
    maxSubagentDepth: definition.maxSubagentDepth,
    fastTrack,
    task: input.taskAssignment ? { taskId: input.taskAssignment.task.id, title: input.taskAssignment.task.title } : undefined,
    next: terminal ? [{ tool: "subagent_result", args: { runId } }] : [],
  };
}
