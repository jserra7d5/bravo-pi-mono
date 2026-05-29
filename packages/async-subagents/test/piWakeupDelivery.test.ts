import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import asyncSubagentsPiExtension from "../extensions/pi/index.js";
import { createRunResult } from "../src/result.js";
import { readRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { SCHEMA_VERSION, type EventType, type RunState } from "../src/types.js";
import { writeDeliverySubscription } from "../extensions/pi/wakeups.js";

interface SentMessage {
  message: any;
  options: any;
}

function makePi() {
  const handlers = new Map<string, Function>();
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
    registerMessageRenderer() {},
  };
  return { pi, handlers, sent };
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
    poll: async (ctxOverride: Record<string, unknown> = {}) => handlersMustGet(harness.handlers, "session_start")({}, { cwd, hasUI: false, ...ctxOverride }),
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
    assert.doesNotMatch(wakeup.message.content, /full terminal body/);
    assert.equal(wakeup.message.details?.body, undefined);
    assert.equal(wakeup.message.details?.bodyAvailable, true);
    assert.equal(wakeup.message.details?.result?.body, undefined);
    assert.deepEqual(wakeup.options, { triggerTurn: true, deliverAs: "steer" });

    const sentAfterFirstPoll = session.sent.length;
    await session.poll();
    assert.equal(session.sent.length, sentAfterFirstPoll, "terminal result body is displayed once and not delivered again");
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
