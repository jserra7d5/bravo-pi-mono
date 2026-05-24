import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSubagentTools } from "../extensions/pi/tools.js";
import { pollWakeups } from "../extensions/pi/wakeups.js";
import { acquireRootSessionLease } from "../src/leases.js";
import { createRunResult } from "../src/result.js";
import { createRootSession } from "../src/rootSession.js";
import { RunStore } from "../src/runStore.js";
import { startSubagent } from "../src/start.js";
import { createInitialStatus } from "../src/status.js";
import { NAME_PACKS } from "../src/namePacks.js";
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

function continuationLockPath(store: RunStore, rootRunId: string, piSessionPath: string): string {
  const key = `${rootRunId}:${piSessionPath}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(resolve(store.runRoot, ".."), "continuation-locks", `${key}.json`);
}

test("subagent_status tool defaults to root session direct children", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_status.execute("call", {}, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal((result.details.rows as Array<{ runId: string }>)[0]?.runId, w.runId);
  assert.equal((result.details.counts as { active: number }).active, 1);
});

test("subagent_start marks waited terminal results handled before subscribing wakeups", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  const runDir = store.pathsFor({ runId: w.runId }).runDir;
  const terminalResult = createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", summary: "Done", body: "Full body" });
  const built = Object.fromEntries(
    buildSubagentTools({
      getRootIdentity() {
        return w.identity;
      },
      async startSubagent() {
        store.writeResult(terminalResult);
        store.writeStatus({ ...status, state: "completed", resultReady: true, summary: "Done" });
        return {
          runId: w.runId,
          runDir,
          agentName: "scout",
          state: "completed",
          started: true,
          waited: true,
          waitResult: {
            state: "ready",
            mode: "race",
            readyRunIds: [w.runId],
            events: [],
            results: [terminalResult],
            statuses: [{ runId: w.runId, state: "completed", summary: "Done" }],
            cursors: {},
            remainingRunIds: [],
            timedOut: false,
            next: [],
          },
          contextPolicy: "fresh",
          sessionPolicy: "record",
          next: [{ tool: "subagent_result", args: { runId: w.runId } }],
        };
      },
    }).map((tool) => [tool.name, tool]),
  );

  const result = await built.subagent_start.execute("call", { agent: "scout", task: "review", mode: "sync" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(store.readStatus(w.runId).resultReady, false);
  acquireRootSessionLease({ cwd: w.root, rootSessionId: w.identity.rootSessionId, ownerId: "owner_a", ttlMs: 10_000 });
  assert.equal(pollWakeups({ store, parentRunId: w.identity.parentRunId, rootSessionId: w.identity.rootSessionId, ownerId: "owner_a", modelFollowUpOnly: true }).length, 0);
});

test("subagent_message appends inbox messages and waits for child-control acknowledgement", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_message.execute("call", { runId: w.runId, body: "Continue" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.appended, true);
  assert.equal(result.details.liveDelivered, false);
  assert.equal((result.details.unsupported as { code?: string }).code, "LIVE_MESSAGE_UNSUPPORTED");
});

test("subagent_message can append without required acknowledgement", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_message.execute("call", { runId: w.runId, body: "Continue", requiresAck: false }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.appended, true);
  assert.equal(result.details.liveDelivered, false);
});

test("subagent_message rejects lifecycle controls", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_message.execute("call", { runId: w.runId, type: "cancel", body: "Stop" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "LIFECYCLE_MESSAGE_REJECTED");
});

test("subagent_interrupt cancel writes terminal cancelled result", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_interrupt.execute("call", { runId: w.runId, action: "cancel", reason: "Wrong direction" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.state, "cancelled");
  const store = new RunStore({ cwd: w.root });
  assert.equal(store.readStatus(w.runId).state, "cancelled");
  assert.equal(store.readResult(w.runId)?.state, "cancelled");
  assert.equal(store.readInbox(w.runId).records.at(-1)?.type, "cancel");
});

test("subagent_continue rejects non-paused runs", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, body: "Use the narrowed scope" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "RUN_NOT_PAUSED");
});

test("subagent_continue records running state even when required ack fails", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeStatus({ ...status, state: "paused", pid: process.pid, processHealth: "alive", thinkingLevel: "low" });
  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, thinkingLevel: "high" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.state, "running");
  assert.equal(result.details.thinkingLevel, "high");
  assert.equal(store.readStatus(w.runId).state, "running");
  assert.equal(store.readStatus(w.runId).thinkingLevel, "high");
  assert.equal(store.readInbox(w.runId).records.at(-1)?.thinkingLevel, "high");
});

test("subagent_continue creates an async terminal continuation using the original Pi session", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({
    ...original,
    state: "completed",
    resultReady: true,
    piSessionPath: originalSession,
    requestedPiSessionPath: join(store.pathsFor({ runId: w.runId }).runDir, "pi-session", "session.jsonl"),
    thinkingLevel: "low",
  });
  store.writeResult(createRunResult({
    runId: w.runId,
    parentRunId: w.identity.parentRunId,
    agentName: "scout",
    thinkingLevel: "low",
    state: "completed",
    summary: "Original done",
    piSessionPath: originalSession,
  }));

  const calls: unknown[] = [];
  const built = buildSubagentTools({
    getRootIdentity() {
      return w.identity;
    },
    startSubagent(input) {
      calls.push(input);
      return startSubagent({ ...input, fake: { mode: "immediate", body: "Continuation done" } });
    },
  });
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));
  const result = await byName.subagent_continue.execute("call", { runId: w.runId, body: "Add the retry loop" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.continuedFromRunId, w.runId);
  assert.equal(result.details.continuationRootRunId, w.runId);
  assert.equal(result.details.continuationSequence, 1);
  assert.equal(result.details.continuationOfPiSessionPath, originalSession);
  assert.equal((calls[0] as { startMode?: string }).startMode, "async");

  const newRunId = result.details.runId as string;
  assert.notEqual(newRunId, w.runId);
  const continuation = store.readStatus(newRunId);
  assert.equal(continuation.continuedFromRunId, w.runId);
  assert.equal(continuation.continuationRootRunId, w.runId);
  assert.equal(continuation.continuationSequence, 1);
  assert.equal(continuation.continuationOfPiSessionPath, originalSession);
  assert.equal(continuation.piSessionPath, originalSession);
  assert.equal(store.readResult(newRunId)?.continuedFromRunId, w.runId);

  const launch = JSON.parse(readFileSync(join(store.pathsFor({ runId: newRunId }).runDir, "logs", "launch.json"), "utf8"));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--session"), launch.args.indexOf("--session") + 2), ["--session", originalSession]);
  assert.equal(launch.continuation.continuedFromRunId, w.runId);
});

test("subagent_continue rejects concurrent terminal continuation starts for the same session", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "completed", resultReady: true, piSessionPath: originalSession });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", piSessionPath: originalSession }));

  let launchCount = 0;
  const built = buildSubagentTools({
    getRootIdentity() {
      return w.identity;
    },
    async startSubagent(input) {
      launchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return startSubagent({ ...input, fake: { mode: "immediate", body: "Continuation done" } });
    },
  });
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));

  const [first, second] = await Promise.all([
    byName.subagent_continue.execute("call-1", { runId: w.runId, body: "First" }, undefined, undefined, { cwd: w.root }),
    byName.subagent_continue.execute("call-2", { runId: w.runId, body: "Second" }, undefined, undefined, { cwd: w.root }),
  ]);

  assert.equal(launchCount, 1);
  const errors = [first, second].filter((result) => result.isError);
  const successes = [first, second].filter((result) => !result.isError);
  assert.equal(successes.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.details.code, "TERMINAL_CONTINUATION_START_IN_PROGRESS");
});

test("subagent_continue recovers stale terminal continuation startup locks", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "completed", resultReady: true, piSessionPath: originalSession });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", piSessionPath: originalSession }));
  const lockPath = continuationLockPath(store, w.runId, originalSession);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    rootRunId: w.runId,
    piSessionPath: originalSession,
    requestedByRunId: w.runId,
    claimedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  })}\n`, "utf8");

  let launchCount = 0;
  const built = buildSubagentTools({
    getRootIdentity() {
      return w.identity;
    },
    startSubagent(input) {
      launchCount += 1;
      return startSubagent({ ...input, fake: { mode: "immediate", body: "Recovered stale lock" } });
    },
  });
  const byName = Object.fromEntries(built.map((tool) => [tool.name, tool]));
  const result = await byName.subagent_continue.execute("call", { runId: w.runId, body: "Continue after stale lock" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(launchCount, 1);
  assert.equal(result.details.continuedFromRunId, w.runId);
});

test("subagent_continue points to an active terminal continuation instead of launching another", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const originalSession = join(w.root, "original-child-session.jsonl");
  const original = store.readStatus(w.runId);
  store.writeStatus({ ...original, state: "completed", resultReady: true, piSessionPath: originalSession });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", piSessionPath: originalSession }));
  const active = store.createRunDirectory({
    cwd: w.root,
    parentRunId: w.identity.parentRunId,
    rootSessionId: w.identity.rootSessionId,
    contextPolicy: "fresh",
    sessionPolicy: "record",
    piSessionPath: originalSession,
    continuedFromRunId: w.runId,
    continuationRootRunId: w.runId,
    continuationSequence: 1,
    continuationOfPiSessionPath: originalSession,
  });
  store.writeStatus(createInitialStatus({
    runId: active.runId,
    parentRunId: w.identity.parentRunId,
    rootSessionId: w.identity.rootSessionId,
    agentName: "scout",
    agentSource: "builtin",
    definitionPath: "/builtin/scout.md",
    mode: "oneshot",
    cwd: w.root,
    state: "running",
    piSessionPath: originalSession,
    continuedFromRunId: w.runId,
    continuationRootRunId: w.runId,
    continuationSequence: 1,
    continuationOfPiSessionPath: originalSession,
  }));

  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, body: "Third" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "ACTIVE_TERMINAL_CONTINUATION");
  assert.equal(result.details.activeRunId, active.runId);
});

test("subagent_continue returns a structured error for terminal runs without a recorded Pi session", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeStatus({ ...status, state: "completed", resultReady: true, sessionPolicy: "none", piSessionPath: undefined, requestedPiSessionPath: undefined });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", sessionPolicy: "none" }));

  const built = tools(w.identity);
  const result = await built.subagent_continue.execute("call", { runId: w.runId, body: "Continue anyway" }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "TERMINAL_CONTINUATION_SESSION_UNAVAILABLE");
});

test("Pi tool schemas expose thinking level controls and skill forwarding", () => {
  const built = buildSubagentTools();
  const startSchema = JSON.stringify(built.find((tool) => tool.name === "subagent_start")?.parameters);
  assert.ok(startSchema.includes("thinkingLevel"));
  assert.ok(startSchema.includes("skills"));
  assert.ok(startSchema.includes("Children do not inherit parent-session skills automatically"));
  assert.ok(JSON.stringify(built.find((tool) => tool.name === "subagent_continue")?.parameters).includes("thinkingLevel"));
});

test("subagent_start rejects path-like forwarded skills", async () => {
  const w = workspace();
  const built = tools(w.identity);
  const result = await built.subagent_start.execute("call", { agent: "scout", task: "Probe", skills: ["./local-skill"] }, undefined, undefined, { cwd: w.root });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "INVALID_SKILL_NAME");
  assert.match(result.content[0].text, /path-like skill values are not allowed/);
});

test("every subagent tool opts into the self-rendered shell so card chrome sits on chat bg", () => {
  // Without renderShell: "self" Pi wraps tool output in the pending/success/error Box. Our
  // cards bring their own chrome; the tinted box clashes underneath. Every tool must opt in.
  const built = buildSubagentTools();
  assert.ok(built.length >= 7);
  for (const tool of built) {
    assert.equal((tool as { renderShell?: string }).renderShell, "self", `tool ${tool.name} missing renderShell: "self"`);
  }
});

test("startSubagent surfaces agent-definition detail and forwarded skills on the start result", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const started = await startSubagent({
    agent: "scout",
    task: "Probe",
    cwd: w.root,
    runRoot: store.runRoot,
    parentRunId: w.identity.parentRunId,
    skills: ["tui-design"],
    fake: { mode: "immediate", body: "Done" },
  });
  // scout.md defines: tools: [read, grep, find, ls], maxSubagentDepth: 0
  assert.ok(Array.isArray(started.tools) && started.tools.includes("read"));
  assert.equal(started.maxSubagentDepth, 0);
  assert.deepEqual(started.skills, ["tui-design"]);
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
  assert.equal(store.readStatus(w.runId).resultReady, false);
});

test("subagent_status reports result and status mismatches", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "Done" }));

  const built = tools(w.identity);
  const result = await built.subagent_status.execute("call", { runIds: [w.runId] }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  const row = (result.details.rows as Array<{ diagnostics?: string[] }>)[0];
  assert.ok(row?.diagnostics?.includes("result exists but status is non-terminal"));
});

test("subagent_name_pack inspects and changes the active pack for future runs", async () => {
  const w = workspace();
  const built = tools(w.identity);

  const initial = await built.subagent_name_pack.execute("call", {}, undefined, undefined, { cwd: w.root });
  assert.equal(initial.details.activePack, "default");

  const changed = await built.subagent_name_pack.execute("call", { pack: "clones" }, undefined, undefined, { cwd: w.root });
  assert.equal(changed.details.activePack, "clones");

  const store = new RunStore({ cwd: w.root });
  const started = await startSubagent({
    agent: "scout",
    task: "Use clone name",
    cwd: w.root,
    runRoot: store.runRoot,
    parentRunId: w.identity.parentRunId,
    fake: { mode: "immediate", body: "Done" },
  });
  assert.ok(NAME_PACKS.clones.includes(started.displayName as (typeof NAME_PACKS.clones)[number]));
  assert.equal(started.agentName, "scout");
});

test("subagent_wait returns usable result bodies with truncation metadata", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "0123456789abcdef" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_wait.execute("call", { runIds: [w.runId], until: "result", maxBytes: 8 }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  const ready = (result.details.results as Array<{ body?: string; bodyTruncation?: { truncated?: boolean; originalBytes?: number; returnedBytes?: number; maxBytes?: number } }>)[0];
  assert.equal(ready.body, "01234...");
  assert.match(result.content[0]?.text ?? "", /01234\.\.\./);
  assert.match(result.content[0]?.text ?? "", /Body truncated: 8 of 16 bytes returned/);
  assert.equal(ready.bodyTruncation?.truncated, true);
  assert.equal(ready.bodyTruncation?.originalBytes, 16);
  assert.equal(ready.bodyTruncation?.returnedBytes, 8);
  assert.equal(ready.bodyTruncation?.maxBytes, 8);
  assert.equal(store.readStatus(w.runId).resultReady, false);
});

test("subagent_wait omits model-facing bodies when includeResult is false", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "secret body" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_wait.execute("call", { runIds: [w.runId], until: "result", includeResult: false, timeoutMs: 0 }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.content[0]?.text ?? "", /secret body/);
});

test("subagent_result omits model-facing body when includeBody is false", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "secret body" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_result.execute("call", { runId: w.runId, includeBody: false }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.content[0]?.text ?? "", /secret body/);
  assert.match(result.content[0]?.text ?? "", /Body omitted: includeBody=false/);
});

test("subagent_result returns body with truncation metadata", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root });
  const status = store.readStatus(w.runId);
  store.writeResult(createRunResult({ runId: w.runId, parentRunId: w.identity.parentRunId, agentName: "scout", state: "completed", body: "0123456789abcdef" }));
  store.writeStatus({ ...status, state: "completed", resultReady: true });

  const built = tools(w.identity);
  const result = await built.subagent_result.execute("call", { runId: w.runId, maxBytes: 8 }, undefined, undefined, { cwd: w.root });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.body, "01234...");
  assert.match(result.content[0]?.text ?? "", /01234\.\.\./);
  assert.match(result.content[0]?.text ?? "", /Body truncated: 8 of 16 bytes returned/);
  assert.deepEqual((result.details.bodyTruncation as { truncated?: boolean; returnedBytes?: number; maxBytes?: number }).truncated, true);
  assert.equal((result.details.bodyTruncation as { returnedBytes?: number }).returnedBytes, 8);
  assert.equal(store.readStatus(w.runId).resultReady, false);
});
