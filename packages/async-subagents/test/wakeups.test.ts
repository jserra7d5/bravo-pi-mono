import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireRootSessionLease } from "../src/leases.js";
import { createRunResult } from "../src/result.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { pollWakeups, markWakeupHandled, isWakeupKeyHandled, writeDeliverySubscription } from "../extensions/pi/wakeups.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-wakeups-"));
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  return { root, store };
}

function createCompletedRun(store: RunStore, cwd: string, parentRunId: string): string {
  const { runId } = store.createRunDirectory({ cwd, parentRunId, rootSessionId: parentRunId });
  store.writeStatus({
    ...createInitialStatus({
      runId,
      parentRunId,
      rootSessionId: parentRunId,
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "oneshot",
      cwd,
      state: "completed",
    }),
    resultReady: true,
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

  const second = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" });
  assert.equal(second.length, 0);

  const stale = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_b" });
  assert.equal(stale.length, 0);
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

test("model follow-up polling skips terminal results before claiming them", () => {
  const { root, store } = workspace();
  createCompletedRun(store, root, "root_test");
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_test", ownerId: "owner_a", ttlMs: 10_000 });

  const modelPoll = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a", modelFollowUpOnly: true });
  assert.equal(modelPoll.length, 0);

  const normalPoll = pollWakeups({ store, parentRunId: "root_test", rootSessionId: "root_test", ownerId: "owner_a" });
  assert.equal(normalPoll.length, 1);
  assert.match(normalPoll[0]?.deliveryKey ?? "", /^terminal:/);
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
