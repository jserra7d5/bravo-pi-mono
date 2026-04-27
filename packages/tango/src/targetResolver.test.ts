import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTarget, isChildOf } from "./targetResolver.js";
import { listMetadata } from "./metadata.js";
import { projectSlug } from "./paths.js";

let tempHome: string;
let runA: string;
let runB: string;
let runC: string;
let runChild: string;
let runSibling: string;
let runChildSameName: string;
let runGrandchild: string;
let runRootOnly: string;
let runWsOnly: string;
let runBothDiff: string;

before(() => {
  tempHome = mkdtempSync(join(tmpdir(), "tango-test-"));
  process.env.TANGO_HOME = tempHome;

  const slug1 = projectSlug("/tmp");
  const runs1 = join(tempHome, "runs", slug1);
  mkdirSync(runs1, { recursive: true });

  runA = join(runs1, "agent-a");
  mkdirSync(runA, { recursive: true });
  writeFileSync(
    join(runA, "metadata.json"),
    JSON.stringify({
      name: "agent-a",
      runDir: runA,
      runId: "run_a",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp",
      task: "t",
      homeDir: join(runA, "home"),
      tmuxSocket: join(runA, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  runB = join(runs1, "agent-b");
  mkdirSync(runB, { recursive: true });
  writeFileSync(
    join(runB, "metadata.json"),
    JSON.stringify({
      name: "agent-b",
      runDir: runB,
      runId: "run_b",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp",
      task: "t",
      homeDir: join(runB, "home"),
      tmuxSocket: join(runB, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  runChild = join(runs1, "child-a");
  mkdirSync(runChild, { recursive: true });
  writeFileSync(
    join(runChild, "metadata.json"),
    JSON.stringify({
      name: "child-a",
      runDir: runChild,
      runId: "run_child",
      parentRunId: "run_a",
      parentRunDir: runA,
      rootSessionId: "root_1",
      workstreamId: "ws_1",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp",
      task: "t",
      homeDir: join(runChild, "home"),
      tmuxSocket: join(runChild, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  const slug2 = projectSlug("/tmp2");
  const runs2 = join(tempHome, "runs", slug2);
  mkdirSync(runs2, { recursive: true });

  runC = join(runs2, "agent-a");
  mkdirSync(runC, { recursive: true });
  writeFileSync(
    join(runC, "metadata.json"),
    JSON.stringify({
      name: "agent-a",
      runDir: runC,
      runId: "run_c",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp2",
      task: "t",
      homeDir: join(runC, "home"),
      tmuxSocket: join(runC, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  // sibling-a in different cwd, child of runA, no root/workstream
  const slug3 = projectSlug("/tmp3");
  const runs3 = join(tempHome, "runs", slug3);
  mkdirSync(runs3, { recursive: true });

  runSibling = join(runs3, "sibling-a");
  mkdirSync(runSibling, { recursive: true });
  writeFileSync(
    join(runSibling, "metadata.json"),
    JSON.stringify({
      name: "sibling-a",
      runDir: runSibling,
      runId: "run_sibling",
      parentRunId: "run_a",
      parentRunDir: runA,
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp3",
      task: "t",
      homeDir: join(runSibling, "home"),
      tmuxSocket: join(runSibling, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  // direct child named agent-a in different cwd
  runChildSameName = join(runs3, "agent-a-child");
  mkdirSync(runChildSameName, { recursive: true });
  writeFileSync(
    join(runChildSameName, "metadata.json"),
    JSON.stringify({
      name: "agent-a",
      runDir: runChildSameName,
      runId: "run_child_same",
      parentRunId: "run_a",
      parentRunDir: runA,
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp3",
      task: "t",
      homeDir: join(runChildSameName, "home"),
      tmuxSocket: join(runChildSameName, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  // grandchild of runA (child of child-a)
  const slug4 = projectSlug("/tmp4");
  const runs4 = join(tempHome, "runs", slug4);
  mkdirSync(runs4, { recursive: true });

  runGrandchild = join(runs4, "grandchild-a");
  mkdirSync(runGrandchild, { recursive: true });
  writeFileSync(
    join(runGrandchild, "metadata.json"),
    JSON.stringify({
      name: "grandchild-a",
      runDir: runGrandchild,
      runId: "run_grandchild",
      parentRunId: "run_child",
      parentRunDir: runChild,
      rootSessionId: "root_1",
      workstreamId: "ws_1",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp4",
      task: "t",
      homeDir: join(runGrandchild, "home"),
      tmuxSocket: join(runGrandchild, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  // root-only agent
  runRootOnly = join(runs1, "root-only");
  mkdirSync(runRootOnly, { recursive: true });
  writeFileSync(
    join(runRootOnly, "metadata.json"),
    JSON.stringify({
      name: "root-only",
      runDir: runRootOnly,
      runId: "run_root_only",
      rootSessionId: "root_1",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp",
      task: "t",
      homeDir: join(runRootOnly, "home"),
      tmuxSocket: join(runRootOnly, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  // ws-only agent
  runWsOnly = join(runs1, "ws-only");
  mkdirSync(runWsOnly, { recursive: true });
  writeFileSync(
    join(runWsOnly, "metadata.json"),
    JSON.stringify({
      name: "ws-only",
      runDir: runWsOnly,
      runId: "run_ws_only",
      workstreamId: "ws_1",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp",
      task: "t",
      homeDir: join(runWsOnly, "home"),
      tmuxSocket: join(runWsOnly, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

  // both root and workstream but different workstream
  runBothDiff = join(runs1, "both-diff");
  mkdirSync(runBothDiff, { recursive: true });
  writeFileSync(
    join(runBothDiff, "metadata.json"),
    JSON.stringify({
      name: "both-diff",
      runDir: runBothDiff,
      runId: "run_both_diff",
      rootSessionId: "root_1",
      workstreamId: "ws_2",
      status: "running",
      harness: "pi",
      mode: "interactive",
      cwd: "/tmp",
      task: "t",
      homeDir: join(runBothDiff, "home"),
      tmuxSocket: join(runBothDiff, "tmux.sock"),
      tmuxSession: "tango",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  );

});

after(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  delete process.env.TANGO_HOME;
});

describe("resolveTarget", () => {
  it("resolves by explicit run-id", () => {
    const meta = resolveTarget({ runId: "run_a" });
    assert.strictEqual(meta.name, "agent-a");
    assert.strictEqual(meta.runId, "run_a");
  });

  it("resolves by explicit run-dir", () => {
    const meta = resolveTarget({ runDir: runB });
    assert.strictEqual(meta.name, "agent-b");
  });

  it("resolves direct child by name when inside parent run", () => {
    const meta = resolveTarget({ name: "child-a", env: { TANGO_RUN_ID: "run_a", TANGO_RUN_DIR: runA } });
    assert.strictEqual(meta.name, "child-a");
  });

  it("resolves descendant by name when inside ancestor run", () => {
    const meta = resolveTarget({ name: "grandchild-a", env: { TANGO_RUN_ID: "run_a" } });
    assert.strictEqual(meta.name, "grandchild-a");
    assert.strictEqual(meta.runId, "run_grandchild");
  });

  it("prefers direct child in different cwd over cwd same-name", () => {
    const meta = resolveTarget({ name: "agent-a", env: { TANGO_RUN_ID: "run_a" } });
    assert.strictEqual(meta.runId, "run_child_same");
  });

  it("does not resolve sibling as descendant", () => {
    assert.throws(() => resolveTarget({ name: "sibling-a", env: { TANGO_RUN_ID: "run_child" } }), /Agent not found/);
  });

  it("does not fall back to cwd when lineage context is present", () => {
    assert.throws(() => resolveTarget({ name: "agent-a", cwd: "/tmp", env: { TANGO_RUN_ID: "run_child" } }), /Agent not found/);
  });

  it("root+workstream conjoins rather than ORs", () => {
    // both env vars set; agent missing workstream should not match
    assert.throws(() => resolveTarget({ name: "root-only", env: { TANGO_ROOT_SESSION_ID: "root_1", TANGO_WORKSTREAM_ID: "ws_1" } }), /Agent not found/);
    // both env vars set; agent with mismatched workstream should not match
    assert.throws(() => resolveTarget({ name: "both-diff", env: { TANGO_ROOT_SESSION_ID: "root_1", TANGO_WORKSTREAM_ID: "ws_1" } }), /Agent not found/);
    // both env vars set; exact match should succeed
    const meta = resolveTarget({ name: "child-a", env: { TANGO_ROOT_SESSION_ID: "root_1", TANGO_WORKSTREAM_ID: "ws_1" } });
    assert.strictEqual(meta.name, "child-a");
  });

  it("resolves by rootSessionId only when workstream not required", () => {
    const meta = resolveTarget({ name: "root-only", env: { TANGO_ROOT_SESSION_ID: "root_1" } });
    assert.strictEqual(meta.name, "root-only");
  });

  it("resolves by workstreamId only when root not required", () => {
    const meta = resolveTarget({ name: "ws-only", env: { TANGO_WORKSTREAM_ID: "ws_1" } });
    assert.strictEqual(meta.name, "ws-only");
  });

  it("normalizes parentRunDir comparison", () => {
    const meta = resolveTarget({ name: "sibling-a", env: { TANGO_RUN_DIR: runA + "/" } });
    assert.strictEqual(meta.name, "sibling-a");
  });

  it("falls back to cwd project", () => {
    const meta = resolveTarget({ name: "agent-a", cwd: "/tmp" });
    assert.strictEqual(meta.runId, "run_a");
  });

  it("falls back to global unique name", () => {
    const meta = resolveTarget({ name: "agent-b" });
    assert.strictEqual(meta.runId, "run_b");
  });

  it("throws ambiguity for duplicate names across projects", () => {
    assert.throws(() => resolveTarget({ name: "agent-a" }), /Ambiguous/);
  });

  it("throws not found", () => {
    assert.throws(() => resolveTarget({ name: "nonexistent" }), /Agent not found/);
  });
});

describe("isChildOf", () => {
  it("matches by parentRunId", () => {
    const all = listMetadata(undefined);
    const parent = all.find((a) => a.runId === "run_a")!;
    const child = all.find((a) => a.runId === "run_child")!;
    assert.strictEqual(isChildOf(child, parent), true);
  });

  it("matches by parentRunDir fallback", () => {
    const all = listMetadata(undefined);
    const parent = all.find((a) => a.runId === "run_a")!;
    const child = all.find((a) => a.runId === "run_child")!;
    const parentNoId = { ...parent, runId: undefined } as any;
    assert.strictEqual(isChildOf(child, parentNoId), true);
  });

  it("normalizes parentRunDir with trailing slash", () => {
    const all = listMetadata(undefined);
    const parent = all.find((a) => a.runId === "run_a")!;
    const child = all.find((a) => a.runId === "run_child")!;
    const childWithSlash = { ...child, parentRunDir: runA + "/" } as any;
    assert.strictEqual(isChildOf(childWithSlash, parent), true);
  });

  it("returns false for unrelated agents", () => {
    const all = listMetadata(undefined);
    const parent = all.find((a) => a.runId === "run_b")!;
    const child = all.find((a) => a.runId === "run_child")!;
    assert.strictEqual(isChildOf(child, parent), false);
  });
});
