import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunEvent } from "../../src/events.js";
import { appendJsonl, readJsonl } from "../../src/jsonl.js";
import { createInboxMessage, sendSubagentMessage, waitForMessageAck } from "../../src/message.js";
import { NAME_PACKS, readNamePackSelection, writeNamePackSelection, type NamePackId } from "../../src/namePacks.js";
import { readSubagentResult } from "../../src/result.js";
import { createRootSession, readRootSession } from "../../src/rootSession.js";
import { RunStore } from "../../src/runStore.js";
import { TaskStore, type TaskUpdateInput } from "../../src/taskStore.js";
import { readTaskRuntimeState } from "../../src/taskRuntime.js";
import { deriveTaskReadiness, unresolvedDependencies } from "../../src/taskState.js";
import { bucketForState, isTerminalRunState, isThinkingLevel } from "../../src/schemas.js";
import { normalizeAllowedFilePaths, startSubagent, type StartSubagentInput } from "../../src/start.js";
import { reconcileUnderLock } from "../../src/lifecycle.js";
import { withRunMutationLock } from "../../src/runLock.js";
import { readSubagentStatus, updateRunStatus } from "../../src/status.js";
import { SCHEMA_VERSION, type ContextPolicy, type EventType, type InboxMessageType, type ParentMessageType, type RootSessionIdentity, type RunResult, type RunStatus, type SessionPolicy, type SubagentMessageResult } from "../../src/types.js";
import { readParentPiSessionRef } from "../../src/piSession.js";
import { markWakeupHandled, writeDeliverySubscription } from "./wakeups.js";
import {
  subagentContinueSchema,
  subagentInterruptSchema,
  subagentMessageSchema,
  subagentNamePackSchema,
  subagentResultSchema,
  subagentStartSchema,
  subagentStatusSchema,
  taskCancelSchema,
  taskCreateSchema,
  taskGetSchema,
  taskListSchema,
  taskUpdateSchema,
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
  /** Set only by registerSubagentTools inside a live Pi extension runtime. */
  pushAvailable?: boolean;
}

export const TASK_TOOL_NAMES = ["task_create", "task_list", "task_get", "task_update", "task_cancel", "task_clear"] as const;
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
    readiness: deriveTaskReadiness(task, tasks),
    blockedBy: task.dependsOn.filter((depId) => tasks.find((dep) => dep.id === depId)?.status !== "done"),
    dependsOn: task.dependsOn,
    notes: task.notes,
    activeForm: task.activeForm,
    lastAttemptRunIds: task.lastAttemptRunIds,
    receiptPaths: task.receiptPaths,
    artifactPaths: task.artifactPaths,
    evidence: task.evidence,
    updatedAt: task.updatedAt,
  }));
}

function formatTaskListContent(summary: string, rows: ReturnType<typeof compactTaskRows>): string {
  if (!rows.length) return summary;
  return [summary, ...rows.map((row) => `- ${row.taskId} [${row.readiness ?? row.status}] ${row.title}`)].join("\n");
}

function formatTaskGetContent(summary: string, details: Record<string, unknown>, view: "status" | "full"): string {
  const lines = [summary, `Status: ${details.status}`, `Readiness: ${details.readiness ?? "n/a"}`];
  const receiptPaths = details.receiptPaths as string[] | undefined;
  const artifactPaths = details.artifactPaths as string[] | undefined;
  const evidence = details.evidence as string[] | undefined;
  const notes = details.notes as string | undefined;
  if (notes) lines.push("Notes:", notes);
  if (receiptPaths?.length) lines.push("Receipts:", ...receiptPaths.map((item) => `- ${item}`));
  if (artifactPaths?.length) lines.push("Artifacts:", ...artifactPaths.map((item) => `- ${item}`));
  if (view === "full" && evidence?.length) lines.push("Evidence:", ...evidence.map((item) => `- ${item}`));
  return lines.join("\n");
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
      const event = readJsonl<any>(join(params.runDir, "events.jsonl")).records.find((candidate) => candidate.type === "message.handled" && candidate.data?.messageId === messageId);
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

function deliveryFor(runtime: ToolRuntime): { mode: "pi-poll" | "none"; pushAvailable: boolean } {
  const pushAvailable = runtime.pushAvailable === true;
  return { mode: pushAvailable ? "pi-poll" : "none", pushAvailable };
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

function filesFromParams(params: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(params.files)) return undefined;
  return normalizeAllowedFilePaths(params.files as string[]);
}

function widenedAllowedFiles(status: RunStatus, additionalFiles: string[] | undefined): string[] | undefined {
  if (status.allowedFiles === undefined) return undefined;
  return [...new Set([...status.allowedFiles, ...(additionalFiles ?? [])])];
}

function writeScopeAmendment(allowedFiles: string[]): string {
  return [
    "# Authoritative Write-Scope Amendment",
    "",
    "The write scope for this run is now the following additive union of exact paths, directory roots, and globs. Write only within it; protected paths remain protected:",
    ...allowedFiles.map((file) => `- ${file}`),
    "",
    "This is contract and prompt enforcement, not OS sandboxing.",
  ].join("\n");
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
  let additionalFiles: string[] | undefined;
  try {
    additionalFiles = filesFromParams(input.params);
  } catch (error) {
    return response(error instanceof Error ? error.message : String(error), { code: "INVALID_ALLOWED_FILE", runId: input.status.runId }, true);
  }
  const allowedFiles = widenedAllowedFiles(input.status, additionalFiles);
  if (additionalFiles?.length && allowedFiles === undefined) {
    return response(
      `Run ${input.status.runId} has no specified file scope; continue without files or start a new scoped run`,
      { code: "SCOPE_UNSPECIFIED", runId: input.status.runId },
      true,
    );
  }
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

  const parentBody = typeof input.params.body === "string" && input.params.body.trim() ? input.params.body.trim() : "Continue from the previous terminal result.";
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
      task: parentBody,
      cwd: input.status.cwd,
      files: allowedFiles,
      protect: input.status.protectedPaths,
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
      inheritedFastTrack: input.status.fastTrack?.applied === true,
    });
    const notifyOn = Array.isArray(input.params.notifyOn) ? (input.params.notifyOn.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined;
    writeDeliverySubscription(input.store, {
      schemaVersion: SCHEMA_VERSION,
      parentRunId: input.root.parentRunId,
      runId: result.runId,
      notifyOn: notifyOn ?? ["question", "blocked", "liveness", "result", "completed", "failed", "cancelled", "expired"],
      createdAt: new Date().toISOString(),
    });
    await input.runtime.afterMutation?.(input.ctx, input.sessionCwd, input.root);
    const delivery = deliveryFor(input.runtime);
    const summary = delivery.pushAvailable
      ? `Created continuation run ${result.runId} from terminal run ${input.status.runId}; async wakeups will report attention or results`
      : `Created continuation run ${result.runId} from terminal run ${input.status.runId}; use async-subagents watch --cwd ${JSON.stringify(input.sessionCwd)} --run-id ${result.runId}`;
    return response(summary, {
      ...result,
      delivery,
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

function taskUpdateInputFromParams(params: Record<string, unknown>, actor: string): TaskUpdateInput {
  const input: TaskUpdateInput = { actor };
  if (typeof params.status === "string") input.status = params.status as TaskUpdateInput["status"];
  if (typeof params.title === "string") input.title = params.title;
  if (typeof params.description === "string") input.description = params.description;
  if (Array.isArray(params.dependsOn)) input.dependsOn = params.dependsOn.filter((item): item is string => typeof item === "string");
  if (typeof params.notes === "string") input.notes = params.notes;
  if (typeof params.appendNotes === "string") input.appendNotes = params.appendNotes;
  if (Object.hasOwn(params, "activeForm")) input.activeForm = typeof params.activeForm === "string" ? params.activeForm : null;
  if (Array.isArray(params.addAttemptRunIds)) input.addAttemptRunIds = params.addAttemptRunIds.filter((item): item is string => typeof item === "string");
  if (Array.isArray(params.addReceiptPaths)) input.addReceiptPaths = params.addReceiptPaths.filter((item): item is string => typeof item === "string");
  if (Array.isArray(params.addArtifactPaths)) input.addArtifactPaths = params.addArtifactPaths.filter((item): item is string => typeof item === "string");
  if (Array.isArray(params.addEvidence)) input.addEvidence = params.addEvidence.filter((item): item is string => typeof item === "string");
  if (params.force === true) input.force = true;
  return input;
}

export function buildSubagentTools(runtime: ToolRuntime = {}) {
  return [
    {
      name: "task_create",
      label: "Task Create",
      description: "Create parent-owned milestone board entries with optional dependencies. Tasks are durable scheduling memory only; start subagents directly and update milestones later with task_update. Returns newly_ready synchronously.",
      parameters: taskCreateSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const denied = parentOnly(); if (denied) return denied;
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; const store = taskStoreFor(cwd);
        try {
          const result = store.createTasks(root.rootSessionId, { parentRunId: root.parentRunId, tasks: (params.tasks as any[]) ?? [] });
          await runtime.afterMutation?.(ctx, cwd, root);
          const message = `Created ${result.tasks.length} task(s); ${result.newly_ready.length} newly ready`;
          return response(message, { tasks: result.tasks, rows: compactTaskRows(result.tasks), aliasToId: result.aliasToId, newly_ready: result.newly_ready, counts: { total: store.listTasks(root.rootSessionId).length, ready: result.newly_ready.length } });
        } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_CREATE_FAILED" }, true); }
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_create"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "task_list",
      label: "Task List",
      description: "List parent-owned milestone tasks with stored status and derived readiness (ready / waiting / null). Reads do not reconcile or claim child runs.",
      parameters: taskListSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; const store = taskStoreFor(cwd); const all = store.listTasks(root.rootSessionId);
        const states = Array.isArray(params.states) ? new Set(params.states.filter((s): s is string => typeof s === "string")) : undefined;
        const includeCompleted = params.includeCompleted === true; const limit = typeof params.limit === "number" ? params.limit : 50;
        const rows = compactTaskRows(all).filter((row) => (includeCompleted || (row.status !== "done" && row.status !== "cancelled")) && (!states || states.has(row.status) || states.has(String(row.readiness)))).slice(0, limit);
        const summary = `${rows.length} task(s)`;
        return response(summary, { rows, counts: { total: all.length, ready: rows.filter((t) => t.readiness === "ready").length, waiting: rows.filter((t) => t.readiness === "waiting").length, open: all.filter((t) => t.status === "open").length, active: all.filter((t) => t.status === "active").length, blocked: all.filter((t) => t.status === "blocked").length, done: all.filter((t) => t.status === "done").length, failed: all.filter((t) => t.status === "failed").length, cancelled: all.filter((t) => t.status === "cancelled").length } }, false, formatTaskListContent(summary, rows));
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_list"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "task_get",
      label: "Task Get",
      description: "Read one parent-owned milestone task with stored status, derived readiness, dependencies, notes, evidence, and recent task audit events.",
      parameters: taskGetSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; const taskId = String(params.taskId); const store = taskStoreFor(cwd); const all = store.listTasks(root.rootSessionId); const task = store.readTask(root.rootSessionId, taskId); const deps = unresolvedDependencies(task, all);
        const base: Record<string, unknown> = { taskId: task.id, title: task.title, description: task.description, status: task.status, readiness: deriveTaskReadiness(task, all), dependsOn: task.dependsOn, blockedBy: deps.map((d) => d.id), unresolvedDependencies: deps.map((d) => ({ taskId: d.id, title: d.title, status: d.status })), notes: task.notes, activeForm: task.activeForm, lastAttemptRunIds: task.lastAttemptRunIds, receiptPaths: task.receiptPaths, artifactPaths: task.artifactPaths, evidence: task.evidence };
        if (params.view === "full") Object.assign(base, { events: store.readEvents(root.rootSessionId).filter((e) => e.taskId === task.id).slice(-20) });
        const summary = `Task ${task.id}: ${task.title}`;
        return response(summary, base, false, formatTaskGetContent(summary, base, "status"));
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_get"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "task_update",
      label: "Task Update",
      description: "Parent-only: canonical milestone mutation for status, notes, dependencies, attempt references, receipts, artifacts, and evidence. Returns newly_ready synchronously and never returns next.",
      parameters: taskUpdateSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const denied = parentOnly(); if (denied) return denied;
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled;
        try {
          const result = taskStoreFor(cwd).updateTask(root.rootSessionId, String(params.taskId), taskUpdateInputFromParams(params, root.parentRunId));
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(`Updated ${result.task.id}`, result as unknown as Record<string, unknown>);
        } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_UPDATE_FAILED", details: (error as any).details }, true); }
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_update"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "task_cancel", label: "Task Cancel", description: "Parent-only: cancel a single milestone task. Equivalent to task_update({ status: 'cancelled' }) with a reason note.", parameters: taskCancelSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) { const denied = parentOnly(); if (denied) return denied; const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled; try { const task = taskStoreFor(cwd).cancelTask(root.rootSessionId, String(params.taskId), { actor: root.parentRunId, reason: String(params.reason) }); await runtime.afterMutation?.(ctx, cwd, root); return response(`Cancelled ${task.id}`, { taskId: task.id, status: task.status }); } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_CANCEL_FAILED" }, true); } },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_cancel"), renderResult: renderSubagentToolResultComponent, renderShell: "self",
    },
    {
      name: "task_clear",
      label: "Task Clear",
      description: "Parent-only: bulk-cancel every non-done task in this session. Completed/cancelled history is preserved and task IDs keep counting.",
      parameters: taskClearSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const denied = parentOnly(); if (denied) return denied;
        const cwd = ctxCwd(ctx); const root = rootFor(runtime, cwd, ctx); const disabled = requireTaskRuntime(runtime, cwd, root); if (disabled) return disabled;
        try { const result = taskStoreFor(cwd).clearTasks(root.rootSessionId, { actor: root.parentRunId, reason: String(params.reason) }); await runtime.afterMutation?.(ctx, cwd, root); return response(`Cancelled ${result.count} task(s).`, result); } catch (error) { return response(error instanceof Error ? error.message : String(error), { code: (error as any).code ?? "TASK_CLEAR_FAILED" }, true); }
      },
      renderCall: (args: Record<string, unknown>, theme: unknown) => renderSubagentToolCallComponent(args, theme as Parameters<typeof renderSubagentToolCallComponent>[1], "task_clear"),
      renderResult: renderSubagentToolResultComponent,
      renderShell: "self",
    },
    {
      name: "subagent_start",
      label: "Subagent Start",
      description: "Start a durable async Pi child agent and return immediately; files sets an exhaustive prompt-enforced write scope, not an OS sandbox.",
      parameters: subagentStartSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const sessionCwd = ctxCwd(ctx);
        const cwd = cwdFromParams(params, ctx);
        const root = rootFor(runtime, sessionCwd, ctx);
        const contextPolicy = params.context === "fork" ? "fork" : params.context === "fresh" ? "fresh" : undefined;
        const sessionPolicy = params.session === "none" ? "none" : params.session === "record" ? "record" : undefined;
        const notifyOn = Array.isArray(params.notifyOn) ? (params.notifyOn.filter((event): event is EventType => typeof event === "string") as EventType[]) : undefined;
        let skills: string[] | undefined;
        let files: string[] | undefined;
        let protect: string[] | undefined;
        try {
          skills = skillNamesFromParams(params);
          files = filesFromParams(params);
          protect = normalizeAllowedFilePaths(Array.isArray(params.protect) ? (params.protect as string[]) : undefined);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = (error as { code?: string }).code === "INVALID_ALLOWED_FILE" ? "INVALID_ALLOWED_FILE" : "INVALID_SKILL_NAME";
          return response(message, { code }, true);
        }
        const launcher = runtime.startSubagent ?? startSubagent;
        const taskId = typeof params.taskId === "string" && params.taskId ? params.taskId : undefined;
        const sessionStore = storeFor(sessionCwd);
        let taskAssignment: StartSubagentInput["taskAssignment"] | undefined;
        if (taskId) {
          const disabled = requireTaskRuntime(runtime, sessionCwd, root); if (disabled) return disabled;
          const tasks = taskStoreFor(sessionCwd);
          const all = tasks.listTasks(root.rootSessionId);
          const task = tasks.readTask(root.rootSessionId, taskId);
          taskAssignment = { task, dependencies: all.filter((candidate) => task.dependsOn.includes(candidate.id)) };
        }
        let result;
        try {
          result = await launcher({
          agent: String(params.agent),
          variant: typeof params.variant === "string" && params.variant ? params.variant : undefined,
          task: String(params.task),
          cwd,
          runRoot: storeFor(sessionCwd).runRoot,
          parentRunId: root.parentRunId,
          rootRunId: root.parentRunId,
          rootSessionId: root.rootSessionId,
          depth: typeof params.maxSubagentDepth === "number" ? params.maxSubagentDepth : undefined,
          files,
          protect,
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
          throw error;
        }
        writeDeliverySubscription(sessionStore, {
          schemaVersion: SCHEMA_VERSION,
          parentRunId: root.parentRunId,
          runId: result.runId,
          notifyOn: notifyOn ?? ["question", "blocked", "liveness", "result", "completed", "failed", "cancelled", "expired"],
          createdAt: new Date().toISOString(),
        });
        await runtime.afterMutation?.(ctx, sessionCwd, root);
        const isStartFailure = result.started === false || result.state === "failed";
        const delivery = deliveryFor(runtime);
        return response(summarizeStartResult(result, delivery), { ...result, delivery, taskId, rootSessionId: root.rootSessionId }, isStartFailure);
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
        let additionalFiles: string[] | undefined;
        try {
          additionalFiles = filesFromParams(params);
        } catch (error) {
          return response(error instanceof Error ? error.message : String(error), { code: "INVALID_ALLOWED_FILE", runId }, true);
        }
        const runDir = store.pathsFor({ runId }).runDir;
        const mutation = await withRunMutationLock(runDir, () => {
          const current = store.readStatus(runId);
          if (isTerminalRunState(current.state)) return { status: current, terminal: true as const };
          const allowedFiles = widenedAllowedFiles(current, additionalFiles);
          if (additionalFiles?.length && allowedFiles === undefined) return { status: current, scopeUnspecified: true as const };
          if (additionalFiles?.length && allowedFiles) store.writeStatus(updateRunStatus(current, { allowedFiles }));
          const body = additionalFiles?.length && allowedFiles
            ? `${String(params.body)}\n\n${writeScopeAmendment(allowedFiles)}`
            : String(params.body);
          return { status: current, messageResult: appendParentMessage(params, store, root, runId, type, body) };
        });
        if (mutation.value.terminal) {
          return response(`Run ${runId} is terminal; message not appended`, { code: "RUN_TERMINAL", runId, state: mutation.value.status.state }, true);
        }
        if (mutation.value.scopeUnspecified) {
          return response(`Run ${runId} has no specified file scope; message without files or start a new scoped run`, { code: "SCOPE_UNSPECIFIED", runId }, true);
        }
        const messageResult = mutation.value.messageResult;
        if (!messageResult) throw new Error(`Message for ${runId} did not append an inbox message`);
        const result = await waitForLiveAckIfNeeded(store, params, mutation.value.status, messageResult);
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
      description: "Resume a paused child or continue a terminal run; files adds prompt-enforced write approvals without narrowing prior scope and is not an OS sandbox.",
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
        let additionalFiles: string[] | undefined;
        try {
          additionalFiles = filesFromParams(params);
        } catch (error) {
          return response(error instanceof Error ? error.message : String(error), { code: "INVALID_ALLOWED_FILE", runId }, true);
        }
        const parentBody = typeof params.body === "string" && params.body.trim() ? params.body : "Resume work.";
        const type = (typeof params.type === "string" ? params.type : "instruction") as ParentMessageType;
        const messageType: InboxMessageType = additionalFiles?.length ? type : !params.body ? "resume" : type;
        const runDir = store.pathsFor({ runId }).runDir;
        const mutation = await withRunMutationLock(runDir, () => {
          const current = store.readStatus(runId);
          if (current.state !== "paused") return { status: current };
          const allowedFiles = widenedAllowedFiles(current, additionalFiles);
          if (additionalFiles?.length && allowedFiles === undefined) return { status: current, scopeUnspecified: true };
          if (additionalFiles?.length && allowedFiles) store.writeStatus(updateRunStatus(current, { allowedFiles }));
          const body = additionalFiles?.length && allowedFiles
            ? `${parentBody}\n\n${writeScopeAmendment(allowedFiles)}`
            : parentBody;
          const messageResult = appendParentMessage(params, store, root, runId, messageType, body);
          return { status: current, allowedFiles, messageResult };
        });
        const currentStatus = mutation.value.status;
        if (currentStatus.state !== "paused") {
          return response(`Run ${runId} is ${currentStatus.state}; use subagent_message for normal input`, { code: "RUN_NOT_PAUSED", runId, state: currentStatus.state }, true);
        }
        if (mutation.value.scopeUnspecified) {
          return response(`Run ${runId} has no specified file scope; continue without files or start a new scoped run`, { code: "SCOPE_UNSPECIFIED", runId }, true);
        }
        const messageResult = mutation.value.messageResult;
        if (!messageResult) throw new Error(`Paused continuation for ${runId} did not append an inbox message`);
        const additionalRunSeconds = typeof params.additionalRunSeconds === "number" ? params.additionalRunSeconds : undefined;
        writeSupervisorControl(store, runId, { action: "resume", reason: "Continued by parent", additionalRunSeconds });
        const thinkingLevel = isThinkingLevel(params.thinkingLevel) ? params.thinkingLevel : undefined;
        const selectedThinkingLevel = thinkingLevel ?? currentStatus.thinkingLevel;
        const event = createRunEvent({ sequence: nextEventSequence(store, runId), runId, parentRunId: currentStatus.parentRunId, type: "status", summary: "Continue requested", wake: false, data: { action: "continue", pid: currentStatus.pid, controlQueued: true, thinkingLevel, additionalRunSeconds } });
        store.appendEvent(runId, event);
        const result = await waitForLiveAckIfNeeded(store, params, currentStatus, messageResult);
        if (requiredAckFailed(params, result)) {
          await runtime.afterMutation?.(ctx, cwd, root);
          return response(result.unsupported?.message ?? "Required child acknowledgement was not received", { ...result, runId, state: currentStatus.state, controlQueued: true, event, thinkingLevel: selectedThinkingLevel }, true);
        }
        await runtime.afterMutation?.(ctx, cwd, root);
        const delivery = deliveryFor(runtime);
        const summary = delivery.pushAvailable
          ? `Subagent ${runId} continue requested; async wakeups will report attention or results`
          : `Subagent ${runId} continue requested; use async-subagents watch --cwd ${JSON.stringify(cwd)} --run-id ${runId}`;
        return response(summary, { ...result, delivery, runId, state: currentStatus.state, controlQueued: true, event, thinkingLevel: selectedThinkingLevel });
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
        };
        const summary = summarizeRunResult(result, runId);
        const content = resultBodyContent(summary, result, body);
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
      description: "One-shot inspection of direct children or selected run ids. Returns terminal, attention, and busy buckets; CLI callers should use async-subagents watch for polling.",
      parameters: subagentStatusSchema,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
        const cwd = ctxCwd(ctx);
        const root = rootFor(runtime, cwd, ctx);
        const store = storeFor(cwd);
        const parentRunId = typeof params.parentRunId === "string" ? params.parentRunId : root.parentRunId;
        const runIds = defaultRunIds(store, parentRunId, params);
        const maxEvents = typeof params.maxEvents === "number" ? params.maxEvents : 10;
        const rows = (await Promise.all(runIds.map(async (runId) => {
          try {
            const reconciliation = await reconcileUnderLock(store, runId);
            const status = reconciliation.status;
            const diagnostics = statusDiagnostics(store, status);
            if (reconciliation.repairedResult) diagnostics.push("result exists but status is non-terminal");
            return [{
              runId: status.runId,
              state: status.state,
              bucket: bucketForState(status.state),
              displayName: status.displayName,
              namePack: status.namePack,
              agentName: status.agent.name,
              summary: `${bucketForState(status.state)}: ${preview(status.summary, 120) || status.state}`,
              cwd: status.cwd,
              parentRunId: status.parentRunId,
              rootSessionId: status.rootSessionId,
              pid: status.pid,
              processHealth: status.processHealth,
              supervisorAlive: reconciliation.supervisorAlive,
              harness: status.harness,
              launchHarness: status.launchHarness,
              resultParser: status.resultParser,
              variant: status.variant,
              model: status.model,
              requestedModel: status.requestedModel,
              resolvedModel: status.resolvedModel,
              thinkingLevel: status.thinkingLevel,
              effort: status.effort,
              executionMode: status.executionMode,
              claudeAuthHome: status.claudeAuthHome,
              claudeMemoryIsolation: status.claudeMemoryIsolation,
              claudeHomeDir: status.claudeHomeDir,
              claudeSettingsPath: status.claudeSettingsPath,
              claudeMcpConfigPath: status.claudeMcpConfigPath,
              claudeShellHomeDir: status.claudeShellHomeDir,
              claudeShellWrapperPath: status.claudeShellWrapperPath,
              claudeTransport: status.claudeTransport,
              claudeInstalledSkills: status.claudeInstalledSkills,
              livenessState: status.livenessState,
              lastTerminalOutputAt: status.lastTerminalOutputAt,
              terminalOutputBytes: status.terminalOutputBytes,
              lastMcpCallAt: status.lastMcpCallAt,
              lastNudgeAt: status.lastNudgeAt,
              pendingAckMessageIds: status.pendingAckMessageIds,
              livenessReason: status.livenessReason,
              supervisorPid: status.supervisorPid,
              childPid: status.childPid,
              panePid: status.panePid,
              processGroupId: status.processGroupId,
              tmuxSocket: status.tmuxSocket,
              tmuxSession: status.tmuxSession,
              tmuxPane: status.tmuxPane,
              transcriptPath: status.transcriptPath,
              resolvedSkills: status.resolvedSkills,
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
        }))).flat();
        const details: Record<string, unknown> = {
          scope: "explicit",
          requestedRunIds: runIds,
          parentRunId,
          rootSessionId: root.rootSessionId,
          rows,
          counts: {
            total: rows.length,
            busy: rows.filter((row) => row.bucket === "busy").length,
            attention: rows.filter((row) => row.bucket === "attention").length,
            terminal: rows.filter((row) => row.bucket === "terminal").length,
            active: rows.filter((row) => row.bucket !== "terminal").length,
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
  for (const tool of buildSubagentTools({ ...runtime, pushAvailable: true })) pi.registerTool(tool as never);
}

export const tools = buildSubagentTools();
