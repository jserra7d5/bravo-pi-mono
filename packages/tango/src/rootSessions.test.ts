import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./paths.js";
import { writeMetrics } from "./metrics.js";
import type { AgentMetadata } from "./types.js";
import type { RootSessionRecord } from "./server.js";
import {
  classifyAgent,
  buildAgentForest,
  buildAgentCommands,
  groupByRootSession,
  gatherAttentionItems,
  computeSessionCounts,
  type AgentTreeNode,
} from "./rootSessions.js";

let tempHome: string;
let runA: string;
let runB: string;
let runChild: string;
let runGrandchild: string;
let runOrphan: string;

const baseMeta = (overrides: Partial<AgentMetadata> & { name: string; runDir: string }): AgentMetadata => ({
  status: "running",
  harness: "pi",
  mode: "interactive",
  cwd: "/tmp",
  task: "t",
  homeDir: join(overrides.runDir, "home"),
  tmuxSocket: join(overrides.runDir, "tmux.sock"),
  tmuxSession: "tango",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

before(() => {
  tempHome = mkdtempSync(join(tmpdir(), "tango-rs-test-"));
  process.env.TANGO_HOME = tempHome;

  const slug = projectSlug("/tmp");
  const runs = join(tempHome, "runs", slug);
  mkdirSync(runs, { recursive: true });

  runA = join(runs, "agent-a");
  runB = join(runs, "agent-b");
  runChild = join(runs, "child-a");
  runGrandchild = join(runs, "grandchild-a");
  runOrphan = join(runs, "orphan-a");

  for (const d of [runA, runB, runChild, runGrandchild, runOrphan]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(join(runA, "metadata.json"), JSON.stringify(baseMeta({ name: "agent-a", runDir: runA, runId: "run_a" })));
  writeFileSync(join(runB, "metadata.json"), JSON.stringify(baseMeta({ name: "agent-b", runDir: runB, runId: "run_b" })));
  writeFileSync(
    join(runChild, "metadata.json"),
    JSON.stringify(baseMeta({ name: "child-a", runDir: runChild, runId: "run_child", parentRunId: "run_a", parentRunDir: runA }))
  );
  writeFileSync(
    join(runGrandchild, "metadata.json"),
    JSON.stringify(baseMeta({ name: "grandchild-a", runDir: runGrandchild, runId: "run_grandchild", parentRunId: "run_child", parentRunDir: runChild }))
  );
  writeFileSync(
    join(runOrphan, "metadata.json"),
    JSON.stringify(baseMeta({ name: "orphan-a", runDir: runOrphan, runId: "run_orphan", parentRunId: "run_missing", parentRunDir: "/nonexistent" }))
  );
});

after(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  delete process.env.TANGO_HOME;
});

describe("classifyAgent", () => {
  it("classifies blocked as attention", () => {
    const meta = baseMeta({ name: "x", runDir: runA, status: "blocked" });
    assert.strictEqual(classifyAgent(meta), "attention");
  });

  it("classifies error as attention", () => {
    const meta = baseMeta({ name: "x", runDir: runA, status: "error" });
    assert.strictEqual(classifyAgent(meta), "attention");
  });

  it("classifies needs as attention even when running", () => {
    const meta = baseMeta({ name: "x", runDir: runA, status: "running", needs: "input" });
    assert.strictEqual(classifyAgent(meta), "attention");
  });

  it("classifies running as active", () => {
    const meta = baseMeta({ name: "x", runDir: runA, status: "running" });
    assert.strictEqual(classifyAgent(meta), "active");
  });

  it("classifies created as active", () => {
    const meta = baseMeta({ name: "x", runDir: runA, status: "created" });
    assert.strictEqual(classifyAgent(meta), "active");
  });

  it("classifies done within 24h as recent", () => {
    const updated = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const meta = baseMeta({ name: "x", runDir: runA, status: "done", updatedAt: updated });
    assert.strictEqual(classifyAgent(meta), "recent");
  });

  it("classifies done older than 24h as historical", () => {
    const updated = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const meta = baseMeta({ name: "x", runDir: runA, status: "done", updatedAt: updated });
    assert.strictEqual(classifyAgent(meta), "historical");
  });

  it("classifies done older than 7d as legacy", () => {
    const updated = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    const meta = baseMeta({ name: "x", runDir: runA, status: "done", updatedAt: updated });
    assert.strictEqual(classifyAgent(meta), "legacy");
  });

  it("classifies missing dates as legacy", () => {
    const meta = baseMeta({ name: "x", runDir: runA, status: "done", updatedAt: "", createdAt: "" });
    assert.strictEqual(classifyAgent(meta), "legacy");
  });
});

describe("buildAgentForest", () => {
  it("builds roots for top-level agents", () => {
    const agents = [
      baseMeta({ name: "a", runDir: runA, runId: "run_a" }),
      baseMeta({ name: "b", runDir: runB, runId: "run_b" }),
    ];
    const forest = buildAgentForest(agents);
    assert.strictEqual(forest.length, 2);
    assert.deepStrictEqual(forest.map((n) => n.name).sort(), ["a", "b"]);
  });

  it("nests children by parentRunId", () => {
    const agents = [
      baseMeta({ name: "a", runDir: runA, runId: "run_a" }),
      baseMeta({ name: "c", runDir: runChild, runId: "run_child", parentRunId: "run_a" }),
    ];
    const forest = buildAgentForest(agents);
    assert.strictEqual(forest.length, 1);
    assert.strictEqual(forest[0].children.length, 1);
    assert.strictEqual(forest[0].children[0].name, "c");
  });

  it("falls back to parentRunDir when parentRunId missing", () => {
    const agents = [
      baseMeta({ name: "a", runDir: runA, runId: "run_a" }),
      baseMeta({ name: "c", runDir: runChild, runId: "run_child", parentRunDir: runA }),
    ];
    const forest = buildAgentForest(agents);
    assert.strictEqual(forest.length, 1);
    assert.strictEqual(forest[0].children.length, 1);
    assert.strictEqual(forest[0].children[0].name, "c");
  });

  it("prefers parentRunId over parentRunDir mismatch", () => {
    const agents = [
      baseMeta({ name: "a", runDir: runA, runId: "run_a" }),
      baseMeta({ name: "c", runDir: runChild, runId: "run_child", parentRunId: "run_a", parentRunDir: "/other" }),
    ];
    const forest = buildAgentForest(agents);
    assert.strictEqual(forest[0].children.length, 1);
    assert.strictEqual(forest[0].children[0].name, "c");
  });

  it("treats orphaned children as roots", () => {
    const agents = [
      baseMeta({ name: "o", runDir: runOrphan, runId: "run_orphan", parentRunId: "run_missing" }),
    ];
    const forest = buildAgentForest(agents);
    assert.strictEqual(forest.length, 1);
    assert.strictEqual(forest[0].name, "o");
    assert.strictEqual(forest[0].children.length, 0);
  });

  it("builds deep nesting", () => {
    const agents = [
      baseMeta({ name: "a", runDir: runA, runId: "run_a" }),
      baseMeta({ name: "c", runDir: runChild, runId: "run_child", parentRunId: "run_a" }),
      baseMeta({ name: "g", runDir: runGrandchild, runId: "run_grandchild", parentRunId: "run_child" }),
    ];
    const forest = buildAgentForest(agents);
    assert.strictEqual(forest[0].children[0].children[0].name, "g");
  });
});

describe("buildAgentCommands", () => {
  it("uses --run-id when runId is present", () => {
    const meta = baseMeta({ name: "a", runDir: runA, runId: "run_a" });
    const cmds = buildAgentCommands(meta);
    assert.ok(cmds.attach?.includes("--run-id run_a"));
    assert.ok(cmds.look.includes("--run-id run_a"));
    assert.ok(cmds.result.includes("--run-id run_a"));
  });

  it("uses name fallback when runId is absent", () => {
    const meta = baseMeta({ name: "a", runDir: runA });
    delete (meta as any).runId;
    const cmds = buildAgentCommands(meta);
    assert.ok(cmds.attach?.includes("tango attach a"));
    assert.ok(!cmds.look.includes("--run-id"));
    assert.ok(!cmds.result.includes("--run-id"));
  });

  it("omits attach for oneshot mode", () => {
    const meta = baseMeta({ name: "a", runDir: runA, runId: "run_a", mode: "oneshot" });
    const cmds = buildAgentCommands(meta);
    assert.strictEqual(cmds.attach, undefined);
  });
});

describe("groupByRootSession", () => {
  it("groups agents by rootSessionId", () => {
    const rs: RootSessionRecord[] = [
      { schemaVersion: 1, rootSessionId: "r1", workstreamId: "w1", kind: "pi", createdAt: "", updatedAt: "", lastSeenAt: "" },
    ];
    const agents = [
      baseMeta({ name: "a", runDir: runA, rootSessionId: "r1" }),
      baseMeta({ name: "b", runDir: runB, rootSessionId: "r2" }),
    ];
    const map = groupByRootSession(agents, rs);
    assert.strictEqual(map.get("r1")!.length, 1);
    assert.strictEqual(map.get("r1")![0].name, "a");
    assert.strictEqual(map.get("_legacy")!.length, 1);
    assert.strictEqual(map.get("_legacy")![0].name, "b");
  });

  it("falls back to workstreamId mapping", () => {
    const rs: RootSessionRecord[] = [
      { schemaVersion: 1, rootSessionId: "r1", workstreamId: "w1", kind: "pi", createdAt: "", updatedAt: "", lastSeenAt: "" },
    ];
    const agents = [baseMeta({ name: "a", runDir: runA, workstreamId: "w1" })];
    const map = groupByRootSession(agents, rs);
    assert.strictEqual(map.get("r1")!.length, 1);
  });
});

describe("gatherAttentionItems", () => {
  it("collects blocked and error agents", () => {
    const agents = [
      baseMeta({ name: "a", runDir: runA, status: "blocked" }),
      baseMeta({ name: "b", runDir: runB, status: "error" }),
      baseMeta({ name: "c", runDir: runChild, status: "running" }),
    ];
    const items = gatherAttentionItems(agents);
    assert.strictEqual(items.length, 2);
    assert.ok(items.some((i) => i.name === "a" && i.reason === "blocked"));
    assert.ok(items.some((i) => i.name === "b" && i.reason === "error"));
  });

  it("collects needs reason", () => {
    const agents = [baseMeta({ name: "a", runDir: runA, status: "running", needs: "review" })];
    const items = gatherAttentionItems(agents);
    assert.strictEqual(items[0].reason, "needs: review");
  });
});

describe("computeSessionCounts", () => {
  it("sums all buckets", () => {
    const agents = [
      baseMeta({ name: "a", runDir: runA, status: "blocked" }),
      baseMeta({ name: "b", runDir: runB, status: "running" }),
      baseMeta({ name: "c", runDir: runChild, status: "done", updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }),
    ];
    const counts = computeSessionCounts(agents);
    assert.strictEqual(counts.attention, 1);
    assert.strictEqual(counts.active, 1);
    assert.strictEqual(counts.recent, 1);
    assert.strictEqual(counts.total, 3);
  });
});
