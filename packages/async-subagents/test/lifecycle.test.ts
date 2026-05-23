import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeTerminalRun } from "../src/lifecycle.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-lifecycle-"));
  return { root, runRoot: join(root, ".subagents", "runs") };
}

function assistantLine(cost: number): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
    },
  });
}

test("finalizeTerminalRun extracts assistant cost from the pi session log and writes it to metrics.cost.total", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
  });
  writeFileSync(paths.piSessionPath, [assistantLine(0.05), assistantLine(0.07), assistantLine(0.13)].join("\n") + "\n", "utf8");

  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "scout",
      agentSource: "project",
      definitionPath: join(w.root, ".agents", "scout.md"),
      mode: "oneshot",
      cwd: w.root,
      piSessionPath: paths.piSessionPath,
      state: "running",
    }),
  );

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.ok(result.metrics, "expected metrics on result");
  assert.ok(result.metrics?.cost, "expected metrics.cost on result");
  const total = result.metrics?.cost?.total;
  assert.ok(typeof total === "number");
  assert.ok(Math.abs(total - 0.25) < 1e-9, `expected ~0.25, got ${total}`);

  const status = store.readStatus(runId);
  assert.ok(Math.abs((status.metrics?.cost?.total ?? -1) - 0.25) < 1e-9);
});

test("finalizeTerminalRun leaves metrics undefined when there is no pi session log to read", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
  });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "scout",
      agentSource: "project",
      definitionPath: join(w.root, ".agents", "scout.md"),
      mode: "oneshot",
      cwd: w.root,
      // No piSessionPath wired here, and the JSONL was never written.
      sessionPolicy: "none",
      state: "running",
    }),
  );

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.equal(result.metrics, undefined);
  assert.equal(store.readStatus(runId).metrics, undefined);
});

test("finalizeTerminalRun leaves metrics undefined when the session log has no assistant turns", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
  });
  writeFileSync(paths.piSessionPath, JSON.stringify({ type: "message", message: { role: "user" } }) + "\n", "utf8");
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "scout",
      agentSource: "project",
      definitionPath: join(w.root, ".agents", "scout.md"),
      mode: "oneshot",
      cwd: w.root,
      piSessionPath: paths.piSessionPath,
      state: "running",
    }),
  );

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.equal(result.metrics, undefined);
});

test("finalizeTerminalRun does not charge shared continuation session history", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
    continuedFromRunId: "run_original",
    continuationRootRunId: "run_original",
    continuationSequence: 1,
  });
  writeFileSync(paths.piSessionPath, [assistantLine(0.05), assistantLine(0.07), assistantLine(0.13)].join("\n") + "\n", "utf8");

  const status = createInitialStatus({
    runId,
    parentRunId: "root_test",
    rootSessionId: "root_test",
    agentName: "scout",
    agentSource: "project",
    definitionPath: join(w.root, ".agents", "scout.md"),
    mode: "oneshot",
    cwd: w.root,
    piSessionPath: paths.piSessionPath,
    continuedFromRunId: "run_original",
    continuationRootRunId: "run_original",
    continuationSequence: 1,
    continuationOfPiSessionPath: paths.piSessionPath,
    state: "running",
  });
  store.writeStatus({ ...status, metrics: { tokens: { total: 42 }, cost: { total: 99 } } });

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.equal(result.metrics?.cost, undefined);
  assert.equal(result.metrics?.tokens?.total, 42);
  assert.equal(store.readStatus(runId).metrics?.cost, undefined);
  assert.equal(store.readStatus(runId).metrics?.tokens?.total, 42);
});
