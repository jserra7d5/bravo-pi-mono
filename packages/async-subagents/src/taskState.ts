import type { DerivedTaskState, TaskRecord } from "./types.js";

const SATISFIED = new Set(["completed"]);

export function unresolvedDependencies(task: TaskRecord, allTasks: TaskRecord[]): TaskRecord[] {
  const byId = new Map(allTasks.map((item) => [item.id, item]));
  return task.dependsOn.map((id) => byId.get(id)).filter((dep): dep is TaskRecord => !dep || !SATISFIED.has(dep.status));
}

export function isTaskReady(task: TaskRecord, allTasks: TaskRecord[]): boolean {
  return task.status === "pending" && !task.owner && unresolvedDependencies(task, allTasks).length === 0;
}

export function deriveTaskState(task: TaskRecord, allTasks: TaskRecord[]): DerivedTaskState {
  if (task.status === "pending") return isTaskReady(task, allTasks) ? "ready" : "blocked";
  return task.status;
}
