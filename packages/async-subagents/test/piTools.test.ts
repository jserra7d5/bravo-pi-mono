import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSubagentTools } from "../extensions/pi/tools.js";
import { writeFastTrackState } from "../src/fastTrack.js";
import { pollWakeups } from "../extensions/pi/wakeups.js";
import { acquireRootSessionLease } from "../src/leases.js";
import { createRunResult } from "../src/result.js";
import { finalizeTerminalRun } from "../src/lifecycle.js";
import { createRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { TaskStore } from "../src/taskStore.js";
import { startSubagent } from "../src/start.js";
import { createInitialStatus } from "../src/status.js";
import { withRunMutationLock } from "../src/runLock.js";
import { NAME_PACKS } from "../src/namePacks.js";
import type { RootSessionIdentity } from "../src/types.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-tools-"));
  const identity = createRootSession({ cwd: root, rootSessionId: "root_test" });
  const store = new RunStore({ cwd: root });
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: identity.parentRunId,
      rootSessionId: identity.rootSessionId,
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "oneshot",
      cwd: root,
      state: "running",
    }),
  );
  return { root, identity, runId };
}

function tools(identity: RootSessionIdentity) {
  const built = buildSubagentTools({
    getRootIdentity() {
      return identity;
    },
  });
  return Object.fromEntries(built.map((tool) => [tool.name, tool]));
}

function continuationLockPath(store: RunStore, rootRunId: string, piSessionPath: string): string {
  const key = `${rootRunId}:${piSessionPath}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(resolve(store.runRoot, ".."), "continuation-locks", `${key}.json`);
}

test("task tools fail closed when task runtime is disabled", async () => {
  const w = workspace();
  const built = buildSubagentTools({
    getRootIdentity() { return w.identity; },
    isTaskRuntimeEnabled() { return false; },
  });
  const toolsByName = Object.fromEntries(built.map((tool) => [tool.name, tool]));

  const result = await toolsByName.task_list.execute("list", {}, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "TASK_RUNTIME_DISABLED");
});

test("taskless direct subagent_start remains available while taskId is rejected before launch", async () => {
  const previousRunId = process.env.ASYNC_SUBAGENTS_RUN_ID;
  const previousSingularRunId = process.env.ASYNC_SUBAGENT_RUN_ID;
  delete process.env.ASYNC_SUBAGENTS_RUN_ID;
  delete process.env.ASYNC_SUBAGENT_RUN_ID;
  try {
    const w = workspace();
    let launches = 0;
    const built = buildSubagentTools({
      getRootIdentity() { return w.identity; },
      isTaskRuntimeEnabled() { return false; },
      async startSubagent(input) {
        launches += 1;
        return { runId: input.runId ?? "run_direct", started: true, state: "running", displayName: "Direct" } as never;
      },
    });
    const toolsByName = Object.fromEntries(built.map((tool) => [tool.name, tool]));
    const taskStore = new TaskStore(new RunStore({ cwd: w.root }));
    const [task] = taskStore.createTasks(w.identity.rootSessionId, { parentRunId: w.identity.parentRunId, tasks: [{ title: "A", description: "A" }] }).tasks;

    const direct = await toolsByName.subagent_start.execute("direct", { agent: "scout", task: "Look" }, undefined, undefined, { cwd: w.root });
    const rejected = await toolsByName.subagent_start.execute("task", { taskId: task.id, agent: "scout", task: "Look" }, undefined, undefined, { cwd: w.root });

    assert.equal(direct.isError, undefined);
    assert.equal(launches, 1);
    assert.equal(rejected.isError, true);
    assert.equal(rejected.details.code, "TASK_RUNTIME_DISABLED");
    assert.equal(taskStore.readTask(w.identity.rootSessionId, task.id).status, "open");
    assert.equal(launches, 1);
  } finally {
    if (previousRunId === undefined) delete process.env.ASYNC_SUBAGENTS_RUN_ID;
    else process.env.ASYNC_SUBAGENTS_RUN_ID = previousRunId;
    if (previousSingularRunId === undefined) delete process.env.ASYNC_SUBAGENT_RUN_ID;
    else process.env.ASYNC_SUBAGENT_RUN_ID = previousSingularRunId;
  }
});

test("subagent_status tool defaults to root session direct children", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_status.execute("call", {}, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal((result.details.rows as Array<{ runId: string }>)[0]?.runId, w.runId);
  assert.equal((result.details.counts as { active: number }).active, 1);
});

test("task_list defaults to active queue after task_clear while includeCompleted shows cancelled history", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const previousRunId = process.env.ASYNC_SUBAGENTS_RUN_ID;
  const previousSingularRunId = process.env.ASYNC_SUBAGENT_RUN_ID;
  delete process.env.ASYNC_SUBAGENTS_RUN_ID;
  delete process.env.ASYNC_SUBAGENT_RUN_ID;
  try {
    await built.task_create.execute("create", { tasks: [
      { title: "A", description: "A" },
      { title: "B", description: "B" },
    ] }, undefined, undefined, { cwd: w.root });
    const clear = await built.task_clear.execute("clear", { reason: "reset queue" }, undefined, undefined, { cwd: w.root });
    assert.equal(clear.isError, undefined);

    const defaultList = await built.task_list.execute("list", {}, undefined, undefined, { cwd: w.root });
    assert.equal(defaultList.isError, undefined);
    assert.deepEqual(defaultList.details.rows, []);
    assert.equal(defaultList.content[0]?.text, "0 task(s)");
    assert.equal((defaultList.details.counts as { total: number; cancelled: number }).total, 2);
    assert.equal((defaultList.details.counts as { total: number; cancelled: number }).cancelled, 2);

    const historyList = await built.task_list.execute("list-history", { includeCompleted: true }, undefined, undefined, { cwd: w.root });
    assert.equal(historyList.isError, undefined);
    assert.deepEqual((historyList.details.rows as Array<{ status: string }>).map((row) => row.status), ["cancelled", "cancelled"]);
  } finally {
    if (previousRunId === undefined) delete process.env.ASYNC_SUBAGENTS_RUN_ID;
    else process.env.ASYNC_SUBAGENTS_RUN_ID = previousRunId;
    if (previousSingularRunId === undefined) delete process.env.ASYNC_SUBAGENT_RUN_ID;
    else process.env.ASYNC_SUBAGENT_RUN_ID = previousSingularRunId;
  }
});

test("task_get surfaces milestone evidence attached by task_update", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const taskStore = new TaskStore(new RunStore({ cwd: w.root }));
  const [task] = taskStore.createTasks(w.identity.rootSessionId, { parentRunId: w.identity.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
  taskStore.updateTask(w.identity.rootSessionId, task.id, {
    status: "done",
    addAttemptRunIds: ["run_task_1"],
    addReceiptPaths: ["receipts/task.json"],
    addArtifactPaths: [join(w.root, "artifact.md")],
    addEvidence: ["src/a.ts updated", "npm test passed"],
    appendNotes: "accepted",
  });

  const defaultResult = await built.task_get.execute("get-default", { taskId: task.id }, undefined, undefined, { cwd: w.root });
  const statusResult = await built.task_get.execute("get-status", { taskId: task.id, view: "status" }, undefined, undefined, { cwd: w.root });
  const fullResult = await built.task_get.execute("get", { taskId: task.id, view: "full" }, undefined, undefined, { cwd: w.root });

  assert.equal(defaultResult.isError, undefined);
  assert.equal(defaultResult.details.status, "done");
  assert.deepEqual(defaultResult.details.receiptPaths, ["receipts/task.json"]);
  assert.deepEqual(defaultResult.details.artifactPaths, [join(w.root, "artifact.md")]);
  assert.deepEqual(defaultResult.details.evidence, ["src/a.ts updated", "npm test passed"]);
  assert.match(defaultResult.content[0]?.text ?? "", /Status: done/);
  assert.doesNotMatch(statusResult.content[0]?.text ?? "", /src\/a\.ts updated/);
  assert.deepEqual(fullResult.details.receiptPaths, ["receipts/task.json"]);
});

test("task_update response exposes status/readiness without next or state", async () => {
  const previousRunId = process.env.ASYNC_SUBAGENTS_RUN_ID;
  const previousSingularRunId = process.env.ASYNC_SUBAGENT_RUN_ID;
  delete process.env.ASYNC_SUBAGENTS_RUN_ID;
  delete process.env.ASYNC_SUBAGENT_RUN_ID;
  try {
    const w = workspace();
    const built = tools(w.identity);
    const taskStore = new TaskStore(new RunStore({ cwd: w.root }));
    const [task] = taskStore.createTasks(w.identity.rootSessionId, { parentRunId: w.identity.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;

    const result = await built.task_update.execute("update", { taskId: task.id, status: "active", appendNotes: "started" }, undefined, undefined, { cwd: w.root });

    assert.equal(result.isError, undefined);
    assert.equal((result.details.task as { status?: string }).status, "active");
    assert.equal(Object.hasOwn(result.details.task as Record<string, unknown>, "readiness"), true);
    assert.equal(Object.hasOwn(result.details.task as Record<string, unknown>, "state"), false);
    assert.equal(Object.hasOwn(result.details, "next"), false);
  } finally {
    if (previousRunId === undefined) delete process.env.ASYNC_SUBAGENTS_RUN_ID;
    else process.env.ASYNC_SUBAGENTS_RUN_ID = previousRunId;
    if (previousSingularRunId === undefined) delete process.env.ASYNC_SUBAGENT_RUN_ID;
    else process.env.ASYNC_SUBAGENT_RUN_ID = previousSingularRunId;
  }
});

test("model-facing tool catalog does not expose subagent_wait", () => {
  const w = workspace();
  const built = tools(w.identity);
  assert.equal(Object.hasOwn(built, "subagent_wait"), false);
});

test("subagent_message appends inbox messages and waits for child-control acknowledgement", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_message.execute("call", { runId: w.runId, body: "Continue" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.appended, true);
  assert.equal(result.details.liveDelivered, false);
  assert.equal((result.details.unsupported as { code?: string }).code, "LIVE_MESSAGE_UNSUPPORTED");
});

test("subagent_message does not append after terminal finalization wins the mutation lock", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const runDir = store.pathsFor({ runId: w.runId }).runDir;
  let release!: () => void;
  let locked!: () => void;
  const entered = new Promise<void>((resolve) => { locked = resolve; });
  const holder = withRunMutationLock(runDir, async () => {
    finalizeTerminalRun(store, { runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Done" });
    locked();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await entered;
  const pending = tools(w.identity).subagent_message.execute("call", { runId: w.runId, body: "Too late", requiresAck: false }, undefined, undefined, { cwd: w.root });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await holder;

  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "RUN_TERMINAL");
  assert.equal(store.readInbox(w.runId).records.length, 0);
});

test("subagent_message can append without required acknowledgement", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_message.execute("call", { runId: w.runId, body: "Continue", requiresAck: false }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.appended, true);
  assert.equal(result.details.liveDelivered, false);
});

test("subagent_message rejects lifecycle controls", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_message.execute("call", { runId: w.runId, type: "cancel", body: "Stop" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "LIFECYCLE_MESSAGE_REJECTED");
});

test("subagent_interrupt cancel queues supervisor control without finalizing live run", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_interrupt.execute("call", { runId: w.runId, action: "cancel", reason: "Wrong direction" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.state, "running");
  assert.equal(result.details.controlQueued, true);
  const store = new RunStore({ cwd: w.root });
  assert.equal(store.readStatus(w.runId).state, "running");
  assert.equal(store.readResult(w.runId), undefined);
  assert.equal(store.readInbox(w.runId).records.at(-1)?.type, "cancel");
});

test("subagent_continue rejects non-paused runs", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, body: "Use the narrowed scope" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "RUN_NOT_PAUSED");
});

test("subagent_continue queues resume control even when required ack fails", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeStatus({
    ...status,
    state: "paused",
    pid: process.pid,
    processHealth: "alive",
    thinkingLevel: "low",
    allowedFiles: ["src/original.ts"],
    fastTrack: { requested: true, enabled: true, applied: true, serviceTier: "priority" },
  });
  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, thinkingLevel: "high", body: "Finish the implementation", files: ["src/new.ts", "src/original.ts", "src/new.ts"] }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.state, "paused");
  assert.equal(result.details.controlQueued, true);
  assert.equal(result.details.thinkingLevel, "high");
  assert.equal(store.readStatus(w.runId).state, "paused");
  assert.equal(store.readStatus(w.runId).thinkingLevel, "low");
  assert.equal(store.readStatus(w.runId).fastTrack?.applied, true);
  assert.deepEqual(store.readStatus(w.runId).allowedFiles, ["src/original.ts", "src/new.ts"]);
  const inboxMessage = store.readInbox(w.runId).records.at(-1);
  assert.equal(inboxMessage?.thinkingLevel, "high");
  assert.match(inboxMessage?.body ?? "", /Finish the implementation/);
  assert.match(inboxMessage?.body ?? "", /Authoritative Write-Scope Amendment/);
  assert.match(inboxMessage?.body ?? "", /write scope for this run is now the following additive union/);
  assert.match(inboxMessage?.body ?? "", /- src\/original\.ts\n- src\/new\.ts/);
  assert.match(inboxMessage?.body ?? "", /contract and prompt enforcement, not OS sandboxing/);
});

test("paused scope widening re-reads status under the run mutation lock", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeStatus({ ...status, state: "paused", allowedFiles: ["src/base.ts"] });
  const built = tools(w.identity);
  const runDir = store.pathsFor({ runId: w.runId }).runDir;
  let release!: () => void;
  let locked!: () => void;
  const entered = new Promise<void>((resolve) => { locked = resolve; });
  const holder = withRunMutationLock(runDir, async () => {
    const current = store.readStatus(w.runId);
    store.writeStatus({ ...current, allowedFiles: ["src/base.ts", "src/concurrent.ts"] });
    locked();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await entered;

  const first = built.subagent_continue.execute("first", { runId: w.runId, files: ["src/first.ts"], requiresAck: false }, undefined, undefined, { cwd: w.root });
  const second = built.subagent_continue.execute("second", { runId: w.runId, files: ["src/second.ts"], requiresAck: false }, undefined, undefined, { cwd: w.root });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await holder;
  await Promise.all([first, second]);

  const persistedFiles = store.readStatus(w.runId).allowedFiles ?? [];
  assert.equal(persistedFiles[0], "src/base.ts");
  assert.equal(persistedFiles[1], "src/concurrent.ts");
  assert.deepEqual(new Set(persistedFiles), new Set(["src/base.ts", "src/concurrent.ts", "src/first.ts", "src/second.ts"]));
  const amendments = store.readInbox(w.runId).records.map((message) => {
    assert.equal(message.type, "instruction");
    assert.match(message.body, /Authoritative Write-Scope Amendment/);
    return [...message.body.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
  });
  assert.equal(amendments.length, 2);
  assert.ok(amendments[0]?.every((file) => amendments[1]?.includes(file)));
  assert.deepEqual(amendments[1], persistedFiles);
});

test("unscoped paused runs reject file widening without resuming or mutating", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeStatus({ ...status, state: "paused" });
  const built = tools(w.identity);

  const result = await built.subagent_continue.execute("call", { runId: w.runId, files: ["src/additional.ts"], requiresAck: false }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "SCOPE_UNSPECIFIED");
  assert.equal(store.readStatus(w.runId).allowedFiles, undefined);
  assert.equal(store.readInbox(w.runId).records.length, 0);
  assert.equal(existsSync(join(store.pathsFor({ runId: w.runId }).runDir, "control.jsonl")), false);
});

test("subagent_continue creates an async terminal continuation using the original Pi session", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({
    ...original,
    state: "completed",
    resultReady: true,
    piSessionPath: originalSession,
    requestedPiSessionPath: join(store.pathsFor({ runId: w.runId }).runDir, "pi-session", "session.jsonl"),
    thinkingLevel: "low",
    allowedFiles: ["src/original.ts", "src/shared.ts"],
    agent: { ...original.agent, name: "worker" },
    fastTrack: { requested: true, enabled: true, applied: true, serviceTier: "priority" },
  });
  store.writeResult(createRunResult({
    runId: w.runId,
    parentRunId: w.identity.parentRunId,
    agentName: "worker",
    thinkingLevel: "low",
    state: "completed",
    summary: "Original done",
    piSessionPath: originalSession,
  }));

  const calls: unknown[] = [];
  const built = buildSubagentTools({
    getRootIdentity() {
      return w.identity;
    },
    startSubagent(input) {
      calls.push(input);
      return startSubagent({ ...input, fake: { mode: "immediate", body: "Continuation done" } });
    },
  });
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));
  const result = await byName.subagent_continue.execute("call", { runId: w.runId, body: "Add the retry loop", files: ["src/shared.ts", "src/retry.ts", "src/retry.ts"] }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.continuedFromRunId, w.runId);
  assert.equal(result.details.continuationRootRunId, w.runId);
  assert.equal(result.details.continuationSequence, 1);
  assert.equal(result.details.continuationOfPiSessionPath, originalSession);
  assert.equal(Object.hasOwn(calls[0] as Record<string, unknown>, "startMode"), false);
  assert.deepEqual((calls[0] as { files?: string[] }).files, ["src/original.ts", "src/shared.ts", "src/retry.ts"]);
  assert.equal((calls[0] as { inheritedFastTrack?: boolean }).inheritedFastTrack, true);

  const newRunId = result.details.runId as string;
  assert.notEqual(newRunId, w.runId);
  const continuation = store.readStatus(newRunId);
  assert.equal(continuation.continuedFromRunId, w.runId);
  assert.equal(continuation.continuationRootRunId, w.runId);
  assert.equal(continuation.continuationSequence, 1);
  assert.equal(continuation.continuationOfPiSessionPath, originalSession);
  assert.equal(continuation.piSessionPath, originalSession);
  assert.deepEqual(continuation.allowedFiles, ["src/original.ts", "src/shared.ts", "src/retry.ts"]);
  assert.equal(continuation.fastTrack?.applied, true);
  assert.equal(store.readResult(newRunId)?.continuedFromRunId, w.runId);
  const continuationTask = readFileSync(join(store.pathsFor({ runId: newRunId }).artifactsDir, "task.md"), "utf8");
  assert.match(continuationTask, /# Write Scope\n\n[^#]*- src\/original\.ts\n- src\/shared\.ts\n- src\/retry\.ts/);

  const launch = JSON.parse(readFileSync(join(store.pathsFor({ runId: newRunId }).runDir, "logs", "launch.json"), "utf8"));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--session"), launch.args.indexOf("--session") + 2), ["--session", originalSession]);
  assert.equal(launch.continuation.continuedFromRunId, w.runId);
  assert.equal(launch.fastTrack.applied, true);
  assert.ok(launch.extensions.some((entry: string) => entry.endsWith("extensions/child-fast-track/index.ts")));

  const second = await byName.subagent_continue.execute("second", { runId: newRunId, body: "Continue again" }, undefined, undefined, { cwd: w.root });
  assert.equal(second.isError, undefined);
  assert.deepEqual(store.readStatus(second.details.runId as string).allowedFiles, ["src/original.ts", "src/shared.ts", "src/retry.ts"]);
});

test("unscoped terminal runs reject file widening before launch", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "unscoped-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "completed", resultReady: true, piSessionPath: originalSession });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", piSessionPath: originalSession }));
  let launches = 0;
  const built = buildSubagentTools({
    getRootIdentity() { return w.identity; },
    startSubagent(input) { launches += 1; return startSubagent({ ...input, fake: { mode: "immediate", body: "Done" } }); },
  });
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));

  const result = await byName.subagent_continue.execute("call", { runId: w.runId, files: ["src/new.ts"] }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "SCOPE_UNSPECIFIED");
  assert.equal(launches, 0);

  const withoutFiles = await byName.subagent_continue.execute("without-files", { runId: w.runId, body: "Continue unscoped" }, undefined, undefined, { cwd: w.root });
  assert.equal(withoutFiles.isError, undefined);
  assert.equal(launches, 1);
  assert.equal(store.readStatus(withoutFiles.details.runId as string).allowedFiles, undefined);
});

test("subagent_continue rejects concurrent terminal continuation starts for the same session", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "completed", resultReady: true, piSessionPath: originalSession });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", piSessionPath: originalSession }));

  let launchCount = 0;
  const built = buildSubagentTools({
    getRootIdentity() {
      return w.identity;
    },
    async startSubagent(input) {
      launchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return startSubagent({ ...input, fake: { mode: "immediate", body: "Continuation done" } });
    },
  });
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));

  const [first, second] = await Promise.all([
    byName.subagent_continue.execute("call-1", { runId: w.runId, body: "First" }, undefined, undefined, { cwd: w.root }),
    byName.subagent_continue.execute("call-2", { runId: w.runId, body: "Second" }, undefined, undefined, { cwd: w.root }),
  ]);

  assert.equal(launchCount, 1);
  const errors = [first, second].filter((result) => result.isError);
  const successes = [first, second].filter((result) => !result.isError);
  assert.equal(successes.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.details.code, "TERMINAL_CONTINUATION_START_IN_PROGRESS");
});

test("subagent_continue recovers stale terminal continuation startup locks", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "completed", resultReady: true, piSessionPath: originalSession });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", piSessionPath: originalSession }));
  const lockPath = continuationLockPath(store, w.runId, originalSession);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    rootRunId: w.runId,
    piSessionPath: originalSession,
    requestedByRunId: w.runId,
    claimedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  })}\n`, "utf8");

  let launchCount = 0;
  const built = buildSubagentTools({
    getRootIdentity() {
      return w.identity;
    },
    startSubagent(input) {
      launchCount += 1;
      return startSubagent({ ...input, fake: { mode: "immediate", body: "Recovered stale lock" } });
    },
  });
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));
  const result = await byName.subagent_continue.execute("call", { runId: w.runId, body: "Continue after stale lock" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(launchCount, 1);
  assert.equal(result.details.continuedFromRunId, w.runId);
});

test("subagent_continue points to an active terminal continuation instead of launching another", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "completed", resultReady: true, piSessionPath: originalSession });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", piSessionPath: originalSession }));
  const active = store.createRunDirectory({
    cwd: w.root,
    parentRunId: w.identity.parentRunId,
    rootSessionId: w.identity.rootSessionId,
    contextPolicy: "fresh",
    sessionPolicy: "record",
    piSessionPath: originalSession,
    continuedFromRunId: w.runId,
    continuationRootRunId: w.runId,
    continuationSequence: 1,
    continuationOfPiSessionPath: originalSession,
  });
  store.writeStatus(createInitialStatus({
    runId: active.runId,
    parentRunId: w.identity.parentRunId,
    rootSessionId: w.identity.rootSessionId,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd: w.root,
    state: "running",
    piSessionPath: originalSession,
    continuedFromRunId: w.runId,
    continuationRootRunId: w.runId,
    continuationSequence: 1,
    continuationOfPiSessionPath: originalSession,
  }));

  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, body: "Third" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "ACTIVE_TERMINAL_CONTINUATION");
  assert.equal(result.details.activeRunId, active.runId);
});

test("subagent_continue returns a structured error for terminal runs without a recorded Pi session", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeStatus({ ...status, state: "completed", resultReady: true, sessionPolicy: "none", piSessionPath: undefined, requestedPiSessionPath: undefined });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", sessionPolicy: "none" }));

  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, body: "Continue anyway" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "TERMINAL_CONTINUATION_SESSION_UNAVAILABLE");
});

test("start and continue reject invalid allowed-file paths and empty start scope remains unknown", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const started = await startSubagent({
    agent: "scout",
    task: "No explicit scope",
    cwd: w.root,
    runRoot: store.runRoot,
    parentRunId: w.identity.parentRunId,
    files: [],
    fake: { mode: "immediate", body: "Done" },
  });
  assert.equal(store.readStatus(started.runId).allowedFiles, undefined);
  await assert.rejects(
    () => startSubagent({ agent: "scout", task: "Bad scope", cwd: w.root, runRoot: store.runRoot, parentRunId: w.identity.parentRunId, files: ["  "] }),
    (error: any) => error?.code === "INVALID_ALLOWED_FILE",
  );

  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "paused" });
  const built = tools(w.identity);
  for (const file of ["", "  ", "src/a.ts\nsrc/b.ts", "src/a.ts\rnope"]) {
    const result = await built.subagent_continue.execute("invalid", { runId: w.runId, files: [file] }, undefined, undefined, { cwd: w.root });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "INVALID_ALLOWED_FILE");
  }
  assert.equal(store.readStatus(w.runId).allowedFiles, undefined);

  const startResult = await built.subagent_start.execute("invalid-start", { agent: "scout", task: "Bad", files: ["src/a.ts\nnope"] }, undefined, undefined, { cwd: w.root });
  assert.equal(startResult.isError, true);
  assert.equal(startResult.details.code, "INVALID_ALLOWED_FILE");
});

test("Pi tool schemas expose thinking level controls and skill forwarding", () => {
  const built = buildSubagentTools();
  const startSchema = JSON.stringify(built.find((tool) => tool.name === "subagent_start")?.parameters);
  assert.ok(startSchema.includes("thinkingLevel"));
  assert.ok(startSchema.includes("skills"));
  assert.ok(startSchema.includes("Children do not inherit parent-session skills automatically"));
  const continueSchema = JSON.stringify(built.find((tool) => tool.name === "subagent_continue")?.parameters);
  assert.ok(continueSchema.includes("thinkingLevel"));
  assert.ok(continueSchema.includes("files"));
  assert.ok(continueSchema.includes("Existing specified scope is always retained"));
  assert.ok(continueSchema.includes("runs without a specified scope reject file widening"));
});

test("subagent_start returns a tool error when fastTrack is requested while disabled", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_start.execute("call", { agent: "worker", task: "Critical path", fastTrack: true }, undefined, undefined, { cwd: w.root });
  assert.equal(result.isError, true);
  assert.equal(result.details.state, "failed");
  assert.equal(result.details.started, false);
  assert.equal((result.details.fastTrack as { reason?: string }).reason, "disabled");
  assert.match(result.content[0]?.text ?? "", /failed to start/);
});

test("subagent_start injects fast-track extension and launch metadata when applied", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  writeFastTrackState(store.runRoot, w.identity.rootSessionId, true);
  const started = await startSubagent({
    agent: "worker",
    task: "Critical path",
    cwd: w.root,
    runRoot: store.runRoot,
    parentRunId: w.identity.parentRunId,
    rootSessionId: w.identity.rootSessionId,
    fastTrack: true,
    fake: { mode: "immediate", body: "Done" },
  });
  assert.equal(started.fastTrack?.applied, true);
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8")) as { extensions?: string[]; fastTrack?: { applied?: boolean; serviceTier?: string } };
  assert.equal(launch.fastTrack?.applied, true);
  assert.equal(launch.fastTrack?.serviceTier, "priority");
  assert.ok(launch.extensions?.some((entry) => entry.endsWith("extensions/child-fast-track/index.ts")));
});

test("subagent_start rejects path-like forwarded skills", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_start.execute("call", { agent: "scout", task: "Probe", skills: ["./local-skill"] }, undefined, undefined, { cwd: w.root });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "INVALID_SKILL_NAME");
  assert.match(result.content[0].text, /path-like skill values are not allowed/);
});

test("every subagent tool opts into the self-rendered shell so card chrome sits on chat bg", () => {
  // Without renderShell: "self" Pi wraps tool output in the pending/success/error Box. Our
  // cards bring their own chrome; the tinted box clashes underneath. Every tool must opt in.
  const built = buildSubagentTools();
  assert.ok(built.length >= 7);
  for (const tool of built) {
    assert.equal((tool as { renderShell?: string }).renderShell, "self", `tool ${tool.name} missing renderShell: "self"`);
  }
});

test("startSubagent surfaces agent-definition detail and forwarded skills on the start result", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const started = await startSubagent({
    agent: "scout",
    task: "Probe",
    cwd: w.root,
    runRoot: store.runRoot,
    parentRunId: w.identity.parentRunId,
    skills: ["tui-design"],
    fake: { mode: "immediate", body: "Done" },
  });
  // scout.md defines: tools: [read, grep, find, ls], maxSubagentDepth: 0
  assert.ok(Array.isArray(started.tools) && started.tools.includes("read"));
  assert.equal(started.maxSubagentDepth, 0);
  assert.deepEqual(started.skills, ["tui-design"]);
});

test("subagent_result can recover by runDir", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const runDir = store.pathsFor({ runId: w.runId }).runDir;
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "Recovered result" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_result.execute("call", { runDir }, undefined, undefined, { cwd: w.root });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.body, "Recovered result");
  assert.equal(result.details.runDir, runDir);
  assert.equal(store.readStatus(w.runId).resultReady, false);
});

test("subagent_status reports result and status mismatches", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "Done" }));

  const built = tools(w.identity);
  const result = await built.subagent_status.execute("call", { runIds: [w.runId] }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  const row = (result.details.rows as Array<{ diagnostics?: string[] }>)[0];
  assert.ok(row?.diagnostics?.includes("result exists but status is non-terminal"));
});

test("subagent_name_pack inspects and changes the active pack for future runs", async () => {
  const w = workspace();
  const built = tools(w.identity);

  const initial = await built.subagent_name_pack.execute("call", {}, undefined, undefined, { cwd: w.root });
  assert.equal(initial.details.activePack, "default");

  const changed = await built.subagent_name_pack.execute("call", { pack: "clones" }, undefined, undefined, { cwd: w.root });
  assert.equal(changed.details.activePack, "clones");

  const store = new RunStore({ cwd: w.root });
  const started = await startSubagent({
    agent: "scout",
    task: "Use clone name",
    cwd: w.root,
    runRoot: store.runRoot,
    parentRunId: w.identity.parentRunId,
    fake: { mode: "immediate", body: "Done" },
  });
  assert.ok(NAME_PACKS.clones.includes(started.displayName as (typeof NAME_PACKS.clones)[number]));
  assert.equal(started.agentName, "scout");
});

test("subagent_result omits model-facing body when includeBody is false", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "secret body" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_result.execute("call", { runId: w.runId, includeBody: false }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.content[0]?.text ?? "", /secret body/);
  assert.match(result.content[0]?.text ?? "", /Body omitted: includeBody=false/);
});

test("subagent_result returns body with truncation metadata", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "0123456789abcdef" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_result.execute("call", { runId: w.runId, maxBytes: 8 }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.body, "01234...");
  assert.match(result.content[0]?.text ?? "", /01234\.\.\./);
  assert.match(result.content[0]?.text ?? "", /Body truncated: 8 of 16 bytes returned/);
  assert.deepEqual((result.details.bodyTruncation as { truncated?: boolean; returnedBytes?: number; maxBytes?: number }).truncated, true);
  assert.equal((result.details.bodyTruncation as { returnedBytes?: number }).returnedBytes, 8);
  assert.equal(store.readStatus(w.runId).resultReady, false);
});
