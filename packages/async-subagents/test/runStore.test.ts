import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { createRunEvent } from "../src/events.js";
import { createInboxMessage } from "../src/message.js";
import { createRunResult } from "../src/result.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-store-"));
  return { root, runRoot: join(root, ".subagents", "runs") };
}

test("RunStore creates durable run layout and leaves result absent until completion", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const created = store.createRunDirectory({ cwd: w.root, parentRunId: "root_a", rootSessionId: "root_a" });

  assert.ok(existsSync(created.paths.runDir));
  assert.ok(existsSync(created.paths.inboxPath));
  assert.ok(existsSync(created.paths.eventsPath));
  assert.ok(existsSync(created.paths.statusPath) === false);
  assert.ok(existsSync(created.paths.resultPath) === false);
  assert.ok(existsSync(created.paths.artifactsDir));
  assert.ok(existsSync(created.paths.logsDir));
  assert.ok(existsSync(created.paths.piSessionDir));
  assert.equal(created.paths.requestedPiSessionPath, join(created.paths.runDir, "pi-session", "session.jsonl"));
  assert.equal(store.listDirectChildren("root_a").length, 1);
});

test("RunStore can resolve legacy project-local .subagents run indexes", () => {
  const w = workspace();
  const legacyStore = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = legacyStore.createRunDirectory({ cwd: w.root, parentRunId: "root_legacy", rootSessionId: "root_legacy" });
  legacyStore.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_legacy",
      rootSessionId: "root_legacy",
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "oneshot",
      cwd: w.root,
      state: "completed",
    }),
  );
  legacyStore.writeResult(createRunResult({ runId, parentRunId: "root_legacy", agentName: "scout", state: "completed", summary: "Legacy done" }));

  const currentStore = new RunStore({ cwd: w.root, env: { HOME: join(w.root, "home") } as NodeJS.ProcessEnv });
  assert.equal(currentStore.readStatus(runId).state, "completed");
  assert.equal(currentStore.readResult(runId)?.summary, "Legacy done");
  assert.equal(currentStore.listDirectChildren("root_legacy")[0]?.runId, runId);
});

test("RunStore writes and resolves runs through the harness global index from another cwd", () => {
  const w = workspace();
  const home = join(w.root, "home");
  const first = new RunStore({ cwd: join(w.root, "project-a"), env: { HOME: home } as NodeJS.ProcessEnv });
  const { runId } = first.createRunDirectory({ cwd: first.cwd, parentRunId: "root_global", rootSessionId: "root_global" });
  first.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_global",
      rootSessionId: "root_global",
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "oneshot",
      cwd: first.cwd,
      state: "completed",
    }),
  );

  const second = new RunStore({ cwd: join(w.root, "project-b"), env: { HOME: home } as NodeJS.ProcessEnv });
  assert.equal(second.readStatus(runId).state, "completed");
});

test("RunStore does not full re-read the index when the warmed index is unchanged", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  store.createRunDirectory({ cwd: w.root, parentRunId: "root_warm", rootSessionId: "root_warm" });
  assert.equal(store.listDirectChildren("root_warm").length, 1);

  (store as unknown as { readRunIndexUncached: () => never; readRunIndexSourcesUncached: () => never }).readRunIndexUncached = () => {
    throw new Error("unexpected full index re-read");
  };
  (store as unknown as { readRunIndexSourcesUncached: () => never }).readRunIndexSourcesUncached = () => {
    throw new Error("unexpected full index source re-read");
  };

  assert.equal(store.listDirectChildren("root_warm").length, 1);
  assert.equal(store.readRunIndex().length, 1);
});

test("RunStore observes externally appended index records after the cache is warm", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  store.createRunDirectory({ cwd: w.root, parentRunId: "root_external", rootSessionId: "root_external" });
  assert.equal(store.listDirectChildren("root_external").length, 1);

  const external = {
    schemaVersion: 1,
    runId: "run_external_append",
    runDir: join(w.runRoot, "run_external_append"),
    projectRoot: w.root,
    parentRunId: "root_external",
    rootSessionId: "root_external",
    createdAt: new Date().toISOString(),
  };
  const before = statSync(store.indexPath());
  writeFileSync(store.indexPath(), `${JSON.stringify(external)}\n`, { encoding: "utf8", flag: "a" });
  utimesSync(store.indexPath(), before.atime, before.mtime);

  const children = store.listDirectChildren("root_external").map((record) => record.runId).sort();
  assert.deepEqual(children, ["run_external_append", store.readRunIndex()[0].runId].sort());
});

test("RunStore keeps unparsed tail bytes live until a partial index record completes", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  store.createRunDirectory({ cwd: w.root, parentRunId: "root_partial", rootSessionId: "root_partial" });
  assert.equal(store.listDirectChildren("root_partial").length, 1);

  const external = JSON.stringify({
    schemaVersion: 1,
    runId: "run_partial_append",
    runDir: join(w.runRoot, "run_partial_append"),
    projectRoot: w.root,
    parentRunId: "root_partial",
    rootSessionId: "root_partial",
    createdAt: new Date().toISOString(),
  });
  const split = Math.floor(external.length / 2);
  writeFileSync(store.indexPath(), external.slice(0, split), { encoding: "utf8", flag: "a" });
  assert.equal(store.listDirectChildren("root_partial").some((record) => record.runId === "run_partial_append"), false);
  assert.equal(store.listDirectChildren("root_partial").some((record) => record.runId === "run_partial_append"), false);

  writeFileSync(store.indexPath(), `${external.slice(split)}\n`, { encoding: "utf8", flag: "a" });
  assert.equal(store.listDirectChildren("root_partial").some((record) => record.runId === "run_partial_append"), true);
});

test("RunStore reads and writes status, events, inbox, and terminal result", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_a", rootSessionId: "root_a" });
  const status = createInitialStatus({
    runId,
    parentRunId: "root_a",
    rootSessionId: "root_a",
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd: w.root,
  });
  store.writeStatus(status);
  assert.equal(store.readStatus(runId).state, "created");

  store.appendEvent(runId, createRunEvent({ sequence: 1, runId, parentRunId: "root_a", type: "question", summary: "Need input" }));
  const events = store.readEvents(runId);
  assert.equal(events.records[0]?.eventId, "evt_000001");
  assert.equal(events.cursor.lastEventId, "evt_000001");

  store.appendInboxMessage(runId, createInboxMessage({ toRunId: runId, fromRunId: "root_a", body: "Answer", type: "answer" }));
  assert.equal(store.readInbox(runId).records[0]?.type, "answer");

  assert.equal(store.readResult(runId), undefined);
  store.writeResult(createRunResult({ runId, parentRunId: "root_a", agentName: "scout", state: "completed", summary: "Done" }));
  assert.equal(store.readResult(runId)?.success, true);
});
