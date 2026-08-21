import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor } from "../src/supervisor.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for a condition instead of sleeping a guessed interval. The timeout is a
 * failure bound, not a timing assertion — generous on a loaded box, and it names
 * what it was waiting for so a real hang is not mistaken for scheduling noise.
 */
async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await delay(20);
  }
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
  const { cwd, runRoot, parentRunId, runId, paths } = createQueuedRun();
  const warning = 'Warning: No models match pattern "bravo-codex-balanced/gpt-5.6-luna"';

  // What this asserts is that expiry keeps the child's stderr as the body. Racing a
  // short wall-clock budget against node's startup made that a coin flip under the
  // parallel suite: if the process had not flushed yet, the body was empty. Instead
  // give the budget room it cannot reach on its own, wait until the supervisor has
  // actually recorded the stderr, then drive expiry from the control channel.
  const supervisor = runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    effectiveMaxRunMs: 60_000,
    command: {
      command: process.execPath,
      args: ["-e", `console.error(${JSON.stringify(warning)}); setInterval(() => {}, 1000);`],
      cwd,
      env: {},
    },
  });

  const stderrPath = join(paths.logsDir, "stderr.log");
  await waitUntil(
    () => existsSync(stderrPath) && readFileSync(stderrPath, "utf8").includes(warning),
    "supervisor to record the child's stderr",
  );
  // Smallest budget the runtime accepts, applied from zero elapsed: expiry fires on
  // the next timer tick, through the same expireForBudget path a wall-clock deadline
  // would take.
  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "extend", additionalRunSeconds: 0.001 })}\n`, "utf8");

  const result = await supervisor;
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

const UPSTREAM_REFUSAL =
  "Codex error: Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting";

/**
 * A real child process that refuses on its first N invocations exactly the way Pi
 * does — the upstream string on stderr, exit code 1 — and succeeds after that. The
 * attempt counter lives on disk so it survives the relaunch, which is the whole
 * point: the supervisor must spawn a genuinely new process for the count to move.
 */
function refusingChild(cwd: string, refusals: number, successOutput = "recovered result") {
  const counterPath = join(cwd, "refusal-count");
  const script = `
    const { existsSync, readFileSync, writeFileSync } = require("node:fs");
    const counter = ${JSON.stringify(counterPath)};
    const seen = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    writeFileSync(counter, String(seen + 1), "utf8");
    if (seen < ${refusals}) {
      process.stderr.write(${JSON.stringify(UPSTREAM_REFUSAL)} + "\\n");
      process.exit(1);
    }
    process.stdout.write(${JSON.stringify(successOutput)});
  `;
  return { command: process.execPath, args: ["-e", script], cwd, env: {}, counterPath };
}

test("a child refused by the upstream content filter is relaunched, not failed", async () => {
  const { cwd, runRoot, parentRunId, store, runId } = createQueuedRun();
  const child = refusingChild(cwd, 1);

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: child,
    transientRetry: { maxAttempts: 2, backoffMs: 10 },
  });

  assert.equal(result.state, "completed");
  assert.equal(result.success, true);
  // The refusal text must not survive into the reported body.
  assert.match(result.body ?? "", /recovered result/);
  assert.doesNotMatch(result.body ?? "", /usage policy/);
  assert.equal(readFileSync(child.counterPath, "utf8"), "2");

  const status = store.readStatus(runId);
  assert.equal(status.transientRetries, 1);
  const events = store.readEvents(runId).records;
  const retryEvent = events.find((event) => event.data?.reason === "upstream_prompt_flag");
  assert.ok(retryEvent, "expected a progress event recording the relaunch");
  assert.equal(retryEvent?.data?.attempt, 1);
  assert.equal(retryEvent?.wake, false);
});

test("relaunching stops at maxAttempts and reports the refusal", async () => {
  const { cwd, runRoot, parentRunId, store, runId } = createQueuedRun();
  const child = refusingChild(cwd, 99);

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: child,
    transientRetry: { maxAttempts: 2, backoffMs: 10 },
  });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "CHILD_EXITED");
  assert.equal((result.error?.details as { transientRetries?: number })?.transientRetries, 2);
  // Initial attempt plus two relaunches.
  assert.equal(readFileSync(child.counterPath, "utf8"), "3");
  assert.equal(store.readStatus(runId).transientRetries, 2);
});

test("a failure that is not an upstream refusal is never relaunched", async () => {
  const { cwd, runRoot, parentRunId, runId } = createQueuedRun();
  const counterPath = join(cwd, "plain-count");
  const script = `
    const { existsSync, readFileSync, writeFileSync } = require("node:fs");
    const counter = ${JSON.stringify(counterPath)};
    const seen = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    writeFileSync(counter, String(seen + 1), "utf8");
    process.stderr.write("TypeError: cannot read properties of undefined\\n");
    process.exit(1);
  `;

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: { command: process.execPath, args: ["-e", script], cwd, env: {} },
    transientRetry: { maxAttempts: 2, backoffMs: 10 },
  });

  assert.equal(result.state, "failed");
  assert.equal(readFileSync(counterPath, "utf8"), "1");
});

test("cancelling during the relaunch backoff settles the run instead of hanging", async () => {
  const { cwd, runRoot, parentRunId, store, runId, paths } = createQueuedRun();
  const child = refusingChild(cwd, 99);

  const supervisor = runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: child,
    // Long enough that the cancel lands while no child process exists.
    transientRetry: { maxAttempts: 3, backoffMs: 3_000 },
  });

  await delay(300);
  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "cancel", reason: "parent stopped the lane" })}\n`, "utf8");

  const result = await Promise.race([
    supervisor,
    delay(2_000).then(() => "hung" as const),
  ]);
  assert.notEqual(result, "hung", "cancel during backoff must settle the run");
  assert.equal(typeof result === "string" ? result : result.state, "cancelled");
  assert.equal(store.readStatus(runId).state, "cancelled");
  // The pending relaunch must not have spawned after the cancel.
  await delay(3_200);
  assert.equal(readFileSync(child.counterPath, "utf8"), "1");
});

test("pausing during the relaunch backoff holds the relaunch until resume", async () => {
  const { cwd, runRoot, parentRunId, store, runId, paths } = createQueuedRun();
  const child = refusingChild(cwd, 1);

  const supervisor = runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: child,
    transientRetry: { maxAttempts: 2, backoffMs: 400 },
  });

  // Land the pause inside the backoff window, while no child process exists.
  await delay(180);
  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "pause", reason: "parent checkpoint" })}\n`, "utf8");
  await delay(700);

  // The relaunch must not have fired on its own timer.
  assert.equal(store.readStatus(runId).state, "paused");
  assert.equal(readFileSync(child.counterPath, "utf8"), "1");

  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "resume" })}\n`, "utf8");
  const result = await supervisor;
  assert.equal(result.state, "completed");
  assert.equal(readFileSync(child.counterPath, "utf8"), "2");
});

test("a child that merely prints the refusal text is not relaunched", async () => {
  const { cwd, runRoot, parentRunId, runId } = createQueuedRun();
  const counterPath = join(cwd, "quoting-count");
  // The refusal text reaches stdout the way a child quoting a brief or echoing a
  // log would produce it, while the real failure is something else entirely.
  const script = `
    const { existsSync, readFileSync, writeFileSync } = require("node:fs");
    const counter = ${JSON.stringify(counterPath)};
    const seen = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    writeFileSync(counter, String(seen + 1), "utf8");
    process.stdout.write(${JSON.stringify(UPSTREAM_REFUSAL)} + "\\n");
    process.stderr.write("quoted the incident report above; " + ${JSON.stringify(UPSTREAM_REFUSAL)} + "\\n");
    process.stderr.write("TypeError: cannot read properties of undefined\\n");
    process.exit(1);
  `;

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: { command: process.execPath, args: ["-e", script], cwd, env: {} },
    transientRetry: { maxAttempts: 2, backoffMs: 10 },
  });

  assert.equal(result.state, "failed");
  assert.equal(readFileSync(counterPath, "utf8"), "1");
});

test("the time budget expiring during the relaunch backoff settles the run and spawns nothing", async () => {
  const { cwd, runRoot, parentRunId, store, runId } = createQueuedRun();
  const child = refusingChild(cwd, 99);

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: child,
    // The budget runs out while the relaunch is still counting down.
    effectiveMaxRunMs: 250,
    transientRetry: { maxAttempts: 3, backoffMs: 2_000 },
  });

  assert.equal(result.state, "expired");
  assert.equal(result.error?.code, "MAX_RUN_SECONDS_EXPIRED");
  assert.equal(readFileSync(child.counterPath, "utf8"), "1");
  await delay(2_200);
  // The backoff was charged to the run, so nothing spawns after expiry.
  assert.equal(readFileSync(child.counterPath, "utf8"), "1");
  assert.equal(store.readStatus(runId).state, "expired");
});

test("a relaunch that cannot spawn settles the run once", async () => {
  const { cwd, runRoot, parentRunId, store, runId } = createQueuedRun();
  const child = refusingChild(cwd, 99);

  const result = await runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    command: child,
    transientRetry: {
      maxAttempts: 2,
      backoffMs: 10,
      command: { command: join(cwd, "does-not-exist"), args: [], cwd, env: {} },
    },
  });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "SPAWN_FAILED");
  assert.equal(store.readStatus(runId).state, "failed");
});
