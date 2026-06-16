import type { DerivedTaskState, TaskReadiness, TaskRecord } from "./types.js";

const SATISFIED = new Set(["done"]);
let deriveTaskStateCallCountForTest = 0;
let deriveTaskStatesCallCountForTest = 0;

export function unresolvedDependencies(task: TaskRecord, allTasks: TaskRecord[]): TaskRecord[] {
  const byId = new Map(allTasks.map((item) => [item.id, item]));
  return task.dependsOn.map((id) => byId.get(id)).filter((dep): dep is TaskRecord => !dep || !SATISFIED.has(dep.status));
}

export function unresolvedDependencyIds(task: TaskRecord, allTasks: TaskRecord[]): string[] {
  const byId = new Map(allTasks.map((item) => [item.id, item]));
  return task.dependsOn.filter((id) => byId.get(id)?.status !== "done");
}

export function deriveTaskReadiness(task: TaskRecord, allTasks: TaskRecord[]): TaskReadiness {
  if (task.status !== "open") return null;
  return unresolvedDependencyIds(task, allTasks).length === 0 ? "ready" : "waiting";
}

export function isTaskReady(task: TaskRecord, allTasks: TaskRecord[]): boolean {
  return deriveTaskReadiness(task, allTasks) === "ready";
}

export function isReadyWakeupStillActionable(_task: TaskRecord | undefined, _allTasks: TaskRecord[]): boolean {
  return false;
}

export function deriveTaskState(task: TaskRecord, allTasks: TaskRecord[]): DerivedTaskState {
  deriveTaskStateCallCountForTest += 1;
  return deriveTaskReadiness(task, allTasks);
}

export function deriveTaskStates(tasks: TaskRecord[]): Map<string, DerivedTaskState> {
  deriveTaskStatesCallCountForTest += 1;
  return new Map(tasks.map((task) => [task.id, deriveTaskReadiness(task, tasks)]));
}

export function unresolvedDependencyIdsByTask(tasks: TaskRecord[]): Map<string, string[]> {
  return new Map(tasks.map((task) => [task.id, unresolvedDependencyIds(task, tasks)]));
}

export function taskStateDerivationStatsForTest(): { deriveTaskState: number; deriveTaskStates: number } {
  return { deriveTaskState: deriveTaskStateCallCountForTest, deriveTaskStates: deriveTaskStatesCallCountForTest };
}

export function resetTaskStateDerivationStatsForTest(): void {
  deriveTaskStateCallCountForTest = 0;
  deriveTaskStatesCallCountForTest = 0;
}
