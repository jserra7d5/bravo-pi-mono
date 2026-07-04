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

export interface HerdrAsyncSubagentsState {
  active: boolean;
  blocked: boolean;
  activeCount: number;
  message?: string;
  rootSessionId?: string;
  parentRunId?: string;
}

export type PidProbeResult = "alive" | "dead" | "unknown";
export type PidProber = (pid: number) => PidProbeResult;

export interface LiveWidgetInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
  maxRows?: number;
  terminalCompletedVisibleMs?: number;
  records?: RunIndexRecord[];
  snapshot?: LiveWidgetSnapshot;
  fastTrackArmed?: boolean;
  tasksEnabled?: boolean;
  pidProber?: PidProber;
  // Optional explicit width — when omitted (the production path), pi tells the
  // widget its real container width via the Component.render(width) callback.
  // This is required: pi's widget container is narrower than the full terminal,
  // so picking `process.stdout.columns` would overflow and wrap the chrome.
  width?: number;
  renderNow?: number;
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

function isTerminal(row: RunSummaryRow): boolean {
  return TERMINAL_STATES.has(row.state);
}

function rowKeepsHerdrActive(row: RunSummaryRow): boolean {
  return !isTerminal(row) || row.resultReady;
}

export function deriveHerdrAsyncSubagentsState(input: { rows: RunSummaryRow[]; rootSessionId?: string; parentRunId?: string }): HerdrAsyncSubagentsState {
  const activeRows = input.rows.filter(rowKeepsHerdrActive);
  const blockedRows = activeRows.filter((row) => row.state === "waiting_for_input" || row.state === "blocked");
  const activeCount = activeRows.length;
  const firstBlocked = blockedRows[0];
  const message = firstBlocked?.summary || firstBlocked?.needs || (activeCount > 0 ? `${activeCount} async subagent${activeCount === 1 ? "" : "s"} active` : undefined);
  return {
    active: activeCount > 0,
    blocked: blockedRows.length > 0,
    activeCount,
    ...(message ? { message } : {}),
    ...(input.rootSessionId ? { rootSessionId: input.rootSessionId } : {}),
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
  };
}

export function readHerdrAsyncSubagentsState(input: Pick<LiveWidgetInput, "store" | "parentRunId" | "rootSessionId" | "records" | "terminalCompletedVisibleMs" | "pidProber" | "renderNow">): HerdrAsyncSubagentsState {
  const now = input.renderNow ?? Date.now();
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 60_000;
  const records = input.records ?? input.store.listActiveOrRecentRuns({ parentRunId: input.parentRunId, rootSessionId: input.rootSessionId });
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
    records,
  });
  const rows = snapshot.rows
    .map((row) => reconcileDeadProcessOwnedLiveRow(input, row, now, terminalCompletedVisibleMs))
    .map((row) => rowWithCurrentResultReady(input, row));
  return deriveHerdrAsyncSubagentsState({ rows, rootSessionId: input.rootSessionId, parentRunId: input.parentRunId });
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

function defaultPidProber(pid: number): PidProbeResult {
  if (!Number.isFinite(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

function processHealth(pid: number | undefined, pidProber: PidProber = defaultPidProber): PidProbeResult {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return "unknown";
  try {
    return pidProber(pid);
  } catch {
    return "unknown";
  }
}

function isCancelRequestRow(row: RunSummaryRow): boolean {
  return row.summary?.startsWith("Cancel requested:") === true;
}

function cancelRequestAtMs(row: RunSummaryRow): number | undefined {
  const rowUpdatedAtMs = Date.parse(row.updatedAt);
  return Number.isFinite(rowUpdatedAtMs) ? rowUpdatedAtMs : undefined;
}

const PROCESS_OWNED_ACTIVE_STATES = new Set(["running", "idle", "stalled"]);

function reconcileDeadProcessOwnedLiveRow(input: LiveWidgetInput, row: RunSummaryRow, now: number, terminalCompletedVisibleMs: number): RunSummaryRow {
  if (isTerminal(row)) return row;

  let status;
  try {
    status = input.store.readStatus(row.runId);
  } catch {
    return row;
  }

  if (TERMINAL_STATES.has(status.state)) return row;

  const health = processHealth(status.pid, input.pidProber);
  const isCancelRequest = isCancelRequestRow(row);
  const cancelAtMs = isCancelRequest ? cancelRequestAtMs(row) : undefined;
  const staleCancelRequest = cancelAtMs !== undefined && now - cancelAtMs > terminalCompletedVisibleMs;

  if (isCancelRequest) {
    if (health !== "dead" || cancelAtMs === undefined || !staleCancelRequest) return row;
  } else if (!PROCESS_OWNED_ACTIVE_STATES.has(status.state) || health !== "dead") {
    return row;
  }

  const finalState = isCancelRequest ? "cancelled" : "failed";
  const summary = isCancelRequest
    ? "Cancelled after recorded child process exited before supervisor finalization"
    : "Failed after recorded child process exited before supervisor finalization";
  const error = {
    code: isCancelRequest ? "PARENT_CANCELLED_PROCESS_EXITED" : "PARENT_PROCESS_EXITED_WITHOUT_TERMINAL_STATUS",
    message: summary,
    details: { pid: status.pid, processHealth: "dead" },
  };

  try {
    input.store.writeStatus({
      ...updateRunStatus(status, {
        state: finalState,
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
      state: finalState,
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
  const records = input.records ?? input.store.listActiveOrRecentRuns(
    { parentRunId: input.parentRunId, rootSessionId: input.rootSessionId },
    { nowMs: now, terminalVisibleMs: terminalCompletedVisibleMs },
  );
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
    nowMs: now,
    completedVisibleMs: terminalCompletedVisibleMs,
    records,
  });
  const rows = snapshot.rows
    .map((row) => reconcileDeadProcessOwnedLiveRow(input, row, now, terminalCompletedVisibleMs))
    .map((row) => rowWithCurrentResultReady(input, row))
    .filter((row) => visible(row, now, terminalCompletedVisibleMs))
    .sort((a, b) => rowPriority(a) - rowPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
  return { rows, totalCost: totalCostForRows(rows) };
}

const TASK_TERMINAL_GRACE_MS = 30_000;

function visibleTasksFor(tasks: TaskRecord[], taskStates: Map<string, DerivedTaskState>, now: number): TaskRecord[] {
  // Keep just-done/failed/cancelled tasks visible briefly so a plan that finishes
  // leaves on-screen evidence instead of vanishing the instant the last task lands.
  // Kept in sync with the same grace in renderers.renderWidgetCard.
  const graceMs = TASK_TERMINAL_GRACE_MS;
  return tasks.filter(t => {
    const state = taskStates.get(t.id) ?? t.status;
    if (state === "done" || state === "failed" || state === "cancelled") {
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
    for (const runId of task.lastAttemptRunIds ?? []) {
      if (runId) runIdToTask.set(runId, task);
    }
  }
  return runIdToTask;
}

function readTasksForSnapshot(input: LiveWidgetInput): TaskRecord[] {
  if (input.tasksEnabled === false || !input.rootSessionId) return [];
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
  const visibleTasks = input.tasksEnabled === false ? [] : visibleTasksFor(tasks, taskStates, now);
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

function hasTimeDependentSnapshotItem(snapshot: LiveWidgetSnapshot, now: number): boolean {
  if (snapshot.rows.length > 0) return true;
  return snapshot.visibleTasks.some((task) => {
    const state = snapshot.taskStates.get(task.id) ?? task.status;
    if (state !== "done" && state !== "failed" && state !== "cancelled") return true;
    const updatedAtMs = Date.parse(task.updatedAt);
    return Number.isFinite(updatedAtMs) && now - updatedAtMs <= TASK_TERMINAL_GRACE_MS;
  });
}

export function hasTimeDependentLiveWidgetItem(input: LiveWidgetInput, now = Date.now()): boolean {
  const snapshot = input.snapshot ?? prepareLiveWidgetSnapshot(input, now);
  const fastTrackArmed = input.fastTrackArmed ?? false;
  return hasVisibleRows(snapshot, fastTrackArmed) && hasTimeDependentSnapshotItem(snapshot, now);
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
  const tasks = input.tasksEnabled === false ? [] : snapshot.visibleTasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: snapshot.taskStates.get(task.id) ?? task.status,
    activeForm: task.activeForm,
    unresolvedDependencyIds: snapshot.taskUnresolvedDependencyIds.get(task.id) ?? [],
  }));
  const taskCounts = input.tasksEnabled === false ? [] : snapshot.tasks.map((task) => [task.id, snapshot.taskStates.get(task.id) ?? task.status]);
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

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

let mountedWidget: LiveWidgetComponent | undefined;
const clearedWidgetContexts = new WeakSet<object>();

function createLiveWidgetComponent(input: LiveWidgetInput, tui: unknown): LiveWidgetComponent {
  const initialNow = input.renderNow ?? Date.now();
  const initialSnapshot = input.snapshot ?? prepareLiveWidgetSnapshot(input, initialNow);
  let currentInput = { ...input, snapshot: initialSnapshot };
  let currentRenderNow = initialNow;
  let currentSignature = liveWidgetRenderSignature(input, initialSnapshot);
  let lastRenderedWidth: number | undefined;
  let lastRenderedLines: string[] | undefined;
  const renderHost = tui as RenderRequester | undefined;
  const component: LiveWidgetComponent = {
    update(nextInput: LiveWidgetInput) {
      const nextNow = nextInput.renderNow ?? Date.now();
      const nextSnapshot = nextInput.snapshot ?? prepareLiveWidgetSnapshot(nextInput, nextNow);
      const nextSignature = liveWidgetRenderSignature(nextInput, nextSnapshot);
      const nextCurrentInput = { ...nextInput, snapshot: nextSnapshot };
      const structurallyChanged = nextSignature !== currentSignature;
      const renderedChanged = !structurallyChanged && lastRenderedWidth !== undefined && lastRenderedLines !== undefined
        ? !sameLines(lastRenderedLines, renderAt(nextCurrentInput, lastRenderedWidth, nextNow))
        : false;

      if (structurallyChanged || renderedChanged) {
        currentSignature = nextSignature;
        currentInput = nextCurrentInput;
        currentRenderNow = nextNow;
        renderHost?.requestRender?.();
      }
    },
    render(width: number) {
      const lines = renderAt(currentInput, width, currentRenderNow);
      lastRenderedWidth = width;
      lastRenderedLines = lines.slice();
      return lines;
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
  const contextObject = typeof ctx === "object" && ctx !== null ? ctx : undefined;
  if (!mountedWidget && contextObject && clearedWidgetContexts.has(contextObject)) return;
  mountedWidget = undefined;
  if (contextObject) clearedWidgetContexts.add(contextObject);
  ui.setWidget("async-subagents-live", undefined, { placement: "belowEditor" });
}

export function updateLiveWidget(ctx: unknown, input: LiveWidgetInput): boolean {
  const ui = (ctx as { ui?: UiSetWidget } | undefined)?.ui;
  if (!ui?.setWidget) return false;
  const now = Date.now();
  const snapshot = input.snapshot ?? prepareLiveWidgetSnapshot(input, now);
  const fastTrackArmed = input.fastTrackArmed ?? (input.rootSessionId ? readFastTrackState(input.store.runRoot, input.rootSessionId).enabled : false);
  const snapshotInput = { ...input, snapshot, fastTrackArmed, renderNow: now };
  const timeDependent = hasVisibleRows(snapshot, fastTrackArmed) && hasTimeDependentSnapshotItem(snapshot, now);
  // Use the precomputed snapshot so the visibility probe stays on the tick/update
  // path and the pi Component.render(width) callback performs no filesystem I/O.
  if (!hasVisibleRows(snapshot, fastTrackArmed)) {
    clearLiveWidget(ctx);
    return false;
  }
  if (mountedWidget) {
    mountedWidget.update?.(snapshotInput);
    return timeDependent;
  }
  if (typeof ctx === "object" && ctx !== null) clearedWidgetContexts.delete(ctx);
  ui.setWidget(
    "async-subagents-live",
    (tui) => {
      mountedWidget = createLiveWidgetComponent(snapshotInput, tui);
      return mountedWidget;
    },
    { placement: "belowEditor" },
  );
  return timeDependent;
}
