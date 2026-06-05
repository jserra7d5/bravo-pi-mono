import { readFastTrackState } from "../../src/fastTrack.js";
import { RunStore } from "../../src/runStore.js";
import type { DerivedTaskState, RunIndexRecord, TaskRecord } from "../../src/types.js";
import { readWatcherSnapshot, type RunSummaryRow } from "../../src/watcher.js";
import { renderWidgetCard, widgetRowFromSummary, type WidgetRowInput } from "./renderers.js";
import { isResultWakeupCurrent } from "./wakeups.js";
import { updateRunStatus } from "../../src/status.js";
import { TaskStore } from "../../src/taskStore.js";
import { deriveTaskStates, unresolvedDependencyIdsByTask } from "../../src/taskState.js";

export interface LiveWidgetSnapshot {
  rows: RunSummaryRow[];
  totalCost: number | undefined;
  tasks: TaskRecord[];
  taskStates: Map<string, DerivedTaskState>;
  taskUnresolvedDependencyIds: Map<string, string[]>;
  runIdToTask: Map<string, TaskRecord>;
  visibleTasks: TaskRecord[];
}

export interface LiveWidgetInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
  maxRows?: number;
  terminalCompletedVisibleMs?: number;
  records?: RunIndexRecord[];
  snapshot?: LiveWidgetSnapshot;
  fastTrackArmed?: boolean;
  // Optional explicit width — when omitted (the production path), pi tells the
  // widget its real container width via the Component.render(width) callback.
  // This is required: pi's widget container is narrower than the full terminal,
  // so picking `process.stdout.columns` would overflow and wrap the chrome.
  width?: number;
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

function isTerminal(row: RunSummaryRow): boolean {
  return TERMINAL_STATES.has(row.state);
}

function visibleState(state: string, updatedAt: string, now: number, terminalCompletedVisibleMs: number): boolean {
  if (!TERMINAL_STATES.has(state)) return ["created", "queued", "running", "idle", "waiting_for_input", "blocked", "stalled", "paused"].includes(state);
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return true;
  return now - updatedAtMs <= terminalCompletedVisibleMs;
}

function visible(row: RunSummaryRow, now: number, terminalCompletedVisibleMs: number): boolean {
  return visibleState(row.state, row.updatedAt, now, terminalCompletedVisibleMs);
}

function rowPriority(row: RunSummaryRow): number {
  if (row.state === "waiting_for_input" || row.state === "blocked") return 0;
  if (!isTerminal(row)) return 1;
  return 2;
}

// Clamp into the chrome's supported range. The lower bound is the smallest
// width the card layout (`pickWidgetLayout`) can still draw legibly; the upper
// bound keeps very wide containers from stretching the card across the screen.
function clampWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 64;
  return Math.max(28, Math.min(96, Math.floor(width)));
}

interface BuildResult {
  rows: RunSummaryRow[];
  totalCost: number | undefined;
}

function rowWithCurrentResultReady(input: LiveWidgetInput, row: RunSummaryRow): RunSummaryRow {
  if (!row.resultReady) return row;
  const result = row.result ?? input.store.readResult(row.runId);
  if (!result) return row;
  const parentRunId = input.parentRunId ?? result.parentRunId;
  if (isResultWakeupCurrent(input.store, parentRunId, row.runId, result)) return { ...row, result };
  return { ...row, resultReady: false };
}

function processHealth(pid: number | undefined): "unknown" | "alive" | "dead" {
  if (!pid) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch {
    return "dead";
  }
}

function cancelRequestAtMs(row: RunSummaryRow): number | undefined {
  if (!row.summary?.startsWith("Cancel requested:")) return undefined;
  const rowUpdatedAtMs = Date.parse(row.updatedAt);
  return Number.isFinite(rowUpdatedAtMs) ? rowUpdatedAtMs : undefined;
}

function reconcileStaleCancelledLiveRow(input: LiveWidgetInput, row: RunSummaryRow, now: number, terminalCompletedVisibleMs: number): RunSummaryRow {
  if (isTerminal(row)) return row;
  const cancelAtMs = cancelRequestAtMs(row);
  if (cancelAtMs === undefined || now - cancelAtMs <= terminalCompletedVisibleMs) return row;

  let status;
  try {
    status = input.store.readStatus(row.runId);
  } catch {
    return row;
  }
  if (TERMINAL_STATES.has(status.state) || !status.pid || processHealth(status.pid) !== "dead") return row;

  const summary = "Cancelled after recorded child process exited before supervisor finalization";
  const error = { code: "PARENT_CANCELLED_PROCESS_EXITED", message: summary, details: { pid: status.pid, processHealth: "dead" } };

  try {
    input.store.writeStatus({
      ...updateRunStatus(status, {
        state: "cancelled",
        writerRole: "parent-runtime",
        processHealth: "dead",
        resultReady: false,
        lastActivityAt: row.updatedAt,
        summary,
        error,
      }),
      updatedAt: row.updatedAt,
    });
    const updated = input.store.readRunSummary(row.runId);
    return {
      ...row,
      state: "cancelled",
      summary: updated?.summary ?? summary,
      resultReady: false,
      updatedAt: updated?.updatedAt ?? row.updatedAt,
      lastActivityAt: updated?.lastActivityAt ?? row.updatedAt,
      result: undefined,
      metrics: updated?.metrics ?? row.metrics,
    };
  } catch {
    return row;
  }
}

function totalCostForRows(rows: RunSummaryRow[]): number | undefined {
  let total = 0;
  let any = false;
  for (const row of rows) {
    const cost = row.metrics?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      total += cost;
      any = true;
    }
  }
  return any ? total : undefined;
}

function buildSnapshot(input: LiveWidgetInput, now: number, terminalCompletedVisibleMs: number): BuildResult {
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
    nowMs: now,
    completedVisibleMs: terminalCompletedVisibleMs,
    records: input.records,
  });
  const rows = snapshot.rows
    .map((row) => reconcileStaleCancelledLiveRow(input, row, now, terminalCompletedVisibleMs))
    .map((row) => rowWithCurrentResultReady(input, row))
    .filter((row) => visible(row, now, terminalCompletedVisibleMs))
    .sort((a, b) => rowPriority(a) - rowPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
  return { rows, totalCost: totalCostForRows(rows) };
}

function visibleTasksFor(tasks: TaskRecord[], taskStates: Map<string, DerivedTaskState>, now: number): TaskRecord[] {
  // Keep just-completed/failed/cancelled tasks visible briefly so a plan that
  // finishes leaves on-screen evidence instead of vanishing the instant the last
  // task lands. Kept in sync with the same grace in renderers.renderWidgetCard.
  const graceMs = 30_000;
  return tasks.filter(t => {
    const state = taskStates.get(t.id) ?? t.status;
    if (state === "completed" || state === "failed" || state === "cancelled") {
      const updatedAtMs = Date.parse(t.updatedAt);
      if (Number.isFinite(updatedAtMs)) {
        return now - updatedAtMs <= graceMs;
      }
    }
    return true;
  });
}

function runIdTaskMap(tasks: TaskRecord[]): Map<string, TaskRecord> {
  const runIdToTask = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (task.owner?.runId) {
      runIdToTask.set(task.owner.runId, task);
    }
    for (const attempt of task.attempts) {
      if (attempt.runId) {
        runIdToTask.set(attempt.runId, task);
      }
    }
  }
  return runIdToTask;
}

function readTasksForSnapshot(input: LiveWidgetInput): TaskRecord[] {
  if (!input.rootSessionId) return [];
  try {
    return new TaskStore(input.store).listTasks(input.rootSessionId, { reconcile: "nonblocking" });
  } catch {
    return [];
  }
}

function prepareLiveWidgetSnapshot(input: LiveWidgetInput, now: number): LiveWidgetSnapshot {
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 60_000;
  const { rows, totalCost } = buildSnapshot(input, now, terminalCompletedVisibleMs);
  const tasks = readTasksForSnapshot(input);
  const taskStates = deriveTaskStates(tasks);
  const taskUnresolvedDependencyIds = unresolvedDependencyIdsByTask(tasks);
  return {
    rows,
    totalCost,
    tasks,
    taskStates,
    taskUnresolvedDependencyIds,
    runIdToTask: runIdTaskMap(tasks),
    visibleTasks: visibleTasksFor(tasks, taskStates, now),
  };
}

function renderAt(input: LiveWidgetInput, width: number, now: number): string[] {
  const maxRows = input.maxRows ?? 5;
  const snapshot = input.snapshot ?? prepareLiveWidgetSnapshot(input, now);
  const { rows, tasks, taskStates, taskUnresolvedDependencyIds, runIdToTask } = snapshot;
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 60_000;
  const visibleRows = rows.filter((row) => visible(row, now, terminalCompletedVisibleMs));
  const visibleTasks = visibleTasksFor(tasks, taskStates, now);
  const fastTrackArmed = input.fastTrackArmed ?? false;

  if (!visibleRows.length && !visibleTasks.length && !fastTrackArmed) return [];

  const widgetRows: WidgetRowInput[] = visibleRows.map((row) => {
    const task = runIdToTask.get(row.runId);
    const baseRow = widgetRowFromSummary(row, now);
    if (task) {
      baseRow.task = {
        id: task.id,
        title: task.title,
        status: taskStates.get(task.id) ?? task.status,
        activeForm: task.activeForm
      };
    }
    return baseRow;
  });

  return renderWidgetCard({
    width: clampWidth(width),
    rows: widgetRows,
    maxRows,
    totalCost: totalCostForRows(visibleRows),
    fastTrackArmed,
    tasks: visibleTasks,
    allTasks: tasks,
    taskStates,
    taskUnresolvedDependencyIds,
    now
  });
}

function hasVisibleRows(snapshot: LiveWidgetSnapshot, fastTrackArmed = false): boolean {
  return fastTrackArmed || snapshot.rows.length > 0 || snapshot.visibleTasks.length > 0;
}

function liveWidgetRenderSignature(input: LiveWidgetInput, snapshot: LiveWidgetSnapshot): string {
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 60_000;
  const rows = snapshot.rows.map((row) => {
    const task = snapshot.runIdToTask.get(row.runId);
    return {
      runId: row.runId,
      displayName: row.displayName,
      agentName: row.agentName,
      state: row.state,
      summary: row.summary,
      needs: row.needs,
      resultReady: row.resultReady,
      resultSummary: row.result?.summary,
      resultDurationMs: row.result?.durationMs,
      cost: row.metrics?.cost?.total,
      task: task ? {
        id: task.id,
        title: task.title,
        status: snapshot.taskStates.get(task.id) ?? task.status,
        activeForm: task.activeForm,
      } : undefined,
    };
  });
  const tasks = snapshot.visibleTasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: snapshot.taskStates.get(task.id) ?? task.status,
    activeForm: task.activeForm,
    ownerRunId: task.owner?.runId,
    ownerDisplayName: task.owner?.displayName,
    ownerAgent: task.owner?.agent,
    unresolvedDependencyIds: snapshot.taskUnresolvedDependencyIds.get(task.id) ?? [],
  }));
  const taskCounts = snapshot.tasks.map((task) => [task.id, snapshot.taskStates.get(task.id) ?? task.status]);
  return JSON.stringify({
    maxRows: input.maxRows ?? 5,
    terminalCompletedVisibleMs,
    rows,
    totalCost: snapshot.totalCost,
    fastTrackArmed: input.fastTrackArmed ?? false,
    tasks,
    taskCounts,
  });
}

// Exposed for tests and the few callers that want a one-shot static render
// (e.g. plain-text transcripts). The production code path goes through the
// factory below so pi can pass its real container width on every redraw.
export function renderLiveWidget(input: LiveWidgetInput): string[] {
  const now = Date.now();
  // When width is explicit (tests / fixtures) honor it; otherwise fall back to
  // the previous heuristic so non-component callers keep working.
  const width = input.width ?? (() => {
    const term = typeof process !== "undefined" ? process.stdout?.columns : undefined;
    return typeof term === "number" && term > 0 ? term : 64;
  })();
  return renderAt(input, width, now);
}

interface LiveWidgetComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
  update?(input: LiveWidgetInput): void;
}

interface RenderRequester {
  requestRender?: () => void;
}

let mountedWidget: LiveWidgetComponent | undefined;

function createLiveWidgetComponent(input: LiveWidgetInput, tui: unknown): LiveWidgetComponent {
  let currentInput = input;
  let currentSignature = liveWidgetRenderSignature(input, input.snapshot ?? prepareLiveWidgetSnapshot(input, Date.now()));
  const renderHost = tui as RenderRequester | undefined;
  const component: LiveWidgetComponent = {
    update(nextInput: LiveWidgetInput) {
      const nextSnapshot = nextInput.snapshot ?? prepareLiveWidgetSnapshot(nextInput, Date.now());
      const nextSignature = liveWidgetRenderSignature(nextInput, nextSnapshot);
      currentInput = { ...nextInput, snapshot: nextSnapshot };
      if (nextSignature !== currentSignature) {
        currentSignature = nextSignature;
        renderHost?.requestRender?.();
      }
    },
    render(width: number) {
      return renderAt(currentInput, width, Date.now());
    },
    invalidate() {},
    dispose() {
      if (mountedWidget === component) mountedWidget = undefined;
    },
  };
  return component;
}

interface UiSetWidget {
  setWidget?: (
    key: string,
    value: string[] | undefined | ((tui: unknown, theme: unknown) => LiveWidgetComponent),
    options?: Record<string, unknown>,
  ) => void;
}

export function clearLiveWidget(ctx: unknown): void {
  const ui = (ctx as { ui?: UiSetWidget } | undefined)?.ui;
  if (!ui?.setWidget) return;
  mountedWidget = undefined;
  ui.setWidget("async-subagents-live", undefined, { placement: "belowEditor" });
}

export function updateLiveWidget(ctx: unknown, input: LiveWidgetInput): void {
  const ui = (ctx as { ui?: UiSetWidget } | undefined)?.ui;
  if (!ui?.setWidget) return;
  const snapshot = input.snapshot ?? prepareLiveWidgetSnapshot(input, Date.now());
  const fastTrackArmed = input.fastTrackArmed ?? (input.rootSessionId ? readFastTrackState(input.store.runRoot, input.rootSessionId).enabled : false);
  const snapshotInput = { ...input, snapshot, fastTrackArmed };
  // Use the precomputed snapshot so the visibility probe stays on the tick/update
  // path and the pi Component.render(width) callback performs no filesystem I/O.
  if (!hasVisibleRows(snapshot, fastTrackArmed)) {
    clearLiveWidget(ctx);
    return;
  }
  if (mountedWidget) {
    mountedWidget.update?.(snapshotInput);
    return;
  }
  ui.setWidget(
    "async-subagents-live",
    (tui) => {
      mountedWidget = createLiveWidgetComponent(snapshotInput, tui);
      return mountedWidget;
    },
    { placement: "belowEditor" },
  );
}
