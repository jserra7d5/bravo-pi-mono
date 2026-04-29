import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminalStatus } from "./lifecycle.js";
import { runDirFor } from "./paths.js";
import { writeMetadata } from "./metadata.js";
import { buildBoard } from "./board.js";
import { waitRuns } from "./controlPlane.js";
import type { AgentMetadata } from "./types.js";

let tempHome: string;
let oldHome: string | undefined;

beforeEach(() => {
  oldHome = process.env.TANGO_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "tango-a2a-cleanup-test-"));
  process.env.TANGO_HOME = tempHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.TANGO_HOME;
  else process.env.TANGO_HOME = oldHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function makeMeta(name: string, overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  const runDir = overrides.runDir ?? runDirFor(tempHome, name, { createRoot: true });
  mkdirSync(runDir, { recursive: true });
  const now = "2024-01-01T00:00:00.000Z";
  return {
    name,
    harness: "generic",
    mode: "oneshot",
    status: "running",
    cwd: tempHome,
    task: "task",
    runDir,
    homeDir: join(runDir, "home"),
    tmuxSocket: join(runDir, "tmux.sock"),
    tmuxSession: "tango",
    createdAt: now,
    updatedAt: now,
    runId: `run_${name}`,
    ...overrides,
  };
}

describe("A2A coordination cleanup slice", () => {
  it("terminal status semantics exclude blocked", () => {
    assert.strictEqual(isTerminalStatus("blocked"), false);
    assert.strictEqual(isTerminalStatus("done"), true);
    assert.strictEqual(isTerminalStatus("error"), true);
    assert.strictEqual(isTerminalStatus("stopped"), true);
  });

  it("waitRuns supports result-ready any/all target checks", async () => {
    const ready = makeMeta("ready", { status: "done", resultFinalizedAt: "2024-01-01T00:01:00.000Z" });
    writeFileSync(join(ready.runDir, "result.md"), "full result\n", "utf8");
    const pending = makeMeta("pending", { status: "running" });
    writeMetadata(ready);
    writeMetadata(pending);

    const any = await waitRuns([ready, pending], "result-ready", "any", 0);
    assert.strictEqual(any.timedOut, false);
    assert.deepStrictEqual(any.matched.map((m) => m.name), ["ready"]);

    const all = await waitRuns([ready, pending], "result-ready", "all", 1);
    assert.strictEqual(all.timedOut, true);
    assert.deepStrictEqual(all.pending.map((m) => m.name), ["pending"]);
  });

  it("board exposes direct children with descendant aggregates and delegation markers", () => {
    const parent = makeMeta("parent", { status: "running", mode: "interactive" });
    const lead = makeMeta("lead", { status: "running", role: "lead", mode: "interactive", parentRunId: parent.runId, parentRunDir: parent.runDir });
    const scout = makeMeta("scout", { status: "done", parentRunId: lead.runId, parentRunDir: lead.runDir, resultFinalizedAt: "2024-01-01T00:02:00.000Z" });
    writeFileSync(join(scout.runDir, "result.md"), "scout result\n", "utf8");
    for (const meta of [parent, lead, scout]) writeMetadata(meta);

    const board = buildBoard({ runId: parent.runId });
    assert.strictEqual(board.tree.directChildren.length, 1);
    assert.strictEqual(board.tree.directChildren[0].name, "lead");
    assert.strictEqual(board.tree.directChildren[0].delegationCapable, true);
    assert.strictEqual(board.tree.directChildren[0].delegationMarker, "L");
    assert.strictEqual(board.tree.directChildren[0].modeMarker, "↔");
    assert.strictEqual(board.tree.directChildren[0].descendantAggregate.total, 1);
    assert.strictEqual(board.tree.directChildren[0].descendantAggregate.ready, 1);
  });
});
