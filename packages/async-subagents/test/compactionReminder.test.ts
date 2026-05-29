import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompactionReminder, ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE } from "../extensions/pi/compactionReminder.js";
import { markWakeupHandled } from "../extensions/pi/wakeups.js";
import { createRunResult } from "../src/result.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore } from "../src/taskStore.js";
import { createInitialStatus } from "../src/status.js";
import type { RunState } from "../src/types.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-compact-"));
  return { root, store: new RunStore({ cwd: root }), parentRunId: "root_compact" };
}

function addRun(input: { store: RunStore; root: string; parentRunId: string; displayName?: string; agentName?: string; state: RunState; summary?: string; resultReady?: boolean }) {
  const agentName = input.agentName ?? "scout";
  const { runId } = input.store.createRunDirectory({ cwd: input.root, parentRunId: input.parentRunId, rootSessionId: input.parentRunId });
  const status = createInitialStatus({
    runId,
    parentRunId: input.parentRunId,
    rootSessionId: input.parentRunId,
    displayName: input.displayName,
    agentName,
    agentSource: "builtin",
    definitionPath: `/builtin/${agentName}.md`,
    mode: "oneshot",
    cwd: input.root,
    state: input.state,
  });
  input.store.writeStatus({
    ...status,
    summary: input.summary,
    resultReady: input.resultReady ?? false,
  });
  return runId;
}

test("compaction reminder is omitted when no async runs need attention", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Done", state: "completed", summary: "already handled" });

  assert.equal(buildCompactionReminder({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId }), undefined);
});

test("compaction reminder preserves active, blocked, and result-ready subagent state", () => {
  const w = workspace();
  const running = addRun({ ...w, displayName: "Alex", state: "running", summary: "auditing hooks" });
  const blocked = addRun({ ...w, displayName: "Rex", state: "blocked", summary: "needs file scope" });
  const completed = addRun({ ...w, displayName: "Mira", state: "completed", summary: "review done", resultReady: true });
  w.store.writeResult(createRunResult({ runId: completed, parentRunId: w.parentRunId, agentName: "scout", displayName: "Mira", state: "completed", summary: "review done" }));

  const reminder = buildCompactionReminder({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId });

  assert.equal(reminder?.customType, ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE);
  assert.equal(reminder?.display, true);
  assert.match(reminder?.content ?? "", /Async subagent status preserved after compaction/);
  assert.match(reminder?.content ?? "", new RegExp(running));
  assert.match(reminder?.content ?? "", /@Alex \(scout\).*running.*no per-row action/);
  assert.match(reminder?.content ?? "", /one subagent_status call is appropriate/);
  assert.match(reminder?.content ?? "", /do not loop on status/);
  assert.doesNotMatch(reminder?.content ?? "", /subagent_wait/);
  assert.match(reminder?.content ?? "", new RegExp(blocked));
  assert.match(reminder?.content ?? "", /@Rex \(scout\).*blocked.*subagent_message/);
  assert.match(reminder?.content ?? "", new RegExp(completed));
  assert.match(reminder?.content ?? "", /@Mira \(scout\).*completed.*subagent_result/);
  assert.equal(reminder?.details.active, 1);
  assert.equal(reminder?.details.waiting, 1);
  assert.equal(reminder?.details.resultReady, 1);
  assert.equal(reminder?.details.rows.length, 3);
});

test("compaction reminder omits terminal results after they are collected", () => {
  const w = workspace();
  const completed = addRun({ ...w, displayName: "Mira", state: "completed", summary: "review done", resultReady: true });
  w.store.writeResult(createRunResult({ runId: completed, parentRunId: w.parentRunId, agentName: "scout", displayName: "Mira", state: "completed", summary: "review done" }));

  markWakeupHandled(w.store, w.parentRunId, completed);

  assert.equal(buildCompactionReminder({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId }), undefined);
});

test("compaction reminder includes task counts in text and details", () => {
  const w = workspace();
  const taskStore = new TaskStore(w.store);

  // Create tasks: one ready, one blocked
  taskStore.createTasks(w.parentRunId, {
    parentRunId: w.parentRunId,
    tasks: [
      { alias: "t1", title: "Task One", description: "Desc 1" },
      { alias: "t2", title: "Task Two", description: "Desc 2", dependsOn: ["t1"] }
    ]
  });

  // Add one active subagent run to force compaction reminder to display (needsReminder must be true)
  addRun({ ...w, displayName: "Worker", state: "running", summary: "working" });

  const reminder = buildCompactionReminder({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  assert.ok(reminder);
  assert.match(reminder.content, /Tasks: 1 ready/);
  assert.match(reminder.content, /1 blocked/);

  const tc = reminder.details.taskCounts;
  assert.ok(tc);
  assert.equal(tc.ready, 1);
  assert.equal(tc.blocked, 1);
  assert.equal(tc.resultReady, 0);
  assert.equal(tc.running, 0);
});
