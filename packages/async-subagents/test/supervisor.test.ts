import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor } from "../src/supervisor.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("manual pause suspends runtime budget and resume reinstalls timeout", async () => {
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

  const supervisor = runSupervisor({
    runId,
    runRoot,
    cwd,
    parentRunId,
    agentName: "scout",
    effectiveMaxRunMs: 500,
    command: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd,
      env: {},
    },
  });

  await delay(60);
  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "pause", reason: "manual checkpoint" })}\n`, "utf8");
  await delay(740);
  let status = store.readStatus(runId);
  assert.equal(status.state, "paused");
  assert.equal(status.summary, "manual checkpoint");
  assert.notEqual(status.timeout?.reason, "time budget expired");

  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "resume", additionalRunSeconds: 0.1 })}\n`, "utf8");
  await delay(420);
  status = store.readStatus(runId);
  assert.equal(status.state, "paused");
  assert.equal(status.timeout?.reason, "time budget expired");

  appendFileSync(join(paths.runDir, "control.jsonl"), `${JSON.stringify({ action: "cancel", reason: "test cleanup" })}\n`, "utf8");
  const result = await supervisor;
  assert.equal(result.state, "cancelled");
});
