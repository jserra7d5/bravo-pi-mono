import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSubagentTools } from "../extensions/pi/tools.js";
import { createRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore } from "../src/taskStore.js";
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

test("task_clear cancels non-done milestone tasks without child-control next-actions", async () => {
  const w = workspace();
  const [done, active, open] = w.taskStore.createTasks(w.identity.rootSessionId, { parentRunId: w.identity.parentRunId, tasks: [
    { title: "Done", description: "Already accepted" },
    { title: "Active", description: "In progress" },
    { title: "Open", description: "Not started" },
  ] }).tasks;
  w.taskStore.updateTask(w.identity.rootSessionId, done.id, { status: "done" });
  w.taskStore.updateTask(w.identity.rootSessionId, active.id, { status: "active", addAttemptRunIds: ["run_active"] });

  const result = await withParentToolEnv(() => tools(w.identity).task_clear.execute("call", { reason: "reset plan" }, undefined, undefined, { cwd: w.root }));

  assert.equal(result.isError, undefined);
  assert.equal(result.details.count, 2);
  assert.deepEqual(result.details.affectedIds, [active.id, open.id]);
  assert.equal(result.details.next, undefined);
  assert.deepEqual(w.taskStore.listTasks(w.identity.rootSessionId).map((task) => task.status), ["done", "cancelled", "cancelled"]);
});

test("parent tools create separate task roots for different Pi sessions in the same cwd", async () => {
  const previousRootSessionId = process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID;
  process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID = "ambient_root_should_not_merge_parent_sessions";
  try {
    const root = mkdtempSync(join(tmpdir(), "async-subagents-tools-"));
    const identities = new Map<string, RootSessionIdentity>();
    const built = buildSubagentTools({
      getRootIdentity(cwd, piSessionId) {
        return identities.get(`${cwd}:${piSessionId ?? ""}`);
      },
      setRootIdentity(identity) {
        identities.set(`${identity.cwd}:${identity.piSessionId ?? ""}`, identity);
      },
    });
    const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));
    const ctxA = { cwd: root, sessionManager: { getSessionId: () => "pi_a" } };
    const ctxB = { cwd: root, sessionManager: { getSessionId: () => "pi_b" } };

    await withParentToolEnv(() => byName.task_create.execute("call-a", { tasks: [{ title: "A", description: "session A" }] }, undefined, undefined, ctxA));
    await withParentToolEnv(() => byName.task_create.execute("call-b", { tasks: [{ title: "B", description: "session B" }] }, undefined, undefined, ctxB));

    const listA = await withParentToolEnv(() => byName.task_list.execute("list-a", {}, undefined, undefined, ctxA));
    const listB = await withParentToolEnv(() => byName.task_list.execute("list-b", {}, undefined, undefined, ctxB));

    assert.deepEqual((listA.details.rows as Array<{ title: string }>).map((row) => row.title), ["A"]);
    assert.deepEqual((listB.details.rows as Array<{ title: string }>).map((row) => row.title), ["B"]);
    assert.notEqual(identities.get(`${root}:pi_a`)?.rootSessionId, identities.get(`${root}:pi_b`)?.rootSessionId);
  } finally {
    if (previousRootSessionId === undefined) delete process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID;
    else process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID = previousRootSessionId;
  }
});
