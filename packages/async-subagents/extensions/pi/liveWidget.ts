import { RunStore } from "../../src/runStore.js";
import type { RunIndexRecord, TaskRecord } from "../../src/types.js";
import { readWatcherSnapshot, type RunSummaryRow } from "../../src/watcher.js";
import { renderWidgetCard, widgetRowFromSummary, type WidgetRowInput } from "./renderers.js";
import { isResultWakeupCurrent } from "./wakeups.js";
import { TaskStore } from "../../src/taskStore.js";
import { deriveTaskState } from "../../src/taskState.js";

export interface LiveWidgetInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
  maxRows?: number;
  terminalCompletedVisibleMs?: number;
  records?: RunIndexRecord[];
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
  if (state !== "completed") return true;
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

function buildSnapshot(input: LiveWidgetInput, now: number, terminalCompletedVisibleMs: number): BuildResult {
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
    nowMs: now,
    completedVisibleMs: terminalCompletedVisibleMs,
    records: input.records,
  });
  const rows = snapshot.rows
    .map((row) => rowWithCurrentResultReady(input, row))
    .filter((row) => visible(row, now, terminalCompletedVisibleMs))
    .sort((a, b) => rowPriority(a) - rowPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
  let total = 0;
  let any = false;
  for (const row of rows) {
    const cost = row.metrics?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      total += cost;
      any = true;
    }
  }
  return { rows, totalCost: any ? total : undefined };
}

function renderAt(input: LiveWidgetInput, width: number, now: number): string[] {
  const maxRows = input.maxRows ?? 5;
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 60_000;
  const { rows, totalCost } = buildSnapshot(input, now, terminalCompletedVisibleMs);

  let tasks: TaskRecord[] = [];
  if (input.rootSessionId) {
    try {
      tasks = new TaskStore(input.store).listTasks(input.rootSessionId);
    } catch {
      // safe fallback
    }
  }

  const graceMs = 5_000;
  const visibleTasks = tasks.filter(t => {
    const state = deriveTaskState(t, tasks);
    if (state === "completed" || state === "failed" || state === "cancelled") {
      const updatedAtMs = Date.parse(t.updatedAt);
      if (Number.isFinite(updatedAtMs)) {
        return now - updatedAtMs <= graceMs;
      }
    }
    return true;
  });

  if (!rows.length && !visibleTasks.length) return [];

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

  const widgetRows: WidgetRowInput[] = rows.map((row) => {
    const task = runIdToTask.get(row.runId);
    const baseRow = widgetRowFromSummary(row, now);
    if (task) {
      baseRow.task = {
        id: task.id,
        title: task.title,
        status: deriveTaskState(task, tasks),
        activeForm: task.activeForm
      };
    }
    return baseRow;
  });

  return renderWidgetCard({
    width: clampWidth(width),
    rows: widgetRows,
    maxRows,
    totalCost,
    tasks: visibleTasks,
    allTasks: tasks,
    now
  });
}

function hasVisibleRows(input: LiveWidgetInput, now: number): boolean {
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 60_000;
  const summaries = input.records
    ? input.records.flatMap((record) => input.store.readRunSummary(record.runId) ?? [])
    : input.store.readRunSummaries({ parentRunId: input.parentRunId, rootSessionId: input.rootSessionId });
  for (const summary of summaries) {
    if (visibleState(summary.state, summary.updatedAt, now, terminalCompletedVisibleMs)) return true;
  }
  if (input.rootSessionId) {
    try {
      const taskStore = new TaskStore(input.store);
      const tasks = taskStore.listTasks(input.rootSessionId);
      const graceMs = 5_000;
      const visibleTasks = tasks.filter(t => {
        const state = deriveTaskState(t, tasks);
        if (state === "completed" || state === "failed" || state === "cancelled") {
          const updatedAtMs = Date.parse(t.updatedAt);
          if (Number.isFinite(updatedAtMs)) {
            return now - updatedAtMs <= graceMs;
          }
        }
        return true;
      });
      if (visibleTasks.length > 0) return true;
    } catch {
      // safe fallback
    }
  }
  return false;
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
  const renderHost = tui as RenderRequester | undefined;
  const component: LiveWidgetComponent = {
    update(nextInput: LiveWidgetInput) {
      currentInput = nextInput;
      renderHost?.requestRender?.();
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
  // Cheap status-only probe so we can drop the widget entirely when there's
  // nothing to show — pi keeps showing the previous content otherwise. Avoid a
  // full render probe here because render reads per-run result/events files.
  if (!hasVisibleRows(input, Date.now())) {
    clearLiveWidget(ctx);
    return;
  }
  if (mountedWidget) {
    mountedWidget.update?.(input);
    return;
  }
  ui.setWidget(
    "async-subagents-live",
    (tui) => {
      mountedWidget = createLiveWidgetComponent(input, tui);
      return mountedWidget;
    },
    { placement: "belowEditor" },
  );
}
