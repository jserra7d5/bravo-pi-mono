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

// Faithful stand-in for the real ExtensionContext.sessionManager, which is
// always present on Pi event handlers. restoreStickyTaskRuntimeState scans the
// session branch for sticky task-mode entries; an empty branch reproduces the
// prior no-sticky-state behavior without diverging from the real context shape.
const sessionManager = { getSessionId: () => undefined, getBranch: () => [] };

async function withStartedExtension() {
  const cwd = mkdtempSync(join(tmpdir(), "async-subagents-pi-wakeup-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "async-subagents-pi-wakeup-home-"));
  const previousHome = process.env.ASYNC_SUBAGENTS_HOME;
  process.env.ASYNC_SUBAGENTS_HOME = home;
  const harness = makePi();
  asyncSubagentsPiExtension(harness.pi as any);
  await handlersMustGet(harness.handlers, "session_start")({}, { cwd, hasUI: false, sessionManager });
  const identity = readRootSession({ cwd });
  assert.ok(identity);
  const store = new RunStore({ cwd });
  return {
    cwd,
    store,
    identity,
    sent: harness.sent,
    renderers: harness.renderers,
    poll: async (ctxOverride: Record<string, unknown> = {}) => handlersMustGet(harness.handlers, "session_start")({}, { cwd, hasUI: false, sessionManager, ...ctxOverride }),
    acknowledge: async (message: any) => handlersMustGet(harness.handlers, "message_start")({ type: "message_start", message: { role: "custom", ...message } }, { cwd, hasUI: false, sessionManager }),
    compact: async (event: Record<string, unknown> = { type: "session_compact", compactionEntry: {}, fromExtension: false }) => handlersMustGet(harness.handlers, "session_compact")(event, { cwd, hasUI: false, sessionManager }),
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
    assert.match(wakeup.message.details?.deliveryKey ?? "", /^terminal:/);
    assert.equal(session.store.readStatus(runId).resultReady, true, "polling only records an attempt");
    await session.acknowledge({ ...wakeup.message, customType: "other-extension" });
    await session.acknowledge({ ...wakeup.message, details: { ...wakeup.message.details, deliveryKey: "terminal:wrong:key" } });
    assert.equal(session.store.readStatus(runId).resultReady, true, "unrelated and mismatched messages do not acknowledge delivery");
    await session.acknowledge(wakeup.message);
    assert.equal(session.store.readStatus(runId).resultReady, false, "exact message_start acknowledges the wakeup");
    const renderer = session.renderers.get("async-subagent-message");
    assert.ok(renderer);
    const rendered = renderer(wakeup.message, {}, {}).render(80).join("\n");
    assert.match(rendered, /full terminal body/);
    assert.deepEqual(wakeup.options, { triggerTurn: true, deliverAs: "steer" });

    const sentAfterFirstPoll = session.sent.length;
    await session.poll();
    assert.equal(session.sent.length, sentAfterFirstPoll, "acknowledged terminal result is not delivered again");
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
    assert.equal(session.store.readStatus(runId).resultReady, true);
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

test("Claude wakeup delivery preserves metadata, redacts transcript body, and terminal result suppresses older attention", async () => {
  const session = await withStartedExtension();
  try {
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "completed");
    const status = session.store.readStatus(runId);
    session.store.writeStatus({
      ...status,
      displayName: "Mira",
      state: "completed",
      resultReady: true,
      harness: "claude",
      launchHarness: "claude-tmux-interactive",
      resultParser: "mcp-terminal",
      model: "claude-sonnet",
      effort: "high",
      executionMode: "dangerous-auth",
      claudeTransport: "mcp",
      livenessState: "comatose",
      livenessReason: "Parent message not acknowledged after nudge probe",
      tmuxSocket: join(session.cwd, "logs", "tmux-with-secret-token.sock"),
      tmuxSession: "async-subagents-test",
      tmuxPane: "%1",
      transcriptPath: join(session.cwd, "logs", "tmux-transcript.log"),
      pendingAckMessageIds: ["msg_123"],
    });
    for (const [eventId, type] of [["evt_old_attention", "question"], ["evt_older_blocked", "blocked"]] as const) {
      session.store.appendEvent(runId, {
        schemaVersion: SCHEMA_VERSION,
        eventId,
        runId,
        parentRunId: session.identity.parentRunId,
        type,
        createdAt: new Date(Date.now() - 1000).toISOString(),
        summary: "older attention should not deliver",
        body: "raw terminal transcript SECRET_TOKEN should not deliver",
        wake: true,
      });
    }
    session.store.writeResult(createRunResult({
      runId,
      parentRunId: session.identity.parentRunId,
      agentName: "worker",
      displayName: "Mira",
      harness: "claude",
      launchHarness: "claude-tmux-interactive",
      resultParser: "mcp-terminal",
      model: "claude-sonnet",
      effort: "high",
      executionMode: "dangerous-auth",
      claudeTransport: "mcp",
      livenessState: "comatose",
      livenessReason: "Parent message not acknowledged after nudge probe",
      tmuxSocket: join(session.cwd, "logs", "tmux-with-secret-token.sock"),
      tmuxSession: "async-subagents-test",
      tmuxPane: "%1",
      transcriptPath: join(session.cwd, "logs", "tmux-transcript.log"),
      pendingAckMessageIds: ["msg_123"],
      state: "failed",
      summary: "Claude tmux session exited without result",
      body: "raw terminal transcript SECRET_TOKEN should not be inline",
      error: { code: "CLAUDE_EXITED_WITHOUT_RESULT", message: "tmux exited" },
    }));
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["question", "blocked", "result", "completed", "failed"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();
    const wakeups = session.sent.filter((item) => item.message?.customType === "async-subagent-message");
    assert.equal(wakeups.filter((item) => item.message.details?.result?.runId === runId).length, 1);
    assert.equal(wakeups.some((item) => /older attention should not deliver|raw terminal transcript SECRET_TOKEN/.test(item.message.content)), false);
    const wakeup = wakeups.find((item) => item.message.details?.result?.runId === runId)!;
    assert.match(wakeup.message.content, /NOT USER INPUT/);
    assert.match(wakeup.message.content, /Harness: claude/);
    assert.match(wakeup.message.content, /@Mira \(worker\/claude\)/);
    assert.match(wakeup.message.content, /State: failed \(comatose\)/);
    assert.match(wakeup.message.content, /Parent message not acknowledged/);
    assert.doesNotMatch(wakeup.message.content, /raw terminal transcript/);
    assert.doesNotMatch(wakeup.message.content, /SECRET_TOKEN/);
    assert.equal(wakeup.message.details?.event, undefined);
    assert.equal(wakeup.message.details?.result?.harness, "claude");
    assert.equal(wakeup.message.details?.result?.body, undefined);
    assert.equal(wakeup.message.details?.body, undefined);
    assert.equal(wakeup.message.details?.bodyAvailable, true);
    assert.equal(wakeup.message.details?.bodyTruncation?.suppressed, true);

    await session.poll();
    assert.equal(session.sent.filter((item) => item.message?.customType === "async-subagent-message").length, 1);
  } finally {
    await session.shutdown();
  }
});

test("Claude liveness wakeup delivers harness and liveness state through the Pi extension boundary", async () => {
  const session = await withStartedExtension();
  try {
    const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "running");
    session.store.writeStatus({
      ...session.store.readStatus(runId),
      displayName: "Mira",
      harness: "claude",
      launchHarness: "claude-tmux-interactive",
      resultParser: "mcp-terminal",
      claudeTransport: "mcp",
      livenessState: "comatose",
      livenessReason: "No terminal output after nudge",
    });
    session.store.appendEvent(runId, {
      schemaVersion: SCHEMA_VERSION,
      eventId: "evt_liveness_comatose",
      runId,
      parentRunId: session.identity.parentRunId,
      type: "liveness",
      createdAt: new Date().toISOString(),
      summary: "comatose",
      wake: true,
      data: { state: "comatose", details: { reason: "No terminal output after nudge" } },
    });
    writeDeliverySubscription(session.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: session.identity.parentRunId,
      runId,
      notifyOn: ["liveness"],
      createdAt: new Date().toISOString(),
    });

    await session.poll();
    const wakeup = session.sent.find((item) => item.message?.customType === "async-subagent-message");
    assert.ok(wakeup);
    assert.match(wakeup.message.content, /ASYNC SUBAGENT ATTENTION/);
    assert.match(wakeup.message.content, /Harness: claude/);
    assert.match(wakeup.message.content, /State: comatose/);
    assert.match(wakeup.message.content, /No terminal output after nudge/);
    assert.match(wakeup.message.content, /subagent_status/);
    assert.match(wakeup.message.content, /subagent_interrupt/);
    assert.equal(wakeup.message.details?.event?.type, "liveness");
    assert.deepEqual(wakeup.message.details?.next, [
      { tool: "subagent_status", args: { runIds: [runId], includeEvents: true, maxEvents: 10 } },
      { tool: "subagent_interrupt", args: { runId, action: "cancel" } },
    ]);
  } finally {
    await session.shutdown();
  }
});

test("Claude liveness attention states include actionable next steps", async () => {
  const session = await withStartedExtension();
  try {
    const states = ["ack_pending", "rate_limited", "comatose", "stale_transport", "orphaned_process"] as const;
    for (const state of states) {
      const runId = createRun(session.store, session.cwd, session.identity.parentRunId, "running");
      session.store.writeStatus({
        ...session.store.readStatus(runId),
        displayName: `Claude-${state}`,
        harness: "claude",
        launchHarness: "claude-tmux-interactive",
        resultParser: "mcp-terminal",
        claudeTransport: "mcp",
        livenessState: state,
        livenessReason: `${state} reason`,
      });
      session.store.appendEvent(runId, {
        schemaVersion: SCHEMA_VERSION,
        eventId: `evt_liveness_${state}`,
        runId,
        parentRunId: session.identity.parentRunId,
        type: "liveness",
        createdAt: new Date().toISOString(),
        summary: state,
        wake: true,
        data: { state },
      });
      writeDeliverySubscription(session.store, { schemaVersion: SCHEMA_VERSION, parentRunId: session.identity.parentRunId, runId, notifyOn: ["liveness"], createdAt: new Date().toISOString() });
    }

    await session.poll();
    const wakeups = session.sent.filter((item) => item.message?.customType === "async-subagent-message");
    assert.equal(wakeups.length, states.length);
    for (const state of states) {
      const wakeup = wakeups.find((item) => item.message.details?.event?.data?.state === state);
      assert.ok(wakeup, `${state} wakeup delivered`);
      assert.match(wakeup.message.content, /subagent_status/);
      const next = wakeup.message.details?.next;
      assert.equal(next?.[0]?.tool, "subagent_status");
      if (["comatose", "stale_transport", "orphaned_process"].includes(state)) {
        assert.match(wakeup.message.content, /subagent_interrupt/);
        assert.equal(next?.[1]?.tool, "subagent_interrupt");
      }
    }
  } finally {
    await session.shutdown();
  }
});
