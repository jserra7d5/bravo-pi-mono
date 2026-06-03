import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderLiveWidget, updateLiveWidget } from "../extensions/pi/liveWidget.js";
import { markWakeupHandled } from "../extensions/pi/wakeups.js";
import { visWidth } from "../extensions/pi/renderers.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore } from "../src/taskStore.js";
import { resetTaskStateDerivationStatsForTest, taskStateDerivationStatsForTest } from "../src/taskState.js";
import { createRunResult } from "../src/result.js";
import { createInitialStatus } from "../src/status.js";
import { createRunEvent } from "../src/events.js";
import type { RunMetrics, RunState } from "../src/types.js";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function withFakeNow<T>(nowMs: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-live-"));
  return { root, store: new RunStore({ cwd: root }), parentRunId: "root_live" };
}

function addRun(input: { store: RunStore; root: string; parentRunId: string; displayName: string; state: RunState; summary: string; updatedAt?: string; metrics?: RunMetrics; pid?: number; processHealth?: "unknown" | "alive" | "dead" }) {
  const { runId } = input.store.createRunDirectory({ cwd: input.root, parentRunId: input.parentRunId, rootSessionId: input.parentRunId });
  const status = createInitialStatus({
    runId,
    parentRunId: input.parentRunId,
    rootSessionId: input.parentRunId,
    displayName: input.displayName,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd: input.root,
    state: input.state,
  });
  input.store.writeStatus({
    ...status,
    summary: input.summary,
    resultReady: input.state === "completed",
    updatedAt: input.updatedAt ?? status.updatedAt,
    lastActivityAt: input.updatedAt ?? status.updatedAt,
    pid: input.pid,
    processHealth: input.processHealth,
    ...(input.metrics ? { metrics: input.metrics } : {}),
  });
  return runId;
}

test("live widget renders the chrome card with header, rows, and +N tail", () => {
  const w = workspace();
  addRun({ ...w, displayName: "OldDone", state: "completed", summary: "old completed", updatedAt: isoAgo(10 * 60_000) });
  addRun({ ...w, displayName: "Done", state: "completed", summary: "recent completed", updatedAt: isoAgo(5_000) });
  addRun({ ...w, displayName: "Work1", state: "running", summary: "running one" });
  addRun({ ...w, displayName: "Wait", state: "waiting_for_input", summary: "needs input" });
  addRun({ ...w, displayName: "Work3", state: "queued", summary: "queued" });
  addRun({ ...w, displayName: "Work4", state: "blocked", summary: "blocked" });
  addRun({ ...w, displayName: "Stopped", state: "cancelled", summary: "cancelled", updatedAt: isoAgo(60_000) });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, maxRows: 5, terminalCompletedVisibleMs: 5 * 60_000, width: 72 });
  const body = lines.map(stripAnsi).join("\n");

  // top border + 5 rows + +N tail + bot border = 8
  assert.equal(lines.length, 8);
  assert.ok(body.includes("subagents"));
  assert.ok(!body.includes("OldDone"));
  assert.ok(body.includes("@Done"));
  assert.ok(body.match(/\+1 more/));
});

test("live widget header omits empty count groups", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  const header = stripAnsi(lines[0]);
  assert.ok(header.includes("1 active"));
  assert.ok(!header.includes("need you"));
  assert.ok(!header.includes("ready"));
});

test("live widget shows the need-you count when an urgent run is present", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });
  addRun({ ...w, displayName: "Pat", state: "waiting_for_input", summary: "creds?" });
  addRun({ ...w, displayName: "Sam", state: "completed", summary: "done" });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  const header = stripAnsi(lines[0]);
  assert.ok(header.includes("active"));
  assert.ok(header.includes("1 need you"));
  assert.ok(header.includes("1 ready"));
});

test("live widget does not count collected completed results as ready", () => {
  const w = workspace();
  const runId = addRun({ ...w, displayName: "Sam", state: "completed", summary: "done" });
  w.store.writeResult(createRunResult({ runId, parentRunId: w.parentRunId, agentName: "scout", displayName: "Sam", state: "completed", summary: "done" }));
  markWakeupHandled(w.store, w.parentRunId, runId);

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  const body = lines.map(stripAnsi).join("\n");
  assert.ok(body.includes("@Sam"));
  assert.ok(!stripAnsi(lines[0]).includes("ready"));
});

test("live widget chrome holds a constant width across all rendered lines", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });
  addRun({ ...w, displayName: "Pat", state: "waiting_for_input", summary: "creds?" });

  for (const width of [72, 56, 44, 32]) {
    const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width });
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      assert.equal(visWidth(line), width, `expected ${width} at "${stripAnsi(line)}"`);
    }
  }
});

test("live widget returns no lines when no rows are visible", () => {
  const w = workspace();
  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  assert.deepEqual(lines, []);
});

test("live widget hides terminal runs older than the default one minute horizon", () => {
  for (const state of ["completed", "failed", "cancelled", "expired"] as const) {
    const w = workspace();
    addRun({ ...w, displayName: `Old-${state}`, state, summary: `old ${state}`, updatedAt: isoAgo(61_000) });

    const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
    assert.deepEqual(lines, [], `expected old ${state} run to be hidden`);
  }
});

test("live widget honors an explicit longer completed visibility horizon", () => {
  const w = workspace();
  addRun({ ...w, displayName: "OldDone", state: "completed", summary: "old completed", updatedAt: isoAgo(61_000) });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, terminalCompletedVisibleMs: 5 * 60_000, width: 72 });
  const body = lines.map(stripAnsi).join("\n");
  assert.ok(body.includes("@OldDone"));
});

test("live widget reconciles old dead cancel-request rows so they do not remain active", () => {
  const w = workspace();
  const old = isoAgo(10 * 60_000);
  const runId = addRun({
    ...w,
    displayName: "Harper",
    state: "running",
    summary: "Cancel requested: User pivoted to no-edit planning",
    updatedAt: old,
    pid: 999_999_999,
    processHealth: "alive",
  });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  assert.deepEqual(lines, []);

  const status = w.store.readStatus(runId);
  assert.equal(status.state, "cancelled");
  assert.equal(status.processHealth, "dead");
  assert.equal(status.resultReady, false);
  assert.equal(status.updatedAt, old);
  assert.equal(w.store.readResult(runId), undefined);
});

test("live widget does not finalize non-cancel dead-pid rows from the render path", () => {
  const w = workspace();
  const old = isoAgo(10 * 60_000);
  const runId = addRun({
    ...w,
    displayName: "Alex",
    state: "running",
    summary: "working",
    updatedAt: old,
    pid: 999_999_999,
    processHealth: "alive",
  });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  const body = lines.map(stripAnsi).join("\n");
  assert.ok(body.includes("@Alex"));

  const status = w.store.readStatus(runId);
  assert.equal(status.state, "running");
  assert.equal(status.resultReady, false);
  assert.equal(w.store.readResult(runId), undefined);
});

test("live widget leaves recent dead cancel requests for the supervisor to finalize", () => {
  const w = workspace();
  const oldStatusTime = isoAgo(10 * 60_000);
  const runId = addRun({
    ...w,
    displayName: "FreshCancel",
    state: "running",
    summary: "working before cancel",
    updatedAt: oldStatusTime,
    pid: 999_999_999,
    processHealth: "alive",
  });
  w.store.appendEvent(runId, createRunEvent({
    sequence: 2,
    runId,
    parentRunId: w.parentRunId,
    type: "status",
    summary: "Cancel requested: recent pivot",
    wake: false,
    data: { action: "cancel" }
  }));

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  const body = lines.map(stripAnsi).join("\n");
  assert.ok(body.includes("@FreshCancel"));

  const status = w.store.readStatus(runId);
  assert.equal(status.state, "running");
  assert.equal(status.resultReady, false);
  assert.equal(status.updatedAt, oldStatusTime);
  assert.equal(w.store.readResult(runId), undefined);
});

test("live widget header sums cost across mixed terminal + active rows", () => {
  const w = workspace();
  // Terminal run with cost on status (mirrors what finalizeTerminalRun writes).
  addRun({ ...w, displayName: "Done1", state: "completed", summary: "finished",
    updatedAt: isoAgo(30_000), metrics: { cost: { total: 0.18 } } });
  // Active run with cost on status (mid-flight runs also carry incremental cost).
  addRun({ ...w, displayName: "Work1", state: "running", summary: "in progress",
    metrics: { cost: { total: 0.24 } } });
  // Active run with no cost — should contribute zero, not break the sum.
  addRun({ ...w, displayName: "Work2", state: "running", summary: "no cost yet" });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  const header = stripAnsi(lines[0]);
  assert.ok(header.includes("$0.420 total"), `expected $0.420 total in header: "${header}"`);
});

test("live widget header omits the cost segment when every row is below the threshold", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Tiny", state: "running", summary: "barely started",
    metrics: { cost: { total: 0.002 } } });
  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  assert.ok(!stripAnsi(lines[0]).includes("total"));
});

test("live widget header drops cost first when the badge cannot fit at narrow widths", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Work1", state: "running", summary: "working",
    metrics: { cost: { total: 1.5 } } });
  addRun({ ...w, displayName: "Wait", state: "waiting_for_input", summary: "creds?" });
  addRun({ ...w, displayName: "Done", state: "completed", summary: "done", updatedAt: isoAgo(5_000) });

  // At width 32 the active/needs/ready counts already saturate the title bar;
  // the cost segment is the lowest priority piece and must drop entirely.
  const narrow = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 32 });
  const narrowHeader = stripAnsi(narrow[0]);
  assert.ok(!narrowHeader.includes("$1.50"), `narrow header still has cost: "${narrowHeader}"`);
  // At width 72 there's plenty of room — the cost segment must come back.
  const wide = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  assert.ok(stripAnsi(wide[0]).includes("$1.50 total"));
});

test("updateLiveWidget passes a component factory that renders at the width pi provides, not process.stdout.columns", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });
  addRun({ ...w, displayName: "Pat", state: "waiting_for_input", summary: "creds?" });

  type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };
  let captured: WidgetFactory | undefined;
  const ctx = {
    ui: {
      setWidget(_key: string, value: unknown) {
        if (typeof value === "function") captured = value as WidgetFactory;
      },
    },
  };

  updateLiveWidget(ctx, { store: w.store, parentRunId: w.parentRunId });
  assert.ok(captured, "expected setWidget to receive a factory function");

  const component = captured!(undefined, undefined);
  for (const width of [30, 40, 50, 60, 72, 96]) {
    const lines = component.render(width);
    assert.ok(lines.length >= 3, `expected chrome at width ${width}`);
    for (const line of lines) {
      assert.equal(visWidth(line), width, `width ${width} mismatch at "${stripAnsi(line)}"`);
    }
  }
});

test("live widget component render uses the precomputed task snapshot", () => {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const w = workspace();
  const taskStore = new TaskStore(w.store);
  taskStore.createTasks(w.parentRunId, {
    parentRunId: w.parentRunId,
    tasks: [{ alias: "t1", title: "Task 1", description: "First" }]
  });
  const runId = addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });

  type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };
  let captured: WidgetFactory | undefined;
  const ctx = {
    ui: {
      setWidget(_key: string, value: unknown) {
        if (typeof value === "function") captured = value as WidgetFactory;
      },
    },
  };

  updateLiveWidget(ctx, { store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  assert.ok(captured, "expected setWidget to receive a factory function");
  const component = captured!(undefined, undefined);
  rmSync(taskStore.pathsFor(w.parentRunId).tasksDir, { recursive: true, force: true });
  rmSync(w.store.pathsFor({ runId }).runDir, { recursive: true, force: true });
  w.store.readRunSummaries = (() => { throw new Error("render must not read run summaries"); }) as RunStore["readRunSummaries"];
  w.store.readRunSummary = (() => { throw new Error("render must not read run summary"); }) as RunStore["readRunSummary"];
  w.store.readResult = (() => { throw new Error("render must not read run result"); }) as RunStore["readResult"];

  const body = component.render(72).map(stripAnsi).join("\n");
  assert.ok(body.includes("Task 1"), "render should use the task data captured during update");
});

test("live widget task snapshot uses non-blocking reconcile", () => {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const w = workspace();
  const taskStore = new TaskStore(w.store);
  taskStore.createTasks(w.parentRunId, {
    parentRunId: w.parentRunId,
    tasks: [{ alias: "t1", title: "Task 1", description: "First" }]
  });
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });

  const original = TaskStore.prototype.listTasks;
  const reconcileValues: Array<boolean | "nonblocking" | undefined> = [];
  TaskStore.prototype.listTasks = function(this: TaskStore, rootSessionId, options) {
    reconcileValues.push(options?.reconcile);
    return original.call(this, rootSessionId, options);
  } as TaskStore["listTasks"];
  try {
    updateLiveWidget({ ui: { setWidget() {} } }, { store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  } finally {
    TaskStore.prototype.listTasks = original;
  }
  assert.deepEqual(reconcileValues, ["nonblocking"]);
});

test("live widget non-blocking reconcile detects terminal owner runs", () => {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const w = workspace();
  const taskStore = new TaskStore(w.store);
  const created = taskStore.createTasks(w.parentRunId, {
    parentRunId: w.parentRunId,
    tasks: [{ alias: "t1", title: "Task 1", description: "First" }]
  });
  const taskId = created.aliasToId["t1"];
  const runId = addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });
  taskStore.claimTask(w.parentRunId, taskId, {
    runId,
    agent: "worker",
    displayName: "Rex",
    assignedAt: new Date().toISOString(),
    tokenHash: "hash"
  });
  w.store.writeStatus({ ...w.store.readStatus(runId), state: "failed", summary: "failed", updatedAt: new Date().toISOString() });

  updateLiveWidget({ ui: { setWidget() {} } }, { store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId });

  const [task] = taskStore.listTasks(w.parentRunId, { reconcile: false });
  assert.equal(task.status, "failed");
  assert.ok(taskStore.readEvents(w.parentRunId).some((event) => event.type === "task.failed" && event.taskId === taskId && event.wake === true));
});

test("live widget non-blocking reconcile skips contended task locks without sleeping", () => {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const w = workspace();
  const taskStore = new TaskStore(w.store);
  const created = taskStore.createTasks(w.parentRunId, {
    parentRunId: w.parentRunId,
    tasks: [{ alias: "t1", title: "Task 1", description: "First" }]
  });
  const taskId = created.aliasToId["t1"];
  const runId = addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });
  taskStore.claimTask(w.parentRunId, taskId, {
    runId,
    agent: "worker",
    displayName: "Rex",
    assignedAt: new Date().toISOString(),
    tokenHash: "hash"
  });
  w.store.writeStatus({ ...w.store.readStatus(runId), state: "failed", summary: "failed", updatedAt: new Date().toISOString() });

  const paths = taskStore.pathsFor(w.parentRunId);
  mkdirSync(paths.lockDir, { recursive: true });
  writeFileSync(join(paths.lockDir, "held.json"), JSON.stringify({ pid: process.pid, host: "other-host", createdAt: new Date().toISOString() }), "utf8");

  const originalWait = Atomics.wait;
  Atomics.wait = (() => { throw new Error("non-blocking reconcile must not sleep"); }) as typeof Atomics.wait;
  try {
    updateLiveWidget({ ui: { setWidget() {} } }, { store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  } finally {
    Atomics.wait = originalWait;
    rmSync(paths.lockDir, { recursive: true, force: true });
  }

  const [task] = taskStore.listTasks(w.parentRunId, { reconcile: false });
  assert.equal(task.status, "running");
});

test("live widget precomputes task states once per snapshot and reuses them on render", () => {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const w = workspace();
  const taskStore = new TaskStore(w.store);
  taskStore.createTasks(w.parentRunId, {
    parentRunId: w.parentRunId,
    tasks: Array.from({ length: 80 }, (_, index) => ({
      alias: `t${index}`,
      title: `Task ${index}`,
      description: `Task ${index}`,
      dependsOn: index === 0 ? [] : [`t${index - 1}`]
    }))
  });
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });

  type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };
  let captured: WidgetFactory | undefined;
  const ctx = { ui: { setWidget(_key: string, value: unknown) { if (typeof value === "function") captured = value as WidgetFactory; } } };

  resetTaskStateDerivationStatsForTest();
  updateLiveWidget(ctx, { store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  assert.ok(captured, "expected setWidget to receive a factory function");
  assert.deepEqual(taskStateDerivationStatsForTest(), { deriveTaskState: 0, deriveTaskStates: 1 });

  const component = captured!(undefined, undefined);
  component.render(72);
  component.render(72);
  assert.deepEqual(taskStateDerivationStatsForTest(), { deriveTaskState: 0, deriveTaskStates: 1 });
});

test("updateLiveWidget keeps pi TUI as this when requesting render after an update", () => {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const w = workspace();
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });

  type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void; update?(input: Parameters<typeof updateLiveWidget>[1]): void };
  let captured: WidgetFactory | undefined;
  const ctx = {
    ui: {
      setWidget(_key: string, value: unknown) {
        if (typeof value === "function") captured = value as WidgetFactory;
      },
    },
  };

  updateLiveWidget(ctx, { store: w.store, parentRunId: w.parentRunId });
  assert.ok(captured, "expected setWidget to receive a factory function");

  let renders = 0;
  const tui = {
    renderRequested: false,
    requestRender() {
      assert.equal(this, tui);
      this.renderRequested = true;
      renders += 1;
    },
  };
  const component = captured!(tui, undefined);
  const [run] = w.store.readRunSummaries({ parentRunId: w.parentRunId });
  w.store.writeStatus({ ...w.store.readStatus(run.runId), summary: "changed work", updatedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() });
  component.update?.({ store: w.store, parentRunId: w.parentRunId });

  assert.equal(renders, 1);
  assert.equal(tui.renderRequested, true);
});

test("updateLiveWidget suppresses render requests for age-only polling changes", () => {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const baseNow = Date.parse("2026-01-01T00:00:00.000Z");
  const w = workspace();
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working", updatedAt: new Date(baseNow - 10_000).toISOString() });

  type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void; update?(input: Parameters<typeof updateLiveWidget>[1]): void };
  let captured: WidgetFactory | undefined;
  const ctx = { ui: { setWidget(_key: string, value: unknown) { if (typeof value === "function") captured = value as WidgetFactory; } } };

  withFakeNow(baseNow, () => {
    updateLiveWidget(ctx, { store: w.store, parentRunId: w.parentRunId });
  });
  assert.ok(captured, "expected setWidget to receive a factory function");

  let renders = 0;
  const component = captured!({ requestRender() { renders += 1; } }, undefined);
  withFakeNow(baseNow + 2_000, () => {
    component.update?.({ store: w.store, parentRunId: w.parentRunId });
  });

  assert.equal(renders, 0);
});

function terminalRunExpiryRenderTest(): void {
  const empty = workspace();
  updateLiveWidget({ ui: { setWidget() {} } }, { store: empty.store, parentRunId: empty.parentRunId });

  const baseNow = Date.parse("2026-01-01T00:00:00.000Z");
  const w = workspace();
  addRun({ ...w, displayName: "Done", state: "completed", summary: "done", updatedAt: new Date(baseNow - 59_000).toISOString() });
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working", updatedAt: new Date(baseNow - 10_000).toISOString() });

  type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void; update?(input: Parameters<typeof updateLiveWidget>[1]): void };
  let captured: WidgetFactory | undefined;
  const ctx = { ui: { setWidget(_key: string, value: unknown) { if (typeof value === "function") captured = value as WidgetFactory; } } };

  withFakeNow(baseNow, () => {
    updateLiveWidget(ctx, { store: w.store, parentRunId: w.parentRunId });
  });
  assert.ok(captured, "expected setWidget to receive a factory function");

  let renders = 0;
  const component = captured!({ requestRender() { renders += 1; } }, undefined);
  withFakeNow(baseNow + 2_000, () => {
    component.update?.({ store: w.store, parentRunId: w.parentRunId });
  });

  assert.equal(renders, 1);
}

test("updateLiveWidget requests render when terminal row expires while other rows remain", terminalRunExpiryRenderTest);

test("updateLiveWidget clears the widget when there are no visible rows", () => {
  const w = workspace();
  const calls: Array<{ value: unknown }> = [];
  const ctx = {
    ui: {
      setWidget(_key: string, value: unknown) {
        calls.push({ value });
      },
    },
  };
  updateLiveWidget(ctx, { store: w.store, parentRunId: w.parentRunId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, undefined);
});

test("live widget renders task summary and maps task to run rows", () => {
  const w = workspace();
  const taskStore = new TaskStore(w.store);
  const result = taskStore.createTasks(w.parentRunId, {
    parentRunId: w.parentRunId,
    tasks: [
      { alias: "t1", title: "Task 1", description: "First" },
      { alias: "t2", title: "Task 2", description: "Second", dependsOn: ["t1"] }
    ]
  });

  const t1Id = result.aliasToId["t1"];

  const runId = addRun({
    ...w,
    displayName: "Rex",
    state: "running",
    summary: "working on task 1"
  });

  taskStore.claimTask(w.parentRunId, t1Id, {
    runId,
    agent: "worker",
    displayName: "Rex",
    assignedAt: new Date().toISOString(),
    tokenHash: "somehash"
  });

  const lines = renderLiveWidget({
    store: w.store,
    parentRunId: w.parentRunId,
    rootSessionId: w.parentRunId,
    width: 72
  });

  const body = lines.map(stripAnsi).join("\n");
  assert.ok(body.includes("T-0001 Task 1"), "run row shows mapped task info");
  assert.ok(body.includes("Tasks"), "bottom section shows Tasks");
  assert.ok(body.includes("T-0002 Task 2"), "bottom section shows pending/blocked task");
});
