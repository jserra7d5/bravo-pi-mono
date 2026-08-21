import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProgressEvent, createRunEvent, createStartedEvent } from "./events.js";
import { finalizeTerminalRun, reconcileUnderLock } from "./lifecycle.js";
import { appendJsonl } from "./jsonl.js";
import { isTerminalRunState } from "./schemas.js";
import { createInboxMessage } from "./message.js";
import { RunStore } from "./runStore.js";
import { withRunMutationLock } from "./runLock.js";
import { supervisorOwnershipPatch, updateRunStatus } from "./status.js";
import { nowIso } from "./time.js";
import type { PiCommand } from "./piHarness.js";
import type { RunResult, RunStatus, TerminalRunState } from "./types.js";
import { cleanupLaunch, syncBack } from "@bravo/codex-auth-balancer";

export interface SupervisorFakeInput {
  mode: "immediate";
  state?: TerminalRunState;
  body?: string;
  summary?: string;
  delayMs?: number;
  exitCode?: number;
}

export type SupervisorAdapter = "stdio" | "tmux";

export interface TmuxSupervisorMetadata {
  socket: string;
  session: string;
  pane: string;
  panePid?: number;
  transcriptPath: string;
}

export interface SupervisorInput {
  runId: string;
  runRoot: string;
  cwd: string;
  parentRunId: string;
  agentName: string;
  command: PiCommand;
  transport?: "stdio" | "mcp";
  supervisorAdapter?: SupervisorAdapter;
  effectiveMaxRunMs?: number;
  /**
   * Relaunch policy for a child killed by a transient upstream refusal. `command`
   * is what to relaunch with — the launcher supplies a continuation prompt when
   * the run records a Pi session, so the retry resumes the child's own history
   * (including any files it already wrote) instead of restarting the brief blind.
   * Omitted entirely when a retry would not be safe, and a retry never extends the
   * run's time budget.
   */
  transientRetry?: {
    maxAttempts: number;
    backoffMs?: number;
    command?: PiCommand;
  };
  fake?: SupervisorFakeInput;
  codexAuthBalancer?: {
    isolatedDir: string;
    selectedSlot: string;
    stateDir?: string;
    timeoutMs: number;
    metadata?: Record<string, unknown>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmuxMcpDrainMs(): number {
  const parsed = Number(process.env.ASYNC_SUBAGENTS_TMUX_MCP_DRAIN_MS ?? "5000");
  if (!Number.isFinite(parsed) || parsed < 0) return 5000;
  return Math.min(5000, parsed);
}

export async function awaitStableResult(store: RunStore, _runDir: string, runId: string): Promise<RunResult | undefined> {
  if (!store.readResult(runId)) return undefined;
  await reconcileUnderLock(store, runId);
  return store.readResult(runId);
}

async function waitForStableResult(store: RunStore, runDir: string, runId: string, timeoutMs: number, pollMs = 50): Promise<RunResult | undefined> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let result = await awaitStableResult(store, runDir, runId);
  while (!result && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    result = await awaitStableResult(store, runDir, runId);
  }
  return result;
}

function execFilePromise(command: string, args: string[], options: { timeoutMs?: number; input?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: options.timeoutMs ?? 5_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

function tmuxBin(): string {
  return process.env.ASYNC_SUBAGENTS_TMUX_BIN || "tmux";
}

function tmuxArgs(meta: Pick<TmuxSupervisorMetadata, "socket">, args: string[]): string[] {
  return ["-S", meta.socket, ...args];
}

export async function hasTmux(): Promise<boolean> {
  try {
    await execFilePromise(tmuxBin(), ["-V"], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionName(runId: string): string {
  return `async-subagents-${runId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellCommand(command: PiCommand): string {
  const env = Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${shellSingleQuote(value)}`);
  return [...env, shellSingleQuote(command.command), ...command.args.map(shellSingleQuote)].join(" ");
}

export async function startTmux(input: { runId: string; paths: ReturnType<RunStore["pathsFor"]>; command: PiCommand }): Promise<TmuxSupervisorMetadata> {
  const socket = join(input.paths.logsDir, "tmux.sock");
  const session = tmuxSessionName(input.runId);
  const transcriptPath = join(input.paths.logsDir, "tmux-transcript.log");
  const target = `${session}:0.0`;
  const fullCommand = `cd ${shellSingleQuote(input.command.cwd)} && ${shellCommand(input.command)}; code=$?; sleep 1; exit $code`;
  await execFilePromise(tmuxBin(), tmuxArgs({ socket }, ["new-session", "-d", "-s", session, "-x", "120", "-y", "40", fullCommand]), { timeoutMs: 5_000 });
  const pane = (await execFilePromise(tmuxBin(), tmuxArgs({ socket }, ["display-message", "-p", "-t", target, "#{pane_id}"]), { timeoutMs: 2_000 })).stdout.trim() || target;
  const panePidText = (await execFilePromise(tmuxBin(), tmuxArgs({ socket }, ["display-message", "-p", "-t", pane, "#{pane_pid}"]), { timeoutMs: 2_000 })).stdout.trim();
  const panePid = /^\d+$/.test(panePidText) ? Number(panePidText) : undefined;
  return { socket, session, pane, panePid, transcriptPath };
}

export async function captureTmux(meta: TmuxSupervisorMetadata): Promise<string> {
  return (await execFilePromise(tmuxBin(), tmuxArgs(meta, ["capture-pane", "-p", "-S", "-", "-t", meta.pane]), { timeoutMs: 2_000 })).stdout;
}

export async function sendTmux(meta: TmuxSupervisorMetadata, message: string): Promise<void> {
  const bufferName = `async-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await execFilePromise(tmuxBin(), tmuxArgs(meta, ["load-buffer", "-b", bufferName, "-"]), { timeoutMs: 2_000, input: message });
  try {
    await execFilePromise(tmuxBin(), tmuxArgs(meta, ["paste-buffer", "-d", "-b", bufferName, "-t", meta.pane]), { timeoutMs: 2_000 });
    await execFilePromise(tmuxBin(), tmuxArgs(meta, ["send-keys", "-t", meta.pane, "Enter"]), { timeoutMs: 2_000 });
  } catch (error) {
    try { await execFilePromise(tmuxBin(), tmuxArgs(meta, ["delete-buffer", "-b", bufferName]), { timeoutMs: 1_000 }); } catch { /* best effort */ }
    throw error;
  }
}

export async function stopTmux(meta: TmuxSupervisorMetadata): Promise<void> {
  try { await execFilePromise(tmuxBin(), tmuxArgs(meta, ["kill-session", "-t", meta.session]), { timeoutMs: 2_000 }); } catch { /* already gone */ }
}

export async function aliveTmux(meta: TmuxSupervisorMetadata): Promise<boolean> {
  try {
    await execFilePromise(tmuxBin(), tmuxArgs(meta, ["has-session", "-t", meta.session]), { timeoutMs: 1_000 });
    return true;
  } catch {
    return false;
  }
}

function summaryFromOutput(body: string, fallback: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 200) : fallback;
}

function appendLog(path: string, text: string): void {
  if (!text) return;
  appendFileSync(path, text, "utf8");
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 128;
}

function childLaunchUsesNoExtensions(command: PiCommand): boolean {
  return command.args.includes("--no-extensions");
}

function providerExtensionHint(model: string): string {
  return [
    `Model "${model}" is not available in the isolated child Pi launch.`,
    "Async subagents launch child Pi with --no-extensions and then load only extensions declared on the agent or selected variant.",
    "If this model is registered by a Pi provider extension, add that extension to the agent/variant extensions list.",
    "Use a loadable extension module path, for example /path/to/package/extensions/pi/index.ts or /path/to/package/dist/extensions/pi/index.js; a package extension directory may not be enough for the child -e launch path.",
  ].join(" ");
}

export function augmentChildFailureDiagnostics(command: PiCommand, stderr: string, error?: RunResult["error"]): { stderr: string; error?: RunResult["error"] } {
  const match = stderr.match(/Model "([^"]+)" not found/);
  if (!match || !childLaunchUsesNoExtensions(command)) return { stderr, error };
  const hint = providerExtensionHint(match[1]);
  const augmentedStderr = stderr.includes(hint) ? stderr : `${stderr.trimEnd()}\n\n${hint}\n`;
  return {
    stderr: augmentedStderr,
    error: error ? { ...error, message: `${error.message}. ${hint}` } : error,
  };
}

/**
 * An upstream moderation classifier on the Codex Responses stream refuses a turn
 * mid-reply — after the response is created and reasoning has begun streaming —
 * and Pi surfaces that as a fatal error, so the child exits non-zero and the whole
 * lane dies holding whatever work it had already done.
 *
 * The refusal is probabilistic, not a property of the brief: in the transcripts
 * that motivated this, 42 of 47 parent-session occurrences succeeded on the very
 * next turn against the same context, several within seconds. A lane that dies on
 * it has not hit a wall; it has hit a coin flip.
 *
 * The wording says "prompt" but the request was accepted and billed nothing, and
 * there is no error code to match on — Pi passes the upstream string through as a
 * diagnostic line of its own. So anchor on that framing: a line that STARTS with
 * Pi's `Codex error:` prefix and carries the flag text. A bare substring search
 * would also fire on a child that merely printed the message — quoting it from a
 * brief, a log, or tool output — and then exited non-zero for an unrelated reason,
 * which would relaunch a genuinely broken run against a tree it may have half
 * edited. Every observed occurrence (32 of 32 in the run store) matches this shape,
 * and all of them arrive on stderr.
 *
 * Deliberately biased toward under-matching. A missed refusal costs one lane, which
 * is the behaviour that already exists; a false match spends budget and resumes a
 * dirty working tree.
 */
const UPSTREAM_REFUSAL_PATTERN = /^Codex error: Invalid prompt:[^\n]*flagged as potentially violating our usage policy/im;

export function isTransientUpstreamRefusal(stderr: string): boolean {
  return UPSTREAM_REFUSAL_PATTERN.test(stderr);
}

function classifyBalancerError(error: unknown): { classification: string; retryable: boolean; safeCleanup: boolean; message: string } {
  if (!error) return { classification: "success", retryable: false, safeCleanup: true, message: "sync-back completed" };
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return { classification: "timeout", retryable: true, safeCleanup: false, message };
  if (/conflict|generation|hash|changed|mismatch/i.test(message)) return { classification: "conflict", retryable: false, safeCleanup: false, message };
  return { classification: "failed", retryable: false, safeCleanup: false, message };
}

function writeBalancerRetentionMarker(balancer: NonNullable<SupervisorInput["codexAuthBalancer"]>, result: { classification: string; message: string }): void {
  const marker = join(balancer.isolatedDir, "ASYNC_SUBAGENTS_RETAINED.json");
  try {
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, provider: "bravo", classification: result.classification, retainUntil: "manual-cleanup-after-sync-back", isolatedDir: balancer.isolatedDir, slot: balancer.selectedSlot, message: result.message.replace(/[A-Za-z0-9+/=._-]{24,}/g, "<redacted>") }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* best-effort marker */ }
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

export async function codexBalancerSyncBackAndCleanup(input: Pick<SupervisorInput, "codexAuthBalancer">): Promise<void> {
  const balancer = input.codexAuthBalancer;
  if (!balancer) return;
  const attempt = async (remaining: number): Promise<{ classification: string; retryable: boolean; safeCleanup: boolean; message: string }> => {
    try {
      const result = await withTimeout(syncBack(balancer.isolatedDir, { stateRoot: balancer.stateDir, slot: balancer.selectedSlot }), balancer.timeoutMs, "codex auth balancer sync-back");
      if (!result.ok) return { classification: "conflict", retryable: false, safeCleanup: false, message: "sync-back conflict" };
      return classifyBalancerError(undefined);
    } catch (error) {
      const result = classifyBalancerError(error);
      if (remaining > 0 && result.retryable) { await sleep(250); return attempt(remaining - 1); }
      return result;
    }
  };
  const result = await attempt(1);
  if (result.safeCleanup) {
    try { await cleanupLaunch(balancer.isolatedDir); } catch { writeBalancerRetentionMarker(balancer, { classification: "cleanup-failed", message: "sync-back succeeded but cleanup failed" }); }
  } else {
    writeBalancerRetentionMarker(balancer, result);
  }
}

/**
 * Rebuild a best-effort report from what the child already told us.
 *
 * When a run is killed before it can emit its final report, `result.json` would
 * otherwise carry an empty body even though the child's substantive output —
 * findings, answers, the reason it was blocked — is sitting in events.jsonl.
 * Those bodies are the deliverable; recovering them by hand is how a killed run
 * gets salvaged today, so do it here instead.
 *
 * Explicitly marked as reconstructed: this is not the report the agent intended
 * to write, and a reader must not mistake it for one.
 */
function salvageBodyFromEvents(store: RunStore, runId: string): string {
  let records: Array<{ type?: string; createdAt?: string; summary?: string; body?: string }>;
  try { records = store.readEvents(runId).records as never; } catch { return ""; }
  const sections = records
    .filter((event) => (event.body ?? "").trim() || (event.summary ?? "").trim())
    .filter((event) => event.type !== "started" && event.type !== "expired")
    .map((event) => {
      const heading = `## ${event.type ?? "event"}${event.createdAt ? ` · ${event.createdAt}` : ""}`;
      return [heading, event.summary?.trim(), event.body?.trim()].filter(Boolean).join("\n\n");
    });
  if (!sections.length) return "";
  return [
    "# Reconstructed report",
    "",
    "This run ended before it emitted a final report. The following is assembled from the event bodies it did write, newest last. It is a salvage, not the agent's intended deliverable.",
    "",
    ...sections,
  ].join("\n\n");
}

async function finalizeRun(input: SupervisorInput, output: { state: TerminalRunState; stdout?: string; stderr?: string; error?: RunResult["error"] }): Promise<RunResult> {
  await codexBalancerSyncBackAndCleanup(input);
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const paths = store.pathsFor({ runId: input.runId });
  const body = output.stdout?.trim() || output.stderr?.trim() || undefined;
  const finalized = await withRunMutationLock(paths.runDir, () => {
    const existingResult = store.readResult(input.runId);
    if (existingResult) return existingResult;
    const status = store.readStatus(input.runId);
    return finalizeTerminalRun(store, {
      runId: input.runId,
      parentRunId: input.parentRunId,
      agentName: input.agentName,
      state: output.state,
      writerRole: "child-runtime",
      startedAt: status.startedAt,
      summary: summaryFromOutput(output.error?.message ?? body ?? "", output.state === "completed" ? "Completed" : `Run ${output.state}`),
      body,
      effectiveMaxRunMs: input.effectiveMaxRunMs,
      error: output.error ?? null,
    });
  });
  return finalized.value;
}

async function runTmuxSupervisor(input: SupervisorInput): Promise<RunResult> {
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const paths = store.pathsFor({ runId: input.runId });
  const startedAt = nowIso();
  if (!(await hasTmux())) {
    return finalizeRun(input, { state: "failed", stderr: "tmux is not available", error: { code: "TMUX_UNAVAILABLE", message: "tmux is not available" } });
  }

  let meta: TmuxSupervisorMetadata | undefined;
  try {
    meta = await startTmux({ runId: input.runId, paths, command: input.command });
    const startedMutation = await withRunMutationLock(paths.runDir, () => {
      const existingResult = store.readResult(input.runId);
      if (existingResult) return existingResult;
      const status = store.readStatus(input.runId);
      if (isTerminalRunState(status.state)) return undefined;
      store.writeStatus(updateRunStatus(status, {
        state: "running",
        writerRole: "child-runtime",
        startedAt,
        lastActivityAt: startedAt,
        ...supervisorOwnershipPatch(),
        pid: meta?.panePid,
        childPid: meta?.panePid,
        panePid: meta?.panePid,
        processGroupId: meta?.panePid,
        tmuxSocket: meta?.socket,
        tmuxSession: meta?.session,
        tmuxPane: meta?.pane,
        transcriptPath: meta?.transcriptPath,
        processHealth: "alive",
        livenessState: "starting",
        summary: meta?.panePid ? `Running Claude tmux pane ${meta.panePid}` : "Running Claude tmux session",
      }));
      store.appendEvent(input.runId, createStartedEvent({ sequence: store.readEvents(input.runId).records.length + 1, runId: input.runId, parentRunId: input.parentRunId, command: input.command.command }));
      return undefined;
    });
    if (startedMutation.value) return startedMutation.value;
    const completedDuringStart = await awaitStableResult(store, paths.runDir, input.runId);
    if (completedDuringStart) return completedDuringStart;

    const deadline = input.effectiveMaxRunMs && input.effectiveMaxRunMs > 0 ? Date.now() + input.effectiveMaxRunMs : undefined;
    while (true) {
      const existing = await awaitStableResult(store, paths.runDir, input.runId);
      if (existing) return existing;
      const alive = await aliveTmux(meta);
      let transcript = "";
      try {
        transcript = await captureTmux(meta);
        writeFileSync(meta.transcriptPath, transcript, "utf8");
      } catch { /* capture best effort */ }
      await withRunMutationLock(paths.runDir, () => {
        if (store.readResult(input.runId)) return;
        const current = store.readStatus(input.runId);
        if (current.state === "running" || current.state === "queued") {
          let bytes: number | undefined;
          try { bytes = statSync(meta!.transcriptPath).size; } catch { bytes = transcript ? Buffer.byteLength(transcript) : undefined; }
          store.writeStatus(updateRunStatus(current, { processHealth: alive ? "alive" : "dead", livenessState: alive ? "running" : "stale_transport", terminalOutputBytes: bytes, lastTerminalOutputAt: transcript ? nowIso() : current.lastTerminalOutputAt, summary: alive ? current.summary : "Claude tmux session exited without result" }));
        }
      });
      const livenessResult = await awaitStableResult(store, paths.runDir, input.runId);
      if (livenessResult) return livenessResult;
      if (!alive) {
        const drained = await waitForStableResult(store, paths.runDir, input.runId, input.transport === "mcp" ? tmuxMcpDrainMs() : 0);
        if (drained) return drained;
        const final = await withRunMutationLock(paths.runDir, () => {
          const existingResult = store.readResult(input.runId);
          if (existingResult) return existingResult;
          return finalizeTerminalRun(store, { runId: input.runId, parentRunId: input.parentRunId, agentName: input.agentName, state: "failed", writerRole: "child-runtime", summary: "Claude tmux session exited without result", body: transcript.trim() || undefined, error: { code: "CLAUDE_EXITED_WITHOUT_RESULT", message: "Claude tmux session exited before subagent_complete" } });
        });
        return final.value;
      }
      if (deadline && Date.now() >= deadline) {
        const final = await withRunMutationLock(paths.runDir, () => {
          const existingResult = store.readResult(input.runId);
          if (existingResult) return existingResult;
          return finalizeTerminalRun(store, { runId: input.runId, parentRunId: input.parentRunId, agentName: input.agentName, state: "expired", writerRole: "child-runtime", summary: "Claude run expired", body: transcript.trim() || undefined, effectiveMaxRunMs: input.effectiveMaxRunMs, error: { code: "MAX_RUN_SECONDS_EXPIRED", message: "Claude tmux run exceeded maxRunSeconds" } });
        });
        return final.value;
      }
      await sleep(250);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const final = await withRunMutationLock(paths.runDir, () => {
      const existingResult = store.readResult(input.runId);
      if (existingResult) return existingResult;
      return finalizeTerminalRun(store, { runId: input.runId, parentRunId: input.parentRunId, agentName: input.agentName, state: "failed", writerRole: "child-runtime", summary: "Claude tmux supervisor failed", body: message, error: { code: "TMUX_SUPERVISOR_FAILED", message } });
    });
    return final.value;
  } finally {
    if (meta) await stopTmux(meta);
  }
}

export async function runSupervisor(input: SupervisorInput): Promise<RunResult> {
  if (input.supervisorAdapter === "tmux") return runTmuxSupervisor(input);
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const paths = store.pathsFor({ runId: input.runId });
  const mutateRun = async <T>(fn: () => T | Promise<T>): Promise<T> => (await withRunMutationLock(paths.runDir, fn)).value;
  const mutateLiveStatus = async (fn: (current: RunStatus) => void): Promise<void> => {
    await mutateRun(() => {
      if (store.readResult(input.runId)) return;
      const current = store.readStatus(input.runId);
      if (isTerminalRunState(current.state)) return;
      fn(current);
    });
  };

  const initialResult = await mutateRun(() => {
    const existingResult = store.readResult(input.runId);
    if (existingResult) return existingResult;
    const status = store.readStatus(input.runId);
    if (isTerminalRunState(status.state)) return undefined;
    const startedAt = nowIso();
    store.writeStatus(
      updateRunStatus(status, {
        state: "running",
        writerRole: "child-runtime",
        startedAt,
        lastActivityAt: startedAt,
        ...supervisorOwnershipPatch(),
        summary: "Starting child process",
      }),
    );
    store.appendEvent(input.runId, createStartedEvent({ sequence: store.readEvents(input.runId).records.length + 1, runId: input.runId, parentRunId: input.parentRunId, command: input.command.command }));
    return undefined;
  });
  if (initialResult) return initialResult;

  if (input.fake?.mode === "immediate") {
    if (input.fake.delayMs) await sleep(input.fake.delayMs);
    const state = input.fake.state ?? (input.fake.exitCode && input.fake.exitCode !== 0 ? "failed" : "completed");
    return finalizeRun(input, {
      state,
      stdout: input.fake.body ?? input.fake.summary ?? "Fake child completed",
      error: state === "completed" ? null : { code: "FAKE_CHILD_FAILED", message: input.fake.summary ?? "fake child failed" },
    });
  }

  return new Promise<RunResult>((resolve) => {
    const stdoutPath = join(paths.logsDir, "stdout.log");
    const stderrPath = join(paths.logsDir, "stderr.log");
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let softTimeout: NodeJS.Timeout | undefined;
    let activeBudgetMs = input.effectiveMaxRunMs && input.effectiveMaxRunMs > 0 ? input.effectiveMaxRunMs : undefined;
    let activeElapsedMs = 0;
    let activeStartedAt = Date.now();
    let budgetPaused = false;
    let controlOffset = 0;
    let controlPoll: NodeJS.Timeout | undefined;
    let cancelState: { reason: string; command: unknown; forceTimer?: NodeJS.Timeout } | undefined;
    let expiryState: { forceTimer?: NodeJS.Timeout } | undefined;
    let supervisorCleanupState: { reason: string; signal?: NodeJS.Signals; forceTimer?: NodeJS.Timeout; exitTimer?: NodeJS.Timeout } | undefined;
    const supervisorErrorPath = join(paths.logsDir, "supervisor-error.log");

    const controlPath = join(paths.runDir, "control.jsonl");

    const spawnChild = (command: PiCommand): ReturnType<typeof spawn> => {
      const spawned = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: {
          ...process.env,
          ...command.env,
          ASYNC_SUBAGENTS_RUN_ID: input.runId,
          ASYNC_SUBAGENTS_RUN_DIR: paths.runDir,
          ASYNC_SUBAGENTS_PARENT_RUN_ID: input.parentRunId,
          ASYNC_SUBAGENT_RUN_ID: input.runId,
          ASYNC_SUBAGENT_RUN_DIR: paths.runDir,
          ASYNC_SUBAGENT_PARENT_RUN_ID: input.parentRunId,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      spawned.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        appendLog(stdoutPath, chunk.toString("utf8"));
      });
      spawned.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        appendLog(stderrPath, chunk.toString("utf8"));
      });
      spawned.once("error", onChildError);
      spawned.once("close", onChildClose);
      return spawned;
    };

    let child: ReturnType<typeof spawn>;
    let transientRetries = 0;
    /**
     * A relaunch that has been decided but not yet spawned: either counting down its
     * backoff (`timer` set) or held because the parent paused the run mid-backoff.
     * While this is set there is no live child, so no `close` event is coming and
     * signals sent to the process group land on nothing.
     */
    let pendingRetry: { command: PiCommand; timer?: NodeJS.Timeout } | undefined;

    /**
     * Claim the pending relaunch so the caller owns what happens next. Cancel, expiry,
     * and supervisor cleanup must settle the run themselves after claiming it —
     * without this a run with no live child hangs until the supervisor is killed.
     */
    const takePendingRetry = (): { command: PiCommand } | undefined => {
      if (!pendingRetry) return undefined;
      if (pendingRetry.timer) clearTimeout(pendingRetry.timer);
      const claimed = pendingRetry;
      pendingRetry = undefined;
      return claimed;
    };

    const publishChildPid = (summaryPrefix: string): void => {
      void mutateLiveStatus((current) => {
        store.writeStatus(updateRunStatus(current, { pid: child.pid, processHealth: child.pid ? "alive" : "unknown", summary: child.pid ? `${summaryPrefix} ${child.pid}` : summaryPrefix }));
      });
    };

    const killGroup = (signal: NodeJS.Signals): boolean => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, signal); return true; } catch {
        try { child.kill(signal); return true; } catch { return false; }
      }
    };

    const logSupervisorCleanup = (message: string): void => {
      const line = `${new Date().toISOString()} ${message}\n`;
      process.stderr.write(line);
      appendLog(supervisorErrorPath, line);
    };

    const clearSupervisorCleanupTimers = (): void => {
      if (supervisorCleanupState?.forceTimer) clearTimeout(supervisorCleanupState.forceTimer);
      if (supervisorCleanupState?.exitTimer) clearTimeout(supervisorCleanupState.exitTimer);
      if (supervisorCleanupState) {
        supervisorCleanupState.forceTimer = undefined;
        supervisorCleanupState.exitTimer = undefined;
      }
    };

    const clearRuntimeResources = (): void => {
      clearBudgetTimers();
      if (pendingRetry?.timer) clearTimeout(pendingRetry.timer);
      pendingRetry = undefined;
      if (controlPoll) clearInterval(controlPoll);
      controlPoll = undefined;
      if (cancelState?.forceTimer) clearTimeout(cancelState.forceTimer);
      if (cancelState) cancelState.forceTimer = undefined;
      if (expiryState?.forceTimer) clearTimeout(expiryState.forceTimer);
      if (expiryState) expiryState.forceTimer = undefined;
      clearSupervisorCleanupTimers();
      process.off("SIGINT", onSupervisorSignal);
      process.off("SIGTERM", onSupervisorSignal);
      process.off("SIGHUP", onSupervisorSignal);
      process.off("uncaughtException", onSupervisorUncaughtException);
      process.off("unhandledRejection", onSupervisorUnhandledRejection);
    };

    const startSupervisorChildCleanup = (reason: string, signal?: NodeJS.Signals): void => {
      if (settled || supervisorCleanupState) return;
      supervisorCleanupState = { reason, signal };
      if (takePendingRetry()) {
        logSupervisorCleanup(`[async-subagents] supervisor cleanup: ${reason}; no live child (retry pending)`);
        settle(signal ? "cancelled" : "failed", signal
          ? { code: "SUPERVISOR_SIGNAL", message: reason, details: { signal, transientRetries } }
          : { code: "SUPERVISOR_CRASH", message: reason, details: { transientRetries } });
        return;
      }
      logSupervisorCleanup(`[async-subagents] supervisor cleanup: ${reason}; sending SIGTERM/SIGCONT to child process group ${child.pid ?? "unknown"}`);
      void mutateLiveStatus((current) => {
        store.writeStatus(updateRunStatus(current, { processHealth: "alive", summary: `Supervisor cleanup: ${reason}` }));
      }).catch(() => undefined);
      killGroup("SIGTERM");
      killGroup("SIGCONT");
      supervisorCleanupState.forceTimer = setTimeout(() => {
        if (settled) return;
        logSupervisorCleanup(`[async-subagents] supervisor cleanup: ${reason}; sending SIGKILL to child process group ${child.pid ?? "unknown"}`);
        killGroup("SIGKILL");
      }, 5_000);
    };

    function onSupervisorSignal(signal: NodeJS.Signals): void {
      startSupervisorChildCleanup(`received ${signal}`, signal);
      if (!supervisorCleanupState) process.exit(128);
      supervisorCleanupState.exitTimer ??= setTimeout(() => process.exit(signalExitCode(signal)), 15_000);
    }

    function onSupervisorUncaughtException(error: Error): void {
      startSupervisorChildCleanup(`uncaughtException: ${error.message}`);
      logSupervisorCleanup(`[async-subagents] supervisor crash detail: ${error.stack ?? error.message}`);
      if (!supervisorCleanupState) process.exit(1);
      supervisorCleanupState.exitTimer ??= setTimeout(() => process.exit(1), 15_000);
    }

    function onSupervisorUnhandledRejection(reason: unknown): void {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      startSupervisorChildCleanup(`unhandledRejection: ${error.message}`);
      logSupervisorCleanup(`[async-subagents] supervisor crash detail: ${error.stack ?? error.message}`);
      if (!supervisorCleanupState) process.exit(1);
      supervisorCleanupState.exitTimer ??= setTimeout(() => process.exit(1), 15_000);
    }

    const clearBudgetTimers = (): void => {
      if (timeout) clearTimeout(timeout);
      if (softTimeout) clearTimeout(softTimeout);
      timeout = undefined;
      softTimeout = undefined;
    };

    process.on("SIGINT", onSupervisorSignal);
    process.on("SIGTERM", onSupervisorSignal);
    process.on("SIGHUP", onSupervisorSignal);
    process.on("uncaughtException", onSupervisorUncaughtException);
    process.on("unhandledRejection", onSupervisorUnhandledRejection);

    const accountActiveTime = (): void => {
      if (budgetPaused) return;
      activeElapsedMs += Math.max(0, Date.now() - activeStartedAt);
      budgetPaused = true;
    };

    const installBudgetTimers = (budgetMs = activeBudgetMs, elapsedMs = activeElapsedMs): void => {
      clearBudgetTimers();
      if (!budgetMs || budgetMs <= 0) return;
      activeBudgetMs = budgetMs;
      activeElapsedMs = Math.max(0, elapsedMs);
      budgetPaused = false;
      activeStartedAt = Date.now();
      const remainingMs = Math.max(0, activeBudgetMs - activeElapsedMs);
      if (remainingMs <= 0) {
        timeout = setTimeout(expireForBudget, 0);
        return;
      }
      const warningLeadMs = Math.min(Math.floor(activeBudgetMs / 2), Math.max(5_000, Math.min(60_000, Math.floor(activeBudgetMs * 0.2))), remainingMs);
      const warningDelayMs = remainingMs - warningLeadMs;
      if (warningDelayMs > 0) {
        softTimeout = setTimeout(() => {
          void mutateLiveStatus((current) => {
            const warningAt = nowIso();
            const hardTimeoutAt = new Date(Date.now() + warningLeadMs).toISOString();
            store.writeStatus(updateRunStatus(current, { timeout: { ...(current.timeout ?? {}), softWarningAt: warningAt, hardTimeoutAt } }));
            const message = createInboxMessage({
              toRunId: input.runId,
              fromRunId: input.parentRunId,
              type: "context",
              requiresAck: false,
              body: `Time budget warning: this run will expire in about ${Math.ceil(warningLeadMs / 1000)} seconds. Checkpoint your current findings and finish before the deadline if possible. The terminal run can be continued from its recorded session if more work is needed.`,
            });
            appendJsonl(join(paths.runDir, "inbox.jsonl"), message);
          }).catch(() => undefined);
        }, warningDelayMs);
      }
      timeout = setTimeout(expireForBudget, remainingMs);
    };

    // A run that is blocked on the parent is not spending its budget doing work.
    // The child writes `blocked`/`waiting_for_input` straight to status.json from
    // its own process, so the supervisor only learns about it by looking. Without
    // this, time spent waiting for a human answer is charged to the run exactly
    // like time spent working, and a run can be killed seconds after it is
    // unblocked, holding a finished deliverable it never got to report.
    //
    // Deliberately distinct from the parent `pause` (SIGSTOP) path: the child
    // process stays runnable here — it may still be working while it waits — so
    // this suspends only the accounting, never the process. Explicit pause and
    // cancel keep full control; this never resumes a run the parent paused.
    const BUDGET_HOLD_STATES = new Set(["blocked", "waiting_for_input"]);
    let budgetHeldByBlock = false;
    const syncBudgetToChildState = (): void => {
      if (settled || cancelState || expiryState) return;
      let state: string;
      try { state = store.readStatus(input.runId).state; } catch { return; }
      // The parent's own pause owns the clock; never fight it.
      if (state === "paused") return;
      const shouldHold = BUDGET_HOLD_STATES.has(state);
      if (shouldHold === budgetHeldByBlock) return;
      budgetHeldByBlock = shouldHold;
      if (shouldHold) {
        accountActiveTime();
        clearBudgetTimers();
      } else {
        installBudgetTimers();
      }
    };

    const settle = (state: TerminalRunState, error?: RunResult["error"]): void => {
      if (settled) return;
      settled = true;
      clearRuntimeResources();
      const capturedStdout = Buffer.concat(stdoutChunks).toString("utf8");
      // A child killed mid-report has written nothing to stdout, so the run would
      // finalize with an empty body while everything it actually said sits in
      // events.jsonl. Salvage that rather than shipping a result with no content:
      // an expired run that already did the work is a delay, not a loss.
      //
      // Not for `failed`: finalizeRun falls back to stderr for the body, and on a
      // crash that stderr IS the diagnostic. Salvaging into stdout would outrank
      // it and hide the reason the run died. Those events stay in events.jsonl.
      const stdout = capturedStdout.trim() || state === "failed" ? capturedStdout : salvageBodyFromEvents(store, input.runId);
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      const diagnostics = state === "failed" ? augmentChildFailureDiagnostics(input.command, rawStderr, error) : { stderr: rawStderr, error };
      if (diagnostics.stderr !== rawStderr) appendLog(stderrPath, diagnostics.stderr.slice(rawStderr.length));
      void finalizeRun(input, { state, stdout, stderr: diagnostics.stderr, error: diagnostics.error }).then(resolve);
    };

    function onChildError(error: Error): void {
      if (supervisorCleanupState) return;
      appendLog(stderrPath, `${error.message}\n`);
      settle("failed", { code: "SPAWN_FAILED", message: error.message });
    }

    /**
     * Relaunch after a transient upstream refusal. The run keeps its identity, its
     * budget, and its logs; only the child process is replaced. The in-memory
     * stdout/stderr buffers are reset so a successful retry reports its own output
     * as the result body instead of the refusal text from the attempt that died —
     * the full history stays on disk in stdout.log/stderr.log.
     */
    function retryAfterUpstreamRefusal(previousStderr: string): void {
      const policy = input.transientRetry!;
      transientRetries += 1;
      const attempt = transientRetries;
      const delayMs = policy.backoffMs ?? 2_000;
      const summary = `Upstream refused the turn; relaunching (retry ${attempt}/${policy.maxAttempts})`;
      appendLog(stderrPath, `[async-subagents] ${summary} after ${delayMs}ms\n`);
      void mutateRun(() => {
        store.appendEvent(input.runId, createProgressEvent({
          sequence: store.readEvents(input.runId).records.length + 1,
          runId: input.runId,
          parentRunId: input.parentRunId,
          summary,
          body: previousStderr.trim() || undefined,
          wake: false,
          data: { reason: "upstream_prompt_flag", attempt, maxAttempts: policy.maxAttempts },
        }));
      }).catch(() => undefined);
      void mutateLiveStatus((current) => {
        store.writeStatus(updateRunStatus(current, { summary, transientRetries: attempt }));
      }).catch(() => undefined);
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      const retryCommand = policy.command ?? input.command;
      pendingRetry = {
        command: retryCommand,
        timer: setTimeout(() => {
          if (!pendingRetry) return;
          pendingRetry = undefined;
          if (settled || cancelState || expiryState || supervisorCleanupState) return;
          launchRetry(retryCommand);
        }, delayMs),
      };
    }

    function launchRetry(command: PiCommand): void {
      child = spawnChild(command);
      publishChildPid("Running child process");
    }

    function onChildClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (supervisorCleanupState) {
        const cleanupState = supervisorCleanupState;
        logSupervisorCleanup(`[async-subagents] supervisor cleanup: child process group ${child.pid ?? "unknown"} closed after ${cleanupState.reason}; code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const state: TerminalRunState = cleanupState.signal ? "cancelled" : "failed";
        const error: RunResult["error"] = cleanupState.signal
          ? { code: "SUPERVISOR_SIGNAL", message: cleanupState.reason, details: { code, signal: cleanupState.signal } }
          : { code: "SUPERVISOR_CRASH", message: cleanupState.reason, details: { code, signal } };
        void finalizeRun(input, { state, stdout, stderr, error })
          .catch((error) => {
            logSupervisorCleanup(`[async-subagents] supervisor cleanup finalization failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          })
          .finally(() => {
            clearRuntimeResources();
            process.exit(cleanupState.signal ? signalExitCode(cleanupState.signal) : 1);
          });
        return;
      }
      if (settled) return;
      if (expiryState) {
        settle("expired", { code: "MAX_RUN_SECONDS_EXPIRED", message: "Time budget expired", details: { effectiveMaxRunMs: input.effectiveMaxRunMs, code, signal } });
      } else if (cancelState) {
        settle("cancelled", { code: "PARENT_CANCELLED", message: cancelState.reason, details: { ...(typeof cancelState.command === "object" && cancelState.command ? cancelState.command : {}), code, signal } });
      } else if (code === 0) {
        settle("completed");
      } else {
        const stderrSoFar = Buffer.concat(stderrChunks).toString("utf8");
        if (input.transientRetry && transientRetries < input.transientRetry.maxAttempts && isTransientUpstreamRefusal(stderrSoFar)) {
          retryAfterUpstreamRefusal(stderrSoFar);
          return;
        }
        settle("failed", { code: "CHILD_EXITED", message: `child exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`, details: { code, signal, transientRetries } });
      }
    }

    child = spawnChild(input.command);
    publishChildPid("Running child process");

    const applyControl = (command: any): void => {
      if (!command || typeof command !== "object") return;
      if (command.action === "cancel") {
        if (cancelState) return;
        const reason = String(command.reason ?? "Cancelled by parent");
        cancelState = { reason, command };
        if (takePendingRetry()) {
          settle("cancelled", { code: "PARENT_CANCELLED", message: reason, details: { transientRetries } });
          return;
        }
        if (command.signal === "SIGKILL") {
          killGroup("SIGKILL");
        } else {
          killGroup("SIGTERM");
          killGroup("SIGCONT");
          cancelState.forceTimer = setTimeout(() => {
            if (!settled) killGroup("SIGKILL");
          }, 5_000);
        }
      } else if (command.action === "pause") {
        // Mid-backoff there is no process to SIGSTOP, so without this the pause is
        // silently dropped and the relaunch spawns anyway — the run keeps working
        // after the parent told it to stop. Hold the relaunch instead; `resume`
        // spawns it.
        const heldRetry = takePendingRetry();
        if (heldRetry) {
          pendingRetry = { command: heldRetry.command };
          accountActiveTime();
          clearBudgetTimers();
          void mutateLiveStatus((current) => {
            store.writeStatus(updateRunStatus(current, { state: "paused", processHealth: "dead", summary: String(command.reason ?? "Paused by parent"), timeout: { ...(current.timeout ?? {}), reason: String(command.reason ?? "Paused by parent") } }));
          }).catch(() => undefined);
        } else if (killGroup("SIGSTOP")) {
          accountActiveTime();
          clearBudgetTimers();
          void mutateLiveStatus((current) => {
            store.writeStatus(updateRunStatus(current, { state: "paused", processHealth: "alive", summary: String(command.reason ?? "Paused by parent"), timeout: { ...(current.timeout ?? {}), reason: String(command.reason ?? "Paused by parent") } }));
          }).catch(() => undefined);
        }
      } else if (command.action === "resume" || command.action === "extend") {
        // A relaunch held by `pause` has no timer; claim it and spawn now.
        const resumedRetry = pendingRetry && !pendingRetry.timer ? takePendingRetry() : undefined;
        if (resumedRetry) launchRetry(resumedRetry.command);
        else killGroup("SIGCONT");
        const additional = typeof command.additionalRunSeconds === "number" ? command.additionalRunSeconds : undefined;
        void mutateLiveStatus((current) => {
          store.writeStatus(updateRunStatus(current, { state: "running", processHealth: "alive", summary: "Continued by parent", needs: null, timeout: { ...(current.timeout ?? {}), additionalRunSeconds: additional } }));
        }).catch(() => undefined);
        if (additional && additional > 0) installBudgetTimers(Math.ceil(additional * 1000), 0);
        else installBudgetTimers();
      }
    };
    const readControls = (): void => {
      if (!existsSync(controlPath)) return;
      const text = readFileSync(controlPath, "utf8");
      const chunk = text.slice(controlOffset);
      controlOffset = text.length;
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        try { applyControl(JSON.parse(line)); } catch { /* ignore malformed control line */ }
      }
    };
    controlPoll = setInterval(() => { readControls(); syncBudgetToChildState(); }, 250);

    const expireForBudget = (): void => {
      if (settled) return;
      accountActiveTime();
      clearBudgetTimers();
      expiryState = {};
      if (takePendingRetry()) {
        settle("expired", { code: "MAX_RUN_SECONDS_EXPIRED", message: "Time budget expired", details: { effectiveMaxRunMs: input.effectiveMaxRunMs, transientRetries } });
        return;
      }
      killGroup("SIGTERM");
      killGroup("SIGCONT");
      expiryState.forceTimer = setTimeout(() => killGroup("SIGKILL"), 500);
      expiryState.forceTimer.unref();
    };
    installBudgetTimers();
  });
}

export async function supervisorMain(argv = process.argv.slice(2)): Promise<void> {
  const inputIndex = argv.indexOf("--input");
  const inputPath = inputIndex >= 0 ? argv[inputIndex + 1] : undefined;
  if (!inputPath) throw new Error("usage: async-subagents supervisor --input <path>");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as SupervisorInput;
  try {
    await runSupervisor(input);
  } catch (error) {
    writeFileSync(
      join(new RunStore({ cwd: input.cwd, runRoot: input.runRoot }).pathsFor({ runId: input.runId }).logsDir, "supervisor-error.log"),
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      { flag: "a" },
    );
    throw error;
  }
}
