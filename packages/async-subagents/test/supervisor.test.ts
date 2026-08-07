import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor } from "../src/supervisor.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createQueuedRun() {
  const cwd = mkdtempSync(join(tmpdir(), "async-supervisor-cwd-"));
  const runRoot = join(cwd, ".runs");
  const parentRunId = "root_supervisor";
  const store = new RunStore({ cwd, runRoot });
  const { runId, paths } = store.createRunDirectory({ cwd, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(createInitialStatus({
    runId,
    parentRunId,
    rootSessionId: parentRunId,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd,
    state: "queued",
  }));
  return { cwd, runRoot, parentRunId, store, runId, paths };
}

test("manual pause suspends runtime budget and resume reinstalls timeout", async () => {
  const { cwd, runRoot, parentRunId, store, runId, paths } = createQueuedRun();

  const supervisor = runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    effectiveMaxRunMs: 500,
    command: {
      command: process.execPath,
      args: ["-e", "console.log('captured checkpoint'); setInterval(() => {}, 1000);"],
      cwd,
      env: {},
    },
  });

  await delay(60);
  const owned = store.readStatus(runId);
  assert.equal(owned.supervisorPid, process.pid);
  assert.equal(owned.supervisorHost, hostname());
  assert.ok(owned.supervisorStartedAtToken);
  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "pause", reason: "manual checkpoint" })}\n`, "utf8");
  await delay(740);
  let status = store.readStatus(runId);
  assert.equal(status.state, "paused");
  assert.equal(status.summary, "manual checkpoint");
  assert.notEqual(status.timeout?.reason, "time budget expired");

  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "resume", additionalRunSeconds: 0.1 })}\n`, "utf8");
  const result = await supervisor;
  status = store.readStatus(runId);
  assert.equal(status.state, "expired");
  assert.equal(result.state, "expired");
  assert.equal(result.error?.code, "MAX_RUN_SECONDS_EXPIRED");
  assert.equal(result.summary, "Time budget expired");
  assert.equal(result.body, "captured checkpoint");
  assert.equal(status.summary, "Time budget expired");
});

test("expiration error summary wins while harmless stderr remains the body", async () => {
  const { cwd, runRoot, parentRunId, runId } = createQueuedRun();
  const warning = 'Warning: No models match pattern "bravo-codex-balanced/gpt-5.6-luna"';

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    effectiveMaxRunMs: 100,
    command: {
      command: process.execPath,
      args: ["-e", `console.error(${JSON.stringify(warning)}); setInterval(() => {}, 1000);`],
      cwd,
      env: {},
    },
  });

  assert.equal(result.state, "expired");
  assert.equal(result.error?.code, "MAX_RUN_SECONDS_EXPIRED");
  assert.equal(result.summary, "Time budget expired");
  assert.equal(result.body, warning);
});

test("a blocked child holds the runtime budget and resumes spending it when unblocked", async () => {
  const { cwd, runRoot, parentRunId, store, runId } = createQueuedRun();

  const supervisor = runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    effectiveMaxRunMs: 700,
    command: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd,
      env: {},
    },
  });

  // The child runtime marks itself blocked when it needs the parent. Time spent
  // waiting on a human is not time the agent spent working, so it must not burn
  // the budget — otherwise a run dies at the deadline having done nothing since.
  await delay(150);
  store.writeStatus({ ...store.readStatus(runId), state: "blocked", summary: "needs scope" });
  await delay(900);
  assert.equal(store.readStatus(runId).state, "blocked");

  store.writeStatus({ ...store.readStatus(runId), state: "running", summary: "unblocked" });
  const result = await supervisor;
  assert.equal(result.state, "expired");
  assert.equal(result.error?.code, "MAX_RUN_SECONDS_EXPIRED");
});

test("a child killed before it reports salvages its body from the events it did write", async () => {
  const { cwd, runRoot, parentRunId, runId, paths } = createQueuedRun();
  const eventsPath = join(paths.runDir, "events.jsonl");
  const event = {
    schemaVersion: 1,
    eventId: "evt_salvage",
    sequence: 1,
    runId,
    parentRunId,
    type: "progress",
    createdAt: new Date().toISOString(),
    summary: "Mapped the call graph",
    body: "supervisor.ts owns the budget timers; tools.ts owns the scope grant.",
    wake: false,
  };

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    effectiveMaxRunMs: 300,
    command: {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").appendFileSync(${JSON.stringify(eventsPath)}, ${JSON.stringify(`${JSON.stringify(event)}\n`)}); setInterval(() => {}, 1000);`,
      ],
      cwd,
      env: {},
    },
  });

  assert.equal(result.state, "expired");
  // Everything the agent actually said was in events.jsonl; stdout was empty
  // because it never reached its final report. Shipping an empty body would
  // throw away work that is already done.
  assert.match(result.body ?? "", /# Reconstructed report/);
  assert.match(result.body ?? "", /Mapped the call graph/);
  assert.match(result.body ?? "", /supervisor\.ts owns the budget timers/);
});

test("a failed child keeps stderr as its body instead of a salvaged report", async () => {
  const { cwd, runRoot, parentRunId, runId, paths } = createQueuedRun();
  const eventsPath = join(paths.runDir, "events.jsonl");
  const event = {
    schemaVersion: 1,
    eventId: "evt_failed",
    sequence: 1,
    runId,
    parentRunId,
    type: "progress",
    createdAt: new Date().toISOString(),
    summary: "Partial work",
    body: "Read three files.",
    wake: false,
  };

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").appendFileSync(${JSON.stringify(eventsPath)}, ${JSON.stringify(`${JSON.stringify(event)}\n`)}); console.error("TypeError: cannot read properties of undefined"); process.exit(1);`,
      ],
      cwd,
      env: {},
    },
  });

  assert.equal(result.state, "failed");
  // On a crash the stderr IS the diagnostic. A salvaged report would outrank it
  // in the body and hide why the run died; the events remain in events.jsonl.
  assert.match(result.body ?? "", /TypeError: cannot read properties of undefined/);
  assert.doesNotMatch(result.body ?? "", /# Reconstructed report/);
});

test("supervisor removes lifecycle listeners after child settles", async () => {
  const { cwd, runRoot, parentRunId, runId } = createQueuedRun();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"] as const;
  const before = new Map(signals.map((signal) => [signal, process.listenerCount(signal)]));

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: {
      command: process.execPath,
      args: ["-e", "console.log('successful child summary');"],
      cwd,
      env: {},
    },
  });

  assert.equal(result.state, "completed");
  assert.equal(result.summary, "successful child summary");
  for (const signal of signals) {
    assert.equal(process.listenerCount(signal), before.get(signal));
  }
});
