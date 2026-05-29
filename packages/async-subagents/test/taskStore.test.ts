import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../src/runStore.js";
import { TaskStore, hashTaskToken, newTaskToken } from "../src/taskStore.js";
import { deriveTaskState } from "../src/taskState.js";

function store() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-tasks-"));
  const runStore = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  return { root, tasks: new TaskStore(runStore), rootSessionId: "root_test", parentRunId: "root_test" };
}

test("TaskStore creates batch tasks with alias dependencies and derived states", () => {
  const s = store();
  const created = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "impl", title: "Implement", description: "Do it" },
    { alias: "review", title: "Review", description: "Check it", dependsOn: ["impl"] },
  ] });
  assert.equal(created.aliasToId.impl, "T-0001");
  assert.equal(created.aliasToId.review, "T-0002");
  assert.ok(existsSync(s.tasks.pathsFor(s.rootSessionId).tasksDir));
  const all = s.tasks.listTasks(s.rootSessionId);
  assert.equal(deriveTaskState(all[0], all), "ready");
  assert.equal(deriveTaskState(all[1], all), "blocked");
});

test("TaskStore rejects dependency cycles", () => {
  const s = store();
  assert.throws(() => s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "a", title: "A", description: "A", dependsOn: ["b"] },
    { alias: "b", title: "B", description: "B", dependsOn: ["a"] },
  ] }), /cycle|CIRCULAR_DEPENDENCY/i);
});

test("TaskStore claim, submit, and accept enforce token ownership", () => {
  const s = store();
  const [task] = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const token = newTaskToken();
  s.tasks.claimTask(s.rootSessionId, task.id, { runId: "run_1", agent: "worker", displayName: "Rex", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
  assert.throws(() => s.tasks.submitResult(s.rootSessionId, task.id, { runId: "run_1", taskToken: "bad", summary: "done" }), /owner|match/i);
  const ready = s.tasks.submitResult(s.rootSessionId, task.id, { runId: "run_1", taskToken: token, summary: "done", receipt: { changedFiles: ["x"] } });
  assert.equal(ready.status, "result_ready");
  assert.ok(ready.result?.receiptPath);
  const accepted = s.tasks.acceptResult(s.rootSessionId, task.id, {});
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.result?.state, "accepted");
});

test("TaskStore force reopen invalidates transitive completed dependents", () => {
  const s = store();
  const created = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "a", title: "A", description: "A" },
    { alias: "b", title: "B", description: "B", dependsOn: ["a"] },
    { alias: "c", title: "C", description: "C", dependsOn: ["b"] },
  ] }).tasks;
  for (const task of created) {
    const token = newTaskToken();
    s.tasks.claimTask(s.rootSessionId, task.id, { runId: `run_${task.id}`, agent: "worker", displayName: "Rex", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
    s.tasks.submitResult(s.rootSessionId, task.id, { runId: `run_${task.id}`, taskToken: token, summary: `done ${task.id}` });
    s.tasks.acceptResult(s.rootSessionId, task.id, {});
  }
  s.tasks.reopenTask(s.rootSessionId, created[0].id, { reason: "bad premise", force: true });
  const reopened = s.tasks.listTasks(s.rootSessionId);
  assert.deepEqual(reopened.map((task) => task.status), ["pending", "pending", "pending"]);
  assert.equal(reopened[1].result?.state, "superseded");
  assert.equal(reopened[2].result?.state, "superseded");
});
