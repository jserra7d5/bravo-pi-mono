import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSubagent } from "../src/start.js";
import { sendSubagentMessage } from "../src/message.js";
import { createRunResult, readSubagentResult } from "../src/result.js";
import { RunStore } from "../src/runStore.js";
import { createRunEvent } from "../src/events.js";
import { createInitialStatus, readSubagentStatus, updateRunStatus } from "../src/status.js";
import { waitOnce, waitSubagents } from "../src/wait.js";
import { finalizeTerminalRun } from "../src/lifecycle.js";
import { assignDisplayName } from "../src/namePacks.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-core-"));
  const agentsDir = join(root, ".agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "scout.md"),
    `---
description: Test scout.
tools: []
mode: oneshot
---

Test scout body.
`,
    "utf8",
  );
  return { root, runRoot: join(root, ".subagents", "runs") };
}

function createStoredRun(store: RunStore, root: string, parentRunId: string) {
  const { runId } = store.createRunDirectory({ cwd: root, parentRunId, rootSessionId: parentRunId });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId,
      rootSessionId: parentRunId,
      agentName: "scout",
      agentSource: "project",
      definitionPath: join(root, ".agents", "scout.md"),
      mode: "oneshot",
      cwd: root,
      state: "running",
    }),
  );
  return runId;
}

async function waitForStatusState(store: RunStore, runId: string, state: string, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (store.readStatus(runId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(store.readStatus(runId).state, state);
}

test("startSubagent drives a detached fake child lifecycle", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Return a fake result",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "child" },
  });

  assert.equal(started.agentName, "scout");
  assert.equal(started.contextPolicy, "fresh");
  assert.equal(started.sessionPolicy, "record");
  assert.equal(started.piSessionPath, join(started.runDir, "pi-session", "session.jsonl"));
  assert.equal(started.thinkingLevel, undefined);
  assert.equal(started.waited, false);
  assert.ok(existsSync(join(started.runDir, "logs", "launch.json")));

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 5000, pollIntervalMs: 25 });
  assert.equal(waited.state, "ready");
  assert.equal(waited.results[0]?.state, "completed");
  assert.match(waited.results[0]?.body ?? "", /Fake child completed/);
  await waitForStatusState(store, started.runId, "completed");
  assert.equal(store.readStatus(started.runId).state, "completed");
  assert.equal(store.readStatus(started.runId).piSessionPath, join(started.runDir, "pi-session", "session.jsonl"));
  assert.equal(store.readStatus(started.runId).thinkingLevel, undefined);
  assert.equal(store.readResult(started.runId)?.piSessionPath, join(started.runDir, "pi-session", "session.jsonl"));
  assert.equal(store.readResult(started.runId)?.thinkingLevel, undefined);
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(launch.args.includes("--thinking"), false);
  assert.equal(Object.hasOwn(launch, "thinkingLevel"), false);
});

test("startSubagent assigns and persists generated display names separately from agent type", async () => {
  const w = workspace();
  const first = await startSubagent({
    agent: "scout",
    task: "Named by pack",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "immediate", body: "Done" },
  });
  const second = await startSubagent({
    agent: "scout",
    task: "Another generated name",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "immediate", body: "Done" },
  });

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  assert.equal(first.agentName, "scout");
  assert.ok(first.displayName);
  assert.ok(second.displayName);
  assert.equal(store.readStatus(first.runId).displayName, first.displayName);
  assert.equal(store.readResult(first.runId)?.displayName, first.displayName);
  assert.equal(store.readStatus(second.runId).agent.name, "scout");
});

test("assignDisplayName skips names already used by active runs", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test" });
  store.writeStatus(createInitialStatus({
    runId,
    parentRunId: "root_test",
    displayName: "Alex",
    namePack: "default",
    agentName: "scout",
    agentSource: "project",
    definitionPath: join(w.root, ".agents", "scout.md"),
    mode: "oneshot",
    cwd: w.root,
    state: "running",
  }));

  const assigned = assignDisplayName({ runRoot: w.runRoot, random: () => 0 });
  assert.equal(assigned.displayName, "Blair");
});

test("startSubagent can explicitly opt out of Pi session recording", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "No session",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    session: "none",
    fake: { mode: "immediate", body: "No session done" },
  });
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  assert.equal(started.sessionPolicy, "none");
  assert.equal(started.piSessionPath, undefined);
  assert.equal(store.readStatus(started.runId).sessionPolicy, "none");
  assert.equal(store.readResult(started.runId)?.sessionPolicy, "none");
});

test("startSubagent applies and persists definition thinking level with start override precedence", async () => {
  const w = workspace();
  writeFileSync(
    join(w.root, ".agents", "thinker.md"),
    `---
description: Thinking scout.
model: openai-codex/gpt-5.5
thinkingLevel: low
---

Thinking body.
`,
    "utf8",
  );
  const started = await startSubagent({
    agent: "thinker",
    task: "Use requested thinking",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    thinkingLevel: "high",
    fake: { mode: "immediate", body: "Done" },
  });

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const status = store.readStatus(started.runId);
  const result = store.readResult(started.runId);
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(started.model, "openai-codex/gpt-5.5");
  assert.equal(started.thinkingLevel, "high");
  assert.equal(status.model, "openai-codex/gpt-5.5");
  assert.equal(status.thinkingLevel, "high");
  assert.equal(result?.model, "openai-codex/gpt-5.5");
  assert.equal(result?.thinkingLevel, "high");
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--thinking"), launch.args.indexOf("--thinking") + 2), ["--thinking", "high"]);
  assert.equal(launch.thinkingLevel, "high");
});

test("startSubagent applies a named agent variant before launch", async () => {
  const w = workspace();
  writeFileSync(
    join(w.root, ".agents", "variant-scout.md"),
    `---
description: Variant scout.
model: openai-codex/gpt-5.4-mini
thinkingLevel: low
tools: [read]
variants:
  gemini:
    model: antigravity-code-assist/gemini-3.5-flash
    thinkingLevel: high
    tools: [read, bash]
---

Variant scout body.
`,
    "utf8",
  );
  const started = await startSubagent({
    agent: "variant-scout",
    variant: "gemini",
    task: "Use variant config",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "immediate", body: "Done" },
  });

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const status = store.readStatus(started.runId);
  const result = store.readResult(started.runId);
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(started.variant, "gemini");
  assert.equal(started.model, "antigravity-code-assist/gemini-3.5-flash");
  assert.equal(started.thinkingLevel, "high");
  assert.deepEqual(started.tools, ["read", "bash"]);
  assert.equal(status.variant, "gemini");
  assert.equal(status.agent.variant, "gemini");
  assert.equal(result?.variant, "gemini");
  assert.equal(launch.model, "antigravity-code-assist/gemini-3.5-flash");
  assert.equal(launch.variant, "gemini");
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--model"), launch.args.indexOf("--model") + 2), ["--model", "antigravity-code-assist/gemini-3.5-flash"]);
});

test("model preflight fails before launch when isolated child Pi cannot see the requested model", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi.js");
  writeFileSync(
    piBin,
    `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log('No models matching "gemini-3.5-flash"');
  process.exit(0);
}
console.error("child should not launch after failed preflight");
process.exit(99);
`,
    "utf8",
  );
  chmodSync(piBin, 0o755);
  writeFileSync(
    join(w.root, ".agents", "gemini-scout.md"),
    `---
description: Gemini scout.
model: antigravity-code-assist/gemini-3.5-flash
tools: []
---

Gemini scout body.
`,
    "utf8",
  );

  const started = await startSubagent({
    agent: "gemini-scout",
    task: "Should fail preflight",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    piBin,
  });

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const result = store.readResult(started.runId);
  assert.equal(started.state, "failed");
  assert.equal(result?.error?.code, "MODEL_PREFLIGHT_FAILED");
  assert.match(result?.body ?? "", /provider extension/);
  assert.ok(existsSync(join(started.runDir, "logs", "model-preflight.json")));
});

test("model preflight uses the selected variant extension set", async () => {
  const w = workspace();
  const extensionPath = "provider-index";
  const piBin = join(w.root, "fake-pi.js");
  writeFileSync(
    piBin,
    `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  if (!process.argv.includes(${JSON.stringify(extensionPath)})) {
    console.error('No models matching "gemini-3.5-flash"');
    process.exit(0);
  }
  console.error("provider                 model");
  console.error("antigravity-code-assist  gemini-3.5-flash");
  process.exit(0);
}
console.log("Variant child completed");
`,
    "utf8",
  );
  chmodSync(piBin, 0o755);
  writeFileSync(
    join(w.root, ".agents", "variant-provider.md"),
    `---
description: Provider variant.
model: openai-codex/gpt-5.5
tools: []
variants:
  gemini:
    model: antigravity-code-assist/gemini-3.5-flash
    extensions: [${extensionPath}]
---

Provider variant body.
`,
    "utf8",
  );

  const started = await startSubagent({
    agent: "variant-provider",
    variant: "gemini",
    task: "Should pass preflight",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    piBin,
  });

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  await waitForStatusState(store, started.runId, "completed", 5000);
  const result = store.readResult(started.runId);
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(store.readStatus(started.runId).state, "completed");
  assert.match(result?.body ?? "", /Variant child completed/);
  assert.deepEqual(launch.extensions, [extensionPath]);
  assert.ok(existsSync(join(started.runDir, "logs", "model-preflight.json")));
});

test("context fork fails clearly without a parent Pi session reference", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Fork without parent",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    context: "fork",
    fake: { mode: "immediate", body: "should not run" },
  });
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const result = store.readResult(started.runId);
  assert.equal(started.state, "failed");
  assert.equal(result?.error?.code, "PARENT_PI_SESSION_UNAVAILABLE");
});

test("context fork uses branch adapter returned path as actual Pi session path", async () => {
  const w = workspace();
  const branchPath = join(w.root, ".subagents", "runs", "generated-fork.jsonl");
  const calls: unknown[] = [];
  const started = await startSubagent({
    agent: "scout",
    task: "Fork with branch",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    context: "fork",
    parentPiSessionRef: { sessionFile: "/parent/session.jsonl", leafId: "leaf_1" },
    branchSession(input) {
      calls.push(input);
      return branchPath;
    },
    fake: { mode: "immediate", body: "Forked done" },
  });
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const status = store.readStatus(started.runId);
  assert.equal(calls.length, 1);
  assert.equal(status.contextPolicy, "fork");
  assert.equal(status.forkSourceSessionFile, "/parent/session.jsonl");
  assert.equal(status.forkSourceLeafId, "leaf_1");
  assert.equal(status.piSessionPath, branchPath);
  assert.equal(store.readResult(started.runId)?.piSessionPath, branchPath);
  assert.equal(store.listDirectChildren("root_test").filter((record) => record.runId === started.runId).length, 1);
});

test("context fork only falls back to fresh when explicitly allowed", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Fork fallback",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    context: "fork",
    allowFreshFallback: true,
    parentPiSessionRef: { sessionFile: "/parent/session.jsonl", leafId: "leaf_1" },
    branchSession() {
      throw new Error("branch unavailable");
    },
    fake: { mode: "immediate", body: "Fallback done" },
  });
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const status = store.readStatus(started.runId);
  assert.equal(status.contextPolicy, "fresh");
  assert.equal(status.forkFallback?.used, true);
  assert.equal(status.piSessionPath, join(started.runDir, "pi-session", "session.jsonl"));
  assert.equal(store.readResult(started.runId)?.forkFallback?.reason, "branch unavailable");
});

test("startSubagent returns async status guidance without waiting", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Start async fake result",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "child", env: { ASYNC_SUBAGENTS_FAKE_DELAY_MS: "50", ASYNC_SUBAGENTS_FAKE_BODY: "Async child completed" } },
  });

  assert.equal(started.waited, false);
  assert.deepEqual(started.next, [{ tool: "subagent_status", args: { runIds: [started.runId] } }]);
});

test("supervisor writes result before terminal status and terminal event", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Immediate fake result",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "immediate", body: "Immediate body" },
  });

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const status = store.readStatus(started.runId);
  const result = store.readResult(started.runId);
  const events = store.readEvents(started.runId).records.map((event) => event.type);

  assert.equal(status.state, "completed");
  assert.equal(status.resultReady, true);
  assert.equal(result?.body, "Immediate body");
  assert.deepEqual(events, ["started", "result", "completed"]);
  assert.ok(existsSync(join(started.runDir, "result.json")));
});

test("terminal finalization preserves an existing result when status is stale", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");
  const original = createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "cancelled", summary: "Cancelled first" });
  store.writeResult(original);

  const finalized = finalizeTerminalRun(store, {
    runId,
    parentRunId: "root_test",
    agentName: "scout",
    state: "failed",
    writerRole: "child-runtime",
    summary: "Late failure",
  });

  assert.equal(finalized.state, "cancelled");
  assert.equal(finalized.createdAt, original.createdAt);
  assert.equal(store.readStatus(runId).state, "cancelled");
  assert.deepEqual(store.readEvents(runId).records.map((event) => event.type), []);
});

test("spawn failure still records a terminal result after creating the run directory", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Fail to spawn",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "child", command: join(w.root, "missing-command"), args: [] },
  });

  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 5000, pollIntervalMs: 25 });
  assert.equal(waited.state, "ready");
  assert.equal(waited.results[0]?.state, "failed");
  assert.equal(waited.results[0]?.error?.code, "SPAWN_FAILED");
  assert.ok(existsSync(join(started.runDir, "result.json")));
});

test("waitOnce race mode returns the first ready run and coalesces terminal events into result readiness", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const first = createStoredRun(store, w.root, "root_test");
  const second = createStoredRun(store, w.root, "root_test");

  for (const runId of [first, second]) {
    const result = createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "completed", summary: `done ${runId}` });
    store.writeResult(result);
    store.appendEvent(runId, createRunEvent({ sequence: 2, runId, parentRunId: "root_test", type: "result", summary: "done", wake: true }));
    store.appendEvent(runId, createRunEvent({ sequence: 3, runId, parentRunId: "root_test", type: "completed", summary: "done", wake: true }));
  }

  const waited = waitOnce(store, { runIds: [first, second], mode: "race" });
  assert.deepEqual(waited.readyRunIds, [first]);
  assert.deepEqual(waited.results.map((result) => result.runId), [first]);
  assert.deepEqual(waited.events, []);
  assert.deepEqual(waited.remainingRunIds, [second]);
});

test("waitSubagents all mode accumulates staggered non-terminal events across polls", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const first = createStoredRun(store, w.root, "root_test");
  const second = createStoredRun(store, w.root, "root_test");

  setTimeout(() => {
    store.appendEvent(first, createRunEvent({ sequence: 4, runId: first, parentRunId: "root_test", type: "question", summary: "first ready", wake: true }));
  }, 25);
  setTimeout(() => {
    store.appendEvent(second, createRunEvent({ sequence: 4, runId: second, parentRunId: "root_test", type: "question", summary: "second ready", wake: true }));
  }, 80);

  const waited = await waitSubagents(store, { runIds: [first, second], mode: "all", until: "interesting", timeoutMs: 1000, pollIntervalMs: 20 });
  assert.equal(waited.state, "ready");
  assert.deepEqual(new Set(waited.readyRunIds), new Set([first, second]));
  assert.deepEqual(new Set(waited.events.map((event) => event.runId)), new Set([first, second]));
});

test("waitSubagents each mode returns the first ready run in v1", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const first = createStoredRun(store, w.root, "root_test");
  const second = createStoredRun(store, w.root, "root_test");
  store.appendEvent(first, createRunEvent({ sequence: 5, runId: first, parentRunId: "root_test", type: "question", summary: "first ready", wake: true }));

  const waited = await waitSubagents(store, { runIds: [first, second], mode: "each", until: "interesting", timeoutMs: 1000, pollIntervalMs: 20 });
  assert.equal(waited.state, "ready");
  assert.deepEqual(waited.readyRunIds, [first]);
  assert.deepEqual(waited.remainingRunIds, [second]);
});

test("sendSubagentMessage appends inbox messages and reports unsupported live delivery", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");

  const message = sendSubagentMessage(store, { runId, fromRunId: "root_test", body: "Please continue", type: "instruction" });
  assert.equal(message.appended, true);
  assert.equal(message.liveDelivered, false);
  assert.equal(message.unsupported?.code, "LIVE_MESSAGE_UNSUPPORTED");

  const cancel = sendSubagentMessage(store, { runId, fromRunId: "root_test", body: "Cancel", type: "cancel" });
  assert.equal(cancel.unsupported, undefined);
  assert.equal(store.readInbox(runId).records.length, 2);
});

test("status and result helpers read durable snapshots", () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");
  const running = readSubagentStatus(store, { runId });
  assert.equal(running.state, "running");

  store.writeResult(createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "completed", body: "Done" }));
  store.writeStatus(updateRunStatus(running, { state: "completed", resultReady: true }));
  assert.equal(readSubagentResult(store, { runId })?.body, "Done");
  assert.equal(JSON.parse(readFileSync(join(store.pathsFor({ runId }).resultPath), "utf8")).state, "completed");
});
