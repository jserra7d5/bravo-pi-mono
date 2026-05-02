import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminalStatus } from "./lifecycle.js";
import { derivedAttentionState } from "./inbox.js";
import { readMetadata, writeMetadata } from "./metadata.js";
import { assertMessageRunAllowed, buildRunState, readActivity, reportRun } from "./controlPlane.js";
import { readCheckpoints } from "./checkpoints.js";
import type { AgentMetadata } from "./types.js";

let tempHome: string;
let oldHome: string | undefined;

beforeEach(() => {
  oldHome = process.env.TANGO_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "tango-lifecycle-ux-test-"));
  process.env.TANGO_HOME = tempHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.TANGO_HOME;
  else process.env.TANGO_HOME = oldHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  const runDir = overrides.runDir ?? join(tempHome, "runs", "proj", overrides.name ?? "agent");
  mkdirSync(runDir, { recursive: true });
  const now = overrides.updatedAt ?? new Date().toISOString();
  return {
    name: overrides.name ?? "agent",
    harness: "generic",
    mode: "interactive",
    status: "running",
    cwd: tempHome,
    task: "implement feature",
    runDir,
    homeDir: join(runDir, "home"),
    tmuxSocket: join(runDir, "tmux.sock"),
    tmuxSession: "tango",
    createdAt: now,
    updatedAt: now,
    runId: `run_${overrides.name ?? "agent"}`,
    resultRequired: true,
    reusable: true,
    ...overrides,
  };
}

function seed(meta: AgentMetadata): AgentMetadata {
  writeMetadata(meta);
  return readMetadata(meta.runDir);
}

describe("interactive lifecycle UX", () => {
  it("treats idle as a reusable non-terminal status with result readiness", () => {
    const meta = seed(makeMeta());
    const resultSource = join(tempHome, "answer.md");
    writeFileSync(resultSource, "Implemented feature and validated focused tests.\n", "utf8");

    const idle = reportRun(meta.runDir, "idle", "Task complete; awaiting follow-up", { resultFile: resultSource });
    const state = buildRunState(idle);

    assert.strictEqual(isTerminalStatus("idle"), false);
    assert.strictEqual(idle.status, "idle");
    assert.strictEqual(idle.reusable, true);
    assert.ok(idle.idleSince);
    assert.strictEqual(state.agent.terminal, false);
    assert.strictEqual(state.session?.state, "idle");
    assert.strictEqual(state.session?.reusable, true);
    assert.strictEqual(state.result.ready, true);
    assert.strictEqual(readFileSync(join(meta.runDir, "result.md"), "utf8"), "Implemented feature and validated focused tests.\n");
  });

  it("records report checkpoints and surfaces checkpoint body before raw activity", () => {
    const meta = seed(makeMeta({ name: "checkpoint-agent" }));
    const checkpointFile = join(tempHome, "checkpoint.md");
    writeFileSync(checkpointFile, "# Checkpoint\n\nParser and state wiring complete.\n", "utf8");

    const updated = reportRun(meta.runDir, "running", "Continuing validation", { checkpointSummary: "Parser checkpoint", checkpointFile });
    const checkpoints = readCheckpoints(meta.runDir);
    const activity = readActivity(updated, { lines: 20 });

    assert.strictEqual(checkpoints.length, 1);
    assert.strictEqual(checkpoints[0].summary, "Parser checkpoint");
    assert.strictEqual(updated.lastCheckpointAt, checkpoints[0].createdAt);
    assert.ok(existsSync(checkpoints[0].path!));
    assert.match(activity.text, /\[checkpoint\] Parser checkpoint/);
    assert.match(activity.text, /Parser and state wiring complete/);
    assert.strictEqual(activity.summary.checkpoints?.count, 1);
  });

  it("rejects normal messages to terminal interactive runs before raw tmux delivery", () => {
    const meta = seed(makeMeta({ name: "done-agent", status: "done", resultFinalizedAt: new Date().toISOString() }));
    writeFileSync(join(meta.runDir, "result.md"), "done result\n", "utf8");

    assert.throws(() => assertMessageRunAllowed(meta), /terminal_run: Run done-agent is terminal/);
    assert.doesNotThrow(() => assertMessageRunAllowed(meta, { forceTerminal: true }));
  });

  it("does not create low-confidence stalled attention for live/reusable idle semantics", () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const oneshot = makeMeta({ name: "old-one", mode: "oneshot", status: "running", updatedAt: old, createdAt: old });
    writeFileSync(join(oneshot.runDir, "metadata.json"), `${JSON.stringify(oneshot, null, 2)}\n`, "utf8");
    assert.strictEqual(derivedAttentionState(oneshot), "stalled");

    const idle = makeMeta({ name: "idle-one", status: "idle", updatedAt: old, createdAt: old });
    writeFileSync(join(idle.runDir, "metadata.json"), `${JSON.stringify(idle, null, 2)}\n`, "utf8");
    // No tmux exists in this unit test, so the derived state is offline rather than stalled/noisy.
    assert.strictEqual(derivedAttentionState(idle), "offline");
  });
});
