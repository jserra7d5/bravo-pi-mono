import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireRootSessionLease } from "../src/leases.js";
import { createRunResult } from "../src/result.js";
import { jsonlReadStatsForTest, resetJsonlReadStatsForTest } from "../src/jsonl.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { TaskStore, hashTaskToken, newTaskToken } from "../src/taskStore.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { pollWakeups, markWakeupHandled, markDeliveredWakeupHandled, isWakeupKeyHandled, writeDeliverySubscription, resultDeliveryKey, deliveryCacheStatsForTest, resetDeliveryCacheStatsForTest } from "../extensions/pi/wakeups.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-wakeups-"));
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  return { root, store };
}

function deliveryStatePath(store: RunStore, parentRunId: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", `${parentRunId}.json`);
}

function createCompletedRun(store: RunStore, cwd: string, parentRunId: string, updatedAt?: string): string {
  const { runId } = store.createRunDirectory({ cwd, parentRunId, rootSessionId: parentRunId });
  const status = createInitialStatus({
    runId,
    parentRunId,
    rootSessionId: parentRunId,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd,
    state: "completed",
  });
  store.writeStatus({
    ...status,
    resultReady: true,
    updatedAt: updatedAt ?? status.updatedAt,
    lastActivityAt: updatedAt ?? status.lastActivityAt,
  });
  store.writeResult(createRunResult({ runId, parentRunId, agentName: "scout", state: "completed", summary: "Done" }));
  writeDeliverySubscription(store, {
    schemaVersion: SCHEMA_VERSION,
    parentRunId,
    runId,
    notifyOn: ["result", "completed", "failed", "cancelled", "expired"],
    createdAt: new Date().toISOString(),
  });
  return runId;
}

test("pollWakeups requires the owner lease and dedupes terminal results", () => {
  const { root, store } = workspace();
  const runId = createCompletedRun(store, root, "root_test");
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_test", ownerId: "owner_a", ttlMs: 10_000 });

  const first = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.runId, runId);
  assert.match(first[0]?.deliveryKey ?? "", /^terminal:/);
  assert.equal(first[0]?.message.result?.body, undefined);
  assert.equal(first[0]?.message.body, undefined);

  const second = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" });
  assert.equal(second.length, 0);

  const stale = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_b" });
  assert.equal(stale.length, 0);
});

test("pollWakeups does not parse unchanged delivery state in steady state", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const runId = createCompletedRun(store, root, parentRunId);
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const first = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.runId, runId);

  const warm = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(warm.length, 0);

  resetDeliveryCacheStatsForTest();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" }).length, 0);
  }
  assert.deepEqual(deliveryCacheStatsForTest(), { deliveryStateParses: 0, subscriptionParses: 0 });
});

test("delivery state cache observes external writes even when mtime is restored", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const runId = createCompletedRun(store, root, parentRunId);
  const result = store.readResult(runId);
  assert.ok(result);
  const key = resultDeliveryKey(runId, result);
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const path = deliveryStatePath(store, parentRunId);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: {}, taskEventCursors: {} }, null, 2)}\n`, "utf8");
  assert.equal(isWakeupKeyHandled(store, parentRunId, key), false);
  const before = statSync(path);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: { [key]: new Date().toISOString() }, taskEventCursors: {} }, null, 2)}\n`, "utf8");
  utimesSync(path, before.atime, before.mtime);

  resetDeliveryCacheStatsForTest();
  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(deliveries.length, 0);
  assert.equal(deliveryCacheStatsForTest().deliveryStateParses, 1);
  assert.equal(isWakeupKeyHandled(store, parentRunId, key), true);
});

test("pollWakeups includes capped terminal result body while keeping result body redacted", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  const status = createInitialStatus({
    runId,
    parentRunId,
    rootSessionId: parentRunId,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd: root,
    state: "completed",
  });
  store.writeStatus({ ...status, resultReady: true });
  store.writeResult(createRunResult({ runId, parentRunId, agentName: "scout", state: "completed", summary: "Done", body: "abc" }));
  writeDeliverySubscription(store, { schemaVersion: SCHEMA_VERSION, parentRunId, runId, notifyOn: ["result"], createdAt: new Date().toISOString() });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const [delivery] = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(delivery?.message.body, "abc");
  assert.equal(delivery?.message.bodyTruncation?.truncated, false);
  assert.equal(delivery?.message.result?.body, undefined);
  assert.deepEqual(delivery?.message.next, []);
  markDeliveredWakeupHandled(store, parentRunId, delivery!);
  assert.equal(isWakeupKeyHandled(store, parentRunId, delivery?.deliveryKey ?? ""), true);
  assert.equal(store.readStatus(runId).resultReady, false);
});

test("pollWakeups caps terminal result body by code point with recovery marker", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  const status = createInitialStatus({
    runId,
    parentRunId,
    rootSessionId: parentRunId,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd: root,
    state: "completed",
  });
  store.writeStatus({ ...status, resultReady: true });
  const body = "🦊".repeat(32_001);
  store.writeResult(createRunResult({ runId, parentRunId, agentName: "scout", state: "completed", summary: "Done", body }));
  writeDeliverySubscription(store, { schemaVersion: SCHEMA_VERSION, parentRunId, runId, notifyOn: ["result"], createdAt: new Date().toISOString() });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const [delivery] = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal([...String(delivery?.message.body)].length, 32_000);
  assert.equal(delivery?.message.bodyTruncation?.truncated, true);
  assert.match(delivery?.message.body ?? "", /subagent_result\(\{ runId: "/);
  assert.equal(delivery?.message.result?.body, undefined);
  assert.deepEqual(delivery?.message.next, [{ tool: "subagent_result", args: { runId } }]);
  markDeliveredWakeupHandled(store, parentRunId, delivery!);
  assert.equal(isWakeupKeyHandled(store, parentRunId, delivery?.deliveryKey ?? ""), false);
  assert.equal(store.readStatus(runId).resultReady, true);
});

test("pollWakeups task cursor catch-up does not full-read unchanged task events", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const taskStore = new TaskStore(store);
  const [task] = taskStore.createTasks(parentRunId, { parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const token = newTaskToken();
  taskStore.claimTask(parentRunId, task.id, { runId: "task_run_1", agent: "worker", displayName: "worker", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
  taskStore.submitResult(parentRunId, task.id, { runId: "task_run_1", taskToken: token, summary: "task done" });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const first = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.message.kind, "task_wakeup");
  assert.equal(first[0]?.message.taskEvent?.type, "task.result_submitted");

  resetJsonlReadStatsForTest();
  const second = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(second.length, 0);
  assert.equal(jsonlReadStatsForTest().fullFileReads, 0);
});

test("pollWakeups delivers a ready task as a start-now nudge", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const taskStore = new TaskStore(store);
  const [task] = taskStore.createTasks(parentRunId, { parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  const ready = deliveries.find((d) => d.message.taskEvent?.type === "task.ready");
  assert.ok(ready, "expected a task.ready wakeup for the immediately-ready task");
  assert.equal(ready?.message.kind, "task_wakeup");
  assert.equal(ready?.message.state, "task.ready");
  assert.deepEqual(ready?.message.next, [{ tool: "subagent_start", args: { taskId: task.id } }]);
});

test("pollWakeups skips a ready wakeup once the task is claimed", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const taskStore = new TaskStore(store);
  const [task] = taskStore.createTasks(parentRunId, { parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  const token = newTaskToken();
  taskStore.claimTask(parentRunId, task.id, { runId: "task_run_1", agent: "agent", displayName: "agent", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(deliveries.some((d) => d.message.taskEvent?.type === "task.ready"), false);
});

test("accepting a task wakes the parent to start a newly-ready dependent", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const taskStore = new TaskStore(store);
  const { tasks: created } = taskStore.createTasks(parentRunId, { parentRunId, tasks: [
    { alias: "impl", title: "Implement", description: "Do it" },
    { alias: "review", title: "Review", description: "Check it", dependsOn: ["impl"] },
  ] });
  const [impl, review] = created;
  const token = newTaskToken();
  taskStore.claimTask(parentRunId, impl.id, { runId: "task_run_1", agent: "agent", displayName: "agent", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
  taskStore.submitResult(parentRunId, impl.id, { runId: "task_run_1", taskToken: token, summary: "impl done" });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  // Drain the result-ready wakeup; the dependent is still blocked at this point.
  const before = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(before.some((d) => d.message.taskEvent?.taskId === review.id), false);

  taskStore.acceptResult(parentRunId, impl.id, {});
  const after = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  const ready = after.find((d) => d.message.taskEvent?.taskId === review.id && d.message.state === "task.ready");
  assert.ok(ready, "expected a ready wakeup for the newly-unblocked dependent");
  assert.deepEqual(ready?.message.next, [{ tool: "subagent_start", args: { taskId: review.id } }]);
});

test("pollWakeups skips a ready wakeup when a dependency regressed before delivery", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const taskStore = new TaskStore(store);
  const { tasks: created } = taskStore.createTasks(parentRunId, { parentRunId, tasks: [
    { alias: "impl", title: "Implement", description: "Do it" },
    { alias: "review", title: "Review", description: "Check it", dependsOn: ["impl"] },
  ] });
  const [impl, review] = created;
  const token = newTaskToken();
  taskStore.claimTask(parentRunId, impl.id, { runId: "task_run_1", agent: "agent", displayName: "agent", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
  taskStore.submitResult(parentRunId, impl.id, { runId: "task_run_1", taskToken: token, summary: "impl done" });
  taskStore.acceptResult(parentRunId, impl.id, {}); // review becomes ready -> task.ready(review) emitted
  // Reopen impl before the review ready wakeup is delivered; review is now blocked again.
  taskStore.reopenTask(parentRunId, impl.id, { reason: "redo" });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  // The stale ready nudge for the now-blocked dependent must not be delivered.
  assert.equal(deliveries.some((d) => d.message.taskEvent?.taskId === review.id && d.message.state === "task.ready"), false);
});

test("pollWakeups ignores unsubscribed runs", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId,
      rootSessionId: parentRunId,
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "oneshot",
      cwd: root,
      state: "completed",
    }),
  );
  store.writeResult(createRunResult({ runId, parentRunId, agentName: "scout", state: "completed", summary: "Done" }));
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" }).length, 0);
});


test("markWakeupHandled records handled delivery metadata", () => {
  const { root, store } = workspace();
  const runId = createCompletedRun(store, root, "root_test");
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_test", ownerId: "owner_a", ttlMs: 10_000 });
  const first = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" });
  assert.equal(first.length, 1);

  const key = first[0]?.deliveryKey ?? "";
  markWakeupHandled(store, "root_test", runId);
  assert.equal(isWakeupKeyHandled(store, "root_test", key), true);
  assert.equal(pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" }).length, 0);
});

test("markWakeupHandled suppresses terminal result before watcher delivery", () => {
  const { root, store } = workspace();
  const runId = createCompletedRun(store, root, "root_test");
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_test", ownerId: "owner_a", ttlMs: 10_000 });

  markWakeupHandled(store, "root_test", runId);

  assert.equal(pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" }).length, 0);
});

test("pollWakeups does not redeliver durable results after collection clears readiness", () => {
  const { root, store } = workspace();
  const runId = createCompletedRun(store, root, "root_test");
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_test", ownerId: "owner_a", ttlMs: 10_000 });
  markWakeupHandled(store, "root_test", runId);
  const status = store.readStatus(runId);
  store.writeStatus({ ...status, resultReady: false });

  assert.equal(store.readResult(runId)?.summary, "Done");
  assert.equal(pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" }).length, 0);
});

test("model follow-up polling delivers terminal results once", () => {
  const { root, store } = workspace();
  createCompletedRun(store, root, "root_test");
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_test", ownerId: "owner_a", ttlMs: 10_000 });

  const modelPoll = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a", modelFollowUpOnly: true });
  assert.equal(modelPoll.length, 1);
  assert.match(modelPoll[0]?.deliveryKey ?? "", /^terminal:/);

  const normalPoll = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" });
  assert.equal(normalPoll.length, 0);
});

test("model follow-up polling still delivers old completed results", () => {
  const { root, store } = workspace();
  createCompletedRun(store, root, "root_test", new Date(Date.now() - 61_000).toISOString());
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_test", ownerId: "owner_a", ttlMs: 10_000 });

  const modelPoll = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a", modelFollowUpOnly: true });
  assert.equal(modelPoll.length, 1);
  assert.match(modelPoll[0]?.deliveryKey ?? "", /^terminal:/);
});

test("pollWakeups remaps a question event onto waiting_for_input so the wake card badge picks 'needs you'", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId,
      rootSessionId: parentRunId,
      displayName: "blip",
      agentName: "auditor",
      agentSource: "builtin",
      definitionPath: "/builtin/auditor.md",
      mode: "oneshot",
      cwd: root,
      state: "waiting_for_input",
    }),
  );
  store.appendEvent(runId, {
    schemaVersion: SCHEMA_VERSION,
    eventId: "evt_q1",
    runId,
    parentRunId,
    type: "question",
    createdAt: new Date().toISOString(),
    summary: "Need staging credentials",
    wake: true,
  });
  writeDeliverySubscription(store, {
    schemaVersion: SCHEMA_VERSION,
    parentRunId,
    runId,
    notifyOn: ["question"],
    createdAt: new Date().toISOString(),
  });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a", modelFollowUpOnly: true });
  assert.equal(deliveries.length, 1);
  // The crux: event.type is "question" but the wake message state is "waiting_for_input" so
  // wake-card glyph/badge selection lights up amber instead of plain `?`.
  assert.equal(deliveries[0]?.message.state, "waiting_for_input");
});
