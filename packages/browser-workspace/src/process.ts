import { spawn } from "node:child_process";
import fs from "node:fs";
import type { ExternalCommand } from "./contracts.js";
import { Exit, WorkspaceError } from "./errors.js";

export interface ExecResult { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }
export interface ProcessIdentity { pid: number; startTicks: string; ppid: number; pgid: number; uid: number }
export class RetryableNotReady extends Error { constructor(message = "not ready") { super(message); this.name = "RetryableNotReady"; } }

export class Deadline {
  readonly expiresAt: number;
  constructor(timeoutMs: number, readonly signal?: AbortSignal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WorkspaceError("DEADLINE_INVALID", "Deadline must be positive", Exit.USAGE);
    this.expiresAt = Date.now() + timeoutMs;
  }
  remaining(): number { return Math.max(0, this.expiresAt - Date.now()); }
  child(timeoutMs: number): AbortSignal {
    const controller = new AbortController();
    const ms = Math.min(timeoutMs, this.remaining());
    const timer = setTimeout(() => controller.abort(new WorkspaceError("PROCESS_TIMEOUT", "Operation timed out", Exit.RUNTIME)), ms);
    timer.unref?.();
    const abort = () => controller.abort(this.signal?.reason ?? new WorkspaceError("PROCESS_ABORTED", "Operation aborted", Exit.RUNTIME));
    this.signal?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => { clearTimeout(timer); this.signal?.removeEventListener("abort", abort); }, { once: true });
    return controller.signal;
  }
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function pollBounded<T>(label: string, timeoutMs: number, operation: () => Promise<T | undefined>, signal?: AbortSignal, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    try { const result = await operation(); if (result !== undefined) return result; }
    catch (error) { if (!(error instanceof RetryableNotReady)) throw error; }
    await abortableSleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal);
  }
  throw new WorkspaceError("POLL_TIMEOUT", `${label} timed out`, Exit.RUNTIME);
}

export async function fetchBounded(url: string, timeoutMs: number, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new WorkspaceError("FETCH_TIMEOUT", "HTTP operation timed out", Exit.RUNTIME)), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** Spawn without a shell. Timeout/output-cap settlement kills and reaps before rejecting. */
export async function execBounded(command: ExternalCommand, timeoutMs = 5000, maxBytes = 1024 * 1024, signal?: AbortSignal): Promise<ExecResult> {
  if ([command.executable, ...command.args].some(value => value.includes("\0"))) throw new WorkspaceError("ARGV_INVALID", "NUL in argv", Exit.USAGE);
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command.executable, command.args, { env: command.env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform === "linux" });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), terminalError: unknown, settled = false, identity: ProcessIdentity | undefined;
    if (child.pid) try { identity = readProcessIdentity(child.pid); } catch {}
    const terminate = () => {
      if (identity && identity.pgid === identity.pid && sameProcess(identity)) try { process.kill(-identity.pgid, "SIGKILL"); return; } catch {}
      child.kill("SIGKILL");
    };
    const append = (which: "stdout" | "stderr", data: Buffer) => {
      const next = Buffer.concat([which === "stdout" ? stdout : stderr, data]);
      if (next.length > maxBytes && !terminalError) {
        terminalError = new WorkspaceError("PROCESS_OUTPUT_LIMIT", "External command exceeded output limit", Exit.RUNTIME);
        terminate();
      }
      if (which === "stdout") stdout = next.subarray(0, maxBytes); else stderr = next.subarray(0, maxBytes);
    };
    child.stdout.on("data", data => append("stdout", data)); child.stderr.on("data", data => append("stderr", data));
    const timeout = setTimeout(() => { terminalError = new WorkspaceError("PROCESS_TIMEOUT", "External command timed out", Exit.RUNTIME); terminate(); }, timeoutMs);
    const abort = () => { terminalError = signal?.reason ?? new WorkspaceError("PROCESS_ABORTED", "External command aborted", Exit.RUNTIME); terminate(); };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { terminalError = new WorkspaceError("DEPENDENCY_SPAWN_FAILED", "Cannot execute dependency", Exit.DEPENDENCY, { code: (error as NodeJS.ErrnoException).code }); });
    child.once("close", (code, childSignal) => {
      if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort);
      if (terminalError) reject(terminalError);
      else resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code, signal: childSignal });
    });
  });
}

function procStat(pid: number): string[] {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), close = text.lastIndexOf(")");
  if (close < 0) throw new WorkspaceError("PROCESS_IDENTITY_INVALID", "Malformed /proc stat", Exit.RUNTIME);
  return text.slice(close + 2).split(" ");
}
export function readProcessIdentity(pid: number): ProcessIdentity {
  const fields = procStat(pid), uid = fs.statSync(`/proc/${pid}`).uid;
  return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), startTicks: fields[19], uid };
}
export function procStartTicks(pid: number): string { return readProcessIdentity(pid).startTicks; }
export function sameProcess(identity: ProcessIdentity): boolean { try { const live = readProcessIdentity(identity.pid); return live.startTicks === identity.startTicks && live.uid === identity.uid; } catch { return false; } }
export function processGroupMembers(pgid: number): ProcessIdentity[] {
  const members: ProcessIdentity[] = [];
  for (const name of fs.readdirSync("/proc")) if (/^\d+$/u.test(name)) try { const identity = readProcessIdentity(Number(name)); if (identity.pgid === pgid) members.push(identity); } catch {}
  return members;
}
export async function waitProcessGone(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs; while (Date.now() < end) { if (!sameProcess(identity)) return true; await abortableSleep(25); } return !sameProcess(identity);
}
