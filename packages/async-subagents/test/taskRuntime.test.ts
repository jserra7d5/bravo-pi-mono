import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findActiveTaskRuntimeBlockers, readTaskRuntimeState, taskRuntimeStatePath, writeTaskRuntimeState } from "../src/taskRuntime.js";
import { createRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore } from "../src/taskStore.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "async-subagents-task-runtime-"));
}

test("task runtime state defaults on and persists per root session", () => {
  const dir = tempDir();
  try {
    assert.equal(readTaskRuntimeState(dir, "root-a").enabled, true);
    writeTaskRuntimeState(dir, "root-a", false);
    assert.equal(readTaskRuntimeState(dir, "root-a").enabled, false);
    assert.equal(readTaskRuntimeState(dir, "root-b").enabled, true);
    writeTaskRuntimeState(dir, "root-a", true);
    assert.equal(readTaskRuntimeState(dir, "root-a").enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task runtime state fails open on corrupt state", () => {
  const dir = tempDir();
  try {
    const path = taskRuntimeStatePath(dir, "root-a");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json", "utf8");
    assert.equal(readTaskRuntimeState(dir, "root-a").enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active task runtime blockers include non-terminal tasks", () => {
  const root = tempDir();
  try {
    const identity = createRootSession({ cwd: root, rootSessionId: "root_test" });
    const store = new RunStore({ cwd: root });
    const taskStore = new TaskStore(store);
    const [task] = taskStore.createTasks(identity.rootSessionId, { parentRunId: identity.parentRunId, tasks: [{ title: "A", description: "A" }] }).tasks;

    const blockers = findActiveTaskRuntimeBlockers(store, identity.rootSessionId);

    assert.equal(blockers.some((blocker) => blocker.kind === "task" && blocker.taskId === task.id && blocker.status === "pending"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
