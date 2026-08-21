import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireRootSessionLease } from "../src/leases.js";
import { createRunResult } from "../src/result.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { pollWakeups, markWakeupHandled, markDeliveredWakeupHandled, isWakeupKeyHandled, readDeliverySubscriptions, writeDeliverySubscription, resultDeliveryKey, deliveryCacheStatsForTest, resetDeliveryCacheStatsForTest, TERMINAL_WAKEUP_RETRY_INTERVAL_MS } from "../extensions/pi/wakeups.js";

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

test("delivery and subscription mutations preserve cross-process unions", async () => {
  const { root, store } = workspace();
  const parentRunId = "root_concurrent";
  const wakeupsUrl = new URL("../extensions/pi/wakeups.js", import.meta.url).href;
  const storeUrl = new URL("../src/runStore.js", import.meta.url).href;
  const typesUrl = new URL("../src/types.js", import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { RunStore } from ${JSON.stringify(storeUrl)};
    import { SCHEMA_VERSION } from ${JSON.stringify(typesUrl)};
    import { isWakeupKeyHandled, markWakeupKeyHandled, readDeliverySubscriptions, writeDeliverySubscription } from ${JSON.stringify(wakeupsUrl)};
    const [cwd, runRoot, parentRunId, index, barrierDir] = process.argv.slice(1);
    const store = new RunStore({ cwd, runRoot });
    // Prime both process-local metadata caches before any worker mutates. The
    // locked transaction must bypass these snapshots, even under contention.
    readDeliverySubscriptions(store, parentRunId);
    isWakeupKeyHandled(store, parentRunId, "prime");
    writeFileSync(join(barrierDir, \`ready.\${index}\`), "");
    const signal = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(join(barrierDir, "go"))) Atomics.wait(signal, 0, 0, 5);
    writeDeliverySubscription(store, { schemaVersion: SCHEMA_VERSION, parentRunId, runId: \`run_\${index}\`, notifyOn: ["question"], createdAt: new Date().toISOString() });
    markWakeupKeyHandled(store, parentRunId, \`event:run_\${index}:evt\`);
  `;
  const barrierDir = mkdtempSync(join(tmpdir(), "async-subagents-union-barrier-"));
  const workers = Array.from({ length: 8 }, (_, index) => new Promise<void>((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, store.runRoot, parentRunId, String(index), barrierDir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectWorker);
    child.once("exit", (code) => code === 0 ? resolveWorker() : rejectWorker(new Error(`worker exited ${code}: ${stderr}`)));
  }));
  const readyDeadline = Date.now() + 10_000;
  while (Array.from({ length: 8 }, (_, index) => existsSync(join(barrierDir, `ready.${index}`))).some((ready) => !ready)) {
    if (Date.now() >= readyDeadline) throw new Error("workers did not reach union-test barrier");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  writeFileSync(join(barrierDir, "go"), "");
  await Promise.all(workers);

  assert.deepEqual(readDeliverySubscriptions(store, parentRunId).map((item) => item.runId).sort(), Array.from({ length: 8 }, (_, index) => `run_${index}`));
  for (let index = 0; index < 8; index += 1) assert.equal(isWakeupKeyHandled(store, parentRunId, `event:run_${index}:evt`), true);
});

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

test("unacknowledged full-inline terminal wakeups retry after the retry interval", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const runId = createCompletedRun(store, root, parentRunId);
  const nowMs = Date.now();
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: TERMINAL_WAKEUP_RETRY_INTERVAL_MS * 2, nowMs });

  const first = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a", nowMs });
  assert.equal(first.length, 1);
  assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a", nowMs: nowMs + TERMINAL_WAKEUP_RETRY_INTERVAL_MS - 1 }).length, 0);

  const retry = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a", nowMs: nowMs + TERMINAL_WAKEUP_RETRY_INTERVAL_MS });
  assert.equal(retry.length, 1);
  assert.equal(retry[0]?.runId, runId);
  assert.equal(retry[0]?.deliveryKey, first[0]?.deliveryKey);
  assert.equal(store.readStatus(runId).resultReady, true);
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
  writeFileSync(path, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: {} }, null, 2)}\n`, "utf8");
  assert.equal(isWakeupKeyHandled(store, parentRunId, key), false);
  const before = statSync(path);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: { [key]: new Date().toISOString() } }, null, 2)}\n`, "utf8");
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

test("later parent answers resolve historical attention while later attention still delivers once", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(createInitialStatus({ runId, parentRunId, rootSessionId: parentRunId, agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: root, state: "blocked" }));
  const append = (eventId: string, type: "question" | "blocked" | "message.received", messageType?: "answer" | "instruction") => store.appendEvent(runId, {
    schemaVersion: SCHEMA_VERSION, eventId, runId, parentRunId, type, createdAt: new Date().toISOString(), summary: eventId, wake: type !== "message.received", data: messageType ? { messageType } : undefined,
  });
  append("evt_old_question", "question");
  append("evt_old_blocked", "blocked");
  append("evt_answer", "message.received", "answer");
  append("evt_new_question", "question");
  writeDeliverySubscription(store, { schemaVersion: SCHEMA_VERSION, parentRunId, runId, notifyOn: ["question", "blocked"], createdAt: new Date().toISOString() });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });

  const first = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.deepEqual(first.map((delivery) => delivery.message.event?.eventId), ["evt_new_question"]);
  assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" }).length, 0);
});

test("poll commit aborts when root-session lease changes after discovery", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(createInitialStatus({ runId, parentRunId, rootSessionId: parentRunId, agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: root, state: "blocked" }));
  store.appendEvent(runId, { schemaVersion: SCHEMA_VERSION, eventId: "evt_takeover", runId, parentRunId, type: "blocked", createdAt: new Date().toISOString(), summary: "takeover", wake: true });
  writeDeliverySubscription(store, { schemaVersion: SCHEMA_VERSION, parentRunId, runId, notifyOn: ["blocked"], createdAt: new Date().toISOString() });
  const nowMs = Date.now();
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000, nowMs });
  const originalReadEvents = store.readEvents.bind(store);
  let reads = 0;
  store.readEvents = ((...args: Parameters<RunStore["readEvents"]>) => {
    reads += 1;
    const result = originalReadEvents(...args);
    if (reads === 2) acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_b", ttlMs: 10_000, nowMs: nowMs + 1 });
    return result;
  }) as RunStore["readEvents"];

  assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a", nowMs: nowMs + 2 }).length, 0);
  const statePath = deliveryStatePath(store, parentRunId);
  const deliveryState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { delivered: {}, handled: {} };
  assert.deepEqual(deliveryState.delivered, {});
  assert.deepEqual(deliveryState.handled, {});
  store.readEvents = originalReadEvents;
  assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_b", nowMs: nowMs + 2 }).length, 1);
});

test("poll cleanup releases a claim when commit revalidation faults", () => {
  const { root, store } = workspace();
  const parentRunId = "root_test";
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(createInitialStatus({ runId, parentRunId, rootSessionId: parentRunId, agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: root, state: "blocked" }));
  store.appendEvent(runId, { schemaVersion: SCHEMA_VERSION, eventId: "evt_fault", runId, parentRunId, type: "blocked", createdAt: new Date().toISOString(), summary: "fault", wake: true });
  writeDeliverySubscription(store, { schemaVersion: SCHEMA_VERSION, parentRunId, runId, notifyOn: ["blocked"], createdAt: new Date().toISOString() });
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a", ttlMs: 10_000 });
  const originalReadEvents = store.readEvents.bind(store);
  let reads = 0;
  store.readEvents = ((...args: Parameters<RunStore["readEvents"]>) => {
    reads += 1;
    if (reads === 2) throw new Error("revalidation fault");
    return originalReadEvents(...args);
  }) as RunStore["readEvents"];

  assert.throws(() => pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" }), /revalidation fault/);
  const claimsDir = join(resolve(store.runRoot, ".."), "delivery", "claims");
  assert.deepEqual(existsSync(claimsDir) ? readdirSync(claimsDir) : [], []);
  store.readEvents = originalReadEvents;
  assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" }).length, 1);
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

/**
 * A terminal run written exactly the way the supervisor writes one, with the
 * subscription and the status flag under the test's control. `resultReady: false`
 * with a durable result.json on disk is the torn finalization the store really
 * contains — 818 such runs at the time this was written.
 */
function createTerminalRun(store: RunStore, cwd: string, parentRunId: string, options: {
  state: "completed" | "failed" | "cancelled" | "expired";
  notifyOn: string[];
  resultReady: boolean;
}): string {
  const { runId } = store.createRunDirectory({ cwd, parentRunId, rootSessionId: parentRunId });
  const status = createInitialStatus({
    runId,
    parentRunId,
    rootSessionId: parentRunId,
    agentName: "worker",
    agentSource: "builtin",
    definitionPath: "/builtin/worker.md",
    mode: "oneshot",
    cwd,
    state: options.state,
  });
  store.writeStatus({ ...status, resultReady: options.resultReady });
  store.writeResult(createRunResult({
    runId,
    parentRunId,
    agentName: "worker",
    state: options.state,
    summary: options.state === "expired" ? "Time budget expired" : "Done",
  }));
  writeDeliverySubscription(store, {
    schemaVersion: SCHEMA_VERSION,
    parentRunId,
    runId,
    notifyOn: options.notifyOn as never,
    createdAt: new Date().toISOString(),
  });
  return runId;
}

test("a terminal result is delivered even when notifyOn omits its state", () => {
  const { root, store } = workspace();
  const parentRunId = "root_notifyon";
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a" });
  // The subscription a Pi lead actually wrote in the field. It omits "expired",
  // so the lane went quiet and the lead waited on a child that was already dead.
  const runId = createTerminalRun(store, root, parentRunId, {
    state: "expired",
    notifyOn: ["completed", "failed", "blocked"],
    resultReady: true,
  });

  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.runId, runId);
  assert.equal(deliveries[0]?.message.state, "expired");
});

test("cancellation is delivered to a parent subscribed only to attention events", () => {
  const { root, store } = workspace();
  const parentRunId = "root_notifyon_cancel";
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a" });
  const runId = createTerminalRun(store, root, parentRunId, {
    state: "cancelled",
    notifyOn: ["blocked"],
    resultReady: true,
  });

  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.runId, runId);
  assert.equal(deliveries[0]?.message.state, "cancelled");
});

test("a durable result is delivered when status.json never recorded resultReady", () => {
  const { root, store } = workspace();
  const parentRunId = "root_torn";
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a" });
  const runId = createTerminalRun(store, root, parentRunId, {
    state: "expired",
    notifyOn: ["result", "completed", "failed", "cancelled", "expired"],
    resultReady: false,
  });

  const deliveries = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.runId, runId);
  assert.equal(deliveries[0]?.message.state, "expired");
});

test("terminal delivery stays idempotent once handled", () => {
  const { root, store } = workspace();
  const parentRunId = "root_notifyon_dedupe";
  acquireRootSessionLease({ cwd: root, rootSessionId: parentRunId, ownerId: "owner_a" });
  createTerminalRun(store, root, parentRunId, {
    state: "expired",
    notifyOn: ["completed"],
    resultReady: false,
  });

  const [delivery] = pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" });
  assert.ok(delivery);
  markWakeupHandled(store, parentRunId, delivery.runId);
  assert.equal(pollWakeups({ store, parentRunId, rootSessionId: parentRunId, ownerId: "owner_a" }).length, 0);
});
