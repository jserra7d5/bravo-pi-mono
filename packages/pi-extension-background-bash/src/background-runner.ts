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

const runtimeId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
const ownedChildren = new Map<string, ChildProcess>();
const liveStatuses = new Set(["starting", "running", "blocked"]);

function nowIso(): string { return new Date().toISOString(); }
function terminal(status: BackgroundTaskRecord["status"]): boolean { return !liveStatuses.has(status); }
function safeAppendLog(path: string, text: string): void {
  try { appendLog(path, text); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export class BackgroundRunner {
  constructor(readonly registry: TaskRegistry, readonly config: ResolvedBackgroundBashConfig) {}

  async start(input: { command: string; timeout?: number; wakeOnCompletion?: boolean; cwd: string; ownerSessionId?: string }): Promise<BackgroundTaskRecord> {
    const taskId = newTaskId();
    const taskDir = join(this.config.dataDir, taskId);
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    const outputPath = join(taskDir, "output.log");
    initializeLog(outputPath);
    safeAppendLog(outputPath, sentinel(`started: ${input.command}`));
    const now = nowIso();
    const maxRuntimeMs = input.timeout ?? this.config.defaultMaxRuntimeMs;
    let record: BackgroundTaskRecord = {
      schemaVersion: 1, taskId, command: input.command, cwd: input.cwd, ownerSessionId: input.ownerSessionId,
      status: "starting", createdAt: now, updatedAt: now, startedAt: now, outputPath, metadataPath: join(taskDir, "metadata.json"),
      outputBytes: 0, maxOutputBytes: this.config.defaultMaxOutputBytes, maxRuntimeMs, wakeOnCompletion: Boolean(input.wakeOnCompletion), ownerRuntimeId: runtimeId,
    };
    this.registry.upsert(record);
    let child: ChildProcess;
    try {
      const { shell, args } = getShellConfig();
      child = spawn(shell, [...args, input.command], { cwd: input.cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
    } catch (err) {
      record = { ...record, status: "failed", endedAt: nowIso() };
      safeAppendLog(outputPath, sentinel(`spawn error: ${err instanceof Error ? err.message : String(err)}`));
      this.registry.upsert(record);
      return record;
    }
    const spawnError = await new Promise<Error | undefined>((resolve) => {
      let settled = false;
      const done = (err?: Error) => { if (!settled) { settled = true; resolve(err); } };
      child.once("error", done);
      setImmediate(() => done());
    });
    if (spawnError || child.pid === undefined) {
      record = { ...record, status: "failed", endedAt: nowIso() };
      safeAppendLog(outputPath, sentinel(`spawn error: ${spawnError?.message ?? "child process did not expose a pid"}`));
      this.registry.upsert(record);
      return record;
    }

    record = { ...record, status: "running", pid: child.pid, pgid: process.platform !== "win32" ? child.pid : undefined, processStartTime: Date.now(), processCommandLine: input.command };
    this.registry.upsert(record);
    ownedChildren.set(taskId, child);

    let stopped = false;
    const stopFor = (status: BackgroundTaskRecord["status"], reason: BackgroundTaskRecord["stopReason"], message: string) => {
      if (stopped || !child.pid) return;
      stopped = true;
      safeAppendLog(outputPath, sentinel(message));
      record = { ...record, status, stopReason: reason };
      this.registry.upsert(record);
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => child.pid && killProcessTree(child.pid, "SIGKILL"), 5000).unref?.();
    };
    const write = (chunk: Buffer) => {
      if (terminal(record.status) || record.outputBytes >= record.maxOutputBytes) return;
      const remaining = record.maxOutputBytes - record.outputBytes;
      const slice = chunk.subarray(0, Math.max(0, remaining));
      if (slice.length) safeAppendLog(outputPath, slice.toString());
      record.outputBytes += slice.length;
      if (looksLikeInteractivePrompt(chunk.toString())) {
        record = { ...record, status: "blocked", blockedReason: "interactive_prompt", stopReason: "interactive_prompt" };
        safeAppendLog(outputPath, sentinel("interactive prompt detected; task marked blocked; no input was sent"));
        this.registry.upsert(record);
      }
      if (record.outputBytes >= record.maxOutputBytes) stopFor("killed", "output_cap", `output cap reached (${record.maxOutputBytes} bytes); stopping task`);
    };
    child.stdout?.on("data", write); child.stderr?.on("data", write);
    const timer = maxRuntimeMs > 0 ? setTimeout(() => stopFor("timed_out", "timeout", `timeout after ${maxRuntimeMs}ms; stopping task`), maxRuntimeMs) : undefined;
    timer?.unref?.();
    child.on("error", (err) => { record = { ...record, status: "failed", endedAt: nowIso() }; safeAppendLog(outputPath, sentinel(`spawn error: ${err.message}`)); this.registry.upsert(record); });
    child.on("exit", (code, signal) => { timer && clearTimeout(timer); ownedChildren.delete(taskId); const terminalStatus = record.stopReason === "timeout" ? "timed_out" : record.stopReason === "output_cap" ? "killed" : signal ? "killed" : code === 0 && record.status !== "blocked" ? "exited" : "failed"; record = { ...record, status: terminalStatus, exitCode: code, signal, endedAt: nowIso() }; safeAppendLog(outputPath, sentinel(`exit code=${code ?? "null"} signal=${signal ?? "null"}`)); this.registry.upsert(record); });
    child.unref();
    return record;
  }

  async stop(taskId: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM", killAfterMs = 5_000): Promise<BackgroundTaskRecord | undefined> {
    const record = this.registry.get(taskId);
    if (!record?.pid) return record;
    const child = ownedChildren.get(taskId);
    if (child?.pid === record.pid && record.ownerRuntimeId === runtimeId) {
      await terminateProcessTree(record.pid, signal, killAfterMs);
      const updated = { ...record, status: "killed" as const, stopReason: "user" as const };
      this.registry.upsert(updated); return updated;
    }
    const updated = { ...record, status: "orphaned" as const, blockedReason: "unverified_pid_ownership" };
    this.registry.upsert(updated);
    return updated;
  }

  reconcile(sessionId?: string): void {
    for (const record of this.registry.list(true)) {
      if (!liveStatuses.has(record.status)) continue;
      if (sessionId && record.ownerSessionId && record.ownerSessionId !== sessionId) continue;
      if (ownedChildren.has(record.taskId) && record.ownerRuntimeId === runtimeId) continue;
      this.registry.upsert({ ...record, status: "orphaned", blockedReason: "unverified_after_reload" });
    }
  }

  async shutdown(sessionId?: string): Promise<void> {
    if (this.config.shutdownPolicy === "leave-running") return;
    for (const record of this.registry.list(true)) {
      if (!liveStatuses.has(record.status)) continue;
      if (sessionId && record.ownerSessionId && record.ownerSessionId !== sessionId) continue;
      if (ownedChildren.has(record.taskId) && record.ownerRuntimeId === runtimeId) await this.stop(record.taskId, "SIGTERM", 5_000);
      else this.registry.upsert({ ...record, status: "orphaned", blockedReason: "unverified_shutdown" });
    }
  }
}
