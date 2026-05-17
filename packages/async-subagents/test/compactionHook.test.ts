import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import asyncSubagentsPiExtension from "../extensions/pi/index.js";
import { ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE } from "../extensions/pi/compactionReminder.js";
import { readRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import type { RunState } from "../src/types.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-compact-hook-"));
  return { root, store: new RunStore({ cwd: root }), parentRunId: "root_hook" };
}

function addRun(input: { store: RunStore; root: string; parentRunId: string; displayName?: string; state: RunState; summary?: string; resultReady?: boolean }) {
  const { runId } = input.store.createRunDirectory({ cwd: input.root, parentRunId: input.parentRunId, rootSessionId: input.parentRunId });
  const status = createInitialStatus({
    runId,
    parentRunId: input.parentRunId,
    rootSessionId: input.parentRunId,
    displayName: input.displayName,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd: input.root,
    state: input.state,
  });
  input.store.writeStatus({ ...status, summary: input.summary, resultReady: input.resultReady ?? false });
  return runId;
}

function loadExtensionHarness() {
  const handlers = new Map<string, Function[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(event: string, handler: Function) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerMessageRenderer() {},
    registerCommand() {},
    registerTool() {},
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };
  asyncSubagentsPiExtension(pi as never);
  return { handlers, sent };
}

test("session_compact hook injects an async status reminder when runs need attention", async () => {
  const w = workspace();
  const { handlers, sent } = loadExtensionHarness();

  const start = handlers.get("session_start")?.[0];
  const compact = handlers.get("session_compact")?.[0];
  assert.ok(start);
  assert.ok(compact);

  const ctx = { cwd: w.root, hasUI: false, ui: { setStatus() {}, setWidget() {} } };
  await start({}, ctx);
  const identity = readRootSession({ cwd: w.root });
  assert.ok(identity);
  const runId = addRun({ ...w, parentRunId: identity.parentRunId, displayName: "Alex", state: "running", summary: "auditing compaction" });
  await compact({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.message.customType, ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE);
  assert.match(sent[0]?.message.content, new RegExp(runId));
  assert.match(sent[0]?.message.content, /@Alex \(scout\).*running/);
  assert.deepEqual(sent[0]?.options, { deliverAs: "steer" });

  const shutdown = handlers.get("session_shutdown")?.[0];
  await shutdown?.({}, ctx);
});

test("session_compact hook stays quiet when there is no in-flight or unread async work", async () => {
  const w = workspace();
  const { handlers, sent } = loadExtensionHarness();
  const ctx = { cwd: w.root, hasUI: false, ui: { setStatus() {}, setWidget() {} } };

  await handlers.get("session_start")?.[0]?.({}, ctx);
  const identity = readRootSession({ cwd: w.root });
  assert.ok(identity);
  addRun({ ...w, parentRunId: identity.parentRunId, displayName: "Done", state: "completed", summary: "already handled" });
  await handlers.get("session_compact")?.[0]?.({ type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);

  assert.equal(sent.length, 0);
  await handlers.get("session_shutdown")?.[0]?.({}, ctx);
});
