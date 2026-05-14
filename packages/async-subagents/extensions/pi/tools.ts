import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendJsonl, readJsonl } from "../../src/jsonl.js";
import { createInboxMessage, sendSubagentMessage, waitForMessageAck } from "../../src/message.js";
import { readSubagentResult } from "../../src/result.js";
import { createRootSession } from "../../src/rootSession.js";
import { RunStore } from "../../src/runStore.js";
import { isTerminalRunState } from "../../src/schemas.js";
import { startSubagent } from "../../src/start.js";
import { readSubagentStatus } from "../../src/status.js";
import { SCHEMA_VERSION, type EventType, type InboxMessageType, type RootSessionIdentity, type RunResult, type RunStatus, type SubagentMessageResult, type WaitCursorMap } from "../../src/types.js";
import { waitSubagents } from "../../src/wait.js";
import { eventDeliveryKey, markWakeupHandled, markWakeupKeyHandled, resultDeliveryKey, writeDeliverySubscription } from "./wakeups.js";
import {
  subagentMessageSchema,
  subagentResultSchema,
  subagentStartSchema,
  subagentStatusSchema,
  subagentWaitSchema,
} from "./schema.js";
import {
  renderSubagentToolCall,
  renderSubagentToolResult,
  summarizeMessageResult,
  summarizeRunResult,
  summarizeStartResult,
  summarizeStatusRows,
  summarizeWaitResult,
  preview,
} from "./renderers.js";

export interface ToolRuntime {
  getRootIdentity?: (cwd: string) => RootSessionIdentity | undefined;
  setRootIdentity?: (identity: RootSessionIdentity) => void;
  afterMutation?: (ctx: unknown, cwd: string, identity: RootSessionIdentity) => void | Promise<void>;
}

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function ctxCwd(ctx: unknown): string {
  const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" ? cwd : process.cwd();
}

function cwdFromParams(params: Record<string, unknown>, ctx: unknown): string {
  return resolve(typeof params.cwd === "string" ? params.cwd : ctxCwd(ctx));
}

function storeFor(cwd: string): RunStore {
  return new RunStore({ cwd });
}

function rootFor(runtime: ToolRuntime, cwd: string): RootSessionIdentity {
  const existing = runtime.getRootIdentity?.(cwd);
  if (existing && resolve(existing.cwd) === resolve(cwd)) return existing;
  const identity = createRootSession({ cwd });
  runtime.setRootIdentity?.(identity);
  return identity;
}

function response(summary: string, details: Record<string, unknown>, isError = false): ToolResponse {
  return { content: [{ type: "text", text: summary }], details: { summary, ...details }, isError: isError || undefined };
}

function ensureIndexedRunDir(store: RunStore, cwd: string, runDir: string): string {
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  try {
    store.pathsFor({ runId: status.runId });
  } catch {
    store.appendRunIndex({
      schemaVersion: SCHEMA_VERSION,
      runId: status.runId,
      runDir,
      projectRoot: cwd,
      parentRunId: status.parentRunId,
      rootRunId: status.rootRunId,
      rootSessionId: status.rootSessionId,
      createdAt: status.createdAt,
    });
  }
  return status.runId;
}

function runIdsFromDirs(store: RunStore, cwd: string, runDirs: unknown): string[] {
  if (!Array.isArray(runDirs)) return [];
  return runDirs.flatMap((runDir) => {
    if (typeof runDir !== "string") return [];
    return [ensureIndexedRunDir(store, cwd, runDir)];
  });
}

function runIdFromParams(store: RunStore, cwd: string, params: Record<string, unknown>): string {
  if (typeof params.runId === "string" && params.runId) return params.runId;
  if (typeof params.runDir === "string" && params.runDir) {
    return ensureIndexedRunDir(store, cwd, params.runDir);
  }
  throw new Error("runId or runDir is required");
}

function statusFromParams(store: RunStore, cwd: string, params: Record<string, unknown>): RunStatus {
  if (typeof params.runDir === "string" && params.runDir && typeof params.runId !== "string") {
    ensureIndexedRunDir(store, cwd, params.runDir);
    return JSON.parse(readFileSync(join(params.runDir, "status.json"), "utf8")) as RunStatus;
  }
  return readSubagentStatus(store, { runId: runIdFromParams(store, cwd, params) });
}

function resultFromParams(store: RunStore, cwd: string, params: Record<string, unknown>): { runId: string; runDir: string; result?: RunResult } {
  if (typeof params.runDir === "string" && params.runDir && typeof params.runId !== "string") {
    const runId = ensureIndexedRunDir(store, cwd, params.runDir);
    try {
      return { runId, runDir: params.runDir, result: JSON.parse(readFileSync(join(params.runDir, "result.json"), "utf8")) as RunResult };
    } catch {
      return { runId, runDir: params.runDir };
    }
  }
  const runId = runIdFromParams(store, cwd, params);
  return { runId, runDir: store.pathsFor({ runId }).runDir, result: readSubagentResult(store, { runId, requireTerminal: false }) };
}

function defaultRunIds(store: RunStore, parentRunId: string, params: Record<string, unknown>): string[] {
  const explicit = Array.isArray(params.runIds) ? params.runIds.filter((runId): runId is string => typeof runId === "string") : [];
  if (explicit.length) return explicit;
  const fromDirs = runIdsFromDirs(store, store.cwd, params.runDirs);
  if (fromDirs.length) return fromDirs;
  return store.listDirectChildren(parentRunId).map((record) => record.runId);
}

async function waitForMessageAckFromParams(store: RunStore, params: Record<string, unknown>, runId: string, messageId: string): Promise<{ eventId: string } | undefined> {
  if (typeof params.runDir === "string" && params.runDir && typeof params.runId !== "string") {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2_000) {
      const event = readJsonl<any>(join(params.runDir, "events.jsonl")).records.find((candidate) => candidate.type === "message.received" && candidate.data?.messageId === messageId);
      if (event?.eventId) return { eventId: event.eventId };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }
  return waitForMessageAck(store, { runId, messageId, timeoutMs: 2_000 });
}

function compactResultBody(body: string | undefined, maxBytes: number): string | undefined {
  if (!body) return body;
  const buffer = Buffer.from(body, "utf8");
  if (buffer.length <= maxBytes) return body;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}...`;
}

function compactEvents(events: unknown[], maxEvents: number): unknown[] {
  return events.length <= maxEvents ? events : events.slice(0, maxEvents);
}

export function buildSubagentTools(runtime: ToolRuntime = {}) {
  return [
    {
      name: "subagent_start",
      label: "Subagent Start",
      description: "Start a durable async Pi child agent and return immediately by default.",
      parameters: subagentStartSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = cwdFromParams(params, ctx);
        const root = rootFor(runtime, cwd);
        const mode = params.mode === "sync" ? "sync" : "async";
        const wait = typeof params.wait === "string" ? params.wait : "none";
        const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
        const notifyOn = Array.isArray(params.notifyOn) ? (params.notifyOn.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined;
        const result = await startSubagent({
          agent: String(params.agent),
          task: String(params.task),
          cwd,
          parentRunId: root.parentRunId,
          rootRunId: root.parentRunId,
          rootSessionId: root.rootSessionId,
          depth: typeof params.maxSubagentDepth === "number" ? params.maxSubagentDepth : undefined,
          files: Array.isArray(params.files) ? params.files.filter((file): file is string => typeof file === "string") : undefined,
          startMode: mode === "sync" || wait !== "none" ? "wait" : "async",
          waitTimeoutMs: timeoutMs ?? (mode === "sync" || wait !== "none" ? 300_000 : 0),
          waitUntil: wait === "terminal" || wait === "result" || wait === "interesting" ? wait : mode === "sync" ? "result" : "interesting",
          env: {
            ASYNC_SUBAGENTS_ROOT_SESSION_ID: root.rootSessionId,
            ASYNC_SUBAGENTS_PARENT_RUN_ID: root.parentRunId,
          },
        });
        writeDeliverySubscription(storeFor(cwd), {
          schemaVersion: SCHEMA_VERSION,
          parentRunId: root.parentRunId,
          runId: result.runId,
          notifyOn: notifyOn ?? ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"],
          createdAt: new Date().toISOString(),
        });
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summarizeStartResult(result), { ...result, rootSessionId: root.rootSessionId });
      },
      renderCall: renderSubagentToolCall,
      renderResult: renderSubagentToolResult,
    },
    {
      name: "subagent_wait",
      label: "Subagent Wait",
      description: "Race-wait on child events or terminal results without cancelling timed-out children.",
      parameters: subagentWaitSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd);
        const store = storeFor(cwd);
        const parentRunId = typeof params.parentRunId === "string" ? params.parentRunId : root.parentRunId;
        const runIds = defaultRunIds(store, parentRunId, params);
        const maxEvents = typeof params.maxEvents === "number" ? params.maxEvents : 20;
        const result = await waitSubagents(store, {
          runIds,
          parentRunId,
          mode: params.mode === "all" || params.mode === "each" ? params.mode : "race",
          until: params.until === "terminal" || params.until === "result" || params.until === "event" ? params.until : "interesting",
          eventTypes: Array.isArray(params.eventTypes) ? (params.eventTypes.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined,
          since: typeof params.since === "object" && params.since ? (params.since as WaitCursorMap) : undefined,
          timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 300_000,
          includeStatus: params.includeStatus !== false,
          includeResult: params.includeResult !== false,
        });
        for (const event of result.events) markWakeupKeyHandled(store, parentRunId, eventDeliveryKey(event));
        for (const readyResult of result.results) markWakeupKeyHandled(store, parentRunId, resultDeliveryKey(readyResult.runId, readyResult));
        result.events = compactEvents(result.events, maxEvents) as typeof result.events;
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summarizeWaitResult(result), result as unknown as Record<string, unknown>);
      },
      renderCall: renderSubagentToolCall,
      renderResult: renderSubagentToolResult,
    },
    {
      name: "subagent_message",
      label: "Subagent Message",
      description: "Append parent-to-child input to inbox.jsonl. Live delivery is reported only when supported.",
      parameters: subagentMessageSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd);
        const store = storeFor(cwd);
        const status = statusFromParams(store, cwd, params);
        const runId = status.runId;
        const type = (typeof params.type === "string" ? params.type : "instruction") as InboxMessageType;
        if (isTerminalRunState(status.state)) {
          return response(`Run ${runId} is terminal; message not appended`, { code: "RUN_TERMINAL", runId, state: status.state }, true);
        }
        const result: SubagentMessageResult =
          typeof params.runDir === "string" && params.runDir && typeof params.runId !== "string"
            ? (() => {
                const message = createInboxMessage({
                  toRunId: runId,
                  fromRunId: root.parentRunId,
                  body: String(params.body),
                  type,
                  attachments: Array.isArray(params.attachments) ? (params.attachments as never) : undefined,
                  requiresAck: typeof params.requiresAck === "boolean" ? params.requiresAck : undefined,
                });
                appendJsonl(join(params.runDir, "inbox.jsonl"), message);
                return { messageId: message.messageId, runId, appended: true, liveDelivered: false };
              })()
            : sendSubagentMessage(store, {
                runId,
                fromRunId: root.parentRunId,
                body: String(params.body),
                type,
                attachments: Array.isArray(params.attachments) ? (params.attachments as never) : undefined,
                requiresAck: typeof params.requiresAck === "boolean" ? params.requiresAck : undefined,
                liveTransport: "child-control",
              });
        const live = !isTerminalRunState(status.state);
        if (live && type !== "cancel") {
          const ack = await waitForMessageAckFromParams(store, params, runId, result.messageId);
          if (ack) {
            result.liveDelivered = true;
            result.ackEventId = ack.eventId;
            result.unsupported = undefined;
          } else {
            result.liveDelivered = false;
            result.unsupported = {
              code: "LIVE_MESSAGE_UNSUPPORTED",
              message: "message was appended to inbox.jsonl, but the child-control extension did not acknowledge it before timeout",
            };
          }
        }
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summarizeMessageResult(result), { ...result, status: { runId: status.runId, state: status.state } });
      },
      renderCall: renderSubagentToolCall,
      renderResult: renderSubagentToolResult,
    },
    {
      name: "subagent_result",
      label: "Subagent Result",
      description: "Read a terminal child result from result.json.",
      parameters: subagentResultSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd);
        const store = storeFor(cwd);
        const { runId, runDir, result } = resultFromParams(store, cwd, params);
        if (!result) return response(summarizeRunResult(undefined, runId), { code: "RESULT_NOT_READY", runId }, true);
        markWakeupHandled(store, root.parentRunId, runId);
        const includeBody = params.includeBody !== false;
        const includeArtifacts = params.includeArtifacts !== false;
        const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : 16_000;
        const details = {
          ...result,
          body: includeBody ? compactResultBody(result.body, maxBytes) : undefined,
          artifacts: includeArtifacts ? result.artifacts : undefined,
          runDir,
          next: [],
        };
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summarizeRunResult(result, runId), details as Record<string, unknown>);
      },
      renderCall: renderSubagentToolCall,
      renderResult: renderSubagentToolResult,
    },
    {
      name: "subagent_status",
      label: "Subagent Status",
      description: "Read compact status for direct children or selected run ids.",
      parameters: subagentStatusSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd);
        const store = storeFor(cwd);
        const parentRunId = typeof params.parentRunId === "string" ? params.parentRunId : root.parentRunId;
        const runIds = defaultRunIds(store, parentRunId, params);
        const maxEvents = typeof params.maxEvents === "number" ? params.maxEvents : 10;
        const rows = runIds.flatMap((runId) => {
          try {
            const status = readSubagentStatus(store, { runId });
            return [{ runId: status.runId, state: status.state, summary: preview(status.summary, 120) }];
          } catch {
            return [];
          }
        });
        const details: Record<string, unknown> = {
          parentRunId,
          rootSessionId: root.rootSessionId,
          rows,
          counts: {
            total: rows.length,
            active: rows.filter((row) => !isTerminalRunState(row.state)).length,
            terminal: rows.filter((row) => isTerminalRunState(row.state)).length,
          },
        };
        if (params.includeEvents === true) {
          details.events = Object.fromEntries(runIds.map((runId) => [runId, compactEvents(store.readEvents(runId).records, maxEvents)]));
        }
        if (params.includeInbox === true) {
          details.inbox = Object.fromEntries(runIds.map((runId) => [runId, store.readInbox(runId).records.slice(0, maxEvents)]));
        }
        return response(summarizeStatusRows(rows), details);
      },
      renderCall: renderSubagentToolCall,
      renderResult: renderSubagentToolResult,
    },
  ];
}

export function registerSubagentTools(pi: ExtensionAPI, runtime: ToolRuntime = {}): void {
  for (const tool of buildSubagentTools(runtime)) pi.registerTool(tool as never);
}

export const tools = buildSubagentTools();
