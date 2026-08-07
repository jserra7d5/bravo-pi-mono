import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { listRuns } from "../src/list.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-list-"));
  return { root, runRoot: join(root, ".subagents", "runs") };
}

function seed(store: RunStore, cwd: string, options: { agentName: string; state: string }): string {
  const { runId } = store.createRunDirectory({ cwd, parentRunId: "root_list", rootSessionId: "root_list" });
  store.writeStatus(createInitialStatus({
    runId,
    parentRunId: "root_list",
    rootSessionId: "root_list",
    agentName: options.agentName,
    agentSource: "builtin",
    definitionPath: `/builtin/${options.agentName}.md`,
    mode: "oneshot",
    cwd,
    state: options.state as never,
  }));
  return runId;
}

test("listRuns reports each run's live state rather than the state recorded at launch", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = seed(store, w.root, { agentName: "worker", state: "queued" });
  store.writeStatus({ ...store.readStatus(runId), state: "blocked", summary: "needs scope" });

  const rows = listRuns(store);
  assert.equal(rows.length, 1);
  // The index records a run once at launch and is never rewritten as it moves,
  // so trusting it would list every run as queued forever.
  assert.equal(rows[0]?.state, "blocked");
  assert.equal(rows[0]?.summary, "needs scope");
  assert.equal(rows[0]?.agentName, "worker");
  assert.equal(rows[0]?.runId, runId);
});

test("listRuns returns newest first and honours the limit", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const first = seed(store, w.root, { agentName: "scout", state: "completed" });
  const second = seed(store, w.root, { agentName: "worker", state: "running" });
  const third = seed(store, w.root, { agentName: "reviewer", state: "running" });

  const all = listRuns(store).map((row) => row.runId);
  assert.deepEqual(all, [third, second, first]);
  assert.deepEqual(listRuns(store, { limit: 2 }).map((row) => row.runId), [third, second]);
});

test("listRuns --all unions every index it can reach and reports each run once", () => {
  const a = workspace();
  const b = workspace();
  // A shared subagents home is what makes a run launched in one worktree
  // reachable from another; each run is also in its own run root's index, so the
  // union has to dedupe or every cross-project run lists twice.
  const env = { ASYNC_SUBAGENTS_HOME: mkdtempSync(join(tmpdir(), "async-subagents-home-")) };
  const storeA = new RunStore({ cwd: a.root, runRoot: a.runRoot, env });
  const storeB = new RunStore({ cwd: b.root, runRoot: b.runRoot, env });
  const runA = seed(storeA, a.root, { agentName: "scout", state: "running" });
  const runB = seed(storeB, b.root, { agentName: "worker", state: "running" });

  assert.equal(storeA.lookupIndexPaths().length > 1, true);
  const everywhere = listRuns(storeA, { all: true }).map((row) => row.runId);
  assert.deepEqual([...everywhere].sort(), [runA, runB].sort());
  assert.equal(listRuns(storeA, { all: true }).find((row) => row.runId === runB)?.agentName, "worker");
});

test("listRuns survives a run whose status has not been written yet", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_list", rootSessionId: "root_list" });

  const rows = listRuns(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.runId, runId);
  assert.equal(rows[0]?.state, undefined);
  assert.equal(rows[0]?.bucket, undefined);
});
