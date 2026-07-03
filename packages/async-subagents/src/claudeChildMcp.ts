import { createInterface } from "node:readline";
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { defaultRunRoot } from "./config.js";
import { createRunEvent } from "./events.js";
import { finalizeTerminalRun } from "./lifecycle.js";
import { withRunMutationLock } from "./runLock.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import { updateRunStatus } from "./status.js";
import type { ClaudeLivenessState, EventType, InboxMessage, RunEvent, RunStatus, TerminalRunState } from "./types.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ClaudeChildMcpContext {
  runDir: string;
  runId: string;
  store: RunStore;
}

const TOOL_NAMES = [
  "subagent_event",
  "subagent_read_inbox",
  "subagent_ack_inbox",
  "subagent_complete",
  "subagent_block",
  "subagent_liveness",
] as const;

type ToolName = typeof TOOL_NAMES[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${name}`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, name);
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error(`invalid ${name}`);
  return value;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createClaudeChildMcpContext(runDirInput: string, options: { env?: NodeJS.ProcessEnv } = {}): ClaudeChildMcpContext {
  const requested = resolve(runDirInput);
  if (!existsSync(requested)) throw new Error(`runDir does not exist: ${runDirInput}`);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink()) throw new Error(`runDir must not be a symlink: ${runDirInput}`);
  if (!stat.isDirectory()) throw new Error(`runDir must be a directory: ${runDirInput}`);
  const realRunDir = realpathSync.native(requested);
  if (realRunDir !== requested) throw new Error(`runDir must be canonical: ${runDirInput}`);

  const statusPath = resolve(realRunDir, "status.json");
  if (!existsSync(statusPath)) throw new Error(`status.json not found in runDir: ${runDirInput}`);
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as RunStatus;
  if (!status.runId || basename(realRunDir) !== status.runId) throw new Error("runDir basename does not match status.runId");
  if (status.agent?.mode !== "interactive") throw new Error("Claude MCP requires an interactive run");
  if (status.harness !== "claude") throw new Error("Claude MCP requires a Claude harness run");
  if (status.launchHarness && !["claude", "claude-tmux-interactive"].includes(status.launchHarness)) throw new Error("Claude MCP launch harness mismatch");
  if (status.claudeTransport !== "mcp") throw new Error("Claude MCP transport mismatch");

  const cwd = status.cwd || process.cwd();
  const configuredRunRoot = status.runRoot ?? defaultRunRoot(cwd, undefined, options.env ?? process.env);
  if (!existsSync(configuredRunRoot)) throw new Error(`configured run root does not exist: ${configuredRunRoot}`);
  const realRunRoot = realpathSync.native(resolve(configuredRunRoot));
  if (!isInside(realRunDir, realRunRoot)) throw new Error("runDir is outside configured run root");
  const store = new RunStore({ cwd, runRoot: realRunRoot, env: options.env ?? process.env });
  const expected = realpathSync.native(store.pathsFor({ runId: status.runId }).runDir);
  if (expected !== realRunDir) throw new Error("RunStore path does not match runDir/status.runId");
  const storeStatus = store.readStatus(status.runId);
  if (
    storeStatus.runId !== status.runId ||
    storeStatus.parentRunId !== status.parentRunId ||
    storeStatus.rootRunId !== status.rootRunId ||
    storeStatus.rootSessionId !== status.rootSessionId
  ) throw new Error("status identity mismatch");

  return { runDir: realRunDir, runId: status.runId, store };
}

function nextSequence(store: RunStore, runId: string): number {
  return store.readEvents(runId).records.length + 1;
}

function appendStatusEvent(ctx: ClaudeChildMcpContext, input: { type: EventType; summary: string; body?: string; wake?: boolean; data?: Record<string, unknown>; patch?: Partial<RunStatus> }): RunEvent {
  const status = ctx.store.readStatus(ctx.runId);
  if (isTerminalRunState(status.state)) throw new Error("run is terminal");
  const event = createRunEvent({
    sequence: nextSequence(ctx.store, ctx.runId),
    runId: ctx.runId,
    parentRunId: status.parentRunId,
    type: input.type,
    summary: input.summary,
    body: input.body,
    wake: input.wake,
    data: input.data,
  });
  ctx.store.appendEvent(ctx.runId, event);

  const patch: Partial<RunStatus> = { writerRole: "child-runtime", lastActivityAt: event.createdAt, lastMcpCallAt: event.createdAt, lastEventId: event.eventId, summary: input.summary, ...input.patch };
  if (input.type === "question") Object.assign(patch, { state: "waiting_for_input", needs: input.summary });
  if (input.type === "blocked") Object.assign(patch, { state: "blocked", needs: input.summary });
  if (input.type === "progress" || input.type === "status" || input.type === "artifact" || input.type === "liveness") Object.assign(patch, { state: status.state === "created" || status.state === "queued" ? "running" : status.state });
  ctx.store.writeStatus(updateRunStatus(status, patch));
  return event;
}

const LIVENESS_STATES: readonly ClaudeLivenessState[] = ["starting", "running", "idle", "waiting_for_input", "ack_pending", "rate_limited", "comatose", "stale_transport", "orphaned_process", "paused", "completed", "failed", "cancelled", "expired"];

function toolDefinitions(): ToolDefinition[] {
  return [
    { name: "subagent_event", description: "Append a child event. Types: progress, status, question, blocked, artifact.", inputSchema: { type: "object", properties: { type: { type: "string" }, summary: { type: "string" }, body: { type: "string" }, wake: { type: "boolean" }, data: { type: "object" } }, required: ["type", "summary"] } },
    { name: "subagent_read_inbox", description: "Return unread messages. Without cursor, messages already recorded as message.received are omitted; with cursor, messages at/after the byte offset are returned.", inputSchema: { type: "object", properties: { cursor: { type: "number" } } } },
    { name: "subagent_ack_inbox", description: "Acknowledge an inbox message as handled or rejected.", inputSchema: { type: "object", properties: { messageId: { type: "string" }, disposition: { type: "string", enum: ["handled", "rejected"] }, summary: { type: "string" } }, required: ["messageId", "disposition"] } },
    { name: "subagent_complete", description: "Complete the run idempotently.", inputSchema: { type: "object", properties: { summary: { type: "string" }, body: { type: "string" }, outcome: { type: "string" } } } },
    { name: "subagent_block", description: "Record a blocked event/status.", inputSchema: { type: "object", properties: { reason: { type: "string" }, checkpoint: { type: "string" } }, required: ["reason"] } },
    { name: "subagent_liveness", description: "Record an explicit liveness signal. Use state=running plus details.reason for custom readiness markers.", inputSchema: { type: "object", properties: { state: { type: "string", enum: LIVENESS_STATES }, details: { type: "object" } } } },
  ];
}

function mcpToolResult(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function asLivenessState(value: unknown): ClaudeLivenessState | undefined {
  if (value === undefined || value === null) return undefined;
  const state = asString(value, "state");
  if (!LIVENESS_STATES.includes(state as ClaudeLivenessState)) throw new Error("invalid liveness state");
  return state as ClaudeLivenessState;
}

function livenessShouldWake(state: ClaudeLivenessState | undefined): boolean {
  return Boolean(state && ["waiting_for_input", "ack_pending", "rate_limited", "comatose", "stale_transport", "orphaned_process", "paused"].includes(state));
}

async function callTool(ctx: ClaudeChildMcpContext, name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const { value } = await withRunMutationLock(ctx.runDir, () => {
    switch (name) {
      case "subagent_event": {
        const type = asString(args.type, "type") as EventType;
        if (!["progress", "status", "question", "blocked", "artifact"].includes(type)) throw new Error("invalid event type");
        const event = appendStatusEvent(ctx, { type, summary: asString(args.summary, "summary"), body: optionalString(args.body, "body"), wake: args.wake === true, data: optionalRecord(args.data, "data") });
        return { eventId: event.eventId };
      }
      case "subagent_read_inbox": {
        const cursor = typeof args.cursor === "number" ? { eventOffset: args.cursor } : undefined;
        const receivedIds = new Set(ctx.store.readEvents(ctx.runId).records.filter((event) => event.type === "message.received").map((event) => String(event.data?.messageId ?? "")));
        const read = ctx.store.readInbox(ctx.runId, cursor);
        const messages = cursor ? read.records : read.records.filter((message) => !receivedIds.has(message.messageId));
        const status = ctx.store.readStatus(ctx.runId);
        if (isTerminalRunState(status.state)) throw new Error("run is terminal");
        const events: string[] = [];
        let sequence = nextSequence(ctx.store, ctx.runId);
        let lastEvent: RunEvent | undefined;
        for (const message of messages) {
          const event = createRunEvent({ sequence: sequence++, runId: ctx.runId, parentRunId: status.parentRunId, type: "message.received", summary: `Received parent message ${message.messageId}`, data: { messageId: message.messageId, fromRunId: message.fromRunId, messageType: message.type } });
          ctx.store.appendEvent(ctx.runId, event);
          lastEvent = event;
          events.push(event.eventId);
        }
        const activityAt = lastEvent?.createdAt ?? new Date().toISOString();
        ctx.store.writeStatus(updateRunStatus(status, { writerRole: "child-runtime", lastActivityAt: activityAt, lastMcpCallAt: activityAt, lastEventId: lastEvent?.eventId ?? status.lastEventId }));
        return { messages, cursor: read.cursor.eventOffset, receivedEventIds: events };
      }
      case "subagent_ack_inbox": {
        const messageId = asString(args.messageId, "messageId");
        const disposition = asString(args.disposition, "disposition");
        if (disposition !== "handled" && disposition !== "rejected") throw new Error("invalid disposition");
        const known = ctx.store.readInbox(ctx.runId).records.find((message: InboxMessage) => message.messageId === messageId);
        if (!known) throw new Error(`unknown message id: ${messageId}`);
        const hasReceived = ctx.store.readEvents(ctx.runId).records.some((event) => event.type === "message.received" && event.data?.messageId === messageId);
        if (!hasReceived) {
          const status = ctx.store.readStatus(ctx.runId);
          if (isTerminalRunState(status.state)) throw new Error("run is terminal");
          const received = createRunEvent({ sequence: nextSequence(ctx.store, ctx.runId), runId: ctx.runId, parentRunId: status.parentRunId, type: "message.received", summary: `Received parent message ${messageId}`, data: { messageId, fromRunId: known.fromRunId, messageType: known.type } });
          ctx.store.appendEvent(ctx.runId, received);
          ctx.store.writeStatus(updateRunStatus(status, { writerRole: "child-runtime", lastActivityAt: received.createdAt, lastMcpCallAt: received.createdAt, lastEventId: received.eventId }));
        }
        const event = appendStatusEvent(ctx, { type: disposition === "handled" ? "message.handled" : "message.rejected", summary: optionalString(args.summary, "summary") ?? `${disposition} parent message ${messageId}`, data: { messageId, disposition } });
        return { eventId: event.eventId };
      }
      case "subagent_complete": {
        const status = ctx.store.readStatus(ctx.runId);
        const alreadyCompleted = Boolean(ctx.store.readResult(ctx.runId));
        const outcome = optionalString(args.outcome, "outcome");
        const requestedState: TerminalRunState = outcome === "failed" || outcome === "cancelled" || outcome === "expired" ? outcome : "completed";
        const state: TerminalRunState = isTerminalRunState(status.state) ? status.state : requestedState;
        const result = finalizeTerminalRun(ctx.store, { runId: ctx.runId, parentRunId: status.parentRunId, agentName: status.agent.name, state, writerRole: "child-runtime", summary: optionalString(args.summary, "summary") ?? status.summary ?? `Run ${state}`, body: optionalString(args.body, "body") });
        return { result, idempotent: alreadyCompleted || isTerminalRunState(status.state) };
      }
      case "subagent_block": {
        const event = appendStatusEvent(ctx, { type: "blocked", summary: asString(args.reason, "reason"), data: { checkpoint: optionalString(args.checkpoint, "checkpoint") } });
        return { eventId: event.eventId };
      }
      case "subagent_liveness": {
        const state = asLivenessState(args.state);
        const details = optionalRecord(args.details, "details");
        const event = appendStatusEvent(ctx, { type: "liveness", summary: state ?? "liveness", wake: livenessShouldWake(state), data: { state, details }, patch: { livenessState: state, livenessReason: typeof details?.reason === "string" ? details.reason : null } });
        return { eventId: event.eventId };
      }
    }
  });
  return mcpToolResult(value);
}

export async function handleClaudeChildMcpRequest(ctx: ClaudeChildMcpContext, request: JsonRpcRequest): Promise<unknown | undefined> {
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") throw Object.assign(new Error("invalid JSON-RPC request"), { code: -32600 });
  if (request.method.startsWith("notifications/")) return undefined;
  if (request.method === "initialize") return { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "async-subagents", version: "0.1.0" } };
  if (request.method === "tools/list") return { tools: toolDefinitions() };
  if (request.method === "tools/call") {
    if (!isObject(request.params)) throw Object.assign(new Error("invalid params"), { code: -32602 });
    const name = asString(request.params.name, "name") as ToolName;
    if (!(TOOL_NAMES as readonly string[]).includes(name)) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
    const args = request.params.arguments === undefined ? {} : request.params.arguments;
    if (!isObject(args)) throw Object.assign(new Error("invalid tool arguments"), { code: -32602 });
    return callTool(ctx, name, args);
  }
  throw Object.assign(new Error(`method not found: ${request.method}`), { code: -32601 });
}

function response(id: JsonRpcRequest["id"], result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function errorResponse(id: JsonRpcRequest["id"] | null, error: unknown): string {
  const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32000;
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function claudeChildMcpMain(argv = process.argv.slice(2), io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = process): Promise<void> {
  const runDirFlag = argv.indexOf("--run-dir");
  if (runDirFlag === -1 || !argv[runDirFlag + 1]) throw new Error("usage: async-subagents claude-child-mcp --run-dir <runDir>");
  const ctx = createClaudeChildMcpContext(argv[runDirFlag + 1]);
  const logPath = resolve(ctx.runDir, "logs", "claude-mcp.jsonl");
  mkdirSync(resolve(ctx.runDir, "logs"), { recursive: true });
  const log = (event: string, data: Record<string, unknown> = {}): void => {
    appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), event, pid: process.pid, ...data })}\n`, "utf8");
  };
  log("started", { argv });
  const rl = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest;
      log("recv", { method: parsed.method, id: parsed.id });
    } catch (error) {
      const wire = errorResponse(null, Object.assign(new Error("parse error"), { code: -32700 }));
      log("parse_error");
      io.stdout.write(`${wire}\n`);
      continue;
    }
    try {
      const result = await handleClaudeChildMcpRequest(ctx, parsed);
      if (result !== undefined && parsed.id !== undefined) {
        const wire = response(parsed.id, result);
        log("send", { method: parsed.method, id: parsed.id });
        io.stdout.write(`${wire}\n`);
      } else {
        log("notify", { method: parsed.method });
      }
    } catch (error) {
      log("error", { method: parsed.method, id: parsed.id, message: error instanceof Error ? error.message : String(error) });
      if (parsed.id !== undefined) io.stdout.write(`${errorResponse(parsed.id, error)}\n`);
    }
  }
  log("ended");
}
