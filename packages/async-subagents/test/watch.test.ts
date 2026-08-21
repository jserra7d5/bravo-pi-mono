import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { finalizeTerminalRun } from "../src/lifecycle.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus, updateRunStatus } from "../src/status.js";
import { watchSubagents, type WatchLine } from "../src/watch.js";

function sink(lines: WatchLine[]): (line: string) => void {
  return (line) => lines.push(JSON.parse(line) as WatchLine);
}

/**
 * The timeout is a failure bound, not a timing assertion. Three seconds was not
 * enough for a cold `node dist/src/cli.js supervisor` to spawn and claim ownership
 * on a loaded box, which made every caller intermittently fail for scheduling
 * reasons. Bound it well above any real startup and name what it waited for, so a
 * genuine hang is distinguishable from a slow machine.
 */
async function waitUntil(predicate: () => boolean, description = "condition", timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function run(state: "running" | "blocked" = "running") {
  const cwd = mkdtempSync(join(tmpdir(), "async-subagents-watch-"));
  const store = new RunStore({ cwd });
  const { runId, paths } = store.createRunDirectory({ cwd, parentRunId: "root_watch" });
  store.writeStatus(createInitialStatus({ runId, parentRunId: "root_watch", agentName: "scout", agentSource: "builtin", definitionPath: "/builtin/scout.md", mode: "oneshot", cwd, state }));
  return { cwd, store, runId, paths };
}

test("watchSubagents promotes a SIGKILLed real supervisor under the run lock", async () => {
  const w = run();
  const inputPath = join(w.paths.runDir, "supervisor-input.test.json");
  writeFileSync(inputPath, JSON.stringify({
    runId: w.runId,
    runRoot: w.store.runRoot,
    cwd: w.cwd,
    parentRunId: "root_watch",
    agentName: "scout",
    command: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: w.cwd, env: {} },
  }), "utf8");
  const supervisor = spawn(process.execPath, [join(process.cwd(), "dist", "src", "cli.js"), "supervisor", "--input", inputPath], { stdio: "ignore" });
  let childPid: number | undefined;
  try {
    await waitUntil(() => {
      const status = w.store.readStatus(w.runId);
      childPid = status.childPid ?? status.pid;
      return status.state === "running" && status.supervisorPid === supervisor.pid && Boolean(status.supervisorStartedAtToken);
    }, "the spawned supervisor to claim ownership of the run");
    supervisor.kill("SIGKILL");
    await new Promise<void>((resolve) => supervisor.once("exit", () => resolve()));
    const lines: WatchLine[] = [];
    await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, write: sink(lines) });
    // Promotion is what matters, not whether a busy poll slipped in ahead of it.
    assert.ok(lines.some((line) => line.state === "failed"), `expected a failed line, got ${JSON.stringify(lines)}`);
    assert.equal(w.store.readStatus(w.runId).error?.code, "SUPERVISOR_DIED");
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    if (childPid) {
      try { process.kill(-childPid, "SIGKILL"); } catch { try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ } }
    }
  }
});

test("watchSubagents emits real transitions as NDJSON-shaped bucket-first records", async () => {
  const w = run();
  const lines: WatchLine[] = [];
  setTimeout(() => {
    const status = w.store.readStatus(w.runId);
    w.store.writeStatus(updateRunStatus(status, { state: "blocked", summary: "Need parent decision" }));
  }, 20);
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, includeResultBody: false, write: sink(lines) });
  assert.deepEqual(lines.map((line) => line.bucket).filter(Boolean), ["busy", "attention"]);
  assert.match(lines[0]?.summary ?? "", /^busy:/);
  assert.match(lines[1]?.summary ?? "", /^attention:/);
  assert.equal(lines[1]?.attentionReason, "blocked");
  assert.deepEqual(lines.at(-1), { allSettled: true });

  const blocked = w.store.readStatus(w.runId);
  w.store.writeStatus(updateRunStatus(blocked, { state: "running", summary: "Continued" }));
  setTimeout(() => finalizeTerminalRun(w.store, { runId: w.runId, parentRunId: "root_watch", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Done after continue" }), 20);
  const continued: WatchLine[] = [];
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, includeResultBody: false, write: sink(continued) });
  assert.deepEqual(continued.map((line) => line.bucket).filter(Boolean), ["busy", "terminal"]);
});

test("watchSubagents repairs torn result finalization and reports result body once globally", async () => {
  const w = run();
  const running = w.store.readStatus(w.runId);
  const result = finalizeTerminalRun(w.store, { runId: w.runId, parentRunId: "root_watch", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Finished", body: "full child result" });
  w.store.writeStatus(running);

  const first: WatchLine[] = [];
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, write: sink(first) });
  assert.equal(first[0]?.state, "completed");
  assert.equal(first[0]?.resultBody, "full child result");
  assert.equal(w.store.readStatus(w.runId).resultReady, true);
  assert.equal(w.store.readResult(w.runId)?.createdAt, result.createdAt);

  const second: WatchLine[] = [];
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, write: sink(second) });
  assert.equal(second[0]?.resultBody, undefined);
  assert.equal(second[0]?.resultReported, true);
  assert.equal(second[0]?.resultPath, w.paths.resultPath);
});

test("watchSubagents reports corrupt and missing run directories explicitly", async () => {
  const corrupt = run();
  writeFileSync(corrupt.paths.statusPath, "{torn", "utf8");
  const corruptLines: WatchLine[] = [];
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 30);
  await watchSubagents({ cwd: corrupt.cwd, runIds: [corrupt.runId], intervalSeconds: 0.01, write: sink(corruptLines), signal: abort.signal });
  assert.ok(corruptLines[0]?.error);
  assert.equal(corruptLines.some((line) => line.allSettled), false);

  const missing = run();
  rmSync(missing.paths.runDir, { recursive: true, force: true });
  const missingLines: WatchLine[] = [];
  await watchSubagents({ cwd: missing.cwd, runIds: [missing.runId], intervalSeconds: 0.01, write: sink(missingLines) });
  assert.ok(missingLines[0]?.error);
});

test("watchSubagents retries and deduplicates transient errors without settling a busy run", async () => {
  const w = run();
  finalizeTerminalRun(w.store, { runId: w.runId, parentRunId: "root_watch", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Recovered" });
  let failures = 2;
  class TransientStore extends RunStore {
    override readStatus(runId: string) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient read fault");
      }
      return super.readStatus(runId);
    }
  }
  const store = new TransientStore({ cwd: w.cwd, runRoot: w.store.runRoot, env: w.store.env });
  const lines: WatchLine[] = [];
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, write: sink(lines), store });

  assert.equal(lines.filter((line) => line.error === "transient read fault").length, 1);
  assert.equal(lines.some((line) => line.state === "completed"), true);
  assert.equal(lines.at(-1)?.allSettled, true);
});

test("watchSubagents --no-result-body semantics suppress bodies without consuming global report marker", async () => {
  const w = run();
  finalizeTerminalRun(w.store, { runId: w.runId, parentRunId: "root_watch", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Done", body: "recoverable" });
  const suppressed: WatchLine[] = [];
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, includeResultBody: false, write: sink(suppressed) });
  assert.equal(suppressed[0]?.resultBody, undefined);
  assert.equal(suppressed[0]?.resultReported, undefined);
  const reported: WatchLine[] = [];
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, write: sink(reported) });
  assert.equal(reported[0]?.resultBody, "recoverable");
});

test("watchSubagents caps terminal bodies with a result recovery marker", async () => {
  const w = run();
  finalizeTerminalRun(w.store, { runId: w.runId, parentRunId: "root_watch", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Large", body: "x".repeat(20_000) });
  const lines: WatchLine[] = [];
  await watchSubagents({ cwd: w.cwd, runIds: [w.runId], intervalSeconds: 0.01, write: sink(lines) });
  assert.equal(lines[0]?.resultBody?.length, 16_000);
  assert.match(lines[0]?.resultBody ?? "", /result --run-id/);
});
