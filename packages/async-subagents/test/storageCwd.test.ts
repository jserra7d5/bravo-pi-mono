import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSubagent } from "../src/start.js";
import { RunStore } from "../src/runStore.js";

test("storageCwd separates canonical run store from execution cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "canonical-store-"));
  const execution = mkdtempSync(join(tmpdir(), "execution-cwd-"));
  const result = await startSubagent({ agent: "worker", task: "bounded", cwd: execution, storageCwd: canonical, fake: { mode: "immediate", state: "completed", body: "ok" } });
  const store = new RunStore({ cwd: canonical });
  assert.equal(store.readStatus(result.runId).cwd, execution);
  assert.ok(store.pathsFor({ runId: result.runId }).runDir.startsWith(store.runRoot));
  assert.equal(existsSync(new RunStore({ cwd: execution }).runRoot), false);
});
