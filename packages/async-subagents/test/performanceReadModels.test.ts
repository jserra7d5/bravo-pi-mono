import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderLiveWidget } from "../extensions/pi/liveWidget.js";
import { readWatcherSnapshot } from "../src/watcher.js";
import { pollWakeups, writeDeliverySubscription } from "../extensions/pi/wakeups.js";
import { acquireRootSessionLease } from "../src/leases.js";
import { pruneRuns } from "../src/retention.js";
import { createRunResult } from "../src/result.js";
import { resetSummaryCacheStatsForTest, RunStore, summaryCacheStatsForTest } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { SCHEMA_VERSION, type EventType, type RunState } from "../src/types.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-perf-"));
  return { root, store: new RunStore({ cwd: root }), parentRunId: "root_perf" };
}

function addRun(store: RunStore, cwd: string, parentRunId: string, state: RunState, updatedAt = new Date().toISOString()) {
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
    state,
  });
  store.writeStatus({ ...status, updatedAt, lastActivityAt: updatedAt, summary: `${state} ${runId}`, resultReady: false });
  return runId;
}

test("live widget uses summary read-models instead of reading every run's events/results", () => {
  const w = workspace();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  for (let i = 0; i < 250; i += 1) addRun(w.store, w.root, w.parentRunId, "completed", old);
  addRun(w.store, w.root, w.parentRunId, "running");

  let readEvents = 0;
  let readResults = 0;
  const originalReadEvents = w.store.readEvents.bind(w.store);
  const originalReadResult = w.store.readResult.bind(w.store);
  w.store.readEvents = ((...args: Parameters<RunStore["readEvents"]>) => {
    readEvents += 1;
    return originalReadEvents(...args);
  }) as RunStore["readEvents"];
  w.store.readResult = ((...args: Parameters<RunStore["readResult"]>) => {
    readResults += 1;
    return originalReadResult(...args);
  }) as RunStore["readResult"];

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  assert.ok(lines.length > 0);
  assert.equal(readEvents, 0);
  assert.equal(readResults, 0);
});

test("live widget does not full re-read the warmed run index on unchanged ticks", () => {
  const w = workspace();
  for (let i = 0; i < 25; i += 1) addRun(w.store, w.root, w.parentRunId, "completed");
  renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });

  (w.store as unknown as { readRunIndexUncached: () => never; readRunIndexSourcesUncached: () => never }).readRunIndexUncached = () => {
    throw new Error("unexpected full index re-read");
  };
  (w.store as unknown as { readRunIndexSourcesUncached: () => never }).readRunIndexSourcesUncached = () => {
    throw new Error("unexpected full index source re-read");
  };

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  assert.ok(lines.length > 0);
});

test("live widget summary cache avoids disk re-reading unchanged terminal summaries while reflecting active mutations and new runs", () => {
  const w = workspace();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  for (let i = 0; i < 200; i += 1) addRun(w.store, w.root, w.parentRunId, "completed", old);
  const activeRunId = addRun(w.store, w.root, w.parentRunId, "running");

  let records = w.store.listRecentRuns({ parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  resetSummaryCacheStatsForTest();
  let lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, records, width: 72 });
  assert.ok(lines.join("\n").includes(activeRunId));
  const warmDiskReads = summaryCacheStatsForTest().diskReads;
  assert.ok(warmDiskReads > 0);

  records = w.store.listRecentRuns({ parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, records, width: 72 });
  assert.ok(lines.join("\n").includes(activeRunId));
  assert.equal(summaryCacheStatsForTest().diskReads, warmDiskReads);

  w.store.writeStatus({ ...w.store.readStatus(activeRunId), summary: "mutated active summary", updatedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() });
  records = w.store.listRecentRuns({ parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, records, width: 72 });
  assert.ok(lines.join("\n").includes("mutated active summary"));

  const newRunId = addRun(w.store, w.root, w.parentRunId, "running");
  records = w.store.listRecentRuns({ parentRunId: w.parentRunId, rootSessionId: w.parentRunId });
  lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, records, width: 72 });
  assert.ok(lines.join("\n").includes(newRunId));
});

test("RunStore listActiveOrRecentRuns includes recent terminal runs and excludes expired terminal runs", () => {
  const w = workspace();
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const terminalVisibleMs = 1_000;
  const recentRunId = addRun(w.store, w.root, w.parentRunId, "completed", new Date(baseMs).toISOString());
  const oldRunId = addRun(w.store, w.root, w.parentRunId, "failed", new Date(baseMs - 1).toISOString());

  const records = w.store.listActiveOrRecentRuns(
    { parentRunId: w.parentRunId, rootSessionId: w.parentRunId },
    { nowMs: baseMs + terminalVisibleMs, terminalVisibleMs },
  );

  assert.deepEqual(records.map((record) => record.runId), [recentRunId]);
  assert.equal(records.some((record) => record.runId === oldRunId), false);
});

test("RunStore listActiveOrRecentRuns retains old terminal runs with ready results", () => {
  const w = workspace();
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const readyRunId = addRun(w.store, w.root, w.parentRunId, "completed", new Date(baseMs).toISOString());
  w.store.writeStatus({ ...w.store.readStatus(readyRunId), resultReady: true, updatedAt: new Date(baseMs).toISOString(), lastActivityAt: new Date(baseMs).toISOString() });

  const records = w.store.listActiveOrRecentRuns(
    { parentRunId: w.parentRunId, rootSessionId: w.parentRunId },
    { nowMs: baseMs + 10_000, terminalVisibleMs: 1_000 },
  );

  assert.deepEqual(records.map((record) => record.runId), [readyRunId]);
});

test("RunStore listActiveOrRecentRuns invalidates cached terminal exclusions when summaries mutate", () => {
  const w = workspace();
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const runId = addRun(w.store, w.root, w.parentRunId, "completed", new Date(baseMs).toISOString());
  const filter = { parentRunId: w.parentRunId, rootSessionId: w.parentRunId };
  const options = { nowMs: baseMs + 10_000, terminalVisibleMs: 1_000 };

  assert.deepEqual(w.store.listActiveOrRecentRuns(filter, options), []);

  w.store.writeStatus({
    ...w.store.readStatus(runId),
    state: "running",
    summary: "reactivated after cached exclusion",
    updatedAt: new Date(baseMs + 10_000).toISOString(),
    lastActivityAt: new Date(baseMs + 10_000).toISOString(),
  });

  const records = w.store.listActiveOrRecentRuns(filter, options);
  assert.deepEqual(records.map((record) => record.runId), [runId]);
});

test("RunStore listActiveOrRecentRuns exclusion cache is time-bound across visibility boundary", () => {
  const w = workspace();
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const terminalVisibleMs = 1_000;
  const runId = addRun(w.store, w.root, w.parentRunId, "completed", new Date(baseMs).toISOString());
  const filter = { parentRunId: w.parentRunId, rootSessionId: w.parentRunId };

  assert.deepEqual(w.store.listActiveOrRecentRuns(filter, { nowMs: baseMs + terminalVisibleMs + 1, terminalVisibleMs }), []);

  const recordsAtBoundary = w.store.listActiveOrRecentRuns(filter, { nowMs: baseMs + terminalVisibleMs, terminalVisibleMs });
  assert.deepEqual(recordsAtBoundary.map((record) => record.runId), [runId]);

  const recordsAfterBoundary = w.store.listActiveOrRecentRuns(filter, { nowMs: baseMs + terminalVisibleMs + 1, terminalVisibleMs });
  assert.deepEqual(recordsAfterBoundary, []);
});

test("manual retention dry-run skips active and unhandled result-ready runs", () => {
  const w = workspace();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const activeRunId = addRun(w.store, w.root, w.parentRunId, "running", old);
  const readyRunId = addRun(w.store, w.root, w.parentRunId, "completed", old);
  w.store.writeStatus({ ...w.store.readStatus(readyRunId), resultReady: true, updatedAt: old });
  const collectableRunId = addRun(w.store, w.root, w.parentRunId, "completed", old);

  const dry = pruneRuns(w.store, { olderThanMs: 60_000, nowMs: Date.now(), dryRun: true });
  assert.deepEqual(dry.prunedRunIds, [collectableRunId]);
  assert.equal(existsSync(w.store.pathsFor({ runId: collectableRunId }).runDir), true);
  assert.ok(dry.skipped.find((skip) => skip.runId === activeRunId && skip.reason === "active"));
  assert.ok(dry.skipped.find((skip) => skip.runId === readyRunId && skip.reason === "unhandled-wakeup"));

  const pruned = pruneRuns(w.store, { olderThanMs: 60_000, nowMs: Date.now(), dryRun: false });
  assert.deepEqual(pruned.prunedRunIds, [collectableRunId]);
  assert.equal(existsSync(join(w.store.runRoot, collectableRunId)), false);
});

test("terminal result with missing summary delivers safe metadata once", () => {
  const w = workspace();
  const runId = addRun(w.store, w.root, w.parentRunId, "completed");
  w.store.writeStatus({ ...w.store.readStatus(runId), resultReady: true });
  w.store.writeResult(createRunResult({ runId, parentRunId: w.parentRunId, agentName: "scout", state: "completed", summary: "done", body: "full body once" }));
  unlinkSync(w.store.summaryPath(runId));
  writeDeliverySubscription(w.store, { schemaVersion: SCHEMA_VERSION, parentRunId: w.parentRunId, runId, notifyOn: ["result"], createdAt: new Date().toISOString() });

  const nowMs = Date.now();
  acquireRootSessionLease({ cwd: w.root, rootSessionId: w.parentRunId, ownerId: "owner", nowMs, ttlMs: 10_000 });
  const first = pollWakeups({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, ownerId: "owner", limit: 5, nowMs });
  assert.equal(first.length, 1);
  assert.equal(first[0].message.body, "full body once");
  assert.equal(first[0].message.bodyAvailable, true);
  assert.equal(first[0].message.result?.body, undefined);
  const second = pollWakeups({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, ownerId: "owner", limit: 5, nowMs: nowMs + 1 });
  assert.equal(second.length, 0);
});

test("two pending blocked/question events before poll both deliver once", () => {
  const w = workspace();
  const runId = addRun(w.store, w.root, w.parentRunId, "blocked");
  for (const [index, eventType] of (["blocked", "question"] as EventType[]).entries()) {
    w.store.appendEvent(runId, {
      schemaVersion: SCHEMA_VERSION,
      eventId: `evt_${index}`,
      runId,
      parentRunId: w.parentRunId,
      type: eventType,
      createdAt: new Date(Date.now() + index).toISOString(),
      summary: `${eventType} summary`,
      wake: true,
    });
  }
  writeDeliverySubscription(w.store, { schemaVersion: SCHEMA_VERSION, parentRunId: w.parentRunId, runId, notifyOn: ["blocked", "question"], createdAt: new Date().toISOString() });

  const nowMs = Date.now();
  acquireRootSessionLease({ cwd: w.root, rootSessionId: w.parentRunId, ownerId: "owner", nowMs, ttlMs: 10_000 });
  const first = pollWakeups({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, ownerId: "owner", limit: 5, nowMs });
  assert.deepEqual(first.map((delivery) => delivery.message.event?.type), ["blocked", "question"]);
  const second = pollWakeups({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, ownerId: "owner", limit: 5, nowMs: nowMs + 1 });
  assert.equal(second.length, 0);
});

test("watcher and live widget fall back when summary is missing", () => {
  const w = workspace();
  const runId = addRun(w.store, w.root, w.parentRunId, "running");
  unlinkSync(w.store.summaryPath(runId));

  const snapshot = readWatcherSnapshot(w.store, { parentRunId: w.parentRunId });
  assert.deepEqual(snapshot.activeRunIds, [runId]);
  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, width: 72 });
  assert.ok(lines.some((line) => line.includes(runId) || line.includes("running")));
});

test("rebuildDerivedIndexes restores latest wake event metadata", () => {
  const w = workspace();
  const runId = addRun(w.store, w.root, w.parentRunId, "blocked");
  w.store.appendEvent(runId, {
    schemaVersion: SCHEMA_VERSION,
    eventId: "evt_blocked",
    runId,
    parentRunId: w.parentRunId,
    type: "blocked",
    createdAt: new Date().toISOString(),
    summary: "blocked summary",
    wake: true,
  });
  unlinkSync(w.store.summaryPath(runId));

  w.store.rebuildDerivedIndexes();

  const summary = w.store.readRunSummary(runId);
  assert.equal(summary?.latestWakeEvent?.eventId, "evt_blocked");
  assert.equal(summary?.hasWakeEvents, true);
});

test("corrupt summary falls back to canonical status", () => {
  const w = workspace();
  const runId = addRun(w.store, w.root, w.parentRunId, "running");
  writeFileSync(w.store.summaryPath(runId), "{not json", "utf8");
  const summary = w.store.readRunSummary(runId);
  assert.equal(summary?.runId, runId);
  assert.equal(summary?.state, "running");
});

test("wakeup polling reads full result and scans only that run's events for terminal attention suppression", () => {
  const w = workspace();
  for (let i = 0; i < 200; i += 1) addRun(w.store, w.root, w.parentRunId, "completed");
  const readyRunId = addRun(w.store, w.root, w.parentRunId, "completed");
  w.store.writeStatus({ ...w.store.readStatus(readyRunId), resultReady: true });
  w.store.writeResult(createRunResult({ runId: readyRunId, parentRunId: w.parentRunId, agentName: "scout", state: "completed", summary: "done", body: "full body" }));
  writeDeliverySubscription(w.store, { schemaVersion: SCHEMA_VERSION, parentRunId: w.parentRunId, runId: readyRunId, notifyOn: ["result"], createdAt: new Date().toISOString() });

  let readEvents = 0;
  let readResults = 0;
  const originalReadEvents = w.store.readEvents.bind(w.store);
  const originalReadResult = w.store.readResult.bind(w.store);
  w.store.readEvents = ((...args: Parameters<RunStore["readEvents"]>) => {
    readEvents += 1;
    return originalReadEvents(...args);
  }) as RunStore["readEvents"];
  w.store.readResult = ((...args: Parameters<RunStore["readResult"]>) => {
    readResults += 1;
    return originalReadResult(...args);
  }) as RunStore["readResult"];

  const nowMs = Date.now();
  acquireRootSessionLease({ cwd: w.root, rootSessionId: w.parentRunId, ownerId: "owner", nowMs, ttlMs: 10_000 });
  const deliveries = pollWakeups({ store: w.store, parentRunId: w.parentRunId, rootSessionId: w.parentRunId, ownerId: "owner", limit: 5, nowMs });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].message.body, "full body");
  assert.equal(deliveries[0].message.bodyAvailable, true);
  assert.equal(deliveries[0].message.result?.body, undefined);
  assert.equal(readEvents, 1);
  assert.equal(readResults, 1);
});

test("Claude observability metadata survives status summary and watcher rows", () => {
  const w = workspace();
  const runId = addRun(w.store, w.root, w.parentRunId, "running");
  const status = w.store.readStatus(runId);
  w.store.writeStatus({
    ...status,
    harness: "claude",
    launchHarness: "claude-tmux-interactive",
    resultParser: "mcp-terminal",
    model: "claude-sonnet",
    requestedModel: "sonnet",
    resolvedModel: "claude-sonnet",
    effort: "high",
    executionMode: "dangerous-auth",
    claudeTransport: "mcp",
    livenessState: "rate_limited",
    livenessReason: "rate limit until later",
    terminalOutputBytes: 1234,
    lastTerminalOutputAt: "2026-01-01T00:00:00.000Z",
    lastMcpCallAt: "2026-01-01T00:01:00.000Z",
    lastNudgeAt: "2026-01-01T00:02:00.000Z",
    pendingAckMessageIds: ["msg_1"],
    tmuxSocket: "/very/long/tmux/socket/path.sock",
    tmuxSession: "session",
    tmuxPane: "%1",
    supervisorPid: 11,
    childPid: 12,
    panePid: 13,
    processGroupId: 13,
    transcriptPath: "/tmp/transcript.log",
    resolvedSkills: ["long-skill"],
  });
  const summary = w.store.readRunSummary(runId);
  assert.equal(summary?.harness, "claude");
  assert.equal(summary?.launchHarness, "claude-tmux-interactive");
  assert.equal(summary?.resultParser, "mcp-terminal");
  assert.equal(summary?.livenessState, "rate_limited");
  assert.deepEqual(summary?.pendingAckMessageIds, ["msg_1"]);
  const row = readWatcherSnapshot(w.store, { parentRunId: w.parentRunId }).rows.find((item) => item.runId === runId);
  assert.equal(row?.harness, "claude");
  assert.equal(row?.livenessReason, "rate limit until later");
  assert.equal(row?.tmuxSocket, "/very/long/tmux/socket/path.sock");
});
