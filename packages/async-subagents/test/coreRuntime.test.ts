import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePiModelTable, preflightPiModelAvailability, startSubagent, windowsTaskkillArgs } from "../src/start.js";
import { sendSubagentMessage, waitForMessageAck } from "../src/message.js";
import { createRunResult, readSubagentResult } from "../src/result.js";
import { RunStore } from "../src/runStore.js";
import { createRunEvent } from "../src/events.js";
import { createInitialStatus, readSubagentStatus, updateRunStatus } from "../src/status.js";
import { waitOnce, waitSubagents } from "../src/wait.js";
import { finalizeTerminalRun } from "../src/lifecycle.js";
import { assignDisplayName } from "../src/namePacks.js";
import { awaitStableResult, hasTmux } from "../src/supervisor.js";
import { withRunMutationLock } from "../src/runLock.js";

function withEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

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

function writeFakeClaudeBin(root: string): string {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const claude = join(binDir, "claude");
  writeFileSync(claude, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const mcpConfigPath = process.argv[process.argv.indexOf('--mcp-config') + 1];
const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
const server = config.mcpServers.async_subagents;
const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  return new Promise((resolve) => pending.set(id, resolve));
}
(async () => {
  await request('initialize', {});
  const waitMs = Number(process.env.FAKE_CLAUDE_WAIT_MS || '0');
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const read = await request('tools/call', { name: 'subagent_read_inbox', arguments: {} });
  const parsed = JSON.parse(read.result.content[0].text);
  for (const message of parsed.messages || []) {
    await request('tools/call', { name: 'subagent_ack_inbox', arguments: { messageId: message.messageId, disposition: 'handled', summary: 'handled fake message' } });
  }
  const completeDelayMs = Number(process.env.FAKE_CLAUDE_COMPLETE_DELAY_MS || '0');
  if (completeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, completeDelayMs));
  await request('tools/call', { name: 'subagent_complete', arguments: { summary: 'MCP completed', body: 'completed via fake claude mcp' } });
  child.stdin.end();
  setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_EXIT_DELAY_MS || '50'));
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
`, "utf8");
  chmodSync(claude, 0o755);
  return binDir;
}

function writeFakeTmuxBin(root: string): string {
  const binDir = join(root, "fake-tmux");
  mkdirSync(binDir, { recursive: true });
  const tmux = join(binDir, "tmux");
  writeFileSync(tmux, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
function finish(code, text = '') { if (text) process.stdout.write(text); process.exit(code); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
(async () => {
  if (args[0] === '-V') return finish(0, 'tmux 3.4\\n');
  const socketIndex = args.indexOf('-S');
  const command = socketIndex >= 0 ? args[socketIndex + 2] : args[0];
  const rest = socketIndex >= 0 ? args.slice(socketIndex + 3) : args.slice(1);
  if (command === 'new-session') {
    const shellCommand = rest.at(-1);
    const child = spawn('bash', ['-lc', shellCommand], { detached: true, stdio: 'ignore' });
    child.unref();
    return finish(0);
  }
  if (command === 'display-message') {
    await delay(Number(process.env.FAKE_TMUX_DISPLAY_DELAY_MS || '0'));
    const template = rest.at(-1) || '';
    if (template.includes('pane_pid')) return finish(0, String(process.pid) + '\\n');
    return finish(0, '%1\\n');
  }
  if (command === 'capture-pane') return finish(0, '');
  if (command === 'has-session') return finish(1);
  if (command === 'kill-session') return finish(0);
  if (command === 'load-buffer' || command === 'paste-buffer' || command === 'send-keys' || command === 'delete-buffer') return finish(0);
  return finish(1, 'unsupported fake tmux command: ' + command + '\\n');
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
`, "utf8");
  chmodSync(tmux, 0o755);
  return tmux;
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

async function waitForClaudeTmuxTransport(store: RunStore, runId: string, timeoutMs = 5000): Promise<void> {
  const ready = () => {
    const status = store.readStatus(runId);
    return status.state === "running"
      && status.harness === "claude"
      && status.claudeTransport === "mcp"
      && Boolean(status.tmuxSocket && status.tmuxSession && status.tmuxPane && status.transcriptPath);
  };
  const startedAt = Date.now();
  while (!ready() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(ready(), true, `Claude tmux transport did not become ready: ${JSON.stringify(store.readStatus(runId))}`);
}

async function waitForPidExit(pid: number, timeoutMs = 1500): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
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
  const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 30_000, pollIntervalMs: 25 });
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

test("detached start reports handed-off queued run as started before delayed supervisor ownership", async () => {
  const w = workspace();
  const runId = "run_delayed_ownership";
  const runDir = join(w.runRoot, runId);
  mkdirSync(runDir, { recursive: true });

  let releaseLock!: () => void;
  let signalAcquired!: () => void;
  const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
  const lockAcquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
  const heldLock = withRunMutationLock(runDir, async () => {
    signalAcquired();
    await lockReleased;
  });
  await lockAcquired;

  try {
    const started = await startSubagent({
      runId,
      agent: "scout",
      task: "Complete after delayed supervisor ownership",
      cwd: w.root,
      runRoot: w.runRoot,
      parentRunId: "root_test",
      fake: { mode: "child", env: { ASYNC_SUBAGENTS_FAKE_DELAY_MS: "50" } },
    });

    assert.equal(started.state, "queued");
    assert.equal(started.started, true);
    const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
    assert.equal(store.readStatus(runId).state, "queued");

    releaseLock();
    await heldLock;
    const waited = await waitSubagents(store, { runIds: [runId], timeoutMs: 30_000, pollIntervalMs: 25 });
    assert.equal(waited.state, "ready");
    assert.equal(waited.results[0]?.state, "completed");
  } finally {
    releaseLock();
    await heldLock;
  }
});

test("Claude start resolves requested skill directories before preparing Claude home", async () => {
  const w = workspace();
  mkdirSync(join(w.root, ".agents", "skills", "probe"), { recursive: true });
  writeFileSync(join(w.root, ".agents", "skills", "probe", "SKILL.md"), "# Probe\n\nSkill sentinel.", "utf8");
  writeFileSync(join(w.root, ".agents", "claude-scout.md"), `---
description: Claude scout.
harness: claude
model: sonnet
mode: interactive
claude:
  authHome: operator-home
---
Claude scout body.
`, "utf8");

  await assert.rejects(
    () => startSubagent({ agent: "claude-scout", task: "Use skill", skills: ["probe"], cwd: w.root, runRoot: w.runRoot, parentRunId: "root_test" }),
    /operator-home auth cannot guarantee run-local Claude skill visibility/,
  );
});

test("Claude start fails closed when a requested skill has no installable directory", async () => {
  const w = workspace();
  writeFileSync(join(w.root, ".agents", "claude-scout.md"), `---
description: Claude scout.
harness: claude
model: sonnet
mode: interactive
---
Claude scout body.
`, "utf8");

  await assert.rejects(
    () => startSubagent({ agent: "claude-scout", task: "Use missing skill", skills: ["missing-skill"], cwd: w.root, runRoot: w.runRoot, parentRunId: "root_test" }),
    /Claude skill not found or missing SKILL.md: missing-skill/,
  );
});

// The tmux tests below budget 30s of wall clock, not because anything here should take 30s, but
// because they race real tmux session startup and a spawned fake Claude binary. At the previous 5s
// ceiling a loaded CI runner pushed the run past its own maxRunSeconds, so it finalized `expired`
// and the assertions failed on state rather than on the behaviour under test — observed as three
// tests passing and failing across two runs three minutes apart on identical trees.
//
// The delays these tests actually exercise (FAKE_CLAUDE_WAIT_MS, FAKE_TMUX_DISPLAY_DELAY_MS,
// FAKE_CLAUDE_COMPLETE_DELAY_MS) are unchanged. The budget is headroom, never the assertion: none
// of these tests should be made to pass by waiting longer for a wrong answer.
test("Claude interactive tmux lifecycle completes from MCP result", { skip: !(await hasTmux()) }, async () => {
  const w = workspace();
  const fakeBin = writeFakeClaudeBin(w.root);
  writeFileSync(join(w.root, ".agents", "claude-scout.md"), `---
description: Claude scout.
harness: claude
model: sonnet
mode: interactive
maxRunSeconds: 30
claude:
  authHome: operator-home
---
Claude scout body.
`, "utf8");

  const started = await startSubagent({
    agent: "claude-scout",
    task: "Complete through MCP",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, FAKE_CLAUDE_EXIT_DELAY_MS: "500" },
  });

  // Start returns as soon as the run is handed to the tmux adapter; pane claim may still be pending.
  assert.ok(["queued", "running"].includes(started.state), `unexpected start state: ${started.state}`);
  assert.equal(started.started, true);
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 30_000, pollIntervalMs: 50 });
  assert.equal(waited.state, "ready");
  assert.equal(waited.results[0]?.state, "completed");
  assert.equal(waited.results[0]?.summary, "MCP completed");
  assert.equal(store.readResult(started.runId)?.body, "completed via fake claude mcp");
  assert.equal(store.readStatus(started.runId).harness, "claude");
  assert.equal(store.readStatus(started.runId).launchHarness, "claude-tmux-interactive");
  assert.equal(store.readStatus(started.runId).resultParser, "mcp-terminal");
  assert.equal(store.readStatus(started.runId).claudeTransport, "mcp");
});

test("Claude tmux supervisor exit after MCP completion does not overwrite result", { skip: !(await hasTmux()) }, async () => {
  const w = workspace();
  const fakeBin = writeFakeClaudeBin(w.root);
  writeFileSync(join(w.root, ".agents", "claude-scout.md"), `---
description: Claude scout.
harness: claude
model: sonnet
mode: interactive
maxRunSeconds: 30
claude:
  authHome: operator-home
---
Claude scout body.
`, "utf8");
  const started = await startSubagent({ agent: "claude-scout", task: "Complete", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_test", env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, FAKE_CLAUDE_EXIT_DELAY_MS: "0" } });
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 30_000, pollIntervalMs: 50 });
  assert.equal(waited.results[0]?.state, "completed");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(store.readResult(started.runId)?.summary, "MCP completed");
  assert.equal(store.readStatus(started.runId).state, "completed");
});

test("Claude parent message tmux nudge waits for MCP handled acknowledgement", { skip: !(await hasTmux()) }, async () => {
  const w = workspace();
  const fakeBin = writeFakeClaudeBin(w.root);
  writeFileSync(join(w.root, ".agents", "claude-scout.md"), `---
description: Claude scout.
harness: claude
model: sonnet
mode: interactive
maxRunSeconds: 30
claude:
  authHome: operator-home
---
Claude scout body.
`, "utf8");
  const started = await startSubagent({ agent: "claude-scout", task: "Read message", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_test", env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, FAKE_CLAUDE_WAIT_MS: "500", FAKE_CLAUDE_EXIT_DELAY_MS: "100" } });
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  await waitForClaudeTmuxTransport(store, started.runId);
  const sent = sendSubagentMessage(store, { runId: started.runId, fromRunId: "root_test", body: "hello", requiresAck: true });
  assert.equal(sent.liveDelivered, true);
  const ack = await waitForMessageAck(store, { runId: started.runId, messageId: sent.messageId, timeoutMs: 30_000, pollIntervalMs: 50 });
  assert.ok(ack);
  const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 30_000, pollIntervalMs: 50 });
  assert.equal(waited.results[0]?.state, "completed");
});

test("Claude tmux supervisor does not rewrite terminal MCP status during slow startup metadata capture", async () => {
  const w = workspace();
  const fakeBin = writeFakeClaudeBin(w.root);
  const fakeTmux = writeFakeTmuxBin(w.root);
  const restoreTmux = withEnv("ASYNC_SUBAGENTS_TMUX_BIN", fakeTmux);
  try {
    writeFileSync(join(w.root, ".agents", "claude-scout.md"), `---
description: Claude scout.
harness: claude
model: sonnet
mode: interactive
maxRunSeconds: 30
claude:
  authHome: operator-home
---
Claude scout body.
`, "utf8");
    const started = await startSubagent({ agent: "claude-scout", task: "Complete before supervisor start write", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_test", env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, FAKE_TMUX_DISPLAY_DELAY_MS: "300", FAKE_CLAUDE_EXIT_DELAY_MS: "0" } });
    const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
    const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 30_000, pollIntervalMs: 50 });
    assert.equal(waited.results[0]?.state, "completed");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(store.readStatus(started.runId).state, "completed");
    assert.equal(store.readResult(started.runId)?.summary, "MCP completed");
  } finally {
    restoreTmux();
  }
});

test("Claude tmux result drain waits for the run mutation lock before treating result.json as stable", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_test", rootRunId: "root_test", rootSessionId: "root_test" });
  store.writeStatus(createInitialStatus({ runId, parentRunId: "root_test", agentName: "claude-scout", agentSource: "project", definitionPath: join(w.root, ".agents", "claude-scout.md"), mode: "interactive", harness: "claude", launchHarness: "claude", cwd: w.root, state: "running" }));
  const partial = createRunResult({ runId, parentRunId: "root_test", agentName: "claude-scout", state: "completed", summary: "partial result visible" });
  let release!: () => void;
  const holder = withRunMutationLock(paths.runDir, async () => {
    store.writeResult(partial);
    await new Promise<void>((resolve) => { release = resolve; });
  });
  while (!store.readResult(runId)) await new Promise((resolve) => setTimeout(resolve, 10));

  let resolved = false;
  const stable = awaitStableResult(store, paths.runDir, runId).then((result) => { resolved = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(resolved, false);
  release();
  await holder;
  assert.equal((await stable)?.summary, "partial result visible");
  assert.equal(store.readStatus(runId).state, "completed");
  assert.equal(store.readStatus(runId).resultReady, true);
});

test("waitSubagents does not return a result before its terminal status publication is stable", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");
  const paths = store.pathsFor({ runId });
  const partial = createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "completed", summary: "published result" });
  let release!: () => void;
  const holder = withRunMutationLock(paths.runDir, async () => {
    store.writeResult(partial);
    await new Promise<void>((resolve) => { release = resolve; });
    finalizeTerminalRun(store, { runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "published result" });
  });
  while (!store.readResult(runId)) await new Promise((resolve) => setTimeout(resolve, 10));

  let resolved = false;
  const waiting = waitSubagents(store, { runIds: [runId], timeoutMs: 1000, pollIntervalMs: 10 }).then((result) => { resolved = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(resolved, false);
  release();
  await holder;

  const waited = await waiting;
  assert.equal(waited.results[0]?.state, "completed");
  assert.equal(waited.statuses[0]?.state, "completed");
  assert.equal(store.readStatus(runId).state, "completed");
});

test("waitSubagents returns normal timeout without torn terminal claims when publication lock outlives deadline", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");
  const paths = store.pathsFor({ runId });
  const partial = createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "completed", summary: "not stable yet" });
  let release!: () => void;
  const holder = withRunMutationLock(paths.runDir, async () => {
    store.writeResult(partial);
    await new Promise<void>((resolve) => { release = resolve; });
  });
  while (!store.readResult(runId)) await new Promise((resolve) => setTimeout(resolve, 10));

  const startedAt = Date.now();
  const waited = await waitSubagents(store, { runIds: [runId], timeoutMs: 100, pollIntervalMs: 10 });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(waited.state, "timeout");
  assert.equal(waited.timedOut, true);
  assert.deepEqual(waited.readyRunIds, []);
  assert.deepEqual(waited.results, []);
  assert.deepEqual(waited.events, []);
  assert.deepEqual(waited.remainingRunIds, [runId]);
  assert.equal(waited.statuses[0]?.state, "running");
  assert.ok(elapsedMs >= 75, `deadline returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 500, `lock timeout escaped caller deadline: ${elapsedMs}ms`);

  release();
  await holder;
});

test("waitSubagents suppresses an unstable all-mode result while preserving other readiness, events, and cursors", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const first = createStoredRun(store, w.root, "root_test");
  const second = createStoredRun(store, w.root, "root_test");
  const question = createRunEvent({ sequence: 1, runId: first, parentRunId: "root_test", type: "question", summary: "still useful", wake: true });
  store.appendEvent(first, question);
  const paths = store.pathsFor({ runId: second });
  const partial = createRunResult({ runId: second, parentRunId: "root_test", agentName: "scout", state: "completed", summary: "not stable yet" });
  let release!: () => void;
  const holder = withRunMutationLock(paths.runDir, async () => {
    store.writeResult(partial);
    await new Promise<void>((resolve) => { release = resolve; });
  });
  while (!store.readResult(second)) await new Promise((resolve) => setTimeout(resolve, 10));

  const waited = await waitSubagents(store, { runIds: [first, second], mode: "all", timeoutMs: 80, pollIntervalMs: 10 });
  assert.equal(waited.state, "timeout");
  assert.deepEqual(waited.readyRunIds, [first]);
  assert.deepEqual(waited.results, []);
  assert.deepEqual(waited.events.map((event) => event.eventId), [question.eventId]);
  assert.ok(waited.cursors[first]!.eventOffset > 0);
  assert.equal(waited.cursors[second]!.eventOffset, 0);
  assert.deepEqual(waited.remainingRunIds, [second]);

  release();
  await holder;
});

test("waitSubagents suppresses a torn terminal event when includeResult is false and the lock outlives deadline", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");
  const paths = store.pathsFor({ runId });
  const partial = createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "completed", summary: "not stable yet" });
  const terminal = createRunEvent({ sequence: 1, runId, parentRunId: "root_test", type: "completed", summary: "not stable yet", wake: true });
  let release!: () => void;
  const holder = withRunMutationLock(paths.runDir, async () => {
    store.writeResult(partial);
    store.appendEvent(runId, terminal);
    await new Promise<void>((resolve) => { release = resolve; });
  });
  while (!store.readEvents(runId).records.length) await new Promise((resolve) => setTimeout(resolve, 10));

  const startedAt = Date.now();
  const waited = await waitSubagents(store, { runIds: [runId], until: "terminal", includeResult: false, timeoutMs: 100, pollIntervalMs: 10 });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(waited.state, "timeout");
  assert.equal(waited.timedOut, true);
  assert.deepEqual(waited.readyRunIds, []);
  assert.deepEqual(waited.results, []);
  assert.deepEqual(waited.events, []);
  assert.ok(waited.cursors[runId]!.eventOffset > 0);
  assert.deepEqual(waited.remainingRunIds, [runId]);
  assert.equal(waited.statuses[0]?.state, "running");
  assert.ok(elapsedMs >= 75, `deadline returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 500, `lock timeout escaped caller deadline: ${elapsedMs}ms`);

  release();
  await holder;
});

test("waitSubagents stabilizes an event-only terminal publication without adding statuses", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");
  const paths = store.pathsFor({ runId });
  const partial = createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "completed", summary: "published event" });
  const terminal = createRunEvent({ sequence: 1, runId, parentRunId: "root_test", type: "completed", summary: "published event", wake: true });
  let release!: () => void;
  const holder = withRunMutationLock(paths.runDir, async () => {
    store.writeResult(partial);
    store.appendEvent(runId, terminal);
    await new Promise<void>((resolve) => { release = resolve; });
    finalizeTerminalRun(store, { runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "published event" });
  });
  while (!store.readEvents(runId).records.length) await new Promise((resolve) => setTimeout(resolve, 10));

  let resolved = false;
  const waiting = waitSubagents(store, { runIds: [runId], until: "terminal", includeResult: false, includeStatus: false, timeoutMs: 1000, pollIntervalMs: 10 }).then((result) => { resolved = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, false);
  release();
  await holder;
  const waited = await waiting;
  assert.equal(waited.state, "ready");
  assert.deepEqual(waited.results, []);
  assert.deepEqual(waited.events.map((event) => event.eventId), [terminal.eventId]);
  assert.deepEqual(waited.statuses, []);
  assert.equal(store.readStatus(runId).state, "completed");
});

test("waitSubagents stabilizes result publication without adding statuses when includeStatus is false", async () => {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const runId = createStoredRun(store, w.root, "root_test");
  const paths = store.pathsFor({ runId });
  const partial = createRunResult({ runId, parentRunId: "root_test", agentName: "scout", state: "completed", summary: "published result" });
  let release!: () => void;
  const holder = withRunMutationLock(paths.runDir, async () => {
    store.writeResult(partial);
    await new Promise<void>((resolve) => { release = resolve; });
    finalizeTerminalRun(store, { runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "published result" });
  });
  while (!store.readResult(runId)) await new Promise((resolve) => setTimeout(resolve, 10));

  const waiting = waitSubagents(store, { runIds: [runId], includeStatus: false, timeoutMs: 1000, pollIntervalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await holder;
  const waited = await waiting;
  assert.equal(waited.state, "ready");
  assert.equal(waited.results[0]?.state, "completed");
  assert.deepEqual(waited.statuses, []);
  assert.equal(store.readStatus(runId).state, "completed");
});

test("Claude tmux supervisor defers dead-session failure long enough for in-flight MCP completion", async () => {
  const w = workspace();
  const fakeBin = writeFakeClaudeBin(w.root);
  const fakeTmux = writeFakeTmuxBin(w.root);
  const restoreTmux = withEnv("ASYNC_SUBAGENTS_TMUX_BIN", fakeTmux);
  try {
    writeFileSync(join(w.root, ".agents", "claude-scout.md"), `---
description: Claude scout.
harness: claude
model: sonnet
mode: interactive
maxRunSeconds: 30
claude:
  authHome: operator-home
---
Claude scout body.
`, "utf8");
    const started = await startSubagent({ agent: "claude-scout", task: "Complete during tmux death grace", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_test", env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, FAKE_CLAUDE_COMPLETE_DELAY_MS: "300", FAKE_CLAUDE_EXIT_DELAY_MS: "0" } });
    const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
    const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 30_000, pollIntervalMs: 50 });
    assert.equal(waited.results[0]?.state, "completed");
    assert.equal(store.readResult(started.runId)?.summary, "MCP completed");
    assert.equal(store.readStatus(started.runId).state, "completed");
  } finally {
    restoreTmux();
  }
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
  assert.equal(started.started, false);
  assert.equal(result?.error?.code, "MODEL_PREFLIGHT_FAILED");
  assert.match(result?.body ?? "", /provider extension/);
  assert.ok(existsSync(join(started.runDir, "logs", "model-preflight.json")));
});

test("parsePiModelTable strips ANSI and accepts only exact valid six-column tables", () => {
  const parsed = parsePiModelTable([
    "warning provider model context max-out thinking images",
    "\u001b[1mprovider model context max-out thinking images\u001b[0m",
    "openai-codex gpt-good 272K 128K yes no",
    "openai-codex malformed unknown 128K yes no",
    "openai-codex too-many 272K 128K yes no trailing",
  ].join("\n"));
  assert.deepEqual(parsed.map(row => [row.provider, row.model]), [["openai-codex", "gpt-good"]]);
});

test("Windows taskkill command contract is an injection-safe PID argument array (not process-tree proof)", () => {
  assert.deepEqual(windowsTaskkillArgs(1234), ["/PID", "1234", "/T", "/F"]);
});

test("model preflight rejects native Luna when the balanced provider row is absent", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-native-luna.js");
  writeFileSync(piBin, `#!/usr/bin/env node
if (!process.argv.includes("bravo-codex-balanced/gpt-5.6-luna")) process.exit(91);
console.log("provider               model           context  max-out  thinking  images");
console.log("openai-codex            gpt-5.6-luna    372K     128K     yes       yes");
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "bravo-codex-balanced/gpt-5.6-luna", 5000);
  assert.equal(result.ok, false);
  assert.match(result.stdout ?? "", /openai-codex/);
});

test("model preflight accepts an exact fully-qualified provider/model stdout row", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-balanced-luna.js");
  writeFileSync(piBin, `#!/usr/bin/env node
console.log("provider model context max-out thinking images");
console.log("bravo-codex-balanced bravo-codex-balanced/gpt-5.6-luna 372K 128K yes yes");
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "bravo-codex-balanced/gpt-5.6-luna", 5000);
  assert.equal(result.ok, true);
});

test("model preflight accepts an exact structured row from older Pi stderr output", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-balanced-stderr.js");
  writeFileSync(piBin, `#!/usr/bin/env node
console.error("provider model context max-out thinking images");
console.error("bravo-codex-balanced bravo-codex-balanced/gpt-5.6-luna 372K 128K yes yes");
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "bravo-codex-balanced/gpt-5.6-luna", 5000);
  assert.equal(result.ok, true);
});

test("model preflight accepts one exact unqualified model id", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-unqualified.js");
  writeFileSync(piBin, `#!/usr/bin/env node
console.log("provider model context max-out thinking images");
console.log("one gpt-exact 128K 32K yes no");
console.log("two gpt-exact-longer 128K 32K yes no");
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "gpt-exact", 5000);
  assert.equal(result.ok, true);
});

test("model preflight rejects an ambiguous unqualified exact model id", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-ambiguous.js");
  writeFileSync(piBin, `#!/usr/bin/env node
console.log("provider model context max-out thinking images");
console.log("one shared-model 128K 32K yes no");
console.log("two shared-model 128K 32K yes no");
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "shared-model", 5000);
  assert.equal(result.ok, false);
});

test("model preflight kills a SIGTERM-resistant parent and grandchild process group with inherited pipes", { skip: process.platform === "win32" }, async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-resistant.js");
  const ready = join(w.root, "grandchild-ready.json");
  writeFileSync(piBin, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const script = \`
  const { writeFileSync } = require("node:fs");
  process.on("SIGTERM", () => {});
  writeFileSync(process.env.READY, JSON.stringify({ pid: process.pid }));
  if (process.send) process.send("ready");
  setInterval(() => {}, 1000);
\`;
const grandchild = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: process.env });
grandchild.once("message", () => {
  console.log("provider model context max-out thinking images");
  console.log("one never 128K 32K yes no");
});
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(piBin, 0o755);

  const startedAt = Date.now();
  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: { READY: ready } }, "never", 1000);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.signal, "SIGKILL");
  assert.match(result.message ?? "", /timed out after 1000ms/);
  assert.equal(result.termination?.strategy, "posix-process-group");
  assert.equal(result.termination?.termSent, true);
  assert.equal(result.termination?.killSent, true);
  assert.ok(elapsed >= 1250 && elapsed < 2500, `expected bounded escalation, got ${elapsed}ms`);
  const grandchildPid = JSON.parse(readFileSync(ready, "utf8")).pid as number;
  assert.equal(await waitForPidExit(grandchildPid), true, "grandchild must be reaped after process-group termination");
});

test("model preflight still escalates the owned group after the direct child closes on SIGTERM", { skip: process.platform === "win32" }, async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-parent-exits.js");
  const ready = join(w.root, "ignored-stdio-grandchild.json");
  writeFileSync(piBin, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const script = \
  'const {writeFileSync}=require("node:fs");' +
  'process.on("SIGTERM",()=>{});' +
  'writeFileSync(process.env.READY,JSON.stringify({pid:process.pid}));' +
  'setInterval(()=>{},1000);';
spawn(process.execPath, ["-e", script], { stdio: "ignore", env: process.env });
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: { READY: ready } }, "never", 750);
  assert.equal(result.ok, false);
  assert.equal(result.signal, "SIGTERM", "direct child may exit on TERM while the group still requires KILL");
  assert.equal(result.termination?.termSent, true);
  assert.equal(result.termination?.killSent, true);
  const grandchildPid = JSON.parse(readFileSync(ready, "utf8")).pid as number;
  assert.equal(await waitForPidExit(grandchildPid), true, "SIGTERM-resistant non-pipe descendant must be reaped before return");
});

test("model preflight has an absolute settlement deadline when an escaped descendant retains stdout", { skip: process.platform === "win32" }, async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-escaped-pipe.js");
  const pidFile = join(w.root, "escaped-pid");
  writeFileSync(piBin, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  detached: true, stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(process.env.PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(piBin, 0o755);

  let escapedPid: number | undefined;
  try {
    const startedAt = Date.now();
    const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: { PID_FILE: pidFile } }, "never", 300);
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, false);
    assert.equal(result.termination?.hardDeadlineReached, true);
    assert.ok(elapsed >= 1250 && elapsed < 2200, `hard deadline must settle despite inherited pipe, got ${elapsed}ms`);
    escapedPid = Number(readFileSync(pidFile, "utf8"));
    assert.doesNotThrow(() => process.kill(escapedPid!, 0), "fixture proves the descendant escaped the preflight process group");
  } finally {
    if (escapedPid) {
      try { process.kill(-escapedPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("model preflight bounds captured output", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-noisy.js");
  writeFileSync(piBin, `#!/usr/bin/env node
process.stdout.write("x".repeat(2 * 1024 * 1024));
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "never", 5000);
  assert.equal(result.ok, false);
  assert.equal(Buffer.byteLength(result.stdout ?? ""), 1024 * 1024);
  assert.equal(result.termination?.outputTruncated, true);
});

test("model preflight does not authorize a stderr row with a stdout header", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-split-stream.js");
  writeFileSync(piBin, `#!/usr/bin/env node
console.log("provider model context max-out thinking images");
console.error("bravo-codex-balanced bravo-codex-balanced/gpt-5.6-luna 372K 128K yes yes");
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "bravo-codex-balanced/gpt-5.6-luna", 5000);
  assert.equal(result.ok, false);
});

test("model preflight ignores stderr warnings mentioning the requested model", async () => {
  const w = workspace();
  const piBin = join(w.root, "fake-pi-warning.js");
  writeFileSync(piBin, `#!/usr/bin/env node
console.error('Warning: No models match pattern "bravo-codex-balanced/gpt-5.6-luna"');
console.log('No models matching "bravo-codex-balanced/gpt-5.6-luna"');
`, "utf8");
  chmodSync(piBin, 0o755);

  const result = await preflightPiModelAvailability({ command: piBin, args: [], cwd: w.root, env: {} }, "bravo-codex-balanced/gpt-5.6-luna", 5000);
  assert.equal(result.ok, false);
  assert.match(result.stderr ?? "", /bravo-codex-balanced\/gpt-5\.6-luna/);
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
  console.log("provider model context max-out thinking images");
  console.log("antigravity-code-assist gemini-3.5-flash 128K 32K yes yes");
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

test("automatic archival skips custom storage domains and honors the disable gate", async () => {
  const w = workspace();
  const home = join(w.root, "archive-home");
  const env = { ASYNC_SUBAGENTS_HOME: home };
  const store = new RunStore({ cwd: w.root, env: { ...process.env, ...env } });
  const old = store.createRunDirectory({ cwd: w.root, parentRunId: "root_old" });
  store.writeStatus({
    ...createInitialStatus({ runId: old.runId, parentRunId: "root_old", agentName: "scout", agentSource: "builtin", definitionPath: "/scout.md", mode: "oneshot", cwd: w.root, state: "completed" }),
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  writeFileSync(old.paths.piSessionPath, "old session\n");

  const started = await startSubagent({ agent: "scout", task: "Trigger sweep", cwd: w.root, parentRunId: "root_new", env, fake: { mode: "immediate" } });
  assert.ok(existsSync(started.runDir));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(existsSync(old.paths.runDir), true);

  const disabledOld = store.createRunDirectory({ cwd: w.root, parentRunId: "root_disabled" });
  store.writeStatus({
    ...createInitialStatus({ runId: disabledOld.runId, parentRunId: "root_disabled", agentName: "scout", agentSource: "builtin", definitionPath: "/scout.md", mode: "oneshot", cwd: w.root, state: "completed" }),
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  await startSubagent({ agent: "scout", task: "No sweep", cwd: w.root, parentRunId: "root_new", env: { ...env, ASYNC_SUBAGENTS_NO_AUTO_ARCHIVE: "1" }, fake: { mode: "immediate" } });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(existsSync(disabledOld.paths.runDir), true);
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

test("startSubagent returns no polling follow-up even when an async response is already terminal", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Start async fake result",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "immediate", body: "Immediate child completed" },
  });

  assert.equal(started.waited, false);
  assert.deepEqual(started.next, []);
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
  const waited = await waitSubagents(store, { runIds: [started.runId], timeoutMs: 30_000, pollIntervalMs: 25 });
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

test("a recorded-session launch carries a relaunch command that resumes the same session", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Return a fake result",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    fake: { mode: "child" },
  });

  const resumePath = join(started.runDir, "artifacts", "resume.md");
  const resume = readFileSync(resumePath, "utf8");
  // The relaunch must tell the child to reconcile a half-applied edit: the turn
  // died mid-reply, so the working tree can be inconsistent in a way the child
  // cannot see from its own transcript.
  assert.match(resume, /partial or inconsistent edits/);
  assert.match(resume, /Do not restart work you have already completed/);

  const supervisorInput = JSON.parse(readFileSync(join(started.runDir, "logs", "supervisor-input.json"), "utf8"));
  assert.equal(supervisorInput.transientRetry.maxAttempts, 2);
});

test("the relaunch command carries the resume prompt against the run's own session", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Return a fake result",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    piBin: "/bin/true",
  });

  const supervisorInput = JSON.parse(readFileSync(join(started.runDir, "logs", "supervisor-input.json"), "utf8"));
  const retryArgs: string[] = supervisorInput.transientRetry.command.args;
  assert.ok(retryArgs.includes(`@${join(started.runDir, "artifacts", "resume.md")}`), "relaunch prompt should be the resume artifact");
  // Same recorded session as the first attempt, so the child resumes its own history.
  const sessionPath = join(started.runDir, "pi-session", "session.jsonl");
  assert.equal(retryArgs[retryArgs.indexOf("--session") + 1], sessionPath);
  assert.equal(supervisorInput.command.args[supervisorInput.command.args.indexOf("--session") + 1], sessionPath);
});

test("a session-less launch carries no relaunch command", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Return a fake result",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    session: "none",
    fake: { mode: "child" },
  });

  const supervisorInput = JSON.parse(readFileSync(join(started.runDir, "logs", "supervisor-input.json"), "utf8"));
  assert.equal(supervisorInput.transientRetry, undefined);
});
