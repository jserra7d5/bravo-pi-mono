import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedBackgroundBashConfig } from "./config.js";
import { appendLog, initializeLog, sentinel } from "./output-log.js";
import { killProcessTree, terminateProcessTree } from "./process-tree.js";
import { newTaskId, TaskRegistry } from "./task-registry.js";
import type { BackgroundTaskRecord } from "./task-types.js";
import { looksLikeInteractivePrompt } from "./watchdogs.js";
import { acquireWakeClaim, buildWakeMessage, isWakeEligible, requireValidWakeRouting, routingFailure, validateWakeRouting, type BackgroundWakeNotifier } from "./notifications.js";

export const runtimeId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
const ownedChildren = new Map<string, ChildProcess>();
const stopReasons = new Map<string, BackgroundTaskRecord["stopReason"]>();
const liveStatuses = new Set(["starting", "running", "blocked"]);

function nowIso(): string { return new Date().toISOString(); }
function terminal(status: BackgroundTaskRecord["status"]): boolean { return !liveStatuses.has(status); }
function preserveWakeFields(record: BackgroundTaskRecord, existing?: BackgroundTaskRecord): BackgroundTaskRecord {
  if (!existing?.modelWakeCanonicalTerminal) return record;
  const c = existing.modelWakeCanonicalTerminal;
  return {
    ...record,
    status: c.status,
    exitCode: c.exitCode,
    signal: c.signal,
    stopReason: c.stopReason,
    endedAt: c.endedAt,
    modelWakeState: existing.modelWakeState,
    modelWakeNotificationId: existing.modelWakeNotificationId,
    modelWakeClaimedAt: existing.modelWakeClaimedAt,
    modelWakeDispatchRequestedAt: existing.modelWakeDispatchRequestedAt,
    modelWakeHostApiInvokedAt: existing.modelWakeHostApiInvokedAt,
    modelWakeDispatchResult: existing.modelWakeDispatchResult,
    modelWakeAttemptedAt: existing.modelWakeAttemptedAt,
    modelWakeAcceptedAt: existing.modelWakeAcceptedAt,
    modelWakeDeliverySemantics: existing.modelWakeDeliverySemantics,
    modelWakeCanonicalTerminal: existing.modelWakeCanonicalTerminal,
    modelWakeErrorCode: existing.modelWakeErrorCode,
    modelWakeError: existing.modelWakeError,
  };
}
function safeAppendLog(path: string, text: string): void {
  try { appendLog(path, text); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`background bash log append failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class BackgroundRunner {
  constructor(readonly registry: TaskRegistry, readonly config: ResolvedBackgroundBashConfig) {}

  async start(input: { command: string; timeout?: number; wakeOnCompletion?: boolean; cwd: string; ownerSessionId?: string; ownerSessionFile?: string; wakeNotifier?: BackgroundWakeNotifier }): Promise<BackgroundTaskRecord> {
    if (input.wakeOnCompletion === true) {
      requireValidWakeRouting({ ownerSessionId: input.ownerSessionId, ownerSessionFile: input.ownerSessionFile, ownerRuntimeId: runtimeId }, input.wakeNotifier);
    }

    const taskId = newTaskId();
    const taskDir = join(this.config.dataDir, taskId);
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    const outputPath = join(taskDir, "output.log");
    initializeLog(outputPath);
    safeAppendLog(outputPath, sentinel(`started: ${input.command}`));
    const now = nowIso();
    const maxRuntimeMs = input.timeout ?? this.config.defaultMaxRuntimeMs;
    let record: BackgroundTaskRecord = {
      schemaVersion: 1, taskId, command: input.command, cwd: input.cwd, ownerSessionId: input.ownerSessionId, ownerSessionFile: input.ownerSessionFile,
      status: "starting", createdAt: now, updatedAt: now, startedAt: now, outputPath, metadataPath: join(taskDir, "metadata.json"),
      outputBytes: 0, maxOutputBytes: this.config.defaultMaxOutputBytes, maxRuntimeMs, wakeOnCompletion: input.wakeOnCompletion === true, ownerRuntimeId: runtimeId,
      wakePolicyVersion: input.wakeOnCompletion === true ? 1 : undefined, wakePolicySource: input.wakeOnCompletion === true ? "tool_arg_v1" : undefined,
    };
    this.registry.upsert(record);

    let child: ChildProcess;
    try {
      const { shell, args } = getShellConfig();
      child = spawn(shell, [...args, input.command], { cwd: input.cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
    } catch (err) {
      record = { ...record, status: "failed", endedAt: nowIso() };
      await this.finalize(record, outputPath, input.wakeNotifier, `spawn error: ${err instanceof Error ? err.message : String(err)}`);
      return this.registry.get(taskId) ?? record;
    }

    let processError: Error | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timer: NodeJS.Timeout | undefined;
    let finalized = false;
    let spawnSettled = false;
    let settleSpawn!: (error?: Error) => void;
    let settleClose!: () => void;
    const spawned = new Promise<Error | undefined>((resolve) => { settleSpawn = resolve; });
    const closed = new Promise<void>((resolve) => { settleClose = resolve; });
    const settle = (error?: Error) => {
      if (spawnSettled) return;
      spawnSettled = true;
      settleSpawn(error);
    };
    const stopFor = (reason: BackgroundTaskRecord["stopReason"], message: string) => {
      if (stopReasons.has(taskId) || !child.pid) return;
      stopReasons.set(taskId, reason);
      record = { ...record, stopReason: reason, updatedAt: nowIso() };
      safeAppendLog(outputPath, sentinel(message));
      this.registry.upsert(record);
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => child.pid && killProcessTree(child.pid, "SIGKILL"), 5_000).unref?.();
    };
    const write = (chunk: Buffer) => {
      if (finalized || terminal(record.status) || record.outputBytes >= record.maxOutputBytes) return;
      const remaining = record.maxOutputBytes - record.outputBytes;
      const slice = chunk.subarray(0, Math.max(0, remaining));
      if (slice.length) safeAppendLog(outputPath, slice.toString());
      record.outputBytes += slice.length;
      if (looksLikeInteractivePrompt(chunk.toString())) {
        record = { ...record, status: "blocked", blockedReason: "interactive_prompt", stopReason: "interactive_prompt", updatedAt: nowIso() };
        safeAppendLog(outputPath, sentinel("interactive prompt detected; task marked blocked; no input was sent"));
        this.registry.upsert(record);
      }
      if (record.outputBytes >= record.maxOutputBytes) stopFor("output_cap", `output cap reached (${record.maxOutputBytes} bytes); stopping task`);
    };
    const finishOnClose = (closeCode: number | null, closeSignal: NodeJS.Signals | null) => {
      if (finalized) return;
      finalized = true;
      if (timer) clearTimeout(timer);
      ownedChildren.delete(taskId);
      const reason = stopReasons.get(taskId) ?? record.stopReason;
      stopReasons.delete(taskId);
      const code = closeCode ?? exitCode;
      const signal = closeSignal ?? exitSignal;
      const terminalStatus = reason === "timeout" ? "timed_out" : reason === "output_cap" || reason === "user" || reason === "shutdown" ? "killed" : processError ? "failed" : signal ? "killed" : code === 0 && record.status !== "blocked" ? "exited" : "failed";
      record = { ...record, status: terminalStatus, stopReason: reason, exitCode: code, signal, endedAt: nowIso() };
      void this.finalize(record, outputPath, input.wakeNotifier, processError ? `process error: ${processError.message}; close code=${code ?? "null"} signal=${signal ?? "null"}` : `close code=${code ?? "null"} signal=${signal ?? "null"}`);
      settle(processError);
      settleClose();
    };

    // Fast children can emit every lifecycle event immediately. Attach all handlers
    // synchronously after spawn returns, before awaiting spawn readiness or unrefing.
    child.once("spawn", () => {
      if (child.pid === undefined) return settle(new Error("child process did not expose a pid"));
      record = { ...record, status: "running", pid: child.pid, pgid: process.platform !== "win32" ? child.pid : undefined, processStartTime: Date.now(), processCommandLine: input.command };
      this.registry.upsert(record);
      ownedChildren.set(taskId, child);
      timer = maxRuntimeMs > 0 ? setTimeout(() => stopFor("timeout", `timeout after ${maxRuntimeMs}ms; stopping task`), maxRuntimeMs) : undefined;
      timer?.unref?.();
      settle();
    });
    child.once("error", (err) => { processError = err; settle(err); });
    child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; });
    child.once("close", finishOnClose);
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);

    const spawnError = await spawned;
    child.unref();
    if (spawnError && !finalized) {
      // Node emits close after error; keep the record active until that managed child
      // boundary so any already-produced output is drained before terminal metadata.
      await closed;
    }
    return this.registry.get(taskId) ?? record;
  }

  async stop(taskId: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM", killAfterMs = 5_000): Promise<BackgroundTaskRecord | undefined> {
    const record = this.registry.get(taskId);
    if (!record || record.schemaVersion !== 1 || terminal(record.status) || !record.pid) return record;
    const child = ownedChildren.get(taskId);
    if (child?.pid === record.pid && record.ownerRuntimeId === runtimeId) {
      if (!stopReasons.has(taskId)) {
        stopReasons.set(taskId, "user");
        this.registry.upsert({ ...record, stopReason: "user", updatedAt: nowIso() });
        await terminateProcessTree(record.pid, signal, killAfterMs);
      }
      return this.registry.get(taskId) ?? { ...record, stopReason: "user" };
    }
    const updated = { ...record, status: "orphaned" as const, blockedReason: "unverified_pid_ownership" };
    this.registry.upsert(updated);
    return updated;
  }

  reconcile(sessionId?: string): void {
    for (const record of this.registry.list(false)) {
      if (record.schemaVersion !== 1 || !liveStatuses.has(record.status)) continue;
      if (sessionId && record.ownerSessionId && record.ownerSessionId !== sessionId) continue;
      if (ownedChildren.has(record.taskId) && record.ownerRuntimeId === runtimeId) continue;
      const orphaned = { ...record, status: "orphaned" as const, blockedReason: "unverified_after_reload" };
      this.registry.upsert(isWakeEligible(record) ? routingFailure(orphaned, "WAKE_HANDLE_LOST_AFTER_RELOAD", "Wake-enabled running task no longer has a live session-bound notifier after reload/reconcile; ambiguous claims are never replayed.") : orphaned);
    }
  }

  private async finalize(record: BackgroundTaskRecord, outputPath: string, notifier: BackgroundWakeNotifier | undefined, finalLog: string): Promise<void> {
    try {
      record = preserveWakeFields(record, this.registry.get(record.taskId));
      safeAppendLog(outputPath, sentinel(finalLog));
      this.registry.upsert(record);
      if (record.stopReason === "shutdown" && isWakeEligible(record)) {
        safeAppendLog(outputPath, sentinel("model wake suppressed for session shutdown"));
        this.registry.upsert(routingFailure(record, "SHUTDOWN_SUPPRESSED", "Session shutdown does not model-wake background bash tasks in v1."));
        return;
      }
      const claimed = acquireWakeClaim(record);
      if (!claimed) return;
      safeAppendLog(outputPath, sentinel(`model wake claim acquired id=${claimed.modelWakeNotificationId}`));
      this.registry.upsert(claimed);
      const route = validateWakeRouting(claimed, notifier);
      if (!route.ok) {
        const failed = routingFailure(claimed, route.code, route.message);
        safeAppendLog(outputPath, sentinel(`model wake routing failed ${route.code}: ${route.message}`));
        this.registry.upsert(failed);
        return;
      }
      const requested = { ...claimed, modelWakeState: "dispatch_requested" as const, modelWakeDispatchRequestedAt: nowIso() };
      safeAppendLog(outputPath, sentinel("model wake dispatch requested"));
      this.registry.upsert(requested);
      const wakeMessage = buildWakeMessage(requested);
      try {
        notifier!.send(wakeMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeAppendLog(outputPath, sentinel(`model wake synchronous dispatch failed: ${message}`));
        this.registry.upsert({ ...requested, modelWakeState: "dispatch_sync_failed", modelWakeErrorCode: "DISPATCH_SYNC_FAILED", modelWakeError: message });
        return;
      }
      const dispatched = { ...requested, modelWakeState: "dispatched_to_host" as const, modelWakeHostApiInvokedAt: nowIso(), modelWakeDispatchResult: "host_api_invoked" as const };
      safeAppendLog(outputPath, sentinel("model wake dispatched to host api; downstream delivery remains unknown"));
      try {
        this.registry.upsert(dispatched);
      } catch (err) {
        // sendMessage returned normally, but Pi exposes no delivery acknowledgement.
        // Preserve durable dispatch_requested ambiguity and never classify or retry it
        // as a synchronous host failure.
        console.warn(`background bash post-dispatch persistence failed for ${record.taskId}; durable dispatch_requested remains ambiguous: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      // Child close handling must never escape as an unhandled rejection. Metadata and
      // claim writes happen before host invocation, so a fault is bounded and not replayed.
      console.warn(`background bash finalization failed for ${record.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async shutdown(sessionId?: string): Promise<void> {
    if (this.config.shutdownPolicy === "leave-running") return;
    for (const record of this.registry.list(false)) {
      if (record.schemaVersion !== 1 || !liveStatuses.has(record.status)) continue;
      if (sessionId && record.ownerSessionId && record.ownerSessionId !== sessionId) continue;
      if (ownedChildren.has(record.taskId) && record.ownerRuntimeId === runtimeId && record.pid) {
        if (!stopReasons.has(record.taskId)) {
          stopReasons.set(record.taskId, "shutdown");
          this.registry.upsert({ ...record, stopReason: "shutdown", updatedAt: nowIso() });
          safeAppendLog(record.outputPath, sentinel("session shutdown; stopping task without model wake"));
          await terminateProcessTree(record.pid, "SIGTERM", 5_000);
        }
      } else this.registry.upsert({ ...record, status: "orphaned", blockedReason: "unverified_shutdown" });
    }
  }
}
