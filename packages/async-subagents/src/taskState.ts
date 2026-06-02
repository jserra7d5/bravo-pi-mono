import type { DerivedTaskState, TaskRecord } from "./types.js";

const SATISFIED = new Set(["completed"]);
let deriveTaskStateCallCountForTest = 0;
let deriveTaskStatesCallCountForTest = 0;

export function unresolvedDependencies(task: TaskRecord, allTasks: TaskRecord[]): TaskRecord[] {
  const byId = new Map(allTasks.map((item) => [item.id, item]));
  return task.dependsOn.map((id) => byId.get(id)).filter((dep): dep is TaskRecord => !dep || !SATISFIED.has(dep.status));
}

export function isTaskReady(task: TaskRecord, allTasks: TaskRecord[]): boolean {
  return task.status === "pending" && !task.owner && unresolvedDependencies(task, allTasks).length === 0;
}

export function deriveTaskState(task: TaskRecord, allTasks: TaskRecord[]): DerivedTaskState {
  deriveTaskStateCallCountForTest += 1;
  if (task.status === "pending") return isTaskReady(task, allTasks) ? "ready" : "blocked";
  return task.status;
}

export function deriveTaskStates(tasks: TaskRecord[]): Map<string, DerivedTaskState> {
  deriveTaskStatesCallCountForTest += 1;
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const states = new Map<string, DerivedTaskState>();
  for (const task of tasks) {
    if (task.status !== "pending") {
      states.set(task.id, task.status);
      continue;
    }
    if (task.owner) {
      states.set(task.id, "blocked");
      continue;
    }
    let ready = true;
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (!dep || !SATISFIED.has(dep.status)) {
        ready = false;
        break;
      }
    }
    states.set(task.id, ready ? "ready" : "blocked");
  }
  return states;
}

export function unresolvedDependencyIdsByTask(tasks: TaskRecord[]): Map<string, string[]> {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const result = new Map<string, string[]>();
  for (const task of tasks) {
    const unresolved = task.dependsOn.filter((id) => {
      const dep = byId.get(id);
      return !dep || !SATISFIED.has(dep.status);
    });
    result.set(task.id, unresolved);
  }
  return result;
}

export function taskStateDerivationStatsForTest(): { deriveTaskState: number; deriveTaskStates: number } {
  return { deriveTaskState: deriveTaskStateCallCountForTest, deriveTaskStates: deriveTaskStatesCallCountForTest };
}

export function resetTaskStateDerivationStatsForTest(): void {
  deriveTaskStateCallCountForTest = 0;
  deriveTaskStatesCallCountForTest = 0;
}
