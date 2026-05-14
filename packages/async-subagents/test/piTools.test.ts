import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSubagentTools } from "../extensions/pi/tools.js";
import { createRunResult } from "../src/result.js";
import { createRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import type { RootSessionIdentity } from "../src/types.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-tools-"));
  const identity = createRootSession({ cwd: root, rootSessionId: "root_test" });
  const store = new RunStore({ cwd: root });
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: identity.parentRunId,
      rootSessionId: identity.rootSessionId,
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "oneshot",
      cwd: root,
      state: "running",
    }),
  );
  return { root, identity, runId };
}

function tools(identity: RootSessionIdentity) {
  const built = buildSubagentTools({
    getRootIdentity() {
      return identity;
    },
  });
  return Object.fromEntries(built.map((tool) => [tool.name, tool]));
}

test("subagent_status tool defaults to root session direct children", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_status.execute("call", {}, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal((result.details.rows as Array<{ runId: string }>)[0]?.runId, w.runId);
  assert.equal((result.details.counts as { active: number }).active, 1);
});

test("subagent_message appends inbox messages and waits for child-control acknowledgement", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_message.execute("call", { runId: w.runId, body: "Continue" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.appended, true);
  assert.equal(result.details.liveDelivered, false);
  assert.equal((result.details.unsupported as { code?: string }).code, "LIVE_MESSAGE_UNSUPPORTED");
});

test("subagent_result can recover by runDir", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const runDir = store.pathsFor({ runId: w.runId }).runDir;
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "Recovered result" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_result.execute("call", { runDir }, undefined, undefined, { cwd: w.root });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.body, "Recovered result");
  assert.equal(result.details.runDir, runDir);
});
