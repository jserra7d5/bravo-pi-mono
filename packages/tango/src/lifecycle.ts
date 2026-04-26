import { existsSync } from "node:fs";
import type { AgentMetadata, AgentStatus } from "./types.js";
import { transitionStatus } from "./metadata.js";
import { tmuxAlive } from "./runtime/tmux.js";

export const STARTUP_PID_GRACE_MS = 10_000;

export function isTerminalStatus(status: AgentStatus): boolean {
  return status === "done" || status === "error" || status === "blocked" || status === "stopped";
}

export function pidAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

export interface ReconcileOptions {
  now?: Date;
  pidGraceMs?: number;
}

export function reconcileAgentLifecycle(meta: AgentMetadata, options: ReconcileOptions = {}): AgentMetadata {
  if (isTerminalStatus(meta.status)) return meta;
  if (meta.status !== "running") return meta;

  if (meta.mode === "interactive") {
    if (!tmuxAlive(meta.tmuxSocket, meta.tmuxSession)) return transitionStatus(meta.runDir, "stopped", "tmux session is no longer alive");
    return meta;
  }

  if (meta.mode !== "oneshot") return meta;

  if (meta.exitCode !== undefined && meta.exitCode !== null) return transitionStatus(meta.runDir, meta.exitCode === 0 ? "done" : "error");

  if (meta.pid === undefined) {
    const now = options.now?.getTime() ?? Date.now();
    const updated = Date.parse(meta.updatedAt || meta.createdAt);
    const age = Number.isFinite(updated) ? now - updated : Number.POSITIVE_INFINITY;
    if (age < (options.pidGraceMs ?? STARTUP_PID_GRACE_MS)) return meta;
    return transitionStatus(meta.runDir, "error", "Agent is running but no child PID was recorded");
  }

  const alive = pidAlive(meta.pid);
  if (alive === true || alive === undefined) return meta;
  return transitionStatus(meta.runDir, "error", "Process exited but Tango did not observe exit code or terminal status");
}

export function runDirExists(runDir: string): boolean {
  return existsSync(runDir);
}
