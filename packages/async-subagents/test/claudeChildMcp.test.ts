import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createClaudeChildMcpContext, handleClaudeChildMcpRequest } from "../src/claudeChildMcp.js";
import { finalizeTerminalRun } from "../src/lifecycle.js";
import { withRunMutationLock } from "../src/runLock.js";
import { EVENT_TYPES } from "../src/schemas.js";
import { createInboxMessage, findMessageAck } from "../src/message.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-mcp-"));
  return { root, runRoot: join(root, ".subagents", "runs") };
}

function addRun() {
  const w = workspace();
  const store = new RunStore({ cwd: w.root, runRoot: w.runRoot });
  const { runId, paths } = store.createRunDirectory({ cwd: w.root, parentRunId: "root_parent", rootRunId: "root_parent", rootSessionId: "root_parent" });
  store.writeStatus(createInitialStatus({
    runId,
    parentRunId: "root_parent",
    rootRunId: "root_parent",
    rootSessionId: "root_parent",
    runRoot: w.runRoot,
    agentName: "claude-worker",
    agentSource: "builtin",
    definitionPath: "/builtin/claude-worker.md",
    mode: "interactive",
    harness: "claude",
    launchHarness: "claude",
    cwd: w.root,
    state: "running",
  }));
  store.writeStatus({ ...store.readStatus(runId), claudeTransport: "mcp" });
  return { ...w, store, runId, runDir: paths.runDir };
}

async function call(ctx: ReturnType<typeof createClaudeChildMcpContext>, name: string, args: Record<string, unknown> = {}) {
  return handleClaudeChildMcpRequest(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

test("Claude child MCP handles initialize, tools/list, event, inbox ack, complete, and idempotent duplicate complete", async () => {
  const run = addRun();
  const ctx = createClaudeChildMcpContext(run.runDir);

  const initialized = await handleClaudeChildMcpRequest(ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) as { capabilities: unknown };
  assert.ok(initialized.capabilities);
  await handleClaudeChildMcpRequest(ctx, { jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await handleClaudeChildMcpRequest(ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" }) as { tools: { name: string }[] };
  assert.deepEqual(list.tools.map((tool) => tool.name).sort(), ["subagent_ack_inbox", "subagent_block", "subagent_complete", "subagent_event", "subagent_liveness", "subagent_read_inbox"].sort());

  await call(ctx, "subagent_event", { type: "progress", summary: "working" });
  assert.equal(run.store.readEvents(run.runId).records.at(-1)?.type, "progress");
  assert.equal(run.store.readStatus(run.runId).summary, "working");

  const message = createInboxMessage({ toRunId: run.runId, fromRunId: "root_parent", body: "please report" });
  run.store.appendInboxMessage(run.runId, message);
  const read = await call(ctx, "subagent_read_inbox") as { content: { text: string }[] };
  const readPayload = JSON.parse(read.content[0].text) as { messages: { messageId: string }[]; cursor: number };
  assert.deepEqual(readPayload.messages.map((item) => item.messageId), [message.messageId]);
  assert.ok(run.store.readEvents(run.runId).records.some((event) => event.type === "message.received" && event.data?.messageId === message.messageId));
  assert.equal(findMessageAck(run.store, { runId: run.runId, messageId: message.messageId }), undefined);
  const secondRead = JSON.parse(((await call(ctx, "subagent_read_inbox")) as { content: { text: string }[] }).content[0].text) as { messages: unknown[] };
  assert.equal(secondRead.messages.length, 0);

  await call(ctx, "subagent_ack_inbox", { messageId: message.messageId, disposition: "handled" });
  assert.ok(run.store.readEvents(run.runId).records.some((event) => event.type === "message.handled" && event.data?.messageId === message.messageId));
  assert.ok(findMessageAck(run.store, { runId: run.runId, messageId: message.messageId }));
  await assert.rejects(() => call(ctx, "subagent_ack_inbox", { messageId: "missing", disposition: "handled" }), /unknown message id/);

  await call(ctx, "subagent_complete", { summary: "done" });
  await call(ctx, "subagent_complete", { summary: "done again" });
  assert.equal(run.store.readResult(run.runId)?.summary, "done");
  const terminalEvents = run.store.readEvents(run.runId).records.filter((event) => event.type === "result" || event.type === "completed");
  assert.equal(terminalEvents.length, 2);
});

test("Claude child MCP ack synthesizes a received event when the child handles a known unread message directly", async () => {
  const run = addRun();
  const ctx = createClaudeChildMcpContext(run.runDir);
  const message = createInboxMessage({ toRunId: run.runId, fromRunId: "root_parent", body: "direct ack" });
  run.store.appendInboxMessage(run.runId, message);

  await call(ctx, "subagent_ack_inbox", { messageId: message.messageId, disposition: "handled", summary: "handled directly" });

  const events = run.store.readEvents(run.runId).records.filter((event) => event.data?.messageId === message.messageId);
  assert.deepEqual(events.map((event) => event.type), ["message.received", "message.handled"]);
});

test("Claude child MCP inbox receipts resume only blocked/waiting answer or instruction runs and keep status aligned", async () => {
  const cases = [
    { type: "answer", initialState: "blocked", expectedState: "running", expectedNeeds: null },
    { type: "instruction", initialState: "waiting_for_input", expectedState: "running", expectedNeeds: null },
    { type: "context", initialState: "blocked", expectedState: "blocked", expectedNeeds: "parent input" },
    { type: "answer", initialState: "running", expectedState: "running", expectedNeeds: "parent input" },
  ] as const;
  for (const item of cases) {
    const run = addRun();
    run.store.writeStatus({ ...run.store.readStatus(run.runId), state: item.initialState, needs: "parent input" });
    const ctx = createClaudeChildMcpContext(run.runDir);
    const message = createInboxMessage({ toRunId: run.runId, fromRunId: "root_parent", type: item.type, body: `${item.type} body` });
    run.store.appendInboxMessage(run.runId, message);

    await call(ctx, "subagent_read_inbox");

    const status = run.store.readStatus(run.runId);
    const received = run.store.readEvents(run.runId).records.at(-1);
    assert.equal(status.state, item.expectedState);
    assert.equal(status.needs, item.expectedNeeds);
    assert.equal(status.lastEventId, received?.eventId);
    assert.equal(status.summary, received?.summary);
  }
});

test("Claude child MCP event racing terminal finalization cannot resurrect the run", async () => {
  const run = addRun();
  const ctx = createClaudeChildMcpContext(run.runDir);
  let release!: () => void;
  let locked!: () => void;
  const entered = new Promise<void>((resolve) => { locked = resolve; });
  const holder = withRunMutationLock(run.runDir, async () => {
    finalizeTerminalRun(run.store, { runId: run.runId, parentRunId: "root_parent", agentName: "claude-worker", state: "completed", writerRole: "child-runtime", summary: "Finished" });
    locked();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await entered;

  const late = call(ctx, "subagent_event", { type: "progress", summary: "late progress" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await holder;
  await assert.rejects(late, /run is terminal/);
  assert.equal(run.store.readStatus(run.runId).state, "completed");
  assert.equal(run.store.readStatus(run.runId).summary, "Finished");
  assert.equal(run.store.readEvents(run.runId).records.some((event) => event.summary === "late progress"), false);
});

test("Claude child MCP validates bad tool requests and runDir containment", async () => {
  const run = addRun();
  const ctx = createClaudeChildMcpContext(run.runDir);
  await assert.rejects(() => handleClaudeChildMcpRequest(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "missing", arguments: {} } }), /unknown tool/);
  await assert.rejects(() => handleClaudeChildMcpRequest(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "subagent_event", arguments: { type: "progress" } } }), /invalid summary/);
  const link = join(run.root, "run-link");
  symlinkSync(run.runDir, link);
  assert.throws(() => createClaudeChildMcpContext(link), /symlink|canonical/);

  const rogue = addRun();
  rogue.store.writeStatus({ ...rogue.store.readStatus(rogue.runId), runRoot: run.runRoot });
  assert.throws(() => createClaudeChildMcpContext(rogue.runDir), /configured run root|RunStore path/);

  const piRun = addRun();
  piRun.store.writeStatus({ ...piRun.store.readStatus(piRun.runId), harness: "pi", claudeTransport: "mcp" });
  assert.throws(() => createClaudeChildMcpContext(piRun.runDir), /Claude harness/);
});


test("Claude child MCP respects terminal status and rejects terminal liveness", async () => {
  const run = addRun();
  const ctx = createClaudeChildMcpContext(run.runDir);
  run.store.writeStatus({ ...run.store.readStatus(run.runId), state: "cancelled", summary: "cancelled by supervisor" });
  await call(ctx, "subagent_complete", { summary: "late child done" });
  assert.equal(run.store.readResult(run.runId)?.state, "cancelled");
  assert.equal(run.store.readStatus(run.runId).state, "cancelled");
  await assert.rejects(() => call(ctx, "subagent_liveness", { state: "running" }), /run is terminal/);
});


test("Claude MCP emitted event types are present in schema constants", () => {
  for (const type of ["message.handled", "message.rejected", "liveness"] as const) {
    assert.ok(EVENT_TYPES.includes(type), `${type} missing from EVENT_TYPES`);
  }
});

test("Claude child MCP concurrent events receive unique monotonic sequence numbers", async () => {
  const run = addRun();
  const ctx = createClaudeChildMcpContext(run.runDir);
  await Promise.all(Array.from({ length: 20 }, (_, index) => call(ctx, "subagent_event", { type: "progress", summary: `event ${index}` })));
  const eventIds = run.store.readEvents(run.runId).records.map((event) => event.eventId);
  assert.equal(new Set(eventIds).size, 20);
  assert.deepEqual(eventIds, Array.from({ length: 20 }, (_, index) => `evt_${String(index + 1).padStart(6, "0")}`));
});

test("Claude child MCP CLI speaks newline-delimited JSON-RPC and reports malformed JSON", async () => {
  const run = addRun();
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = join(here, "..", "src", "cli.js");
  const child = spawn(process.execPath, [cli, "claude-child-mcp", "--run-dir", run.runDir], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
  child.stdin.write("not-json\n");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  assert.ok(lines.some((line) => JSON.parse(line).error?.code === -32700));
  assert.ok(lines.some((line) => JSON.parse(line).id === 7 && JSON.parse(line).result?.serverInfo?.name === "async-subagents"));
});
