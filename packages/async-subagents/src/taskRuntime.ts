import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStore } from "./runStore.js";
import { TaskStore } from "./taskStore.js";
import { isTerminalRunState } from "./schemas.js";

export interface TaskRuntimeState {
  schemaVersion: 1;
  enabled: boolean;
  updatedAt: string;
}

export interface TaskRuntimeBlocker {
  kind: "task" | "run";
  taskId: string;
  status?: string;
  runId?: string;
  runState?: string;
}

export function taskRuntimeStatePath(runRoot: string, rootSessionId: string): string {
  return join(runRoot, "session-task-runtime", `${rootSessionId}.json`);
}

export function readTaskRuntimeState(runRoot: string, rootSessionId: string): TaskRuntimeState {
  const path = taskRuntimeStatePath(runRoot, rootSessionId);
  if (!existsSync(path)) return { schemaVersion: 1, enabled: true, updatedAt: new Date(0).toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskRuntimeState>;
    return { schemaVersion: 1, enabled: parsed.enabled !== false, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString() };
  } catch {
    return { schemaVersion: 1, enabled: true, updatedAt: new Date(0).toISOString() };
  }
}

export function writeTaskRuntimeState(runRoot: string, rootSessionId: string, enabled: boolean): TaskRuntimeState {
  const state: TaskRuntimeState = { schemaVersion: 1, enabled, updatedAt: new Date().toISOString() };
  const path = taskRuntimeStatePath(runRoot, rootSessionId);
  mkdirSync(join(runRoot, "session-task-runtime"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export function findActiveTaskRuntimeBlockers(store: RunStore, rootSessionId: string): TaskRuntimeBlocker[] {
  const taskStore = new TaskStore(store);
  const tasks = taskStore.listTasks(rootSessionId, { reconcile: "nonblocking" });
  const blockers: TaskRuntimeBlocker[] = [];
  const seenRuns = new Set<string>();
  for (const task of tasks) {
    if (task.status !== "completed" && task.status !== "cancelled") {
      blockers.push({ kind: "task", taskId: task.id, status: task.status, runId: task.owner?.runId });
    }
    const runIds = [task.owner?.runId, ...task.attempts.map((attempt) => attempt.runId)].filter((runId): runId is string => typeof runId === "string" && Boolean(runId));
    for (const runId of runIds) {
      if (seenRuns.has(runId)) continue;
      seenRuns.add(runId);
      try {
        const status = store.readStatus(runId);
        if (!isTerminalRunState(status.state)) blockers.push({ kind: "run", taskId: task.id, runId, runState: status.state });
      } catch {
        // Missing run state should not prevent hiding completed/cancelled task history.
      }
    }
  }
  return blockers;
}
