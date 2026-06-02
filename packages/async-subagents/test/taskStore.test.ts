import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eventIdForSequence } from "../src/ids.js";
import { appendJsonl } from "../src/jsonl.js";
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
  const events = s.tasks.readEvents(s.rootSessionId);
  assert.deepEqual(events.map((event) => [event.sequence, event.eventId]), [[1, "evt_000001"], [2, "evt_000002"]]);
  assert.equal(Number(readFileSync(s.tasks.pathsFor(s.rootSessionId).eventHighwatermarkPath, "utf8")), 2);
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

test("TaskStore readEvents supports incremental cursors", () => {
  const s = store();
  const [task] = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const first = s.tasks.readEvents(s.rootSessionId, { eventOffset: 0 });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]?.type, "task.created");

  const token = newTaskToken();
  s.tasks.claimTask(s.rootSessionId, task.id, { runId: "run_1", agent: "worker", displayName: "Rex", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });

  const second = s.tasks.readEvents(s.rootSessionId, first.cursor);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0]?.type, "task.claimed");
  assert.ok(second.cursor.eventOffset > first.cursor.eventOffset);
});

test("TaskStore initializes migrated task-event sequence from existing event count", () => {
  const s = store();
  const paths = s.tasks.pathsFor(s.rootSessionId);
  assert.equal(existsSync(paths.eventHighwatermarkPath), false);
  for (let sequence = 1; sequence <= 2; sequence += 1) {
    appendJsonl(paths.eventsPath, {
      schemaVersion: 1,
      eventId: eventIdForSequence(sequence),
      sequence,
      rootSessionId: s.rootSessionId,
      parentRunId: s.parentRunId,
      taskId: `T-000${sequence}`,
      type: "task.created",
      summary: `legacy ${sequence}`,
      createdAt: new Date().toISOString(),
    });
  }

  s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Migrated next", description: "Do it" }] });

  const events = s.tasks.readEvents(s.rootSessionId);
  assert.deepEqual(events.map((event) => [event.sequence, event.eventId]), [[1, "evt_000001"], [2, "evt_000002"], [3, "evt_000003"]]);
  assert.equal(Number(readFileSync(paths.eventHighwatermarkPath, "utf8")), 3);
});

test("TaskStore recovers invalid task-event highwatermark from max existing sequence", () => {
  for (const corruptValue of ["", "abc"]) {
    const s = store();
    const paths = s.tasks.pathsFor(s.rootSessionId);
    for (const sequence of [1, 3]) {
      appendJsonl(paths.eventsPath, {
        schemaVersion: 1,
        eventId: eventIdForSequence(sequence),
        sequence,
        rootSessionId: s.rootSessionId,
        parentRunId: s.parentRunId,
        taskId: `T-000${sequence}`,
        type: "task.created",
        summary: `legacy ${sequence}`,
        createdAt: new Date().toISOString(),
      });
    }
    writeFileSync(paths.eventHighwatermarkPath, corruptValue, "utf8");

    s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Recovered next", description: "Do it" }] });

    const events = s.tasks.readEvents(s.rootSessionId);
    assert.deepEqual(events.map((event) => [event.sequence, event.eventId]), [[1, "evt_000001"], [3, "evt_000003"], [4, "evt_000004"]]);
    assert.equal(Number(readFileSync(paths.eventHighwatermarkPath, "utf8")), 4);
  }
});

test("TaskStore updateOwnerDisplayName updates owner and attempts displayName", () => {
  const s = store();
  const [task] = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const token = newTaskToken();
  s.tasks.claimTask(s.rootSessionId, task.id, { runId: "run_1", agent: "worker", displayName: "worker", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });

  const updated = s.tasks.updateOwnerDisplayName(s.rootSessionId, task.id, "Rex");
  assert.equal(updated.owner?.displayName, "Rex");
  assert.equal(updated.attempts[0]?.displayName, "Rex");

  const read = s.tasks.readTask(s.rootSessionId, task.id);
  assert.equal(read.owner?.displayName, "Rex");
  assert.equal(read.attempts[0]?.displayName, "Rex");
});

test("TaskStore clearTasks cancels all non-completed tasks", () => {
  const s = store();
  s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "a", title: "A", description: "A" },
    { alias: "b", title: "B", description: "B" },
    { alias: "c", title: "C", description: "C" },
  ] }).tasks;

  // Complete the first task
  const allBefore = s.tasks.listTasks(s.rootSessionId);
  const token = newTaskToken();
  s.tasks.claimTask(s.rootSessionId, allBefore[0].id, { runId: "run_1", agent: "worker", displayName: "worker", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
  s.tasks.submitResult(s.rootSessionId, allBefore[0].id, { runId: "run_1", taskToken: token, summary: "done A" });
  s.tasks.acceptResult(s.rootSessionId, allBefore[0].id, {});

  // Leave the second task actively owned when clearing.
  const token2 = newTaskToken();
  s.tasks.claimTask(s.rootSessionId, allBefore[1].id, { runId: "run_2", agent: "worker", displayName: "worker", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token2) });

  // Clear the tasks
  const result = s.tasks.clearTasks(s.rootSessionId, { reason: "cleanup" });
  assert.equal(result.count, 2);
  assert.deepEqual(result.affectedIds, ["T-0002", "T-0003"]);

  const allAfter = s.tasks.listTasks(s.rootSessionId);
  assert.equal(allAfter[0].status, "completed");
  assert.equal(allAfter[1].status, "cancelled");
  assert.equal(allAfter[1].owner?.runId, "run_2");
  assert.equal(allAfter[1].attempts[0]?.status, "cancelled");
  assert.ok(allAfter[1].attempts[0]?.endedAt);
  assert.equal(allAfter[2].status, "cancelled");
});
