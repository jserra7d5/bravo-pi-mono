import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { finalizeTerminalRun, mutateNonterminalRun, mutateNonterminalStatus, reconcileDeadProcessUnderLock, reconcileUnderLock, SUPERVISOR_LAUNCH_GRACE_MS, TERMINAL_DRAIN_GRACE_MS } from "../src/lifecycle.js";
import { withRunMutationLock } from "../src/runLock.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-lifecycle-"));
  return { root, runRoot: join(root, ".subagents", "runs") };
}

function assistantLine(cost: number): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
    },
  });
}

test("finalizeTerminalRun extracts assistant cost from the pi session log and writes it to metrics.cost.total", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
  });
  writeFileSync(paths.piSessionPath, [assistantLine(0.05), assistantLine(0.07), assistantLine(0.13)].join("\n") + "\n", "utf8");

  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "scout",
      agentSource: "project",
      definitionPath: join(w.root, ".agents", "scout.md"),
      mode: "oneshot",
      cwd: w.root,
      piSessionPath: paths.piSessionPath,
      state: "running",
    }),
  );

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.ok(result.metrics, "expected metrics on result");
  assert.ok(result.metrics?.cost, "expected metrics.cost on result");
  const total = result.metrics?.cost?.total;
  assert.ok(typeof total === "number");
  assert.ok(Math.abs(total - 0.25) < 1e-9, `expected ~0.25, got ${total}`);

  const status = store.readStatus(runId);
  assert.ok(Math.abs((status.metrics?.cost?.total ?? -1) - 0.25) < 1e-9);
});

test("finalizeTerminalRun leaves metrics undefined when there is no pi session log to read", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
  });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "scout",
      agentSource: "project",
      definitionPath: join(w.root, ".agents", "scout.md"),
      mode: "oneshot",
      cwd: w.root,
      // No piSessionPath wired here, and the JSONL was never written.
      sessionPolicy: "none",
      state: "running",
    }),
  );

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.equal(result.metrics, undefined);
  assert.equal(store.readStatus(runId).metrics, undefined);
});

test("finalizeTerminalRun leaves metrics undefined when the session log has no assistant turns", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
  });
  writeFileSync(paths.piSessionPath, JSON.stringify({ type: "message", message: { role: "user" } }) + "\n", "utf8");
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "scout",
      agentSource: "project",
      definitionPath: join(w.root, ".agents", "scout.md"),
      mode: "oneshot",
      cwd: w.root,
      piSessionPath: paths.piSessionPath,
      state: "running",
    }),
  );

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.equal(result.metrics, undefined);
});

test("mutateNonterminalRun applies event and question transition under one lifecycle lock", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  store.writeStatus(createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" }));

  const mutation = await mutateNonterminalRun(store, {
    runId,
    type: "question",
    summary: "Which branch?",
    wake: true,
    writerRole: "child-runtime",
  });

  assert.equal(mutation.applied, true);
  assert.equal(store.readEvents(runId).records.at(-1)?.type, "question");
  assert.equal(store.readStatus(runId).state, "waiting_for_input");
  assert.equal(store.readStatus(runId).needs, "Which branch?");
  assert.equal(store.readStatus(runId).lastEventId, mutation.applied ? mutation.event.eventId : undefined);

  await mutateNonterminalRun(store, {
    runId,
    type: "message.received",
    summary: "Received parent answer",
    data: { messageType: "answer", messageId: "msg_1" },
    writerRole: "child-runtime",
  });
  assert.equal(store.readStatus(runId).state, "running");
  assert.equal(store.readStatus(runId).needs, null);
});

test("mutateNonterminalStatus unblocks delivered parent input without appending an event", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const initial = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "blocked" });
  store.writeStatus({ ...initial, needs: "parent answer", summary: "Waiting", updatedAt: "2026-01-01T00:00:00.000Z" });
  const eventCount = store.readEvents(runId).records.length;

  const mutation = await mutateNonterminalStatus(store, {
    runId,
    writerRole: "child-runtime",
    statusPatch: (current) => ({ state: current.state === "blocked" ? "running" : current.state, needs: null, summary: "Parent input delivered" }),
  });

  assert.equal(mutation.applied, true);
  assert.equal(mutation.status.state, "running");
  assert.equal(mutation.status.needs, null);
  assert.equal(mutation.status.writerRole, "child-runtime");
  assert.notEqual(mutation.status.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(store.readEvents(runId).records.length, eventCount);
  assert.equal(store.readRunSummary(runId)?.state, "running");
  assert.equal(store.readRunSummary(runId)?.needs, null);
  assert.equal(store.readRunSummary(runId)?.summary, "Parent input delivered");
});

test("queued status-only fallback cannot resurrect a terminal run", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  store.writeStatus(createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "blocked" }));

  let fallback!: Promise<Awaited<ReturnType<typeof mutateNonterminalStatus>>>;
  await withRunMutationLock(paths.runDir, async () => {
    fallback = mutateNonterminalStatus(store, {
      runId,
      writerRole: "child-runtime",
      statusPatch: { state: "running", needs: null },
      terminalBehavior: "noop",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    finalizeTerminalRun(store, { runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "parent-runtime", summary: "Done" });
  });

  assert.equal((await fallback).applied, false);
  assert.equal(store.readStatus(runId).state, "completed");
  assert.equal(store.readEvents(runId).records.filter((event) => event.type === "completed").length, 1);
  await assert.rejects(() => mutateNonterminalStatus(store, { runId, writerRole: "child-runtime", statusPatch: { state: "running" } }), /run is terminal/);
});

test("queued nonterminal mutation cannot resurrect a terminal run", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  store.writeStatus(createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" }));

  let lateMutation!: Promise<Awaited<ReturnType<typeof mutateNonterminalRun>>>;
  await withRunMutationLock(paths.runDir, async () => {
    lateMutation = mutateNonterminalRun(store, {
      runId,
      type: "blocked",
      summary: "late blocker",
      writerRole: "child-runtime",
      statusPatch: { state: "blocked", needs: "late blocker" },
      terminalBehavior: "noop",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    finalizeTerminalRun(store, { runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "parent-runtime", summary: "Done" });
  });

  assert.equal((await lateMutation).applied, false);
  assert.equal(store.readStatus(runId).state, "completed");
  assert.equal(store.readStatus(runId).needs, undefined);
  assert.equal(store.readEvents(runId).records.some((event) => event.summary === "late blocker"), false);
  await assert.rejects(() => mutateNonterminalRun(store, { runId, type: "question", summary: "too late", writerRole: "child-runtime" }), /run is terminal/);
});

test("dead-process reconciliation no-ops when supervisor completion wins the lifecycle lock", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" });
  store.writeStatus({ ...status, pid: 4242 });

  let reconciliation!: Promise<Awaited<ReturnType<typeof reconcileDeadProcessUnderLock>>>;
  await withRunMutationLock(paths.runDir, async () => {
    reconciliation = reconcileDeadProcessUnderLock(store, runId, { probe: () => "dead" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    finalizeTerminalRun(store, {
      runId,
      parentRunId: "root_test",
      agentName: "scout",
      state: "completed",
      writerRole: "child-runtime",
      summary: "Supervisor completed",
    });
  });

  const reconciled = await reconciliation;
  assert.equal(reconciled.promoted, false);
  assert.equal(reconciled.status.state, "completed");
  assert.equal(store.readResult(runId)?.state, "completed");
  const events = store.readEvents(runId).records;
  assert.equal(events.filter((event) => event.type === "result").length, 1);
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
  assert.equal(events.some((event) => event.type === "failed"), false);
});

test("dead child with live supervisor delegates terminal publication so completion wins", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "claude-scout", agentSource: "builtin", definitionPath: "/builtin/claude-scout.md", mode: "oneshot", cwd: w.root, state: "running" });
  store.writeStatus({
    ...status,
    pid: 4242,
    supervisorPid: 5252,
    supervisorHost: hostname(),
    supervisorStartedAtToken: "linux-proc-start:supervisor",
  });

  const reconciled = await reconcileDeadProcessUnderLock(store, runId, {
    probe: () => "dead",
    supervisorProbe: () => ({ alive: true, identity: "linux-proc-start:supervisor" }),
  });
  assert.equal(reconciled.promoted, false);
  assert.equal(store.readStatus(runId).state, "running");
  assert.equal(store.readResult(runId), undefined);

  finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "claude-scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "MCP completion drained",
  });
  assert.equal(store.readResult(runId)?.state, "completed");
  assert.deepEqual(store.readEvents(runId).records.map((event) => event.type), ["result", "completed"]);
});

test("dead Claude MCP orphan waits for drain grace then writes canonical failure artifacts", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const drainStartedAt = "2026-01-01T00:00:00.000Z";
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "claude-scout", agentSource: "builtin", definitionPath: "/builtin/claude-scout.md", mode: "oneshot", harness: "claude", cwd: w.root, state: "running" });
  store.writeStatus({
    ...status,
    claudeTransport: "mcp",
    pid: 4242,
    supervisorPid: 5252,
    supervisorHost: hostname(),
    supervisorStartedAtToken: "linux-proc-start:supervisor",
    updatedAt: drainStartedAt,
    lastTerminalOutputAt: drainStartedAt,
  });
  const options = {
    probe: () => "dead" as const,
    supervisorProbe: () => ({ alive: false, identity: "linux-proc-start:supervisor" }),
  };

  const draining = await reconcileDeadProcessUnderLock(store, runId, {
    ...options,
    nowMs: Date.parse(drainStartedAt) + TERMINAL_DRAIN_GRACE_MS,
  });
  assert.equal(draining.promoted, false);
  assert.equal(store.readResult(runId), undefined);

  const orphaned = await reconcileDeadProcessUnderLock(store, runId, {
    ...options,
    nowMs: Date.parse(drainStartedAt) + TERMINAL_DRAIN_GRACE_MS + 1,
  });
  assert.equal(orphaned.promoted, true);
  assert.equal(orphaned.status.state, "failed");
  assert.equal(orphaned.status.resultReady, true);
  assert.equal(store.readResult(runId)?.error?.code, "PARENT_PROCESS_EXITED_WITHOUT_TERMINAL_STATUS");
  assert.deepEqual(store.readEvents(runId).records.map((event) => event.type), ["result", "failed"]);
});

test("dead-process reconciliation writes coherent terminal result, events, and status", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" });
  store.writeStatus({ ...status, pid: 4242 });

  const reconciled = await reconcileDeadProcessUnderLock(store, runId, { probe: () => "dead" });

  assert.equal(reconciled.promoted, true);
  assert.equal(reconciled.status.state, "failed");
  assert.equal(reconciled.status.resultReady, true);
  assert.equal(reconciled.status.processHealth, "dead");
  assert.equal(store.readResult(runId)?.error?.code, "PARENT_PROCESS_EXITED_WITHOUT_TERMINAL_STATUS");
  assert.deepEqual(store.readEvents(runId).records.map((event) => event.type), ["result", "failed"]);
});

test("reconcileUnderLock repairs torn finalization before probing the supervisor", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" });
  store.writeStatus(status);
  const result = finalizeTerminalRun(store, { runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Recovered" });
  store.writeStatus({ ...status, updatedAt: new Date().toISOString() });

  const reconciled = await reconcileUnderLock(store, runId, { probe: () => { throw new Error("result repair must precede probe"); } });
  assert.equal(reconciled.repairedResult, true);
  assert.equal(reconciled.status.state, "completed");
  assert.equal(store.readResult(runId)?.runId, result.runId);
});

test("reconcileUnderLock leaves a consumed terminal run byte-identical", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" });
  store.writeStatus(status);
  finalizeTerminalRun(store, { runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Consumed" });
  store.writeStatus({ ...store.readStatus(runId), resultReady: false, updatedAt: "2020-01-01T00:00:00.000Z" });
  const before = readFileSync(paths.statusPath);

  const reconciled = await reconcileUnderLock(store, runId);

  assert.equal(reconciled.repairedResult, false);
  assert.equal(reconciled.status.resultReady, false);
  assert.deepEqual(readFileSync(paths.statusPath), before);
});

test("reconcileUnderLock promotes dead same-host supervisor and is idempotent", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" });
  store.writeStatus({ ...status, supervisorPid: 12345, supervisorHost: hostname(), supervisorStartedAtToken: "linux-proc-start:1" });

  const first = await reconcileUnderLock(store, runId, { probe: () => ({ alive: false, identity: "linux-proc-start:1" }) });
  const second = await reconcileUnderLock(store, runId, { probe: () => ({ alive: false, identity: "linux-proc-start:1" }) });
  assert.equal(first.promoted, true);
  assert.equal(second.promoted, false);
  assert.equal(second.status.error?.code, "SUPERVISOR_DIED");
  assert.equal(store.readEvents(runId).records.filter((event) => event.type === "failed").length, 1);
});

test("reconcileUnderLock never promotes EPERM, identity mismatch, or foreign host", async () => {
  for (const [label, patch, snapshot] of [
    ["eperm", { supervisorHost: hostname(), supervisorStartedAtToken: "token-a" }, { permissionDenied: true }],
    ["reused", { supervisorHost: hostname(), supervisorStartedAtToken: "token-a" }, { alive: true, identity: "token-b" }],
    ["foreign", { supervisorHost: "different-host", supervisorStartedAtToken: "token-a" }, { alive: false, identity: "token-a" }],
  ] as const) {
    const w = workspace();
    const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
    const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
    const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "running" });
    store.writeStatus({ ...status, supervisorPid: 12345, ...patch });
    const reconciled = await reconcileUnderLock(store, runId, { probe: () => snapshot });
    assert.equal(reconciled.promoted, false, label);
    assert.equal(reconciled.supervisorAlive, "unknown", label);
    assert.equal(reconciled.status.state, "running", label);
  }
});

test("reconcileUnderLock promotes stale unowned queued run after launch grace", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  const status = createInitialStatus({ runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd: w.root, state: "queued" });
  store.writeStatus(status);
  const reconciled = await reconcileUnderLock(store, runId, { nowMs: Date.parse(status.createdAt) + SUPERVISOR_LAUNCH_GRACE_MS });
  assert.equal(reconciled.status.state, "failed");
  assert.equal(reconciled.status.error?.code, "SUPERVISOR_LAUNCH_FAILED");
});

test("finalizeTerminalRun does not charge shared continuation session history", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({
    cwd: w.root,
    parentRunId: "root_test",
    rootSessionId: "root_test",
    continuedFromRunId: "run_original",
    continuationRootRunId: "run_original",
    continuationSequence: 1,
  });
  writeFileSync(paths.piSessionPath, [assistantLine(0.05), assistantLine(0.07), assistantLine(0.13)].join("\n") + "\n", "utf8");

  const status = createInitialStatus({
    runId,
    parentRunId: "root_test",
    rootSessionId: "root_test",
    agentName: "scout",
    agentSource: "project",
    definitionPath: join(w.root, ".agents", "scout.md"),
    mode: "oneshot",
    cwd: w.root,
    piSessionPath: paths.piSessionPath,
    continuedFromRunId: "run_original",
    continuationRootRunId: "run_original",
    continuationSequence: 1,
    continuationOfPiSessionPath: paths.piSessionPath,
    state: "running",
  });
  store.writeStatus({ ...status, metrics: { tokens: { total: 42 }, cost: { total: 99 } } });

  const result = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "completed",
    writerRole: "child-runtime",
    summary: "Done",
  });

  assert.equal(result.metrics?.cost, undefined);
  assert.equal(result.metrics?.tokens?.total, 42);
  assert.equal(store.readStatus(runId).metrics?.cost, undefined);
  assert.equal(store.readStatus(runId).metrics?.tokens?.total, 42);
});
