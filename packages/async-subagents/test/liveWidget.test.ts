import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderLiveWidget } from "../extensions/pi/liveWidget.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import type { RunState } from "../src/types.js";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-live-"));
  return { root, store: new RunStore({ cwd: root }), parentRunId: "root_live" };
}

function addRun(input: { store: RunStore; root: string; parentRunId: string; displayName: string; state: RunState; summary: string; updatedAt?: string }) {
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
  input.store.writeStatus({
    ...status,
    summary: input.summary,
    resultReady: input.state === "completed",
    updatedAt: input.updatedAt ?? status.updatedAt,
    lastActivityAt: input.updatedAt ?? status.updatedAt,
  });
  return runId;
}

test("live widget sorts active and waiting rows before terminal rows, prunes old completed rows, and caps rows", () => {
  const w = workspace();
  addRun({ ...w, displayName: "OldDone", state: "completed", summary: "old completed", updatedAt: isoAgo(10 * 60_000) });
  addRun({ ...w, displayName: "Done", state: "completed", summary: "recent completed", updatedAt: isoAgo(5_000) });
  addRun({ ...w, displayName: "Work1", state: "running", summary: "running one" });
  addRun({ ...w, displayName: "Wait", state: "waiting_for_input", summary: "needs input" });
  addRun({ ...w, displayName: "Work3", state: "queued", summary: "queued" });
  addRun({ ...w, displayName: "Work4", state: "blocked", summary: "blocked" });
  addRun({ ...w, displayName: "Stopped", state: "cancelled", summary: "cancelled", updatedAt: isoAgo(60_000) });

  const lines = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId, maxRows: 5, terminalCompletedVisibleMs: 5 * 60_000 });
  const body = lines.join("\n");

  assert.equal(lines.length, 7);
  assert.match(lines[1], /Work4|Wait/);
  assert.match(body, /Done scout done/);
  assert.doesNotMatch(body, /OldDone/);
  assert.doesNotMatch(body, /run_/);
  assert.match(lines.at(-1) ?? "", /^\+1 more$/);
  assert.ok(lines.findIndex((line) => /Done/.test(line)) > lines.findIndex((line) => /Work/.test(line)));
});

test("live widget header omits empty terminal groups", () => {
  const w = workspace();
  addRun({ ...w, displayName: "Rex", state: "running", summary: "working" });

  const header = renderLiveWidget({ store: w.store, parentRunId: w.parentRunId })[0] ?? "";
  assert.match(header, /1 running - 0 waiting$/);
  assert.doesNotMatch(header, /0 finished/);
});
