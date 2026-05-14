import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootSession, readRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";

test("root sessions in the same repo keep direct-child defaults separate", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-root-"));
  const sessionsDir = join(root, ".subagents", "sessions");
  const a = createRootSession({ cwd: root, rootSessionId: "root_a", sessionsDir });
  const b = createRootSession({ cwd: root, rootSessionId: "root_b", sessionsDir });
  assert.notEqual(a.rootSessionId, b.rootSessionId);

  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  store.createRunDirectory({ cwd: root, parentRunId: a.parentRunId, rootSessionId: a.rootSessionId });
  store.createRunDirectory({ cwd: root, parentRunId: b.parentRunId, rootSessionId: b.rootSessionId });
  assert.equal(store.listDirectChildren(a.parentRunId).length, 1);
  assert.equal(store.listDirectChildren(b.parentRunId).length, 1);
});

test("readRootSession returns the latest session for a cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-root-"));
  const sessionsDir = join(root, ".subagents", "sessions");
  createRootSession({ cwd: root, rootSessionId: "root_a", sessionsDir });
  const latest = createRootSession({ cwd: root, rootSessionId: "root_b", sessionsDir });
  assert.equal(readRootSession({ cwd: root, sessionsDir })?.rootSessionId, latest.rootSessionId);
});
