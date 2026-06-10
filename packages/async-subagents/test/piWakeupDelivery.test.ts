import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import asyncSubagentsPiExtension from "../extensions/pi/index.js";
import { createRunResult } from "../src/result.js";
import { readRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { TaskStore, hashTaskToken, newTaskToken } from "../src/taskStore.js";
import { SCHEMA_VERSION, type EventType, type RunState } from "../src/types.js";
import { writeDeliverySubscription } from "../extensions/pi/wakeups.js";

interface SentMessage {
  message: any;
  options: any;
}

function makePi() {
  const handlers = new Map<string, Function>();
  const renderers = new Map<string, Function>();
  const sent: SentMessage[] = [];
  const pi = {
    sendMessage(message: any, options?: any) {
      sent.push({ message, options });
    },
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer(name: string, renderer: Function) {
      renderers.set(name, renderer);
    },
  };
  return { pi, handlers, renderers, sent };
}

async function withStartedExtension() {
  const cwd = mkdtempSync(join(tmpdir(), "async-subagents-pi-wakeup-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "async-subagents-pi-wakeup-home-"));
  const previousHome = process.env.ASYNC_SUBAGENTS_HOME;
  process.env.ASYNC_SUBAGENTS_HOME = home;
  const harness = makePi();
  asyncSubagentsPiExtension(harness.pi as any);
  await handlersMustGet(harness.handlers, "session_start")({}, { cwd, hasUI: false });
  const identity = readRootSession({ cwd });
  assert.ok(identity);
  const store = new RunStore({ cwd });
  return {
    cwd,
    store,
    identity,
    sent: harness.sent,
    renderers: harness.renderers,
    poll: async (ctxOverride: Record<string, unknown> = {}) => handlersMustGet(harness.handlers, "session_start")({}, { cwd, hasUI: false, ...ctxOverride }),
    compact: async (event: Record<string, unknown> = { type: "session_compact", compactionEntry: {}, fromExtension: false }) => handlersMustGet(harness.handlers, "session_compact")(event, { cwd, hasUI: false }),
    shutdown: async () => {
      await handlersMustGet(harness.handlers, "session_shutdown")();
      if (previousHome === undefined) delete process.env.ASYNC_SUBAGENTS_HOME;
      else process.env.ASYNC_SUBAGENTS_HOME = previousHome;
    },
  };
}

function handlersMustGet(handlers: Map<string, Function>, name: string): Function {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} handler registered`);
  return handler;
}

function createRun(store: RunStore, cwd: string, parentRunId: string, state: RunState) {
  const { runId } = store.createRunDirectory({ cwd, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId,
      rootSessionId: parentRunId,
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "oneshot",
      cwd,
      state,
    }),
  );
  return runId;
}

test("idle terminal result wakeups trigger the parent once", async () => {
  const session = await withStartedExtension();
  try {
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "completed");
    session.store.writeStatus({ ...session.store.readStatus(runId), resultReady: true });
    session.store.writeResult(createRunResult({ runId, parentRunId: session.identity.parentRunId, agentName: "scout", state: "completed", summary: "### Summary", body: "full terminal body" }));
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["result", "completed", "failed", "cancelled", "expired"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();

    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
    assert.ok(wakeup);
    assert.equal(wakeup.message.display, true);
    assert.equal(wakeup.message.details?.result?.runId, runId);
    assert.match(wakeup.message.content, /NOT USER INPUT/);
    assert.match(wakeup.message.content, /full terminal body/);
    assert.equal(wakeup.message.details?.body, "full terminal body");
    assert.equal(wakeup.message.details?.bodyAvailable, true);
    assert.equal(wakeup.message.details?.bodyTruncation?.truncated, false);
    assert.equal(wakeup.message.details?.result?.body, undefined);
    assert.equal(session.store.readStatus(runId).resultReady, false);
    const renderer = session.renderers.get("async-subagent-message");
    assert.ok(renderer);
    const rendered = renderer(wakeup.message, {}, {}).render(80).join("\n");
    assert.match(rendered, /full terminal body/);
    assert.deepEqual(wakeup.options, { triggerTurn: true, deliverAs: "steer" });

    const sentAfterFirstPoll = session.sent.length;
    await session.poll();
    assert.equal(session.sent.length, sentAfterFirstPoll, "terminal result body is displayed once and not delivered again");
  } finally {
    await session.shutdown();
  }
});

test("terminal result wakeup bodies are capped with subagent_result recovery marker", async () => {
  const session = await withStartedExtension();
  try {
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "completed");
    const body = "x".repeat(32_050);
    session.store.writeStatus({ ...session.store.readStatus(runId), resultReady: true });
    session.store.writeResult(createRunResult({ runId, parentRunId: session.identity.parentRunId, agentName: "scout", state: "completed", summary: "### Summary", body }));
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["result", "completed", "failed", "cancelled", "expired"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();

    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
    assert.ok(wakeup);
    assert.equal([...String(wakeup.message.details?.body)].length, 32_000);
    assert.equal(wakeup.message.details?.bodyTruncation?.truncated, true);
    assert.match(wakeup.message.details?.body ?? "", /subagent_result\(\{ runId: "/);
    assert.match(wakeup.message.content, /recover the full result/);
    assert.equal(wakeup.message.details?.result?.body, undefined);
    assert.equal(session.store.readStatus(runId).resultReady, true);
  } finally {
    await session.shutdown();
  }
});

test("manual compaction cooldown defers wakeups without marking delivery state", async () => {
  const session = await withStartedExtension();
  const realDateNow = Date.now;
  let now = realDateNow();
  Date.now = () => now;
  try {
    await session.compact({ type: "session_compact", compactionEntry: {}, fromExtension: false });
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "completed");
    session.store.writeStatus({ ...session.store.readStatus(runId), resultReady: true });
    session.store.writeResult(createRunResult({ runId, parentRunId: session.identity.parentRunId, agentName: "scout", state: "completed", summary: "### Summary", body: "manual compact result" }));
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["result", "completed", "failed", "cancelled", "expired"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();

    assert.equal(session.sent.some((item) => item.message?.customType === "async-subagent-message"), false);
    assert.equal(session.store.readStatus(runId).resultReady, true, "cooldown must not mark the wakeup as handled");

    now += 5_001;
    await session.poll();

    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
    assert.ok(wakeup);
    assert.equal(wakeup.message.details?.result?.runId, runId);
    assert.deepEqual(wakeup.options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(session.store.readStatus(runId).resultReady, false);
  } finally {
    Date.now = realDateNow;
    await session.shutdown();
  }
});

test("auto compaction does not suppress post-compaction wakeup turns", async () => {
  const session = await withStartedExtension();
  try {
    await session.compact({ type: "session_compact", compactionEntry: {}, fromExtension: true });
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "completed");
    session.store.writeStatus({ ...session.store.readStatus(runId), resultReady: true });
    session.store.writeResult(createRunResult({ runId, parentRunId: session.identity.parentRunId, agentName: "scout", state: "completed", summary: "### Summary", body: "auto compact result" }));
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["result", "completed", "failed", "cancelled", "expired"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();

    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
    assert.ok(wakeup);
    assert.equal(wakeup.message.details?.result?.runId, runId);
    assert.deepEqual(wakeup.options, { triggerTurn: true, deliverAs: "steer" });
  } finally {
    await session.shutdown();
  }
});

test("active terminal result wakeups also steer into the running parent turn", async () => {
  const session = await withStartedExtension();
  try {
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "completed");
    session.store.writeStatus({ ...session.store.readStatus(runId), resultReady: true });
    session.store.writeResult(createRunResult({ runId, parentRunId: session.identity.parentRunId, agentName: "scout", state: "completed", summary: "### Summary", body: "full terminal body" }));
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["result", "completed", "failed", "cancelled", "expired"],
      createdAt: new Date().toISOString(),
    });

    await session.poll({ isIdle: () => false });

    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
    assert.ok(wakeup);
    assert.equal(wakeup.message.details?.result?.runId, runId);
    assert.deepEqual(wakeup.options, { triggerTurn: true, deliverAs: "steer" });
  } finally {
    await session.shutdown();
  }
});

test("paused wakeups instruct continue or cancel", async () => {
  const session = await withStartedExtension();
  try {
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "paused");
    session.store.appendEvent(runId, {
      schemaVersion: SCHEMA_VERSION,
      eventId: "evt_timeout_pause",
      runId,
      parentRunId: session.identity.parentRunId,
      type: "status",
      createdAt: new Date().toISOString(),
      summary: "Time budget expired; run paused",
      wake: true,
      data: { reason: "timeout" },
    });
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["status"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();

    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
    assert.ok(wakeup);
    assert.match(wakeup.message.content, /subagent_continue/);
    assert.match(wakeup.message.content, /additionalRunSeconds: 900/);
    assert.match(wakeup.message.content, /smallest reasonable budget/);
    assert.match(wakeup.message.content, /subagent_interrupt/);
    assert.match(wakeup.message.content, /action: "cancel"/);
    assert.doesNotMatch(wakeup.message.content, /Call subagent_result\(\{ runId:/);
    assert.deepEqual(wakeup.message.details?.next?.[0], { tool: "subagent_continue", args: { runId, additionalRunSeconds: 900 } });
  } finally {
    await session.shutdown();
  }
});

test("task wakeup polling persists a task-event cursor after catch-up", async () => {
  const session = await withStartedExtension();
  try {
    const taskStore = new TaskStore(session.store);
    const [task] = taskStore.createTasks(session.identity.rootSessionId, { parentRunId: session.identity.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
    const token = newTaskToken();
    taskStore.claimTask(session.identity.rootSessionId, task.id, { runId: "task_run_1", agent: "worker", displayName: "worker", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
    taskStore.submitResult(session.identity.rootSessionId, task.id, { runId: "task_run_1", taskToken: token, summary: "task done", receipt: { ok: true } });

    await session.poll();

    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message" && item.message.details?.kind === "task_wakeup");
    assert.ok(wakeup);
    assert.equal(wakeup.message.details?.taskEvent?.type, "task.result_submitted");

    const deliveryPath = join(resolve(session.store.runRoot, ".."), "delivery", `${session.identity.parentRunId}.json`);
    const state = JSON.parse(readFileSync(deliveryPath, "utf8"));
    assert.ok(state.taskEventCursors?.[session.identity.rootSessionId]?.eventOffset > 0);

    const sentAfterFirstPoll = session.sent.length;
    await session.poll();
    assert.equal(session.sent.length, sentAfterFirstPoll, "delivered task wakeup is not delivered again");
  } finally {
    await session.shutdown();
  }
});

for (const eventType of ["question", "blocked"] as const) {
  test(`${eventType} wakeups remain steerable and trigger parent action`, async () => {
    const session = await withStartedExtension();
    try {
      const runId = createRun(session.store, session.cwd, session.identity.parentRunId, eventType === "question" ? "waiting_for_input" : "blocked");
      session.store.appendEvent(runId, {
        schemaVersion: SCHEMA_VERSION,
        eventId: `evt_${eventType}`,
        runId,
        parentRunId: session.identity.parentRunId,
        type: eventType as EventType,
        createdAt: new Date().toISOString(),
        summary: `${eventType} summary`,
        body: `${eventType} detailed body`,
        wake: true,
      });
      writeDeliverySubscription(session.store, {
        schemaVersion: SCHEMA_VERSION,
        parentRunId: session.identity.parentRunId,
        runId,
        notifyOn: [eventType],
        createdAt: new Date().toISOString(),
      });

      await session.poll();

      const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
      assert.ok(wakeup);
      assert.equal(wakeup.message.details?.event?.type, eventType);
      assert.equal(wakeup.message.details?.event?.body, undefined);
      assert.equal(wakeup.message.details?.body, `${eventType} detailed body`);
      assert.match(wakeup.message.content, new RegExp(`${eventType} detailed body`));
      assert.doesNotMatch(wakeup.message.content, /available via subagent_result/);
      assert.match(wakeup.message.content, /subagent_message/);
      assert.doesNotMatch(wakeup.message.content, /subagent_status/);
      assert.match(wakeup.message.content, /Do not call subagent_result/);
      assert.doesNotMatch(wakeup.message.content, /Call subagent_result\(\{ runId:/);
      assert.deepEqual(wakeup.options, { triggerTurn: true, deliverAs: "steer" });
    } finally {
      await session.shutdown();
    }
  });
}

test("task-owned terminal result coalesces task and run result wakeups", async () => {
  const session = await withStartedExtension();
  try {
    const taskStore = new TaskStore(session.store);
    const runId = "task_run_coalesce";
    session.store.createRunDirectory({ runId, cwd: session.cwd, parentRunId: session.identity.parentRunId, rootSessionId: session.identity.rootSessionId });
    const [task] = taskStore.createTasks(session.identity.rootSessionId, { parentRunId: session.identity.parentRunId, tasks: [{ title: "Implement", description: "Do it" }] }).tasks;
    const token = newTaskToken();
    taskStore.claimTask(session.identity.rootSessionId, task.id, { runId, agent: "worker", displayName: "worker", assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
    taskStore.submitResult(session.identity.rootSessionId, task.id, { runId, taskToken: token, summary: "task done", receipt: { ok: true } });
    session.store.writeStatus({ ...createInitialStatus({
      runId,
      parentRunId: session.identity.parentRunId,
      rootSessionId: session.identity.rootSessionId,
      agentName: "worker",
      agentSource: "builtin",
      definitionPath: "/builtin/worker.md",
      mode: "oneshot",
      cwd: session.cwd,
      state: "completed",
    }), resultReady: true });
    session.store.writeResult(createRunResult({ runId, parentRunId: session.identity.parentRunId, agentName: "worker", state: "completed", body: "terminal body" }));
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["result", "completed"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();

    const wakeups = session.sent.filter((item) => item.message?.customType === "async-subagent-message");
    assert.equal(wakeups.length, 1);
    assert.equal(wakeups[0]?.message.details?.kind, "task_wakeup");
    assert.equal(wakeups[0]?.message.details?.taskEvent?.type, "task.result_submitted");
    assert.equal(wakeups[0]?.message.details?.taskEvent?.taskId, task.id);
    assert.equal(wakeups[0]?.message.details?.result?.runId, runId);
    assert.deepEqual(wakeups[0]?.message.details?.next, [{ tool: "task_get", args: { taskId: task.id, view: "receipt" } }]);
    assert.match(wakeups[0]?.message.content ?? "", /Review the receipt first: task_get/);
    assert.match(wakeups[0]?.message.content ?? "", /task_accept_result/);
    assert.match(wakeups[0]?.message.content ?? "", /task_reopen/);
    assert.equal(session.store.readStatus(runId).resultReady, false);

    await session.poll();
    assert.equal(session.sent.filter((item) => item.message?.customType === "async-subagent-message").length, 1);
  } finally {
    await session.shutdown();
  }
});
