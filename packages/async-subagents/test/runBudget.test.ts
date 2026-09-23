import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSubagent } from "../src/start.js";
import { RunStore } from "../src/runStore.js";
import { waitSubagents } from "../src/wait.js";
import { createRootSession } from "../src/rootSession.js";
import { buildSubagentTools } from "../extensions/pi/tools.js";
import { watchSubagents } from "../src/watch.js";
import { spawnSync } from "node:child_process";
import { createRunEvent } from "../src/events.js";
import { acquireRootSessionLease } from "../src/leases.js";
import { pollWakeups, writeDeliverySubscription } from "../extensions/pi/wakeups.js";
import { SCHEMA_VERSION } from "../src/types.js";

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "run-budget-"));
  mkdirSync(join(cwd, ".agents"));
  writeFileSync(join(cwd, ".agents", "scout.md"), "---\ndescription: Budget test.\ntools: []\nmaxRunSeconds: 4\n---\nTest scout.\n");
  const store = new RunStore({ cwd });
  const root = createRootSession({ cwd, rootSessionId: "budget_test" });
  const tools = Object.fromEntries(buildSubagentTools({
    getRootIdentity: () => root,
    startSubagent: (input) => startSubagent({ ...input, fake: { mode: "child", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } }),
  }).map(tool => [tool.name, tool]));
  const call = (name: string, params: Record<string, unknown>) => tools[name].execute("test", params, undefined, undefined, { cwd });
  return { cwd, store, root, call };
}

test("override expires on real supervisor timer and terminal continuation resets or overrides budget", { timeout: 22000 }, async () => {
  const w = setup();
  const started = await startSubagent({ agent: "scout", task: "Work", cwd: w.cwd, runRoot: w.store.runRoot, parentRunId: w.root.parentRunId, rootSessionId: w.root.rootSessionId, maxRunSeconds: 1, fake: { mode: "child", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } });
  assert.equal(started.effectiveMaxRunMs, 1000);
  assert.equal(started.maxRunSource, "override");
  const expired = await waitSubagents(w.store, { runIds: [started.runId], timeoutMs: 10000, pollIntervalMs: 50 });
  assert.equal(expired.results[0]?.state, "expired");
  assert.equal(w.store.readResult(started.runId)?.maxRunSource, "override");
  const invalid = await w.call("subagent_continue", { runId: started.runId, additionalRunSeconds: 1 });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /maxRunSeconds/);
  const continued = await w.call("subagent_continue", { runId: started.runId, maxRunSeconds: 1 });
  assert.equal(continued.isError, undefined);
  const next = continued.details.runId as string;
  assert.equal(w.store.readStatus(next).effectiveMaxRunMs, 1000);
  assert.equal(w.store.readStatus(next).maxRunSource, "override");
  assert.equal((await waitSubagents(w.store, { runIds: [next], timeoutMs: 10000, pollIntervalMs: 50 })).results[0]?.state, "expired");
  const defaulted = await w.call("subagent_continue", { runId: next });
  assert.equal(defaulted.isError, undefined);
  assert.equal(w.store.readStatus(defaulted.details.runId as string).effectiveMaxRunMs, 4000);
  assert.equal(w.store.readStatus(defaulted.details.runId as string).maxRunSource, "definition");
  await w.call("subagent_interrupt", { runId: defaulted.details.runId as string, action: "cancel" });
});

test("invalid overrides fail before allocation and legacy status/result remain readable", async () => {
  const w = setup();
  for (const maxRunSeconds of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(startSubagent({ agent: "scout", task: "No", cwd: w.cwd, runRoot: w.store.runRoot, maxRunSeconds }), /positive integer/);
  }
  const started = await startSubagent({ agent: "scout", task: "Done", cwd: w.cwd, runRoot: w.store.runRoot, parentRunId: w.root.parentRunId, rootSessionId: w.root.rootSessionId, fake: { mode: "immediate", body: "done" } });
  assert.equal(w.store.readStatus(started.runId).maxRunSource, "definition");
  const paths = w.store.pathsFor({ runId: started.runId });
  for (const name of ["status.json", "result.json"]) {
    const file = join(paths.runDir, name);
    const data = JSON.parse(readFileSync(file, "utf8"));
    delete data.maxRunSource;
    writeFileSync(file, JSON.stringify(data));
  }
  assert.equal(w.store.readStatus(started.runId).maxRunSource, undefined);
  assert.equal(w.store.readResult(started.runId)?.maxRunSource, undefined);
  writeFileSync(join(w.cwd, ".agents", "plain.md"), "---\ndescription: Config default test.\ntools: []\n---\nPlain.");
  const configDefault = await startSubagent({ agent: "plain", task: "Done", cwd: w.cwd, runRoot: w.store.runRoot, fake: { mode: "immediate", body: "done" } });
  assert.equal(configDefault.effectiveMaxRunMs, 1_800_000);
  assert.equal(w.store.readResult(configDefault.runId)?.maxRunSource, "config");
  assert.equal((await w.call("subagent_status", { runIds: [started.runId] })).isError, undefined);
  const lines: string[] = [];
  await watchSubagents({ cwd: w.cwd, store: w.store, runIds: [started.runId], intervalSeconds: 0.01, write: line => lines.push(line) });
  assert.equal(JSON.parse(lines[0]!).state, "completed");
  assert.equal((await w.call("subagent_continue", { runId: started.runId, maxRunSeconds: 2 })).isError, undefined);
});

test("CLI rejects meaningless start timeout", () => {
  const cli = new URL("../src/cli.js", import.meta.url);
  const outcome = spawnSync(process.execPath, [cli.pathname, "start", "--agent", "scout", "--task", "x", "--timeout-seconds", "2"], { encoding: "utf8", timeout: 15000, env: { ...process.env, ASYNC_SUBAGENTS_HOME: mkdtempSync(join(tmpdir(), "budget-cli-")) } });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stdout, /--timeout-seconds is only for blocking run/);
});

test("parent-paused resume still applies additional seconds to live supervisor", { timeout: 15000 }, async () => {
  const w = setup();
  const started = await startSubagent({ agent: "scout", task: "Work", cwd: w.cwd, runRoot: w.store.runRoot, parentRunId: w.root.parentRunId, rootSessionId: w.root.rootSessionId, fake: { mode: "child", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } });
  const pause = await w.call("subagent_interrupt", { runId: started.runId, action: "pause" });
  assert.equal(pause.isError, undefined);
  const waitPaused = async () => {
    for (let i = 0; i < 100; i++) {
      if (w.store.readStatus(started.runId).state === "paused") return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("supervisor did not pause");
  };
  await waitPaused();
  const invalid = await w.call("subagent_continue", { runId: started.runId, maxRunSeconds: 1 });
  assert.equal(invalid.isError, true);
  const resumed = await w.call("subagent_continue", { runId: started.runId, additionalRunSeconds: 0.2 });
  assert.equal(resumed.isError, undefined);
  assert.equal((await waitSubagents(w.store, { runIds: [started.runId], timeoutMs: 10000, pollIntervalMs: 50 })).results[0]?.state, "expired");
  assert.equal(w.store.readStatus(started.runId).timeout?.additionalRunSeconds, 0.2);
});

test("paused wakeup next-action resumes a parent-paused run", { timeout: 15000 }, async () => {
  const w = setup();
  const started = await startSubagent({ agent: "scout", task: "Work", cwd: w.cwd, runRoot: w.store.runRoot, parentRunId: w.root.parentRunId, rootSessionId: w.root.rootSessionId, fake: { mode: "child", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } });
  try {
    assert.equal((await w.call("subagent_interrupt", { runId: started.runId, action: "pause" })).isError, undefined);
    for (let i = 0; i < 100 && w.store.readStatus(started.runId).state !== "paused"; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(w.store.readStatus(started.runId).state, "paused");
    w.store.appendEvent(started.runId, createRunEvent({ sequence: w.store.readEvents(started.runId).records.length + 1, runId: started.runId, parentRunId: w.root.parentRunId, type: "liveness", data: { state: "paused" }, summary: "Parent paused", wake: true }));
    writeDeliverySubscription(w.store, { schemaVersion: SCHEMA_VERSION, parentRunId: w.root.parentRunId, runId: started.runId, notifyOn: ["liveness"], createdAt: new Date().toISOString() });
    acquireRootSessionLease({ cwd: w.cwd, rootSessionId: w.root.rootSessionId, ownerId: "budget-test", ttlMs: 10000 });
    const wakeup = pollWakeups({ store: w.store, parentRunId: w.root.parentRunId, rootSessionId: w.root.rootSessionId, ownerId: "budget-test" }).find(delivery => delivery.message.state === "paused");
    assert.ok(wakeup, "real paused wakeup delivered");
    const next = wakeup.message.next?.find(action => action.tool === "subagent_continue");
    assert.ok(next, "paused wakeup offers continue");
    const response = await w.call(next.tool, next.args);
    assert.equal(response.isError, undefined, JSON.stringify(response.details));
    assert.equal(response.details.controlQueued, true);
  } finally {
    await w.call("subagent_interrupt", { runId: started.runId, action: "cancel" });
  }
});
