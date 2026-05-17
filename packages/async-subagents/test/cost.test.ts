import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateCostForSubtree, extractCostFromSessionLog, extractCostFromSessionLogSync } from "../src/cost.js";
import { RunStore } from "../src/runStore.js";
import { createRunResult } from "../src/result.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "async-subagents-cost-"));
}

function writeJsonl(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
}

function assistantMessage(cost: number): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
    },
  });
}

function userMessage(): string {
  return JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });
}

test("extractCostFromSessionLog returns undefined for empty file", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, []);
  assert.equal(await extractCostFromSessionLog(path), undefined);
});

test("extractCostFromSessionLog returns undefined when no assistant messages present", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, [userMessage(), userMessage()]);
  assert.equal(await extractCostFromSessionLog(path), undefined);
});

test("extractCostFromSessionLog returns the single assistant cost when only one entry is present", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, [assistantMessage(0.0042)]);
  assert.equal(await extractCostFromSessionLog(path), 0.0042);
});

test("extractCostFromSessionLog sums multiple assistant entries", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, [assistantMessage(0.01), assistantMessage(0.02), assistantMessage(0.03)]);
  const total = await extractCostFromSessionLog(path);
  assert.ok(total !== undefined);
  assert.ok(Math.abs(total - 0.06) < 1e-9, `expected ~0.06, got ${total}`);
});

test("extractCostFromSessionLog only counts assistant messages, ignoring user turns", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, [userMessage(), assistantMessage(0.1), userMessage(), assistantMessage(0.4)]);
  const total = await extractCostFromSessionLog(path);
  assert.ok(total !== undefined);
  assert.ok(Math.abs(total - 0.5) < 1e-9, `expected ~0.5, got ${total}`);
});

test("extractCostFromSessionLog skips corrupt lines in the middle and still sums the rest", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, [assistantMessage(0.1), "{not valid json", assistantMessage(0.2)]);
  const total = await extractCostFromSessionLog(path);
  assert.ok(total !== undefined);
  assert.ok(Math.abs(total - 0.3) < 1e-9, `expected ~0.3, got ${total}`);
});

test("extractCostFromSessionLog returns undefined for nonexistent path", async () => {
  const dir = tempDir();
  const path = join(dir, "missing.jsonl");
  assert.equal(await extractCostFromSessionLog(path), undefined);
});

test("extractCostFromSessionLog returns undefined when piSessionPath is missing", async () => {
  assert.equal(await extractCostFromSessionLog(undefined), undefined);
  assert.equal(await extractCostFromSessionLog(""), undefined);
});

test("extractCostFromSessionLog ignores assistant messages with non-numeric cost", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  const malformed = JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { cost: { total: "not a number" } } },
  });
  writeJsonl(path, [malformed, assistantMessage(0.5)]);
  const total = await extractCostFromSessionLog(path);
  assert.ok(total !== undefined);
  assert.ok(Math.abs(total - 0.5) < 1e-9);
});

test("extractCostFromSessionLogSync mirrors the async surface", () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, [assistantMessage(0.25), assistantMessage(0.25)]);
  const total = extractCostFromSessionLogSync(path);
  assert.ok(total !== undefined);
  assert.ok(Math.abs(total - 0.5) < 1e-9);
});

test("aggregateCostForSubtree sums the root plus its descendants from persisted results", async () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-cost-rollup-"));
  const runRoot = join(root, ".subagents", "runs");
  const store = new RunStore({ cwd: root, runRoot });

  const parent = store.createRunDirectory({ cwd: root, parentRunId: "root_test", rootSessionId: "root_test" });
  const childA = store.createRunDirectory({ cwd: root, parentRunId: parent.runId, rootSessionId: "root_test" });
  const childB = store.createRunDirectory({ cwd: root, parentRunId: parent.runId, rootSessionId: "root_test" });
  const grandchild = store.createRunDirectory({ cwd: root, parentRunId: childA.runId, rootSessionId: "root_test" });

  store.writeResult(
    createRunResult({
      runId: parent.runId,
      parentRunId: "root_test",
      agentName: "scout",
      state: "completed",
      metrics: { cost: { total: 0.1 } },
    }),
  );
  store.writeResult(
    createRunResult({
      runId: childA.runId,
      parentRunId: parent.runId,
      agentName: "scout",
      state: "completed",
      metrics: { cost: { total: 0.2 } },
    }),
  );
  store.writeResult(
    createRunResult({
      runId: childB.runId,
      parentRunId: parent.runId,
      agentName: "scout",
      state: "completed",
      // no metrics — should be skipped without erroring
    }),
  );
  store.writeResult(
    createRunResult({
      runId: grandchild.runId,
      parentRunId: childA.runId,
      agentName: "scout",
      state: "completed",
      metrics: { cost: { total: 0.4 } },
    }),
  );

  const total = await aggregateCostForSubtree(store, parent.runId);
  assert.ok(total !== undefined);
  assert.ok(Math.abs(total - 0.7) < 1e-9, `expected ~0.7, got ${total}`);
});

test("aggregateCostForSubtree returns undefined when no run in the subtree has cost", async () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-cost-rollup-empty-"));
  const runRoot = join(root, ".subagents", "runs");
  const store = new RunStore({ cwd: root, runRoot });
  const parent = store.createRunDirectory({ cwd: root, parentRunId: "root_test", rootSessionId: "root_test" });
  assert.equal(await aggregateCostForSubtree(store, parent.runId), undefined);
});
