import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eventIdForSequence } from "../src/ids.js";
import { appendJsonl } from "../src/jsonl.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore, hashTaskToken, newTaskToken } from "../src/taskStore.js";
import { deriveTaskReadiness } from "../src/taskState.js";

function store() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-tasks-"));
  const runStore = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  return { root, tasks: new TaskStore(runStore), rootSessionId: "root_test", parentRunId: "root_test" };
}

test("TaskStore creates parent-owned milestone tasks with alias dependencies and readiness", () => {
  const s = store();
  const created = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "impl", title: "Implement", description: "Do it" },
    { alias: "review", title: "Review", description: "Check it", dependsOn: ["impl"] },
  ] });
  assert.equal(created.aliasToId.impl, "T-0001");
  assert.equal(created.aliasToId.review, "T-0002");
  assert.deepEqual(created.newly_ready.map((task) => task.id), ["T-0001"]);
  assert.ok(existsSync(s.tasks.pathsFor(s.rootSessionId).tasksDir));

  const events = s.tasks.readEvents(s.rootSessionId);
  assert.deepEqual(events.map((event) => [event.sequence, event.eventId, event.type]), [
    [1, "evt_000001", "task.created"],
    [2, "evt_000002", "task.created"],
  ]);
  assert.equal(events.some((event) => event.wake), false);
  assert.equal(Number(readFileSync(s.tasks.pathsFor(s.rootSessionId).eventHighwatermarkPath, "utf8")), 2);

  const all = s.tasks.listTasks(s.rootSessionId);
  assert.equal(deriveTaskReadiness(all[0], all), "ready");
  assert.equal(deriveTaskReadiness(all[1], all), "waiting");
});

test("TaskStore rejects dependency cycles", () => {
  const s = store();
  assert.throws(() => s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "a", title: "A", description: "A", dependsOn: ["b"] },
    { alias: "b", title: "B", description: "B", dependsOn: ["a"] },
  ] }), /cycle|CIRCULAR_DEPENDENCY/i);
});

test("TaskStore removed task token and child-owned lifecycle APIs fail closed", () => {
  const s = store();
  const [task] = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  assert.throws(() => newTaskToken(), /TASK_TOKENS_REMOVED|task tokens were removed/);
  assert.throws(() => hashTaskToken("token"), /TASK_TOKENS_REMOVED|task tokens were removed/);
  assert.equal(s.tasks.readTask(s.rootSessionId, task.id).status, "open");
  assert.throws(() => s.tasks.claimTask(s.rootSessionId, task.id, {}), /TASK_OWNERSHIP_REMOVED|child lifecycle was removed/);
  assert.throws(() => s.tasks.submitResult(s.rootSessionId, task.id, {}), /TASK_CHILD_TOOLS_REMOVED|task_submit_result was removed/);
  assert.throws(() => s.tasks.acceptResult(s.rootSessionId, task.id, {}), /TASK_ACCEPT_REMOVED|task_accept_result was removed/);
  assert.throws(() => s.tasks.reopenTask(s.rootSessionId, task.id, {}), /TASK_REOPEN_REMOVED|task_reopen was removed/);
});

test("TaskStore rejects legacy task state fields instead of leaking them", () => {
  const s = store();
  const [task] = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const taskPath = join(s.tasks.pathsFor(s.rootSessionId).tasksDir, `${task.id}.json`);
  const record = JSON.parse(readFileSync(taskPath, "utf8")) as Record<string, unknown>;
  writeFileSync(taskPath, `${JSON.stringify({ ...record, state: "result_ready" }, null, 2)}\n`, "utf8");

  assert.throws(() => s.tasks.listTaskViews(s.rootSessionId), /TASK_SCHEMA_MIGRATION_REQUIRED|removed task state field/);
});

test("TaskStore update marks milestones done and synchronously returns newly_ready dependents", () => {
  const s = store();
  const created = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "a", title: "A", description: "A" },
    { alias: "b", title: "B", description: "B", dependsOn: ["a"] },
    { alias: "c", title: "C", description: "C", dependsOn: ["b"] },
  ] }).tasks;

  const doneA = s.tasks.updateTask(s.rootSessionId, created[0].id, { status: "done", addAttemptRunIds: ["run_a"], addReceiptPaths: ["receipts/a.json"], addArtifactPaths: ["artifacts/a.txt"], addEvidence: ["tests passed"], appendNotes: "accepted" });
  assert.equal(doneA.task.status, "done");
  assert.equal(doneA.changed, true);
  assert.deepEqual(doneA.newly_ready.map((task) => task.id), [created[1].id]);
  assert.equal(doneA.task.readiness, null);
  assert.deepEqual(doneA.task.lastAttemptRunIds, ["run_a"]);
  assert.deepEqual(doneA.task.receiptPaths, ["receipts/a.json"]);
  assert.deepEqual(doneA.task.artifactPaths, ["artifacts/a.txt"]);
  assert.deepEqual(doneA.task.evidence, ["tests passed"]);

  const all = s.tasks.listTaskViews(s.rootSessionId);
  assert.equal(all[1].readiness, "ready");
  assert.equal(all[2].readiness, "waiting");
});

test("TaskStore force update invalidates active/done downstream milestones when dependencies regress", () => {
  const s = store();
  const created = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "a", title: "A", description: "A" },
    { alias: "b", title: "B", description: "B", dependsOn: ["a"] },
    { alias: "c", title: "C", description: "C", dependsOn: ["b"] },
  ] }).tasks;
  for (const task of created) s.tasks.updateTask(s.rootSessionId, task.id, { status: "done" });

  assert.throws(() => s.tasks.updateTask(s.rootSessionId, created[0].id, { status: "open" }), /TASK_UPDATE_INVALIDATES_DEPENDENTS|invalidate/);
  const reopened = s.tasks.updateTask(s.rootSessionId, created[0].id, { status: "open", force: true, appendNotes: "bad premise" });
  assert.deepEqual(reopened.invalidated?.map((task) => task.id), [created[1].id, created[2].id]);
  assert.deepEqual(s.tasks.listTasks(s.rootSessionId).map((task) => task.status), ["open", "open", "open"]);
  assert.deepEqual(reopened.newly_ready.map((task) => task.id), [created[0].id]);
});

test("TaskStore readEvents supports incremental cursors", () => {
  const s = store();
  const [task] = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const first = s.tasks.readEvents(s.rootSessionId, { eventOffset: 0 });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]?.type, "task.created");

  s.tasks.updateTask(s.rootSessionId, task.id, { status: "active", addAttemptRunIds: ["run_1"] });
  const second = s.tasks.readEvents(s.rootSessionId, first.cursor);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0]?.type, "task.updated");
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

test("TaskStore updateOwnerDisplayName is a no-op compatibility method after task ownership removal", () => {
  const s = store();
  const [task] = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const updated = s.tasks.updateOwnerDisplayName(s.rootSessionId, task.id, "Rex");
  assert.equal(updated.id, task.id);
});

test("TaskStore clearTasks cancels all non-done tasks", () => {
  const s = store();
  const tasks = s.tasks.createTasks(s.rootSessionId, { parentRunId: s.parentRunId, tasks: [
    { alias: "a", title: "A", description: "A" },
    { alias: "b", title: "B", description: "B" },
    { alias: "c", title: "C", description: "C" },
  ] }).tasks;
  s.tasks.updateTask(s.rootSessionId, tasks[0].id, { status: "done" });
  s.tasks.updateTask(s.rootSessionId, tasks[1].id, { status: "active", addAttemptRunIds: ["run_2"] });

  const result = s.tasks.clearTasks(s.rootSessionId, { reason: "cleanup" });
  assert.equal(result.count, 2);
  assert.deepEqual(result.affectedIds, ["T-0002", "T-0003"]);

  const allAfter = s.tasks.listTasks(s.rootSessionId);
  assert.equal(allAfter[0].status, "done");
  assert.equal(allAfter[1].status, "cancelled");
  assert.deepEqual(allAfter[1].lastAttemptRunIds, ["run_2"]);
  assert.equal(allAfter[2].status, "cancelled");
});
