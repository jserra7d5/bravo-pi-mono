import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
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
  assert.equal(store.listDirectChildren("root_a").length, 1);
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
