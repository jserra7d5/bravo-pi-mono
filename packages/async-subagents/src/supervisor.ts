import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRunEvent, createStartedEvent } from "./events.js";
import { finalizeTerminalRun } from "./lifecycle.js";
import { appendJsonl } from "./jsonl.js";
import { createInboxMessage } from "./message.js";
import { RunStore } from "./runStore.js";
import { updateRunStatus } from "./status.js";
import { nowIso } from "./time.js";
import type { PiCommand } from "./piHarness.js";
import type { RunResult, TerminalRunState } from "./types.js";
import { cleanupLaunch, syncBack } from "@bravo/codex-auth-balancer";

export interface SupervisorFakeInput {
  mode: "immediate";
  state?: TerminalRunState;
  body?: string;
  summary?: string;
  delayMs?: number;
  exitCode?: number;
}

export interface SupervisorInput {
  runId: string;
  runRoot: string;
  cwd: string;
  parentRunId: string;
  agentName: string;
  command: PiCommand;
  effectiveMaxRunMs?: number;
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

async function finalizeRun(input: SupervisorInput, output: { state: TerminalRunState; stdout?: string; stderr?: string; error?: RunResult["error"] }): Promise<RunResult> {
  await codexBalancerSyncBackAndCleanup(input);
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const status = store.readStatus(input.runId);
  const body = output.stdout?.trim() || output.stderr?.trim() || undefined;
  return finalizeTerminalRun(store, {
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    state: output.state,
    writerRole: "child-runtime",
    startedAt: status.startedAt,
    summary: summaryFromOutput(body ?? "", output.state === "completed" ? "Completed" : `Run ${output.state}`),
    body,
    effectiveMaxRunMs: input.effectiveMaxRunMs,
    error: output.error ?? null,
  });
}

export async function runSupervisor(input: SupervisorInput): Promise<RunResult> {
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const status = store.readStatus(input.runId);
  const paths = store.pathsFor({ runId: input.runId });

  store.writeStatus(
    updateRunStatus(status, {
      state: "running",
      writerRole: "child-runtime",
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      summary: "Starting child process",
    }),
  );
  store.appendEvent(input.runId, createStartedEvent({ sequence: 1, runId: input.runId, parentRunId: input.parentRunId, command: input.command.command }));

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
    let supervisorCleanupState: { reason: string; signal?: NodeJS.Signals; forceTimer?: NodeJS.Timeout; exitTimer?: NodeJS.Timeout } | undefined;
    const supervisorErrorPath = join(paths.logsDir, "supervisor-error.log");

    const controlPath = join(paths.runDir, "control.jsonl");
    const child = spawn(input.command.command, input.command.args, {
      cwd: input.command.cwd,
      env: {
        ...process.env,
        ...input.command.env,
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

    const started = store.readStatus(input.runId);
    store.writeStatus(updateRunStatus(started, { pid: child.pid, processHealth: child.pid ? "alive" : "unknown", summary: child.pid ? `Running child process ${child.pid}` : "Running child process" }));

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      appendLog(stdoutPath, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      appendLog(stderrPath, chunk.toString("utf8"));
    });

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
      if (controlPoll) clearInterval(controlPoll);
      controlPoll = undefined;
      if (cancelState?.forceTimer) clearTimeout(cancelState.forceTimer);
      if (cancelState) cancelState.forceTimer = undefined;
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
      logSupervisorCleanup(`[async-subagents] supervisor cleanup: ${reason}; sending SIGTERM/SIGCONT to child process group ${child.pid ?? "unknown"}`);
      try {
        const current = store.readStatus(input.runId);
        store.writeStatus(updateRunStatus(current, { processHealth: "alive", summary: `Supervisor cleanup: ${reason}` }));
      } catch { /* best-effort status update during fatal cleanup */ }
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
        timeout = setTimeout(pauseForBudget, 0);
        return;
      }
      const warningLeadMs = Math.min(Math.floor(activeBudgetMs / 2), Math.max(5_000, Math.min(60_000, Math.floor(activeBudgetMs * 0.2))), remainingMs);
      const warningDelayMs = remainingMs - warningLeadMs;
      if (warningDelayMs > 0) {
        softTimeout = setTimeout(() => {
          const current = store.readStatus(input.runId);
          const warningAt = nowIso();
          const hardTimeoutAt = new Date(Date.now() + warningLeadMs).toISOString();
          store.writeStatus(updateRunStatus(current, { timeout: { ...(current.timeout ?? {}), softWarningAt: warningAt, hardTimeoutAt } }));
          const message = createInboxMessage({
            toRunId: input.runId,
            fromRunId: input.parentRunId,
            type: "context",
            requiresAck: false,
            body: `Time budget warning: this run will be paused in about ${Math.ceil(warningLeadMs / 1000)} seconds. Checkpoint your current findings and, if you cannot finish before the deadline, emit a blocked event with a concise checkpoint and what parent input or continuation you need.`,
          });
          appendJsonl(join(paths.runDir, "inbox.jsonl"), message);
        }, warningDelayMs);
      }
      timeout = setTimeout(pauseForBudget, remainingMs);
    };

    const settle = (state: TerminalRunState, error?: RunResult["error"]): void => {
      if (settled) return;
      settled = true;
      clearRuntimeResources();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      const diagnostics = state === "failed" ? augmentChildFailureDiagnostics(input.command, rawStderr, error) : { stderr: rawStderr, error };
      if (diagnostics.stderr !== rawStderr) appendLog(stderrPath, diagnostics.stderr.slice(rawStderr.length));
      void finalizeRun(input, { state, stdout, stderr: diagnostics.stderr, error: diagnostics.error }).then(resolve);
    };

    child.once("error", (error) => {
      if (supervisorCleanupState) return;
      appendLog(stderrPath, `${error.message}\n`);
      settle("failed", { code: "SPAWN_FAILED", message: error.message });
    });

    child.once("close", (code, signal) => {
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
      if (cancelState) {
        settle("cancelled", { code: "PARENT_CANCELLED", message: cancelState.reason, details: { ...(typeof cancelState.command === "object" && cancelState.command ? cancelState.command : {}), code, signal } });
      } else if (code === 0) {
        settle("completed");
      } else {
        settle("failed", { code: "CHILD_EXITED", message: `child exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`, details: { code, signal } });
      }
    });

    const applyControl = (command: any): void => {
      if (!command || typeof command !== "object") return;
      if (command.action === "cancel") {
        if (cancelState) return;
        const reason = String(command.reason ?? "Cancelled by parent");
        cancelState = { reason, command };
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
        if (killGroup("SIGSTOP")) {
          accountActiveTime();
          clearBudgetTimers();
          const current = store.readStatus(input.runId);
          store.writeStatus(updateRunStatus(current, { state: "paused", processHealth: "alive", summary: String(command.reason ?? "Paused by parent"), timeout: { ...(current.timeout ?? {}), reason: String(command.reason ?? "Paused by parent") } }));
        }
      } else if (command.action === "resume" || command.action === "extend") {
        killGroup("SIGCONT");
        const additional = typeof command.additionalRunSeconds === "number" ? command.additionalRunSeconds : undefined;
        const current = store.readStatus(input.runId);
        store.writeStatus(updateRunStatus(current, { state: "running", processHealth: "alive", summary: "Continued by parent", needs: null, timeout: { ...(current.timeout ?? {}), additionalRunSeconds: additional } }));
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
    controlPoll = setInterval(readControls, 250);

    const pauseForBudget = (): void => {
      if (settled) return;
      accountActiveTime();
      clearBudgetTimers();
      const paused = killGroup("SIGSTOP");
      const current = store.readStatus(input.runId);
      if (!paused) {
        const event = createRunEvent({ sequence: store.readEvents(input.runId).records.length + 1, runId: input.runId, parentRunId: input.parentRunId, type: "status", summary: "Time budget expired; pause failed", body: "Runtime budget expired, but the supervisor could not pause the process group. The run is being finalized as expired.", wake: true, data: { reason: "timeout", effectiveMaxRunMs: input.effectiveMaxRunMs, paused } });
        store.appendEvent(input.runId, event);
        settle("expired", { code: "MAX_RUN_SECONDS_EXPIRED", message: "Time budget expired and SIGSTOP failed", details: { effectiveMaxRunMs: input.effectiveMaxRunMs } });
        return;
      }
      const event = createRunEvent({ sequence: store.readEvents(input.runId).records.length + 1, runId: input.runId, parentRunId: input.parentRunId, type: "status", summary: "Time budget expired; run paused", body: "Runtime budget expired. Continue this run if the result is still needed, or cancel it.", wake: true, data: { reason: "timeout", effectiveMaxRunMs: input.effectiveMaxRunMs, paused } });
      store.appendEvent(input.runId, event);
      store.writeStatus(updateRunStatus(current, { state: "paused", processHealth: "alive", summary: event.summary, needs: "runtime budget expired", lastActivityAt: event.createdAt, lastEventId: event.eventId, timeout: { ...(current.timeout ?? {}), pausedAt: nowIso(), hardTimeoutAt: nowIso(), reason: "time budget expired" } }));
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
