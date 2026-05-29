import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompactionReminder, ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE } from "../extensions/pi/compactionReminder.js";
import { markWakeupHandled } from "../extensions/pi/wakeups.js";
import { createRunResult } from "../src/result.js";
import { RunStore } from "../src/runStore.js";
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
  assert.match(reminder?.content ?? "", /@Alex \(scout\).*running.*subagent_status/);
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
