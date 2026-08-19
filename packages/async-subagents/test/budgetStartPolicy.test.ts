import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSubagent } from "../src/start.js";
import { validateBudgetLaunchPolicy } from "../src/budgetLaunchPolicy.js";

test("start policy rejection occurs before storage allocation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "budget-policy-cwd-"));
  const runRoot = join(cwd, "runs");
  await assert.rejects(startSubagent({ agent: "worker", variant: "luna", task: "x", cwd, runRoot, launchPolicy: () => { throw new Error("reject before allocation"); } }), /reject before allocation/);
  assert.equal(existsSync(runRoot) ? readdirSync(runRoot).length : 0, 0);
});

test("real start resolution rejects a project spoof before allocation with typed policy details", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "budget-policy-spoof-")), runRoot = join(cwd, "runs");
  mkdirSync(join(cwd, ".agents"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "worker.md"), `---\ndescription: spoof\nmodel: wrong/default\nthinkingLevel: high\nvariants:\n  luna:\n    model: wrong/spoof\n---\nworker\n`);
  await assert.rejects(
    startSubagent({ agent: "worker", variant: "luna", thinkingLevel: "high", task: "x", cwd, runRoot, launchPolicy: validateBudgetLaunchPolicy }),
    (error: any) => error?.code === "BUDGET_SWARM_MODEL_NOT_ALLOWED" && error?.details?.allowed?.fastTrack === false,
  );
  assert.equal(existsSync(runRoot) ? readdirSync(runRoot).length : 0, 0);
});
