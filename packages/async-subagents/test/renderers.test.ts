import test from "node:test";
import assert from "node:assert/strict";
import { formatRunRow, renderSubagentToolCallComponent, renderSubagentToolResultComponent, renderSubagentWakeMessage, summarizeWaitResult } from "../extensions/pi/renderers.js";
import type { SubagentWaitResult } from "../src/types.js";
import type { RunSummaryRow } from "../src/watcher.js";

test("formatRunRow renders compact result-ready rows", () => {
  const row: RunSummaryRow = {
    runId: "run_test",
    runDir: "/tmp/run_test",
    displayName: "Rex",
    agentName: "scout",
    state: "completed",
    summary: "Completed a long reconnaissance task with useful findings",
    resultReady: true,
    updatedAt: "2026-05-14T00:00:00.000Z",
  };

  const rendered = formatRunRow(row);
  assert.match(rendered, /@Rex scout done/);
  assert.doesNotMatch(rendered, /run_test/);
});

test("tool renderer components implement Pi TUI render contract", () => {
  const call = renderSubagentToolCallComponent({ agent: "worker", task: "fix a bug" });
  assert.equal(typeof call.render, "function");
  assert.match(call.render(80).join("\n"), /worker/);

  const defaultCall = renderSubagentToolCallComponent({});
  assert.equal(defaultCall.render(80).join("\n"), "subagents");

  const result = renderSubagentToolResultComponent({ details: { summary: "Started worker" } });
  assert.equal(typeof result.render, "function");
  assert.match(result.render(80).join("\n"), /Started worker/);
});

test("tool result renderer shows terminal bodies in expanded mode", () => {
  const compact = renderSubagentToolResultComponent({ details: { summary: "Subagent run_a result: completed", body: "Full reviewer findings" } });
  assert.doesNotMatch(compact.render(100).join("\n"), /Full reviewer findings/);

  const direct = renderSubagentToolResultComponent(
    { details: { summary: "Subagent run_a result: completed", body: "Full reviewer findings" } },
    { expanded: true },
  );

  assert.match(direct.render(100).join("\n"), /Full reviewer findings/);

  const waited = renderSubagentToolResultComponent(
    {
      details: {
        summary: "Subagent wait: 1 ready, 1 result",
        results: [{ runId: "run_a", displayName: "Fives", agentName: "reviewer", body: "Reviewer found path safety gaps" }],
      },
    },
    { expanded: true },
  );

  const rendered = waited.render(100).join("\n");
  assert.match(rendered, /@Fives reviewer:/);
  assert.match(rendered, /Reviewer found path safety gaps/);
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

test("result summaries do not duplicate agent name when displayName is missing", () => {
  const waited: SubagentWaitResult = {
    state: "ready",
    mode: "race",
    readyRunIds: ["run_a"],
    events: [],
    results: [
      {
        schemaVersion: 1,
        runId: "run_a",
        parentRunId: "root_a",
        agentName: "scout",
        contextPolicy: "fresh",
        sessionPolicy: "record",
        state: "completed",
        success: true,
        createdAt: "2026-05-14T00:00:01.000Z",
        durationMs: 1000,
        summary: "Done",
        body: "Done",
        artifacts: [],
        error: null,
      },
    ],
    statuses: [],
    cursors: {},
    remainingRunIds: [],
    timedOut: false,
    next: [],
  };

  assert.match(summarizeWaitResult(waited), /scout done/);
  assert.doesNotMatch(summarizeWaitResult(waited), /scout scout/);
});
