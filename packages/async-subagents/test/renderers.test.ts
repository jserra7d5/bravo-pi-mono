import test from "node:test";
import assert from "node:assert/strict";
import { formatRunRow, renderSubagentToolCallComponent, renderSubagentToolResultComponent, renderSubagentWakeMessage, summarizeWaitResult } from "../extensions/pi/renderers.js";
import type { SubagentWaitResult } from "../src/types.js";
import type { RunSummaryRow } from "../src/watcher.js";

test("formatRunRow renders compact result-ready rows", () => {
  const row: RunSummaryRow = {
    runId: "run_test",
    runDir: "/tmp/run_test",
    agentName: "scout",
    state: "completed",
    summary: "Completed a long reconnaissance task with useful findings",
    resultReady: true,
    updatedAt: "2026-05-14T00:00:00.000Z",
  };

  const rendered = formatRunRow(row);
  assert.match(rendered, /scout result/);
  assert.match(rendered, /run_test/);
});

test("tool renderer components implement Pi TUI render contract", () => {
  const call = renderSubagentToolCallComponent({ agent: "worker", task: "fix a bug" });
  assert.equal(typeof call.render, "function");
  assert.match(call.render(80).join("\n"), /worker/);

  const result = renderSubagentToolResultComponent({ details: { summary: "Started worker" } });
  assert.equal(typeof result.render, "function");
  assert.match(result.render(80).join("\n"), /Started worker/);
});

test("wait and wake-up renderers keep summaries concise", () => {
  const waited: SubagentWaitResult = {
    state: "ready",
    mode: "race",
    readyRunIds: ["run_a"],
    events: [],
    results: [],
    statuses: [],
    cursors: {},
    remainingRunIds: [],
    timedOut: false,
    next: [],
  };

  assert.equal(summarizeWaitResult(waited), "Subagent wait: 1 ready");
  assert.match(
    renderSubagentWakeMessage({
      kind: "subagent_wakeup",
      title: "Subagent result: scout",
      runId: "run_a",
      state: "completed",
      summary: "Done",
    }),
    /Subagent result: scout/,
  );
});
