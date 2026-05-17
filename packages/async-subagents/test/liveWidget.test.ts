import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderLiveWidget, updateLiveWidget } from "../extensions/pi/liveWidget.js";
import { visWidth } from "../extensions/pi/renderers.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import type { RunMetrics, RunState } from "../src/types.js";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-live-"));
  return { root, store: new RunStore({ cwd: root }), parentRunId: "root_live" };
}

function addRun(input: { store: RunStore; root: string; parentRunId: string; displayName: string; state: RunState; summary: string; updatedAt?: string; metrics?: RunMetrics }) {
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
