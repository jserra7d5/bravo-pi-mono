import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunEvent } from "../../src/events.js";
import { newRunId } from "../../src/ids.js";
import { appendJsonl, readJsonl } from "../../src/jsonl.js";
import { createInboxMessage, sendSubagentMessage, waitForMessageAck } from "../../src/message.js";
import { NAME_PACKS, readNamePackSelection, writeNamePackSelection, type NamePackId } from "../../src/namePacks.js";
import { readSubagentResult } from "../../src/result.js";
import { createRootSession, readRootSession } from "../../src/rootSession.js";
import { RunStore } from "../../src/runStore.js";
import { TaskStore, hashTaskToken, newTaskToken } from "../../src/taskStore.js";
import { readTaskRuntimeState } from "../../src/taskRuntime.js";
import { deriveTaskState, unresolvedDependencies } from "../../src/taskState.js";
import { isTerminalRunState, isThinkingLevel } from "../../src/schemas.js";
import { startSubagent, type StartSubagentInput } from "../../src/start.js";
import { readSubagentStatus, updateRunStatus } from "../../src/status.js";
import { SCHEMA_VERSION, type ContextPolicy, type EventType, type InboxMessageType, type ParentMessageType, type RootSessionIdentity, type RunResult, type RunStatus, type SessionPolicy, type SubagentMessageResult, type TaskRecord } from "../../src/types.js";
import { readParentPiSessionRef } from "../../src/piSession.js";
import { markTaskWakeupHandled, markWakeupHandled, markWakeupKeyHandled, taskEventDeliveryKey, writeDeliverySubscription } from "./wakeups.js";
import {
  subagentContinueSchema,
  subagentInterruptSchema,
  subagentMessageSchema,
  subagentNamePackSchema,
  subagentResultSchema,
  subagentStartSchema,
  subagentStatusSchema,
  taskAcceptResultSchema,
  taskCancelSchema,
  taskCreateSchema,
  taskGetSchema,
  taskListSchema,
  taskReopenSchema,
  taskClearSchema,
} from "./schema.js";
import {
  renderSubagentToolCallComponent,
  renderSubagentToolResultComponent,
  summarizeMessageResult,
  summarizeRunResult,
  summarizeStartResult,
  summarizeStatusRows,
  preview,
} from "./renderers.js";

export interface ToolRuntime {
  getRootIdentity?: (cwd: string, piSessionId?: string) => RootSessionIdentity | undefined;
  setRootIdentity?: (identity: RootSessionIdentity) => void;
  startSubagent?: (input: StartSubagentInput) => ReturnType<typeof startSubagent>;
  isTaskRuntimeEnabled?: (cwd: string, rootSessionId: string) => boolean;
  afterMutation?: (ctx: unknown, cwd: string, identity: RootSessionIdentity) => void | Promise<void>;
}

export const TASK_TOOL_NAMES = ["task_create", "task_list", "task_get", "task_accept_result", "task_reopen", "task_cancel", "task_clear"] as const;
export const DIRECT_SUBAGENT_TOOL_NAMES = ["subagent_start", "subagent_status", "subagent_message", "subagent_continue", "subagent_interrupt", "subagent_result", "subagent_name_pack"] as const;
export const ASYNC_SUBAGENT_TOOL_NAMES = [...TASK_TOOL_NAMES, ...DIRECT_SUBAGENT_TOOL_NAMES] as const;

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

const LIVE_ACK_TIMEOUT_MS = 500;
const CONTINUATION_START_LOCK_TTL_MS = 10 * 60 * 1000;

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

function piSessionIdOf(ctx: unknown): string | undefined {
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
  const sessionId = sessionManager?.getSessionId?.();
  return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

function inheritedRootSessionId(): string | undefined {
  return isChildContext() ? process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID : undefined;
}

function rootFor(runtime: ToolRuntime, cwd: string, ctx?: unknown): RootSessionIdentity {
  const rootSessionId = inheritedRootSessionId();
  const piSessionId = rootSessionId ? undefined : piSessionIdOf(ctx);
  const existing = runtime.getRootIdentity?.(cwd, piSessionId);
  if (existing && resolve(existing.cwd) === resolve(cwd) && (!piSessionId || existing.piSessionId === piSessionId)) return existing;
  const identity = readRootSession({ cwd, rootSessionId, piSessionId }) ?? createRootSession({ cwd, rootSessionId, piSessionId });
  runtime.setRootIdentity?.(identity);
  return identity;
}

function response(summary: string, details: Record<string, unknown>, isError = false, contentText?: string): ToolResponse {
  return { content: [{ type: "text", text: contentText ?? summary }], details: { summary, ...details }, isError: isError || undefined };
}

function isChildContext(): boolean {
  return Boolean(process.env.ASYNC_SUBAGENTS_RUN_ID || process.env.ASYNC_SUBAGENT_RUN_ID);
}

function parentOnly(): ToolResponse | undefined {
  return isChildContext() ? response("Task parent/scheduler tool is not available in child contexts", { code: "PARENT_ONLY_TOOL" }, true) : undefined;
}

function taskStoreFor(cwd: string): TaskStore {
  return new TaskStore(storeFor(cwd));
}

function isTaskRuntimeEnabled(runtime: ToolRuntime, cwd: string, rootSessionId: string): boolean {
  return runtime.isTaskRuntimeEnabled?.(cwd, rootSessionId) ?? readTaskRuntimeState(storeFor(cwd).runRoot, rootSessionId).enabled;
}

function taskRuntimeDisabledResponse(): ToolResponse {
  return response("Task runtime is disabled for this root session. Use /tasks on to re-enable task orchestration, or use direct subagent_start without taskId.", { code: "TASK_RUNTIME_DISABLED" }, true);
}

function requireTaskRuntime(runtime: ToolRuntime, cwd: string, root: RootSessionIdentity): ToolResponse | undefined {
  return isTaskRuntimeEnabled(runtime, cwd, root.rootSessionId) ? undefined : taskRuntimeDisabledResponse();
}

function compactTaskRows(tasks: ReturnType<TaskStore["listTasks"]>) {
  return tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    status: task.status,
    state: deriveTaskState(task, tasks),
    dependsOn: task.dependsOn,
    owner: task.owner ? { runId: task.owner.runId, displayName: task.owner.displayName, agent: task.owner.agent } : undefined,
    resultReady: task.status === "result_ready",
    resultSummary: task.result?.summary,
    receiptPath: task.result?.receiptPath,
    artifactPaths: task.result?.artifactPaths,
    updatedAt: task.updatedAt,
  }));
}

interface ReceiptReadResult { receipt?: unknown; diagnostic?: { state: "missing" | "unreadable" | "invalid"; message: string; receiptPath?: string } }

function hasSubstantiveResultPayload(result: { artifactPaths?: string[]; evidence?: string[]; commandsRun?: string[]; notes?: string } | undefined): boolean {
  return Boolean(
    result?.artifactPaths?.some((item) => typeof item === "string" && item.trim()) ||
    result?.evidence?.some((item) => typeof item === "string" && item.trim()) ||
    result?.commandsRun?.some((item) => typeof item === "string" && item.trim()) ||
    (typeof result?.notes === "string" && result.notes.trim())
  );
}

function readReceipt(result: { receiptPath?: string; artifactPaths?: string[]; evidence?: string[]; commandsRun?: string[]; notes?: string } | undefined): ReceiptReadResult {
  const receiptPath = result?.receiptPath;
  if (!receiptPath) return hasSubstantiveResultPayload(result) ? {} : { diagnostic: { state: "missing", message: "task result has no receiptPath" } };
  if (!existsSync(receiptPath)) return { diagnostic: { state: "missing", message: "receipt file is missing", receiptPath } };
  let rawText: string;
  try {
    rawText = readFileSync(receiptPath, "utf8");
  } catch (error) {
    return { diagnostic: { state: "unreadable", message: error instanceof Error ? error.message : String(error), receiptPath } };
  }
  try {
    const raw = JSON.parse(rawText) as { receipt?: unknown } | undefined;
    if (!raw || typeof raw !== "object") return { diagnostic: { state: "invalid", message: "receipt file did not contain a JSON object", receiptPath } };
    return { receipt: Object.hasOwn(raw, "receipt") ? raw.receipt : raw };
  } catch (error) {
    return { diagnostic: { state: "invalid", message: error instanceof Error ? error.message : String(error), receiptPath } };
  }
}

function resultWithReceipt<T extends { receiptPath?: string; artifactPaths?: string[]; evidence?: string[]; commandsRun?: string[]; notes?: string }>(result: T): T & { receipt?: unknown; receiptDiagnostic?: ReceiptReadResult["diagnostic"] } {
  const receipt = readReceipt(result);
  return { ...result, receipt: receipt.receipt, receiptDiagnostic: receipt.diagnostic };
}

function resultWithReceiptAndRunRecovery<T extends { receiptPath?: string; artifactPaths?: string[]; evidence?: string[]; commandsRun?: string[]; notes?: string }>(result: T, task: TaskRecord, runStore: RunStore): T & { receipt?: unknown; receiptDiagnostic?: ReceiptReadResult["diagnostic"]; recoveredRunBody?: string; recoveredRunId?: string } {
  const shaped = resultWithReceipt(result);
  if (!shaped.receiptDiagnostic || shaped.receiptDiagnostic.state !== "missing") return shaped;
  const runId = task.owner?.runId ?? task.attempts.at(-1)?.runId;
  if (!runId) return shaped;
  const runResult = runStore.readResult(runId);
  if (typeof runResult?.body !== "string" || !runResult.body.trim()) return shaped;
  return { ...shaped, recoveredRunBody: runResult.body, recoveredRunId: runId };
}

function formatTaskListContent(summary: string, rows: ReturnType<typeof compactTaskRows>): string {
  if (!rows.length) return summary;
  return [summary, ...rows.map((row) => {
    const owner = row.owner ? ` owner=${row.owner.runId}` : "";
    const result = row.resultReady ? ` result_ready=${row.resultSummary ?? "yes"}` : "";
    return `- ${row.taskId} [${row.state}/${row.status}] ${row.title}${owner}${result}`;
  })].join("\n");
}

function formatTaskGetContent(summary: string, details: Record<string, unknown>, view: "status" | "receipt" | "full"): string {
  const lines = [summary, `Status: ${details.state}/${details.status}`];
  const owner = details.owner as { runId?: string; displayName?: string; agent?: string } | undefined;
  if (owner?.runId) lines.push(`Owner: ${owner.runId}${owner.displayName ? ` (${owner.displayName})` : ""}${owner.agent ? ` agent=${owner.agent}` : ""}`);
  const result = details.result as { summary?: string; receiptPath?: string; artifactPaths?: string[]; evidence?: string[]; commandsRun?: string[]; notes?: string; receipt?: unknown; receiptDiagnostic?: { state?: string; message?: string }; recoveredRunBody?: string; recoveredRunId?: string } | undefined;
  if (result) {
    lines.push(`Result: ${result.summary ?? "submitted"}`);
    if (result.receiptPath) lines.push(`Receipt path: ${result.receiptPath}`);
    if (result.artifactPaths?.length) lines.push(`Artifacts: ${result.artifactPaths.join(", ")}`);
    if (view !== "status" && result.evidence?.length) lines.push("Evidence:", ...result.evidence.map((item) => `- ${item}`));
    if (view !== "status" && result.commandsRun?.length) lines.push("Commands run:", ...result.commandsRun.map((item) => `- ${item}`));
    if (view !== "status" && result.notes) lines.push("Notes:", result.notes);
    if (view !== "status" && result.receipt !== undefined) lines.push("Receipt:", JSON.stringify(result.receipt, null, 2));
    if (view !== "status" && result.recoveredRunBody) lines.push(`Recovered run body${result.recoveredRunId ? ` (${result.recoveredRunId})` : ""}:`, result.recoveredRunBody);
    if (result.receiptDiagnostic) lines.push(`Receipt diagnostic: ${result.receiptDiagnostic.state} - ${result.receiptDiagnostic.message}`);
  }
  return lines.join("\n");
}

function taskReceiptForRun(cwd: string, root: RootSessionIdentity, runId: string): Record<string, unknown> | undefined {
  try {
    const task = taskStoreFor(cwd).listTasks(root.rootSessionId).find((item) => item.owner?.runId === runId || item.attempts.some((attempt) => attempt.runId === runId));
    if (!task) return undefined;
    return { taskId: task.id, result: task.result ? resultWithReceipt(task.result) : undefined, receiptDiagnostic: task.result ? undefined : { state: "missing", message: "task has no submitted result receipt" } };
  } catch { return undefined; }
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function skillNamesFromParams(params: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(params.skills)) return undefined;
  const skills = params.skills.filter((skill): skill is string => typeof skill === "string");
  const invalid = skills.find((skill) => !SKILL_NAME_RE.test(skill) || skill.includes("/") || skill.includes("\\") || skill.startsWith("."));
  if (invalid) {
    throw new Error(`Invalid subagent_start skill: ${invalid}. Pass skill names only; path-like skill values are not allowed.`);
  }
  return [...new Set(skills)];
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

function writeSupervisorControl(store: RunStore, runId: string, command: Record<string, unknown>): void {
  const paths = store.pathsFor({ runId });
  appendJsonl(join(paths.runDir, "control.jsonl"), { schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(), ...command });
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

function continuationSequence(store: RunStore, status: RunStatus): { rootRunId: string; sequence: number } {
  const rootRunId = status.continuationRootRunId ?? status.runId;
  const priorSequences = store
    .readRunIndex()
    .filter((record) => record.continuationRootRunId === rootRunId)
    .map((record) => record.continuationSequence ?? 0);
  if (status.continuationRootRunId === rootRunId) priorSequences.push(status.continuationSequence ?? 0);
  return { rootRunId, sequence: Math.max(0, ...priorSequences) + 1 };
}

function continuationLockPath(store: RunStore, rootRunId: string, piSessionPath: string): string {
  const key = `${rootRunId}:${piSessionPath}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(resolve(store.runRoot, ".."), "continuation-locks", `${key}.json`);
}

function writeContinuationLock(path: string, rootRunId: string, piSessionPath: string, runId: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, rootRunId, piSessionPath, requestedByRunId: runId, claimedAt: new Date().toISOString() })}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function continuationLockAgeMs(path: string, nowMs = Date.now()): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { claimedAt?: unknown };
    if (typeof parsed.claimedAt === "string") {
      const claimedAt = Date.parse(parsed.claimedAt);
      if (Number.isFinite(claimedAt)) return nowMs - claimedAt;
    }
  } catch {
    // Fall back to file mtime below. A crash can leave a partial lock file.
  }
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function removeStaleContinuationLock(path: string, nowMs = Date.now()): boolean {
  const ageMs = continuationLockAgeMs(path, nowMs);
  if (ageMs === undefined || ageMs < CONTINUATION_START_LOCK_TTL_MS) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

function claimContinuationLock(store: RunStore, rootRunId: string, piSessionPath: string, runId: string): { claimed: boolean; path: string; recoveredStale?: boolean } {
  const path = continuationLockPath(store, rootRunId, piSessionPath);
  if (writeContinuationLock(path, rootRunId, piSessionPath, runId)) return { claimed: true, path };
  if (!removeStaleContinuationLock(path)) return { claimed: false, path };
  return { claimed: writeContinuationLock(path, rootRunId, piSessionPath, runId), path, recoveredStale: true };
}

function releaseContinuationLock(path: string): void {
  try {
    rmSync(path);
  } catch {
    // The lock is a short critical-section guard. Active continuation status is
    // the durable long-lived guard once a run has been created.
  }
}

function activeContinuationFor(store: RunStore, rootRunId: string, piSessionPath: string): RunStatus | undefined {
  for (const record of store.readRunIndex()) {
    if (record.continuationRootRunId !== rootRunId) continue;
    if (record.continuationOfPiSessionPath !== piSessionPath) continue;
    try {
      const status = store.readStatus(record.runId);
      if (!isTerminalRunState(status.state)) return status;
    } catch {
      // Ignore broken index entries; status diagnostics elsewhere surface them.
    }
  }
  return undefined;
}

async function startTerminalContinuation(input: {
  runtime: ToolRuntime;
  ctx: unknown;
  sessionCwd: string;
  root: RootSessionIdentity;
  store: RunStore;
  status: RunStatus;
  params: Record<string, unknown>;
}): Promise<ToolResponse> {
  const originalResult = input.store.readResult(input.status.runId);
  const originalPiSessionPath = input.status.piSessionPath ?? originalResult?.piSessionPath;
  if (!originalPiSessionPath) {
    return response(
      `Run ${input.status.runId} is terminal and has no recorded Pi session to continue`,
      {
        code: "TERMINAL_CONTINUATION_SESSION_UNAVAILABLE",
        runId: input.status.runId,
        state: input.status.state,
        sessionPolicy: input.status.sessionPolicy,
      },
      true,
    );
  }

  const body = typeof input.params.body === "string" && input.params.body.trim() ? input.params.body.trim() : "Continue from the previous terminal result.";
  const lineage = continuationSequence(input.store, input.status);
  const lock = claimContinuationLock(input.store, lineage.rootRunId, originalPiSessionPath, input.status.runId);
  if (!lock.claimed) {
    const active = activeContinuationFor(input.store, lineage.rootRunId, originalPiSessionPath);
    if (active) {
      return response(
        `Run ${input.status.runId} already has active continuation ${active.runId}`,
        {
          code: "ACTIVE_TERMINAL_CONTINUATION",
          runId: input.status.runId,
          activeRunId: active.runId,
          activeState: active.state,
          continuationRootRunId: lineage.rootRunId,
          continuationOfPiSessionPath: originalPiSessionPath,
        },
        true,
      );
    }
    return response(
      `A terminal continuation is already being started for run ${input.status.runId}`,
      {
        code: "TERMINAL_CONTINUATION_START_IN_PROGRESS",
        runId: input.status.runId,
        continuationRootRunId: lineage.rootRunId,
        continuationOfPiSessionPath: originalPiSessionPath,
      },
      true,
    );
  }
  try {
    const active = activeContinuationFor(input.store, lineage.rootRunId, originalPiSessionPath);
    if (active) {
      return response(
        `Run ${input.status.runId} already has active continuation ${active.runId}`,
        {
          code: "ACTIVE_TERMINAL_CONTINUATION",
          runId: input.status.runId,
          activeRunId: active.runId,
          activeState: active.state,
          continuationRootRunId: lineage.rootRunId,
          continuationOfPiSessionPath: originalPiSessionPath,
        },
        true,
      );
    }

    const launcher = input.runtime.startSubagent ?? startSubagent;
    const result = await launcher({
      agent: input.status.agent.name,
      variant: input.status.variant,
      task: body,
      cwd: input.status.cwd,
      runRoot: input.store.runRoot,
      parentRunId: input.root.parentRunId,
      rootRunId: input.root.parentRunId,
      rootSessionId: input.root.rootSessionId,
      context: "fresh",
      session: "record",
      piSessionPathOverride: originalPiSessionPath,
      continuation: {
        continuedFromRunId: input.status.runId,
        continuationRootRunId: lineage.rootRunId,
        continuationSequence: lineage.sequence,
        continuationOfPiSessionPath: originalPiSessionPath,
      },
      env: {
        ASYNC_SUBAGENTS_ROOT_SESSION_ID: input.root.rootSessionId,
        ASYNC_SUBAGENTS_PARENT_RUN_ID: input.root.parentRunId,
      },
      thinkingLevel: isThinkingLevel(input.params.thinkingLevel) ? input.params.thinkingLevel : input.status.thinkingLevel,
    });
    const notifyOn = Array.isArray(input.params.notifyOn) ? (input.params.notifyOn.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined;
    writeDeliverySubscription(input.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: input.root.parentRunId,
      runId: result.runId,
      notifyOn: notifyOn ?? ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"],
      createdAt: new Date().toISOString(),
    });
    await input.runtime.afterMutation?.(input.ctx, input.sessionCwd, input.root);
    const summary = `Created continuation run ${result.runId} from terminal run ${input.status.runId}`;
    return response(summary, {
      ...result,
      originalRunId: input.status.runId,
      continuedFromRunId: input.status.runId,
      continuationRootRunId: lineage.rootRunId,
      continuationSequence: lineage.sequence,
      continuationOfPiSessionPath: originalPiSessionPath,
      rootSessionId: input.root.rootSessionId,
    });
  } finally {
    releaseContinuationLock(lock.path);
  }
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
      name: "task_create",
      label: "Task Create",
      description: "Create a durable, dependency-ordered plan of one or more tasks. Use when work has multiple steps with real ordering constraints you want tracked and sequenced across child runs (e.g. implement → review → fix). Avoid for a single independent delegation — call subagent_start directly instead. Creation does no work: immediately start every ready task with subagent_start({ taskId }).",
      parameters: taskCreateSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const denied = parentOnly(); if (denied) return denied;
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; const store = taskStoreFor(cwd);
        try {
          const result = store.createTasks(root.rootSessionId, { parentRunId: root.parentRunId, tasks: (params.tasks as any[]) ?? [] });
          await runtime.afterMutation?.(ctx, cwd, root);
          const all = store.listTasks(root.rootSessionId);
          const ready = result.tasks.filter((task) => deriveTaskState(task, all) === "ready");
          const next = ready.length
            ? ready.slice(0, 8).map((task) => ({ tool: "subagent_start", args: { taskId: task.id, agent: "<agent>" } }))
            : [{ tool: "task_list", args: {} }];
          const message = ready.length
            ? `Created ${result.tasks.length} task(s); ${ready.length} ready to start now (${ready.map((task) => task.id).join(", ")}). Start each ready task with subagent_start({ taskId, agent }); blocked tasks start automatically becoming ready as their dependencies are accepted.`
            : `Created ${result.tasks.length} task(s)`;
          return response(message, { rows: compactTaskRows(result.tasks), aliasToId: result.aliasToId, readyTaskIds: ready.map((task) => task.id), counts: { total: all.length, ready: ready.length }, next });
        } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_CREATE_FAILED" }, true); }
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_create"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "task_list",
      label: "Task List",
      description: "List the active task queue with derived readiness (ready / blocked / running / result_ready). Use to see what is startable now or what is blocking progress; completed and cancelled history are hidden unless includeCompleted is set. This is a read — to make progress, start ready tasks with subagent_start({ taskId }) and accept result_ready tasks with task_accept_result.",
      parameters: taskListSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; const store = taskStoreFor(cwd); const all = store.listTasks(root.rootSessionId);
        const states = Array.isArray(params.states) ? new Set(params.states.filter((s): s is string => typeof s === "string")) : undefined;
        const includeCompleted = params.includeCompleted === true; const limit = typeof params.limit === "number" ? params.limit : 50;
        const rows = compactTaskRows(all).filter((row) => (includeCompleted || (row.status !== "completed" && row.status !== "cancelled")) && (!states || states.has(row.status) || states.has(String(row.state)))).slice(0, limit);
        const summary = `${rows.length} task(s)`;
        return response(summary, { rows, counts: { total: all.length, result_ready: all.filter((t) => t.status === "result_ready").length, running: all.filter((t) => t.status === "running").length, ready: all.filter((t) => deriveTaskState(t, all) === "ready").length, blocked: all.filter((t) => deriveTaskState(t, all) === "blocked").length, completed: all.filter((t) => t.status === "completed").length, cancelled: all.filter((t) => t.status === "cancelled").length } }, false, formatTaskListContent(summary, rows));
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_list"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "task_get",
      label: "Task Get",
      description: "Read one task in detail with progressive disclosure: default view is smart and includes the submitted result receipt/diagnostic when a task is result_ready/completed; explicit view=status returns compact status and pointers only; view=receipt adds the submitted result receipt; view=full adds description, attempts, and recent events. Use after a task wakeup when the wakeup summary is not enough to decide whether to accept, reopen, or unblock.",
      parameters: taskGetSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; const taskId = String(params.taskId); const store = taskStoreFor(cwd); const runStore = storeFor(cwd); const all = store.listTasks(root.rootSessionId); const task = store.readTask(root.rootSessionId, taskId); const deps = unresolvedDependencies(task, all);
        const explicitView = typeof params.view === "string";
        const view = params.view === "receipt" || params.view === "full" ? params.view : "status";
        markTaskWakeupHandled(runStore, root.parentRunId, task.id);
        const compactResult = task.result ? { state: task.result.state, summary: task.result.summary, receiptPath: task.result.receiptPath, artifactPaths: task.result.artifactPaths, submittedAt: task.result.submittedAt } : undefined;
        const fullResult = task.result ? resultWithReceiptAndRunRecovery(task.result, task, runStore) : undefined;
        const includeReceiptByDefault = !explicitView && Boolean(task.result) && ["result_ready", "completed"].includes(task.status);
        const base: Record<string, unknown> = { taskId: task.id, title: task.title, status: task.status, state: deriveTaskState(task, all), dependsOn: task.dependsOn, unresolvedDependencies: deps.map((d) => ({ taskId: d.id, title: d.title, status: d.status })), owner: task.owner ? { runId: task.owner.runId, displayName: task.owner.displayName, agent: task.owner.agent } : undefined, result: view === "status" && !includeReceiptByDefault ? compactResult : fullResult, next: task.status === "result_ready" ? [{ tool: "task_get", args: { taskId: task.id, view: "receipt" } }, { tool: "task_accept_result", args: { taskId: task.id } }] : [] };
        if (view === "full") Object.assign(base, { description: task.description, activeForm: task.activeForm, attempts: task.attempts, events: store.readEvents(root.rootSessionId).filter((e) => e.taskId === task.id).slice(-20) });
        const summary = `Task ${task.id}: ${task.title}`;
        const contentView = includeReceiptByDefault && view === "status" ? "receipt" : view;
        return response(summary, base, false, formatTaskGetContent(summary, base, contentView));
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_get"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "task_accept_result",
      label: "Task Accept Result",
      description: "Parent-only: accept a child-submitted result, moving the task to completed and unblocking its dependents (newly-ready dependents then wake you to start them). Use when a result_ready task's result is sufficient. If the result is inadequate, use task_reopen instead. A result_ready task that is never accepted permanently blocks the rest of the plan.",
      parameters: taskAcceptResultSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) { const denied = parentOnly(); if (denied) return denied; const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; try { const task = taskStoreFor(cwd).acceptResult(root.rootSessionId, String(params.taskId), { actor: root.parentRunId, summary: typeof params.summary === "string" ? params.summary : undefined }); markTaskWakeupHandled(storeFor(cwd), root.parentRunId, task.id); await runtime.afterMutation?.(ctx, cwd, root); return response(`Accepted ${task.id}`, { taskId: task.id, status: task.status, result: task.result, next: [{ tool: "task_list", args: {} }] }); } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_ACCEPT_FAILED" }, true); } },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_accept_result"), renderResult: renderSubagentToolResultComponent, renderShell: "self",
    },
    {
      name: "task_reopen", label: "Task Reopen", description: "Parent-only: reject a submitted result or reopen a work item back to pending for another attempt. Use when a result is insufficient or a premise changed. Pass force to also reset dependents built on the now-invalid result; the returned next hints interrupt their owner runs.", parameters: taskReopenSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) { const denied = parentOnly(); if (denied) return denied; const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; try { const tasks = taskStoreFor(cwd); const before = tasks.listTasks(root.rootSessionId); const taskId = String(params.taskId); const affectedIds = new Set<string>(); const queue = [taskId]; while (queue.length) { const current = queue.shift()!; for (const candidate of before) { if (!candidate.dependsOn.includes(current) || affectedIds.has(candidate.id)) continue; affectedIds.add(candidate.id); queue.push(candidate.id); } } const affected = before.filter((candidate) => affectedIds.has(candidate.id) && ["running", "result_ready", "completed"].includes(candidate.status)); const beforeTask = before.find((candidate) => candidate.id === taskId); const task = tasks.reopenTask(root.rootSessionId, taskId, { actor: root.parentRunId, reason: String(params.reason), activeForm: typeof params.activeForm === "string" ? params.activeForm : undefined, force: params.force === true }); markTaskWakeupHandled(storeFor(cwd), root.parentRunId, task.id); for (const dep of affected) markTaskWakeupHandled(storeFor(cwd), root.parentRunId, dep.id); await runtime.afterMutation?.(ctx, cwd, root); const after = tasks.listTasks(root.rootSessionId); const readyAfterReopen = deriveTaskState(task, after) === "ready" ? [{ tool: "subagent_start", args: { taskId: task.id, agent: "<agent>" } }] : []; return response(`Reopened ${task.id}`, { taskId: task.id, status: task.status, affectedDependents: affected.map((dep) => ({ taskId: dep.id, title: dep.title, status: dep.status, owner: dep.owner ? { runId: dep.owner.runId, displayName: dep.owner.displayName, agent: dep.owner.agent } : undefined })), next: [...readyAfterReopen, ...(beforeTask?.status === "running" && beforeTask.owner ? [{ tool: "subagent_interrupt", args: { runId: beforeTask.owner.runId, action: "cancel", reason: `Task ${task.id} reopened: ${String(params.reason)}` } }] : []), ...affected.flatMap((dep) => dep.owner ? [{ tool: "subagent_interrupt", args: { runId: dep.owner.runId, action: "cancel", reason: `Task ${dep.id} invalidated by reopen of ${task.id}` } }] : [])] }); } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_REOPEN_FAILED", next: [{ tool: "task_get", args: { taskId: params.taskId, view: "full" } }] }, true); } },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_reopen"), renderResult: renderSubagentToolResultComponent, renderShell: "self",
    },
    {
      name: "task_cancel", label: "Task Cancel", description: "Parent-only: cancel a single task you no longer need. Use for one task; to abandon the whole plan use task_clear. If the task is running, the returned next hint interrupts its owner run.", parameters: taskCancelSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) { const denied = parentOnly(); if (denied) return denied; const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; try { const task = taskStoreFor(cwd).cancelTask(root.rootSessionId, String(params.taskId), { actor: root.parentRunId, reason: String(params.reason) }); markTaskWakeupHandled(storeFor(cwd), root.parentRunId, task.id); await runtime.afterMutation?.(ctx, cwd, root); return response(`Cancelled ${task.id}`, { taskId: task.id, status: task.status, next: task.owner ? [{ tool: "subagent_interrupt", args: { runId: task.owner.runId, action: "cancel", reason: params.reason } }] : [] }); } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_CANCEL_FAILED" }, true); } },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_cancel"), renderResult: renderSubagentToolResultComponent, renderShell: "self",
    },
    {
      name: "task_clear",
      label: "Task Clear",
      description: "Parent-only: bulk-cancel every non-completed task in this session (abandon the current plan). Use when starting over; for a single task use task_cancel. Completed/cancelled history is preserved and task IDs keep counting.",
      parameters: taskClearSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const denied = parentOnly(); if (denied) return denied;
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd, ctx);
        const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled;
        try {
          const store = taskStoreFor(cwd);
          const runStore = storeFor(cwd);
          const before = store.listTasks(root.rootSessionId);
          const affectedBefore = before.filter((task) => task.status !== "completed" && task.status !== "cancelled");
          const affectedIds = new Set(affectedBefore.map((task) => task.id));
          const ownedRunning = affectedBefore.filter((task) => task.status === "running" && task.owner);
          const reason = String(params.reason);
          const result = store.clearTasks(root.rootSessionId, { actor: root.parentRunId, reason });
          for (const task of affectedBefore) markTaskWakeupHandled(runStore, root.parentRunId, task.id);
          for (const event of store.readEvents(root.rootSessionId)) {
            if (event.parentRunId === root.parentRunId && event.wake === true && affectedIds.has(event.taskId)) markWakeupKeyHandled(runStore, root.parentRunId, taskEventDeliveryKey(event));
          }
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(
            `Cancelled ${result.count} task(s). Cancelled tasks are preserved in session history; new tasks will continue numbering.`,
            {
              ...result,
              next: ownedRunning.map((task) => ({ tool: "subagent_interrupt", args: { runId: task.owner!.runId, action: "cancel", reason } })),
            }
          );
        } catch (error) {
          return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_CLEAR_FAILED" }, true);
        }
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_clear"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "subagent_start",
      label: "Subagent Start",
      description: "Start a durable async Pi child agent and return immediately by default.",
      parameters: subagentStartSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const sessionCwd = ctxCwd(ctx);
        const cwd = cwdFromParams(params, ctx);
        const root = rootFor(runtime, sessionCwd, ctx);
        const contextPolicy = params.context === "fork" ? "fork" : params.context === "fresh" ? "fresh" : undefined;
        const sessionPolicy = params.session === "none" ? "none" : params.session === "record" ? "record" : undefined;
        const notifyOn = Array.isArray(params.notifyOn) ? (params.notifyOn.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined;
        let skills: string[] | undefined;
        try {
          skills = skillNamesFromParams(params);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return response(message, { code: "INVALID_SKILL_NAME" }, true);
        }
        const launcher = runtime.startSubagent ?? startSubagent;
        const taskId = typeof params.taskId === "string" && params.taskId ? params.taskId : undefined;
        const sessionStore = storeFor(sessionCwd);
        let taskAssignment: StartSubagentInput["taskAssignment"] | undefined;
        let taskRunId: string | undefined;
        if (taskId) {
          const denied = parentOnly(); if (denied) return denied;
          const disabled = requireTaskRuntime(runtime, sessionCwd, root); if (disabled) return disabled;
          const tasks = taskStoreFor(sessionCwd);
          const all = tasks.listTasks(root.rootSessionId);
          const task = tasks.readTask(root.rootSessionId, taskId);
          const state = deriveTaskState(task, all);
          if (task.owner || ["running", "result_ready", "completed"].includes(task.status)) {
            const existingRunId = task.owner?.runId ?? task.attempts.at(-1)?.runId;
            return response(`Task ${taskId} is already ${task.status}; no new subagent launched`, { code: "TASK_START_IDEMPOTENT", idempotent: true, started: false, taskId, state, status: task.status, runId: existingRunId, owner: task.owner ? { runId: task.owner.runId, displayName: task.owner.displayName, agent: task.owner.agent } : undefined, result: task.result, rootSessionId: root.rootSessionId });
          }
          if (state !== "ready") return response(`Task ${taskId} is not ready`, { code: "TASK_NOT_READY", taskId, state }, true);
          taskRunId = newRunId();
          const token = newTaskToken();
          const displayName = String(params.agent);
          tasks.claimTask(root.rootSessionId, taskId, { runId: taskRunId, agent: String(params.agent), displayName, assignedAt: new Date().toISOString(), tokenHash: hashTaskToken(token) });
          // Starting the task is the action a `task.ready` nudge was asking for;
          // clear any pending ready wakeup for it so it cannot resurface.
          markTaskWakeupHandled(sessionStore, root.parentRunId, taskId);
          taskAssignment = { task, token, dependencies: all.filter((candidate) => task.dependsOn.includes(candidate.id)) };
        }
        let result;
        try {
          result = await launcher({
          runId: taskRunId,
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
          skills,
          context: contextPolicy as ContextPolicy | undefined,
          session: sessionPolicy as SessionPolicy | undefined,
          allowFreshFallback: params.allowFreshFallback === true,
          parentPiSessionRef: readParentPiSessionRef(ctx),
          env: {
            ASYNC_SUBAGENTS_ROOT_SESSION_ID: root.rootSessionId,
            ASYNC_SUBAGENTS_PARENT_RUN_ID: root.parentRunId,
          },
          thinkingLevel: isThinkingLevel(params.thinkingLevel) ? params.thinkingLevel : undefined,
          fastTrack: params.fastTrack === true,
          taskAssignment,
        });
        } catch (error) {
          if (taskId && taskRunId) {
            try { taskStoreFor(sessionCwd).releaseClaim(root.rootSessionId, taskId, { runId: taskRunId, reason: "subagent launch failed" }); } catch { /* best effort */ }
          }
          throw error;
        }
        if (taskId && taskRunId && result.started === false) {
          try { taskStoreFor(sessionCwd).releaseClaim(root.rootSessionId, taskId, { runId: taskRunId, reason: "subagent launch did not start" }); } catch { /* best effort */ }
        }
        if (taskId && result.displayName) {
          try { taskStoreFor(sessionCwd).updateOwnerDisplayName(root.rootSessionId, taskId, result.displayName); } catch { /* best effort */ }
        }
        writeDeliverySubscription(sessionStore, {
          schemaVersion: SCHEMA_VERSION,
          parentRunId: root.parentRunId,
          runId: result.runId,
          notifyOn: notifyOn ?? (taskId ? ["question", "blocked", "failed", "cancelled", "expired"] : ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"]),
          createdAt: new Date().toISOString(),
        });
        await runtime.afterMutation?.(ctx, sessionCwd, root);
        const isStartFailure = result.started === false || result.state === "failed";
        return response(summarizeStartResult(result), { ...result, taskId, rootSessionId: root.rootSessionId }, isStartFailure);
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_start"),
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
        const root = rootFor(runtime, cwd, ctx);
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
        const root = rootFor(runtime, cwd, ctx);
        const store = storeFor(cwd);
        const status = statusFromParams(store, cwd, params);
        const runId = status.runId;
        const action = params.action === "cancel" ? "cancel" : "pause";
        const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : action === "cancel" ? "Cancelled by parent" : "Paused by parent";
        if (isTerminalRunState(status.state)) return response(`Run ${runId} is already terminal`, { code: "RUN_TERMINAL", runId, state: status.state }, true);

        if (action === "pause") {
          writeSupervisorControl(store, runId, { action: "pause", reason });
          const event = createRunEvent({ sequence: nextEventSequence(store, runId), runId, parentRunId: status.parentRunId, type: "status", summary: `Pause requested: ${reason}`, wake: false, data: { action: "pause", pid: status.pid, controlQueued: true } });
          store.appendEvent(runId, event);
          appendParentMessage(params, store, root, runId, "pause", reason);
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(`Subagent ${runId} pause requested`, { runId, state: status.state, pid: status.pid, event, controlQueued: true });
        }

        const requestedSignal = params.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
        writeSupervisorControl(store, runId, { action: "cancel", reason, signal: requestedSignal });
        const event = createRunEvent({ sequence: nextEventSequence(store, runId), runId, parentRunId: status.parentRunId, type: "status", summary: `Cancel requested: ${reason}`, wake: false, data: { action: "cancel", pid: status.pid, signal: requestedSignal, controlQueued: true } });
        store.appendEvent(runId, event);
        appendParentMessage(params, store, root, runId, "cancel", reason);
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(`Subagent ${runId} cancel requested`, { runId, state: status.state, pid: status.pid, signal: requestedSignal, event, controlQueued: true });
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
        const root = rootFor(runtime, cwd, ctx);
        const store = storeFor(cwd);
        const status = statusFromParams(store, cwd, params);
        const runId = status.runId;
        if (isTerminalRunState(status.state)) {
          return startTerminalContinuation({ runtime, ctx, sessionCwd: cwd, root, store, status, params });
        }
        if (status.state !== "paused") {
          return response(`Run ${runId} is ${status.state}; use subagent_message for normal input`, { code: "RUN_NOT_PAUSED", runId, state: status.state }, true);
        }

        const additionalRunSeconds = typeof params.additionalRunSeconds === "number" ? params.additionalRunSeconds : undefined;
        writeSupervisorControl(store, runId, { action: "resume", reason: "Continued by parent", additionalRunSeconds });
        const thinkingLevel = isThinkingLevel(params.thinkingLevel) ? params.thinkingLevel : undefined;
        const selectedThinkingLevel = thinkingLevel ?? status.thinkingLevel;
        const event = createRunEvent({ sequence: nextEventSequence(store, runId), runId, parentRunId: status.parentRunId, type: "status", summary: "Continue requested", wake: false, data: { action: "continue", pid: status.pid, controlQueued: true, thinkingLevel, additionalRunSeconds } });
        store.appendEvent(runId, event);
        const body = typeof params.body === "string" && params.body.trim() ? params.body : "Resume work.";
        const type = (typeof params.type === "string" ? params.type : "instruction") as ParentMessageType;
        const messageType: InboxMessageType = !params.body ? "resume" : type;
        const result = await waitForLiveAckIfNeeded(store, params, status, appendParentMessage(params, store, root, runId, messageType, body));
        if (requiredAckFailed(params, result)) {
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(result.unsupported?.message ?? "Required child acknowledgement was not received", { ...result, runId, state: status.state, controlQueued: true, event, thinkingLevel: selectedThinkingLevel }, true);
        }
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(`Subagent ${runId} continue requested`, { ...result, runId, state: status.state, controlQueued: true, event, thinkingLevel: selectedThinkingLevel });
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "subagent_continue"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "subagent_result",
      label: "Subagent Result",
      description: "Canonical backup/recovery read for a terminal child result from result.json; use for truncated wakeups, artifacts, metadata, or reread.",
      parameters: subagentResultSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd, ctx);
        const store = storeFor(cwd);
        const { runId, runDir, result } = resultFromParams(store, cwd, params);
        if (!result) return response(summarizeRunResult(undefined, runId), { code: "RESULT_NOT_READY", runId }, true);
        markResultCollected(store, result.parentRunId ?? root.parentRunId, runId);
        const includeBody = params.includeBody !== false;
        const includeArtifacts = params.includeArtifacts !== false;
        const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : 64_000;
        const body = shapeResultBody(result.body, maxBytes, includeBody);
        const taskReceipt = taskReceiptForRun(cwd, root, runId);
        const details = {
          ...result,
          body: body.body,
          bodyTruncation: body.bodyTruncation,
          artifacts: includeArtifacts ? result.artifacts : undefined,
          taskReceipt,
          runDir,
          piSessionPath: result.piSessionPath,
          requestedPiSessionPath: result.requestedPiSessionPath,
          launchLogPath: join(runDir, "logs", "launch.json"),
          logsDir: join(runDir, "logs"),
          artifactsDir: join(runDir, "artifacts"),
          next: taskReceipt?.taskId ? [{ tool: "task_get", args: { taskId: taskReceipt.taskId, view: "receipt" } }] : [],
        };
        const summary = summarizeRunResult(result, runId);
        let content = resultBodyContent(summary, result, body);
        if (taskReceipt) {
          if (taskReceipt.result) content += `\n\nTask receipt (${taskReceipt.taskId}):\n${JSON.stringify(taskReceipt.result, null, 2)}`;
          else if (taskReceipt.receiptDiagnostic && typeof taskReceipt.receiptDiagnostic === "object") {
            const diagnostic = taskReceipt.receiptDiagnostic as { state?: string; message?: string };
            content += `\n\nTask receipt (${taskReceipt.taskId}):\nReceipt diagnostic: ${diagnostic.state ?? "missing"} - ${diagnostic.message ?? "task has no submitted result receipt"}`;
          }
        }
        await runtime.afterMutation?.(ctx, cwd, root);
        return response(summary, details as Record<string, unknown>, false, content);
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
        const root = rootFor(runtime, cwd, ctx);
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
      description: "One-shot inspection of direct children or selected run ids. Not a polling/waiting tool; if runs are merely active, go idle and wait for async wakeups.",
      parameters: subagentStatusSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd, ctx);
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
