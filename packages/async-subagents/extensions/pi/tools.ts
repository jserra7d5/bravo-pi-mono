import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunEvent } from "../../src/events.js";
import { appendJsonl, readJsonl } from "../../src/jsonl.js";
import { createInboxMessage, sendSubagentMessage, waitForMessageAck } from "../../src/message.js";
import { NAME_PACKS, readNamePackSelection, writeNamePackSelection, type NamePackId } from "../../src/namePacks.js";
import { readSubagentResult } from "../../src/result.js";
import { createRootSession } from "../../src/rootSession.js";
import { RunStore } from "../../src/runStore.js";
import { isTerminalRunState, isThinkingLevel } from "../../src/schemas.js";
import { startSubagent } from "../../src/start.js";
import { readSubagentStatus, updateRunStatus } from "../../src/status.js";
import { SCHEMA_VERSION, type ContextPolicy, type EventType, type InboxMessageType, type ParentMessageType, type RootSessionIdentity, type RunResult, type RunStatus, type SessionPolicy, type SubagentMessageResult, type WaitCursorMap } from "../../src/types.js";
import { waitSubagents } from "../../src/wait.js";
import { finalizeTerminalRun } from "../../src/lifecycle.js";
import { readParentPiSessionRef } from "../../src/piSession.js";
import { eventDeliveryKey, markWakeupHandled, markWakeupKeyHandled, writeDeliverySubscription } from "./wakeups.js";
import {
  subagentContinueSchema,
  subagentInterruptSchema,
  subagentMessageSchema,
  subagentNamePackSchema,
  subagentResultSchema,
  subagentStartSchema,
  subagentStatusSchema,
  subagentWaitSchema,
} from "./schema.js";
import {
  renderSubagentToolCallComponent,
  renderSubagentToolResultComponent,
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

const LIVE_ACK_TIMEOUT_MS = 500;

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

function response(summary: string, details: Record<string, unknown>, isError = false, contentText?: string): ToolResponse {
  return { content: [{ type: "text", text: contentText ?? summary }], details: { summary, ...details }, isError: isError || undefined };
}

function resultBodyContent(summary: string, result: RunResult, body: { body?: string; bodyTruncation: Record<string, unknown> }): string {
  const lines = [summary];
  if (body.body !== undefined) {
    lines.push("", body.body);
    if (body.bodyTruncation.truncated === true) {
      lines.push("", `[Body truncated: ${body.bodyTruncation.returnedBytes} of ${body.bodyTruncation.originalBytes} bytes returned (maxBytes=${body.bodyTruncation.maxBytes}).]`);
    }
  } else if (body.bodyTruncation.included === false) {
    lines.push("", "[Body omitted: includeBody=false]");
  } else if (result.body !== undefined) {
    lines.push("", "[Body unavailable]");
  }
  return lines.join("\n");
}

function appendWithinBudget(lines: string[], value: string, budget: { used: number; maxBytes: number; omitted: number }): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  if (budget.used + bytes > budget.maxBytes) {
    budget.omitted += 1;
    return false;
  }
  lines.push(value);
  budget.used += bytes;
  return true;
}

function waitResultContent(summary: string, results: Array<RunResult & { bodyTruncation: Record<string, unknown> }>, maxContentBytes = 64_000): string {
  if (!results.length) return summary;
  const lines = [summary];
  const budget = { used: Buffer.byteLength(summary, "utf8"), maxBytes: maxContentBytes, omitted: 0 };
  for (const result of results) {
    const section: string[] = ["", `## ${result.displayName ? `@${result.displayName} ` : ""}${result.agentName} ${result.state} (${result.runId})`];
    if (result.body !== undefined) {
      section.push("", result.body);
      if (result.bodyTruncation.truncated === true) {
        section.push("", `[Body truncated: ${result.bodyTruncation.returnedBytes} of ${result.bodyTruncation.originalBytes} bytes returned (maxBytes=${result.bodyTruncation.maxBytes}).]`);
      }
    } else if (result.bodyTruncation.included === false) {
      section.push("", "[Body omitted: includeResult=false]");
    }
    if (!appendWithinBudget(lines, section.join("\n"), budget)) break;
  }
  if (budget.omitted) lines.push("", `[${budget.omitted} result section(s) omitted from model-facing content because the aggregate subagent_wait content cap of ${maxContentBytes} bytes was reached. Use subagent_result for specific runs.]`);
  return lines.join("\n");
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
    while (Date.now() - startedAt < LIVE_ACK_TIMEOUT_MS) {
      const event = readJsonl<any>(join(params.runDir, "events.jsonl")).records.find((candidate) => candidate.type === "message.received" && candidate.data?.messageId === messageId);
      if (event?.eventId) return { eventId: event.eventId };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }
  return waitForMessageAck(store, { runId, messageId, timeoutMs: LIVE_ACK_TIMEOUT_MS });
}

function truncateUtf8WithMarker(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const marker = "...";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return marker.slice(0, maxBytes);
  const prefixBudget = maxBytes - markerBytes;
  let used = 0;
  let prefix = "";
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > prefixBudget) break;
    prefix += char;
    used += bytes;
  }
  return `${prefix}${marker}`;
}

function shapeResultBody(body: string | undefined, maxBytes: number, includeBody: boolean): { body?: string; bodyTruncation: Record<string, unknown> } {
  if (!includeBody) return { body: undefined, bodyTruncation: { included: false } };
  if (!body) return { body, bodyTruncation: { included: true, truncated: false, originalBytes: 0, returnedBytes: 0, maxBytes } };
  const buffer = Buffer.from(body, "utf8");
  if (buffer.length <= maxBytes) {
    return { body, bodyTruncation: { included: true, truncated: false, originalBytes: buffer.length, returnedBytes: buffer.length, maxBytes } };
  }
  const compacted = truncateUtf8WithMarker(body, maxBytes);
  return {
    body: compacted,
    bodyTruncation: {
      included: true,
      truncated: true,
      originalBytes: buffer.length,
      returnedBytes: Buffer.byteLength(compacted, "utf8"),
      maxBytes,
    },
  };
}

function shapeResult(result: RunResult, maxBytes: number, includeBody = true): RunResult & { bodyTruncation: Record<string, unknown> } {
  const body = shapeResultBody(result.body, maxBytes, includeBody);
  return { ...result, body: body.body, bodyTruncation: body.bodyTruncation };
}

function markResultCollected(store: RunStore, parentRunId: string, runId: string): void {
  markWakeupHandled(store, parentRunId, runId);
  try {
    const status = store.readStatus(runId);
    if (status.resultReady) store.writeStatus(updateRunStatus(status, { resultReady: false }));
  } catch {
    // Best-effort cleanup: result reads should not fail just because a recovered
    // runDir is missing from this workspace's status index.
  }
}

function compactEvents(events: unknown[], maxEvents: number): unknown[] {
  return events.length <= maxEvents ? events : events.slice(0, maxEvents);
}

function nextEventSequence(store: RunStore, runId: string): number {
  return store.readEvents(runId).records.length + 1;
}

function trySignal(pid: number | undefined, signal: NodeJS.Signals): { ok: boolean; error?: string } {
  if (!pid) return { ok: false, error: "run has no recorded pid" };
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function processHealth(pid: number | undefined): "unknown" | "alive" | "dead" {
  if (!pid) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch {
    return "dead";
  }
}

function reconcileProcessHealth(store: RunStore, status: RunStatus): RunStatus {
  const health = processHealth(status.pid);
  if (health === status.processHealth) return status;
  const next = updateRunStatus(status, { processHealth: health });
  if (!isTerminalRunState(status.state) && health === "dead") {
    const event = createRunEvent({
      sequence: nextEventSequence(store, status.runId),
      runId: status.runId,
      parentRunId: status.parentRunId,
      type: "status",
      summary: "Recorded child process is no longer alive",
      wake: true,
      data: { reconciliation: "pid_dead", pid: status.pid },
    });
    store.appendEvent(status.runId, event);
    store.writeStatus({ ...next, lastActivityAt: event.createdAt, lastEventId: event.eventId, summary: event.summary });
    return { ...next, lastActivityAt: event.createdAt, lastEventId: event.eventId, summary: event.summary };
  }
  store.writeStatus(next);
  return next;
}

function appendParentMessage(params: Record<string, unknown>, store: RunStore, root: RootSessionIdentity, runId: string, type: InboxMessageType, body: string): SubagentMessageResult {
  const thinkingLevel = isThinkingLevel(params.thinkingLevel) ? params.thinkingLevel : undefined;
  if (typeof params.runDir === "string" && params.runDir && typeof params.runId !== "string") {
    const message = createInboxMessage({
      toRunId: runId,
      fromRunId: root.parentRunId,
      body,
      type,
      attachments: Array.isArray(params.attachments) ? (params.attachments as never) : undefined,
      requiresAck: typeof params.requiresAck === "boolean" ? params.requiresAck : undefined,
      thinkingLevel,
    });
    appendJsonl(join(params.runDir, "inbox.jsonl"), message);
    return { messageId: message.messageId, runId, appended: true, liveDelivered: false };
  }
  return sendSubagentMessage(store, {
    runId,
    fromRunId: root.parentRunId,
    body,
    type,
    attachments: Array.isArray(params.attachments) ? (params.attachments as never) : undefined,
    requiresAck: typeof params.requiresAck === "boolean" ? params.requiresAck : undefined,
    thinkingLevel,
    liveTransport: "child-control",
  });
}

async function waitForLiveAckIfNeeded(store: RunStore, params: Record<string, unknown>, status: RunStatus, result: SubagentMessageResult): Promise<SubagentMessageResult> {
  if (isTerminalRunState(status.state)) return result;
  const ack = await waitForMessageAckFromParams(store, params, status.runId, result.messageId);
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
  return result;
}

function requiredAckFailed(params: Record<string, unknown>, result: SubagentMessageResult): boolean {
  return params.requiresAck !== false && Boolean(result.unsupported);
}

function statusDiagnostics(store: RunStore, status: RunStatus): string[] {
  const diagnostics: string[] = [];
  const result = store.readResult(status.runId);
  if (result && !isTerminalRunState(status.state)) diagnostics.push("result exists but status is non-terminal");
  if (isTerminalRunState(status.state) && !result) diagnostics.push("terminal status exists but result is missing");
  if (result && isTerminalRunState(status.state) && result.state !== status.state) diagnostics.push(`terminal status/result mismatch: status=${status.state} result=${result.state}`);
  return diagnostics;
}

export function buildSubagentTools(runtime: ToolRuntime = {}) {
  return [
    {
      name: "subagent_start",
      label: "Subagent Start",
      description: "Start a durable async Pi child agent and return immediately by default.",
      parameters: subagentStartSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const sessionCwd = ctxCwd(ctx);
        const cwd = cwdFromParams(params, ctx);
        const root = rootFor(runtime, sessionCwd);
        const mode = params.mode === "sync" ? "sync" : "async";
        const wait = typeof params.wait === "string" ? params.wait : "none";
        const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
        const contextPolicy = params.context === "fork" ? "fork" : params.context === "fresh" ? "fresh" : undefined;
        const sessionPolicy = params.session === "none" ? "none" : params.session === "record" ? "record" : undefined;
        const notifyOn = Array.isArray(params.notifyOn) ? (params.notifyOn.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined;
        const result = await startSubagent({
          agent: String(params.agent),
          variant: typeof params.variant === "string" && params.variant ? params.variant : undefined,
          task: String(params.task),
          cwd,
          runRoot: storeFor(sessionCwd).runRoot,
          parentRunId: root.parentRunId,
          rootRunId: root.parentRunId,
          rootSessionId: root.rootSessionId,
          depth: typeof params.maxSubagentDepth === "number" ? params.maxSubagentDepth : undefined,
          files: Array.isArray(params.files) ? params.files.filter((file): file is string => typeof file === "string") : undefined,
          context: contextPolicy as ContextPolicy | undefined,
          session: sessionPolicy as SessionPolicy | undefined,
          allowFreshFallback: params.allowFreshFallback === true,
          parentPiSessionRef: readParentPiSessionRef(ctx),
          startMode: mode === "sync" || wait !== "none" ? "wait" : "async",
          waitTimeoutMs: timeoutMs ?? (mode === "sync" || wait !== "none" ? 300_000 : 0),
          waitUntil: wait === "terminal" || wait === "result" || wait === "interesting" ? wait : mode === "sync" ? "result" : "interesting",
          env: {
            ASYNC_SUBAGENTS_ROOT_SESSION_ID: root.rootSessionId,
            ASYNC_SUBAGENTS_PARENT_RUN_ID: root.parentRunId,
          },
          thinkingLevel: isThinkingLevel(params.thinkingLevel) ? params.thinkingLevel : undefined,
        });
        writeDeliverySubscription(storeFor(sessionCwd), {
          schemaVersion: SCHEMA_VERSION,
          parentRunId: root.parentRunId,
          runId: result.runId,
          notifyOn: notifyOn ?? ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"],
          createdAt: new Date().toISOString(),
        });
        await runtime.afterMutation?.(ctx, sessionCwd, root);
        return response(summarizeStartResult(result), { ...result, rootSessionId: root.rootSessionId });
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_start"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
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
        const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : 64_000;
        const includeResult = params.includeResult !== false;
        const result = await waitSubagents(store, {
          runIds,
          parentRunId,
          mode: params.mode === "all" || params.mode === "each" ? params.mode : "race",
          until: params.until === "terminal" || params.until === "result" || params.until === "event" ? params.until : "interesting",
          eventTypes: Array.isArray(params.eventTypes) ? (params.eventTypes.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined,
          since: typeof params.since === "object" && params.since ? (params.since as WaitCursorMap) : undefined,
          timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 300_000,
          includeStatus: params.includeStatus !== false,
          includeResult,
        });
        for (const event of result.events) markWakeupKeyHandled(store, parentRunId, eventDeliveryKey(event));
        for (const readyResult of result.results) markResultCollected(store, parentRunId, readyResult.runId);
        result.events = compactEvents(result.events, maxEvents) as typeof result.events;
        const shapedResults = result.results.map((readyResult) => shapeResult(readyResult, maxBytes, includeResult));
        const details = {
          ...result,
          results: shapedResults,
        };
        const summary = summarizeWaitResult(result);
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summary, details as unknown as Record<string, unknown>, false, waitResultContent(summary, shapedResults));
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_wait"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
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
        const type = (typeof params.type === "string" ? params.type : "instruction") as ParentMessageType;
        if (!["instruction", "answer", "context"].includes(type)) {
          return response(`Use subagent_interrupt or subagent_continue for lifecycle control (${type})`, { code: "LIFECYCLE_MESSAGE_REJECTED", runId, type }, true);
        }
        if (isTerminalRunState(status.state)) {
          return response(`Run ${runId} is terminal; message not appended`, { code: "RUN_TERMINAL", runId, state: status.state }, true);
        }
        const result = await waitForLiveAckIfNeeded(store, params, status, appendParentMessage(params, store, root, runId, type, String(params.body)));
        if (requiredAckFailed(params, result)) {
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(result.unsupported?.message ?? "Required child acknowledgement was not received", { ...result, status: { runId: status.runId, state: status.state } }, true);
        }
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summarizeMessageResult(result), { ...result, status: { runId: status.runId, state: status.state } });
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_message"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "subagent_interrupt",
      label: "Subagent Interrupt",
      description: "Pause or cancel an active child run with real process control where possible.",
      parameters: subagentInterruptSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd);
        const store = storeFor(cwd);
        const status = statusFromParams(store, cwd, params);
        const runId = status.runId;
        const action = params.action === "cancel" ? "cancel" : "pause";
        const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : action === "cancel" ? "Cancelled by parent" : "Paused by parent";
        if (isTerminalRunState(status.state)) return response(`Run ${runId} is already terminal`, { code: "RUN_TERMINAL", runId, state: status.state }, true);

        if (action === "pause") {
          const signal = trySignal(status.pid, "SIGSTOP");
          if (!signal.ok) return response(`Run ${runId} could not be paused: ${signal.error}`, { code: "PAUSE_FAILED", runId, error: signal.error }, true);
          const event = createRunEvent({ sequence: nextEventSequence(store, runId), runId, parentRunId: status.parentRunId, type: "status", summary: reason, wake: true, data: { action: "pause", pid: status.pid } });
          store.appendEvent(runId, event);
          store.writeStatus(updateRunStatus(status, { state: "paused", writerRole: "parent-runtime", lastActivityAt: event.createdAt, lastEventId: event.eventId, summary: reason }));
          appendParentMessage(params, store, root, runId, "pause", reason);
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(`Subagent ${runId} paused`, { runId, state: "paused", pid: status.pid, event });
        }

        const requestedSignal = params.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
        const signal = status.pid ? trySignal(status.pid, requestedSignal) : { ok: false, error: "run has no recorded pid" };
        const cancelError = { code: "PARENT_CANCELLED", message: reason, details: { pid: status.pid, signal: requestedSignal, signalError: signal.error } };
        const finalized = finalizeTerminalRun(store, {
          runId,
          parentRunId: status.parentRunId,
          agentName: status.agent.name,
          state: "cancelled",
          writerRole: "parent-runtime",
          startedAt: status.startedAt,
          summary: reason,
          body: reason,
          error: cancelError,
        });
        appendParentMessage(params, store, root, runId, "cancel", reason);
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(`Subagent ${runId} cancelled`, { runId, state: "cancelled", pid: status.pid, signal: requestedSignal, signalDelivered: signal.ok, signalError: signal.error, result: finalized });
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_interrupt"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "subagent_continue",
      label: "Subagent Continue",
      description: "Resume a paused child run and optionally deliver follow-up input.",
      parameters: subagentContinueSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd);
        const store = storeFor(cwd);
        const status = statusFromParams(store, cwd, params);
        const runId = status.runId;
        if (isTerminalRunState(status.state)) return response(`Run ${runId} is terminal; cannot continue`, { code: "RUN_TERMINAL", runId, state: status.state }, true);
        if (status.state !== "paused") {
          return response(`Run ${runId} is ${status.state}; use subagent_message for normal input`, { code: "RUN_NOT_PAUSED", runId, state: status.state }, true);
        }

        const signal = trySignal(status.pid, "SIGCONT");
        if (!signal.ok) return response(`Run ${runId} could not be continued: ${signal.error}`, { code: "CONTINUE_FAILED", runId, error: signal.error }, true);
        const thinkingLevel = isThinkingLevel(params.thinkingLevel) ? params.thinkingLevel : undefined;
        const selectedThinkingLevel = thinkingLevel ?? status.thinkingLevel;
        const event = createRunEvent({ sequence: nextEventSequence(store, runId), runId, parentRunId: status.parentRunId, type: "status", summary: "Continued by parent", wake: false, data: { action: "continue", pid: status.pid, signalDelivered: signal.ok, thinkingLevel } });
        store.appendEvent(runId, event);
        store.writeStatus(updateRunStatus(status, { state: "running", writerRole: "parent-runtime", lastActivityAt: event.createdAt, lastEventId: event.eventId, summary: "Continued by parent", needs: null, thinkingLevel: selectedThinkingLevel }));
        const body = typeof params.body === "string" && params.body.trim() ? params.body : "Resume work.";
        const type = (typeof params.type === "string" ? params.type : "instruction") as ParentMessageType;
        const messageType: InboxMessageType = !params.body ? "resume" : type;
        const result = await waitForLiveAckIfNeeded(store, params, status, appendParentMessage(params, store, root, runId, messageType, body));
        if (requiredAckFailed(params, result)) {
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(result.unsupported?.message ?? "Required child acknowledgement was not received", { ...result, runId, state: "running", signalDelivered: signal.ok, event, thinkingLevel: selectedThinkingLevel }, true);
        }
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(`Subagent ${runId} continued`, { ...result, runId, state: "running", signalDelivered: signal?.ok, event, thinkingLevel: selectedThinkingLevel });
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_continue"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
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
        markResultCollected(store, result.parentRunId ?? root.parentRunId, runId);
        const includeBody = params.includeBody !== false;
        const includeArtifacts = params.includeArtifacts !== false;
        const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : 64_000;
        const body = shapeResultBody(result.body, maxBytes, includeBody);
        const details = {
          ...result,
          body: body.body,
          bodyTruncation: body.bodyTruncation,
          artifacts: includeArtifacts ? result.artifacts : undefined,
          runDir,
          piSessionPath: result.piSessionPath,
          requestedPiSessionPath: result.requestedPiSessionPath,
          launchLogPath: join(runDir, "logs", "launch.json"),
          logsDir: join(runDir, "logs"),
          artifactsDir: join(runDir, "artifacts"),
          next: [],
        };
        const summary = summarizeRunResult(result, runId);
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summary, details as Record<string, unknown>, false, resultBodyContent(summary, result, body));
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_result"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "subagent_name_pack",
      label: "Subagent Name Pack",
      description: "Inspect or change the active display-name pack used for future subagent runs.",
      parameters: subagentNamePackSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd);
        const store = storeFor(cwd);
        const pack = typeof params.pack === "string" ? params.pack : undefined;
        if (pack && !Object.hasOwn(NAME_PACKS, pack)) return response(`Unknown subagent name pack: ${pack}`, { code: "UNKNOWN_NAME_PACK", pack }, true);
        const selection = pack ? writeNamePackSelection(store.runRoot, pack as NamePackId) : readNamePackSelection(store.runRoot);
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(`Subagent name pack: ${selection.activePack}`, {
          ...selection,
          changed: Boolean(pack),
        } as unknown as Record<string, unknown>);
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_name_pack"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
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
            const status = reconcileProcessHealth(store, readSubagentStatus(store, { runId }));
            const diagnostics = statusDiagnostics(store, status);
            return [{
              runId: status.runId,
              state: status.state,
              displayName: status.displayName,
              namePack: status.namePack,
              agentName: status.agent.name,
              summary: preview(status.summary, 120),
              cwd: status.cwd,
              parentRunId: status.parentRunId,
              rootSessionId: status.rootSessionId,
              pid: status.pid,
              processHealth: status.processHealth,
              model: status.model,
              thinkingLevel: status.thinkingLevel,
              contextPolicy: status.contextPolicy,
              sessionPolicy: status.sessionPolicy,
              piSessionPath: status.piSessionPath,
              requestedPiSessionPath: status.requestedPiSessionPath,
              launchLogPath: status.launchLogPath,
              resultReady: status.resultReady,
              diagnostics,
            }];
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
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_status"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
  ];
}

export function registerSubagentTools(pi: ExtensionAPI, runtime: ToolRuntime = {}): void {
  for (const tool of buildSubagentTools(runtime)) pi.registerTool(tool as never);
}

export const tools = buildSubagentTools();
