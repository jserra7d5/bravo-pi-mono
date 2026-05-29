import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSubagentTools } from "../extensions/pi/tools.js";
import { isWakeupKeyHandled, pollWakeups, taskEventDeliveryKey } from "../extensions/pi/wakeups.js";
import { acquireRootSessionLease } from "../src/leases.js";
import { createRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore, hashTaskToken, newTaskToken } from "../src/taskStore.js";
import type { RootSessionIdentity } from "../src/types.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-tools-"));
  const identity = createRootSession({ cwd: root, rootSessionId: "root_test" });
  const runStore = new RunStore({ cwd: root });
  const taskStore = new TaskStore(runStore);
  return { root, identity, runStore, taskStore };
}

function tools(identity: RootSessionIdentity) {
  const built = buildSubagentTools({
    getRootIdentity() {
      return identity;
    },
  });
  return Object.fromEntries(built.map((tool) => [tool.name, tool]));
}

async function withParentToolEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousRunId = process.env.ASYNC_SUBAGENTS_RUN_ID;
  const previousLegacyRunId = process.env.ASYNC_SUBAGENT_RUN_ID;
  delete process.env.ASYNC_SUBAGENTS_RUN_ID;
  delete process.env.ASYNC_SUBAGENT_RUN_ID;
  try {
    return await fn();
  } finally {
    if (previousRunId === undefined) delete process.env.ASYNC_SUBAGENTS_RUN_ID;
    else process.env.ASYNC_SUBAGENTS_RUN_ID = previousRunId;
    if (previousLegacyRunId === undefined) delete process.env.ASYNC_SUBAGENT_RUN_ID;
    else process.env.ASYNC_SUBAGENT_RUN_ID = previousLegacyRunId;
  }
}

test("task_clear returns subagent_interrupt next-actions for owned running tasks", async () => {
  const w = workspace();
  const [owned, pending] = w.taskStore.createTasks(w.identity.rootSessionId, { parentRunId: w.identity.parentRunId, tasks: [
    { title: "Owned", description: "Owned running task" },
    { title: "Pending", description: "Unowned pending task" },
  ] }).tasks;
  const token = newTaskToken();
  w.taskStore.claimTask(w.identity.rootSessionId, owned.id, {
    runId: "run_owned",
    agent: "worker",
    displayName: "Worker",
    assignedAt: new Date().toISOString(),
    tokenHash: hashTaskToken(token),
  });

  const result = await withParentToolEnv(() => tools(w.identity).task_clear.execute("call", { reason: "reset plan" }, undefined, undefined, { cwd: w.root }));

  assert.equal(result.isError, undefined);
  assert.equal(result.details.count, 2);
  assert.deepEqual(result.details.affectedIds, [owned.id, pending.id]);
  assert.deepEqual(result.details.next, [
    { tool: "subagent_interrupt", args: { runId: "run_owned", action: "cancel", reason: "reset plan" } },
  ]);
});

test("task_clear marks and suppresses affected task wakeups", async () => {
  const w = workspace();
  const [task] = w.taskStore.createTasks(w.identity.rootSessionId, { parentRunId: w.identity.parentRunId, tasks: [
    { title: "Needs input", description: "Produce a wakeup before clearing" },
  ] }).tasks;
  const token = newTaskToken();
  w.taskStore.claimTask(w.identity.rootSessionId, task.id, {
    runId: "run_blocked",
    agent: "worker",
    displayName: "Worker",
    assignedAt: new Date().toISOString(),
    tokenHash: hashTaskToken(token),
  });
  w.taskStore.reportBlocked(w.identity.rootSessionId, task.id, {
    runId: "run_blocked",
    taskToken: token,
    summary: "Need parent decision",
  });
  const wakeEvent = w.taskStore.readEvents(w.identity.rootSessionId).find((event) => event.type === "task.needs_input");
  assert.ok(wakeEvent);
  const wakeupKey = taskEventDeliveryKey(wakeEvent);
  assert.equal(isWakeupKeyHandled(w.runStore, w.identity.parentRunId, wakeupKey), false);

  const result = await withParentToolEnv(() => tools(w.identity).task_clear.execute("call", { reason: "abandon" }, undefined, undefined, { cwd: w.root }));

  assert.equal(result.isError, undefined);
  assert.equal(isWakeupKeyHandled(w.runStore, w.identity.parentRunId, wakeupKey), true);

  const ownerId = "test-poller";
  const nowMs = Date.now();
  acquireRootSessionLease({ cwd: w.root, rootSessionId: w.identity.rootSessionId, ownerId, nowMs, ttlMs: 10_000 });
  const wakeups = pollWakeups({
    store: w.runStore,
    parentRunId: w.identity.parentRunId,
    rootSessionId: w.identity.rootSessionId,
    ownerId,
    nowMs,
    records: [],
    limit: 5,
  });

  assert.deepEqual(wakeups, []);
  assert.equal(w.taskStore.readTask(w.identity.rootSessionId, task.id).status, "cancelled");
});
