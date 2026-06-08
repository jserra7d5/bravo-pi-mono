import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "../../src/jsonl.js";
import { ownsRootSessionLease } from "../../src/leases.js";
import { isInterestingEvent } from "../../src/schemas.js";
import { RunStore } from "../../src/runStore.js";
import { updateRunStatus } from "../../src/status.js";
import { TaskStore } from "../../src/taskStore.js";
import { isReadyWakeupStillActionable } from "../../src/taskState.js";
import type { DeliverySubscription, EventType, RunEvent, RunIndexRecord, RunResult, TaskEvent, WaitCursor } from "../../src/types.js";
import { SCHEMA_VERSION } from "../../src/types.js";
import type { WakeupMessage } from "./renderers.js";

export interface DeliveryState {
  schemaVersion: typeof SCHEMA_VERSION;
  parentRunId: string;
  delivered: Record<string, string>;
  handled: Record<string, string>;
  taskEventCursors?: Record<string, WaitCursor>;
}

export interface WakeupPollInput {
  store: RunStore;
  parentRunId: string;
  rootSessionId: string;
  ownerId: string;
  nowMs?: number;
  limit?: number;
  modelFollowUpOnly?: boolean;
  records?: RunIndexRecord[];
}

export interface WakeupDelivery {
  deliveryKey: string;
  runId: string;
  message: WakeupMessage;
}

function deliveryPath(store: RunStore, parentRunId: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", `${parentRunId}.json`);
}

function subscriptionsPath(store: RunStore, parentRunId: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", `${parentRunId}.subscriptions.json`);
}

function claimPath(store: RunStore, deliveryKey: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", "claims", `${deliveryKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

interface DeliveryFileState { path: string; exists: boolean; size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }
interface MemoryDeliveryStateCacheEntry { state: DeliveryFileState; deliveryState: DeliveryState }
interface MemoryDeliverySubscriptionsCacheEntry { state: DeliveryFileState; subscriptions: DeliverySubscription[] }

const memoryDeliveryStateCaches = new Map<string, MemoryDeliveryStateCacheEntry>();
const memoryDeliverySubscriptionsCaches = new Map<string, MemoryDeliverySubscriptionsCacheEntry>();
let deliveryStateParseCountForTest = 0;
let subscriptionParseCountForTest = 0;

function statDeliveryFile(path: string): DeliveryFileState {
  const key = resolve(path);
  if (!existsSync(key)) return { path: key, exists: false, size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0 };
  const stat = statSync(key);
  return { path: key, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

function deliveryFileStateUnchanged(previous: DeliveryFileState, current: DeliveryFileState): boolean {
  return previous.path === current.path && previous.exists === current.exists && previous.size === current.size && previous.mtimeMs === current.mtimeMs && previous.ctimeMs === current.ctimeMs && previous.dev === current.dev && previous.ino === current.ino;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneJsonValue(item)])) as T;
  return value;
}

function cloneDeliveryState(state: DeliveryState): DeliveryState { return cloneJsonValue(state); }
function cloneDeliverySubscriptions(subscriptions: DeliverySubscription[]): DeliverySubscription[] { return cloneJsonValue(subscriptions); }
function defaultDeliveryState(parentRunId: string): DeliveryState { return { schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: {}, taskEventCursors: {} }; }
function invalidateDeliveryStateCache(path: string): void { memoryDeliveryStateCaches.delete(resolve(path)); }
function invalidateDeliverySubscriptionsCache(path: string): void { memoryDeliverySubscriptionsCaches.delete(resolve(path)); }

export function deliveryCacheStatsForTest(): { deliveryStateParses: number; subscriptionParses: number } {
  return { deliveryStateParses: deliveryStateParseCountForTest, subscriptionParses: subscriptionParseCountForTest };
}

export function resetDeliveryCacheStatsForTest(): void {
  deliveryStateParseCountForTest = 0;
  subscriptionParseCountForTest = 0;
}

function readDeliveryState(store: RunStore, parentRunId: string): DeliveryState {
  const path = resolve(deliveryPath(store, parentRunId));
  const current = statDeliveryFile(path);
  const cached = memoryDeliveryStateCaches.get(path);
  if (cached && deliveryFileStateUnchanged(cached.state, current)) return cloneDeliveryState(cached.deliveryState);
  if (!current.exists) {
    const state = defaultDeliveryState(parentRunId);
    memoryDeliveryStateCaches.set(path, { state: current, deliveryState: cloneDeliveryState(state) });
    return cloneDeliveryState(state);
  }
  try {
    const raw = readFileSync(path, "utf8");
    deliveryStateParseCountForTest += 1;
    const parsed = JSON.parse(raw) as Partial<DeliveryState>;
    const state = { schemaVersion: SCHEMA_VERSION, parentRunId, delivered: parsed.delivered ?? {}, handled: parsed.handled ?? {}, taskEventCursors: parsed.taskEventCursors ?? {} };
    memoryDeliveryStateCaches.set(path, { state: current, deliveryState: cloneDeliveryState(state) });
    return cloneDeliveryState(state);
  } catch (error) {
    memoryDeliveryStateCaches.delete(path);
    throw error;
  }
}

function mergeTaskEventCursors(existing: Record<string, WaitCursor> | undefined, incoming: Record<string, WaitCursor> | undefined): Record<string, WaitCursor> {
  const merged = { ...(existing ?? {}) };
  for (const [rootSessionId, cursor] of Object.entries(incoming ?? {})) {
    const previous = merged[rootSessionId];
    if (!previous || cursor.eventOffset >= previous.eventOffset) merged[rootSessionId] = cursor;
  }
  return merged;
}

function writeDeliveryState(store: RunStore, state: DeliveryState): void {
  const path = deliveryPath(store, state.parentRunId);
  const existing = readDeliveryState(store, state.parentRunId);
  atomicWriteJson(path, {
    schemaVersion: SCHEMA_VERSION,
    parentRunId: state.parentRunId,
    delivered: { ...existing.delivered, ...state.delivered },
    handled: { ...existing.handled, ...state.handled },
    taskEventCursors: mergeTaskEventCursors(existing.taskEventCursors, state.taskEventCursors),
  });
  invalidateDeliveryStateCache(path);
}

export function resultDeliveryKey(runId: string, result: RunResult): string {
  return `terminal:${runId}:${result.createdAt}`;
}

export function eventDeliveryKey(event: RunEvent): string {
  return `event:${event.runId}:${event.eventId}`;
}

export function taskEventDeliveryKey(event: TaskEvent): string {
  return `task:${event.rootSessionId}:${event.taskId}:${event.eventId}`;
}

function redactedResult(result: RunResult): RunResult & { bodyAvailable?: boolean } {
  const { body, ...rest } = result;
  return { ...rest, bodyAvailable: body !== undefined } as RunResult & { bodyAvailable?: boolean };
}

function redactedEvent(event: RunEvent): RunEvent & { bodyAvailable?: boolean } {
  const { body, ...rest } = event;
  return { ...rest, bodyAvailable: body !== undefined } as RunEvent & { bodyAvailable?: boolean };
}

export const DEFAULT_WAKEUP_RESULT_BODY_CHAR_CAP = 32_000;

function capBodyForWakeup(body: string | undefined, marker: string, maxChars = DEFAULT_WAKEUP_RESULT_BODY_CHAR_CAP): { body?: string; truncated: boolean; originalChars: number; returnedChars: number; maxChars: number } {
  if (body === undefined) return { body: undefined, truncated: false, originalChars: 0, returnedChars: 0, maxChars };
  const chars = [...body];
  if (chars.length <= maxChars) return { body, truncated: false, originalChars: chars.length, returnedChars: chars.length, maxChars };
  const markerChars = [...marker];
  const fittedMarker = markerChars.length <= maxChars ? marker : markerChars.slice(0, Math.max(0, maxChars)).join("");
  const prefixChars = Math.max(0, maxChars - [...fittedMarker].length);
  const capped = `${chars.slice(0, prefixChars).join("")}${fittedMarker}`;
  return { body: capped, truncated: true, originalChars: chars.length, returnedChars: [...capped].length, maxChars };
}

function capResultBodyForWakeup(runId: string, body: string | undefined, maxChars = DEFAULT_WAKEUP_RESULT_BODY_CHAR_CAP): { body?: string; truncated: boolean; originalChars: number; returnedChars: number; maxChars: number } {
  return capBodyForWakeup(body, `\n\n[Subagent result truncated to ${maxChars} characters for this wakeup; call subagent_result({ runId: "${runId}" }) to recover the full result.]`, maxChars);
}

function capEventBodyForWakeup(runId: string, body: string | undefined, maxChars = DEFAULT_WAKEUP_RESULT_BODY_CHAR_CAP): { body?: string; truncated: boolean; originalChars: number; returnedChars: number; maxChars: number } {
  return capBodyForWakeup(body, `\n\n[Subagent event body truncated to ${maxChars} characters for this wakeup; reply with subagent_message({ runId: "${runId}", type: "answer", ... }) if you need more detail.]`, maxChars);
}

function resultDelivery(runId: string, result: RunResult): WakeupDelivery {
  const summary = result.summary ?? result.error?.message ?? `Run ${result.state}`;
  const body = capResultBodyForWakeup(runId, result.body);
  return {
    deliveryKey: resultDeliveryKey(runId, result),
    runId,
    message: {
      kind: "subagent_wakeup",
      title: `Subagent result: ${result.agentName}`,
      runId,
      state: result.state,
      summary,
      body: body.body,
      bodyAvailable: result.body !== undefined,
      bodyTruncation: { included: result.body !== undefined, truncated: body.truncated, originalChars: body.originalChars, returnedChars: body.returnedChars, maxChars: body.maxChars },
      result: redactedResult(result),
      next: body.truncated ? [{ tool: "subagent_result", args: { runId } }] : [],
    },
  };
}

function eventDelivery(event: RunEvent, status?: { agentName?: string; displayName?: string }): WakeupDelivery {
  // Map the event type onto a run-state-ish string so wake-card glyph/badge selection works
  // (event types like "question" → "waiting_for_input").
  const state = event.type === "question" ? "waiting_for_input" : event.type === "status" && event.data?.reason === "timeout" ? "paused" : event.type;
  const body = capEventBodyForWakeup(event.runId, event.body);
  return {
    deliveryKey: eventDeliveryKey(event),
    runId: event.runId,
    message: {
      kind: "subagent_wakeup",
      title: status?.displayName ?? status?.agentName ?? `Subagent ${event.type}`,
      runId: event.runId,
      state,
      summary: event.summary,
      body: body.body,
      bodyAvailable: event.body !== undefined,
      bodyTruncation: { included: event.body !== undefined, truncated: body.truncated, originalChars: body.originalChars, returnedChars: body.returnedChars, maxChars: body.maxChars },
      event: redactedEvent(event),
      status,
      next: event.type === "question" || event.type === "blocked" ? [{ tool: "subagent_message", args: { runId: event.runId, type: "answer" } }] : state === "paused" ? [{ tool: "subagent_continue", args: { runId: event.runId, additionalRunSeconds: 900 } }, { tool: "subagent_interrupt", args: { runId: event.runId, action: "cancel" } }] : [],
    },
  };
}

function statusForRun(store: RunStore, runId: string): { agentName?: string; displayName?: string } | undefined {
  const summary = store.readRunSummary(runId);
  if (summary) return { agentName: summary.agentName, displayName: summary.displayName };
  try {
    const status = store.readStatus(runId);
    return { agentName: status.agent?.name, displayName: status.displayName };
  } catch {
    return undefined;
  }
}

function taskWakeupTitle(eventType: TaskEvent["type"]): string {
  switch (eventType) {
    case "task.result_submitted": return "Task result ready";
    case "task.ready": return "Task ready to start";
    case "task.failed": return "Task failed";
    case "task.needs_input": return "Task needs input";
    default: return "Task attention";
  }
}

// Drive the parent toward the next concrete action for each task event. A ready
// task should be started; a submitted result should be read/reviewed before any
// accept/reopen decision; a failure/blocker should be inspected.
function taskWakeupNext(event: TaskEvent): Array<{ tool: string; args: Record<string, unknown> }> {
  switch (event.type) {
    case "task.ready": return [{ tool: "subagent_start", args: { taskId: event.taskId } }];
    case "task.result_submitted": return [{ tool: "task_get", args: { taskId: event.taskId, view: "receipt" } }];
    default: return [{ tool: "task_get", args: { taskId: event.taskId } }];
  }
}

function taskDelivery(event: TaskEvent, task?: ReturnType<TaskStore["readTask"]>, terminal?: WakeupDelivery): WakeupDelivery {
  return {
    deliveryKey: taskEventDeliveryKey(event),
    runId: event.runId ?? task?.owner?.runId ?? event.taskId,
    message: {
      kind: "task_wakeup",
      title: taskWakeupTitle(event.type),
      runId: event.runId ?? task?.owner?.runId ?? "",
      state: event.type,
      summary: event.summary,
      body: terminal?.message.body,
      bodyAvailable: terminal?.message.bodyAvailable,
      bodyTruncation: terminal?.message.bodyTruncation,
      taskEvent: event,
      task: { taskId: event.taskId, title: task?.title, status: task?.status, owner: task?.owner ? { runId: task.owner.runId, displayName: task.owner.displayName, agent: task.owner.agent } : undefined, receiptPath: task?.status === "result_ready" && task.result?.state === "submitted" ? task.result.receiptPath : undefined },
      result: terminal?.message.result,
      status: terminal?.message.status,
      next: taskWakeupNext(event),
    },
  };
}

function isActionableModelWakeup(delivery: WakeupDelivery): boolean {
  if (delivery.message.kind === "task_wakeup") return true;
  if (delivery.message.result) return true;
  const eventType = delivery.message.event?.type;
  return eventType === "question" || eventType === "blocked" || (delivery.message.state as string | undefined) === "paused";
}

export function isResultWakeupCurrent(store: RunStore, parentRunId: string, runId: string, result: RunResult): boolean {
  if (isWakeupKeyHandled(store, parentRunId, resultDeliveryKey(runId, result))) return false;
  try {
    const status = store.readStatus(runId);
    if (status.resultReady === false) return false;
  } catch {
    // If status recovery fails, fall back to handled-state only so durable results
    // can still be delivered instead of being lost.
  }
  return true;
}

function pendingForRun(store: RunStore, parentRunId: string, runId: string, notifyOn?: EventType[]): WakeupDelivery[] {
  const allowed = notifyOn ? new Set(notifyOn) : undefined;
  const deliveries: WakeupDelivery[] = [];
  const summary = store.readRunSummary(runId);
  if (summary?.resultReady && (!allowed || allowed.has("result") || (summary.resultState && allowed.has(summary.resultState)))) {
    const result = store.readResult(runId);
    if (result && isResultWakeupCurrent(store, parentRunId, runId, result)) deliveries.push(resultDelivery(runId, result));
  }
  const shouldScanEvents = !allowed || [...allowed].some((type) => !["result", "completed", "failed", "cancelled", "expired"].includes(type));
  const status = shouldScanEvents ? statusForRun(store, runId) : undefined;
  const latestTimeoutWake = summary?.latestWakeEvent?.type === "status" && summary.latestWakeEvent.wake && summary.latestWakeEvent.data?.reason === "timeout" ? summary.latestWakeEvent : undefined;
  if (!shouldScanEvents && latestTimeoutWake) deliveries.push(eventDelivery(latestTimeoutWake, statusForRun(store, runId)));
  if (shouldScanEvents) {
    for (const event of store.readEvents(runId).records) {
      if (["result", "completed", "failed", "cancelled", "expired"].includes(event.type)) continue;
      const timeoutAttention = event.type === "status" && event.wake && event.data?.reason === "timeout";
      if (!(isInterestingEvent(event.type, event.wake) || timeoutAttention) || (allowed && !allowed.has(event.type) && !timeoutAttention)) continue;
      deliveries.push(eventDelivery(event, status));
    }
  }
  return deliveries;
}

const TASK_TERMINAL_WAKEUP_COALESCE_MS = 2_000;
const TASK_READY_WAKEUP_DEBOUNCE_MS = 500;
const DELIVERY_CLAIM_TTL_MS = 60_000;

function claimDelivery(store: RunStore, deliveryKey: string, ownerId: string, nowMs?: number): boolean {
  const path = claimPath(store, deliveryKey);
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        const stat = statSync(path);
        if ((nowMs ?? Date.now()) - stat.mtimeMs > DELIVERY_CLAIM_TTL_MS) rmSync(path, { force: true });
      } catch { rmSync(path, { force: true }); }
    }
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, deliveryKey, ownerId, claimedAt: new Date(nowMs ?? Date.now()).toISOString() })}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function releaseDeliveryClaim(store: RunStore, deliveryKey: string): void {
  rmSync(claimPath(store, deliveryKey), { force: true });
}

export function markDeliveredWakeupHandled(store: RunStore, parentRunId: string, delivery: WakeupDelivery, handledAt = new Date().toISOString()): void {
  if (!delivery.message.result || delivery.message.bodyTruncation?.truncated === true) return;
  const state = readDeliveryState(store, parentRunId);
  state.handled[delivery.deliveryKey] = handledAt;
  writeDeliveryState(store, state);
  try {
    const status = store.readStatus(delivery.runId);
    if (status.resultReady) store.writeStatus(updateRunStatus(status, { resultReady: false }));
  } catch {
    // Best effort: delivery state still records the result as handled so it will
    // not keep resurfacing after the inline body was delivered.
  }
}

export function writeDeliverySubscription(store: RunStore, subscription: DeliverySubscription): void {
  const path = subscriptionsPath(store, subscription.parentRunId);
  const subscriptions = readDeliverySubscriptions(store, subscription.parentRunId).filter((item) => item.runId !== subscription.runId);
  subscriptions.push(subscription);
  atomicWriteJson(path, { schemaVersion: SCHEMA_VERSION, parentRunId: subscription.parentRunId, subscriptions });
  invalidateDeliverySubscriptionsCache(path);
}

export function readDeliverySubscriptions(store: RunStore, parentRunId: string): DeliverySubscription[] {
  const path = resolve(subscriptionsPath(store, parentRunId));
  const current = statDeliveryFile(path);
  const cached = memoryDeliverySubscriptionsCaches.get(path);
  if (cached && deliveryFileStateUnchanged(cached.state, current)) return cloneDeliverySubscriptions(cached.subscriptions);
  if (!current.exists) {
    memoryDeliverySubscriptionsCaches.set(path, { state: current, subscriptions: [] });
    return [];
  }
  try {
    const raw = readFileSync(path, "utf8");
    subscriptionParseCountForTest += 1;
    const parsed = JSON.parse(raw) as { subscriptions?: DeliverySubscription[] };
    const subscriptions = parsed.subscriptions ?? [];
    memoryDeliverySubscriptionsCaches.set(path, { state: current, subscriptions: cloneDeliverySubscriptions(subscriptions) });
    return cloneDeliverySubscriptions(subscriptions);
  } catch (error) {
    memoryDeliverySubscriptionsCaches.delete(path);
    throw error;
  }
}

export function isWakeupKeyHandled(store: RunStore, parentRunId: string, deliveryKey: string): boolean {
  return Boolean(readDeliveryState(store, parentRunId).handled[deliveryKey]);
}

export function markWakeupKeyHandled(store: RunStore, parentRunId: string, deliveryKey: string): void {
  const state = readDeliveryState(store, parentRunId);
  state.handled[deliveryKey] = new Date().toISOString();
  writeDeliveryState(store, state);
}

export function markTaskWakeupHandled(store: RunStore, parentRunId: string, taskId: string, eventId?: string): void {
  const state = readDeliveryState(store, parentRunId);
  for (const key of Object.keys(state.delivered)) if (key.includes(`:${taskId}:`) && (!eventId || key.endsWith(`:${eventId}`))) state.handled[key] = new Date().toISOString();
  writeDeliveryState(store, state);
}

export function markWakeupHandled(store: RunStore, parentRunId: string, runId: string): void {
  const state = readDeliveryState(store, parentRunId);
  const result = store.readResult(runId);
  if (result) state.handled[resultDeliveryKey(runId, result)] = new Date().toISOString();
  for (const key of Object.keys(state.delivered)) {
    if (key.includes(`:${runId}:`)) state.handled[key] = new Date().toISOString();
  }
  writeDeliveryState(store, state);
}

export function pollWakeups(input: WakeupPollInput): WakeupDelivery[] {
  if (
    !ownsRootSessionLease({
      cwd: input.store.cwd,
      rootSessionId: input.rootSessionId,
      ownerId: input.ownerId,
      nowMs: input.nowMs,
    })
  ) {
    return [];
  }

  const state = readDeliveryState(input.store, input.parentRunId);
  const deliveries: WakeupDelivery[] = [];
  const deliveredKeys: string[] = [];
  let stateChanged = false;
  const subscriptions = new Map(readDeliverySubscriptions(input.store, input.parentRunId).map((item) => [item.runId, item]));
  const taskStore = new TaskStore(input.store);
  const cursor = state.taskEventCursors?.[input.rootSessionId] ?? { eventOffset: 0 };
  const taskEventRead = taskStore.readEvents(input.rootSessionId, cursor);
  const wakeableTaskEvents = taskEventRead.records.filter((event) => event.parentRunId === input.parentRunId && event.wake === true && ["task.result_submitted", "task.failed", "task.needs_input", "task.ready"].includes(event.type));
  let taskCursorBlocked = false;
  // Lazily loaded only if a task.ready event is encountered; used to confirm the
  // task is still ready by derived state (deps satisfied, unowned) before nudging.
  let readyCheckTasks: ReturnType<TaskStore["listTasks"]> | undefined;
  for (const event of wakeableTaskEvents) {
    if (state.delivered[taskEventDeliveryKey(event)] || state.handled[taskEventDeliveryKey(event)]) continue;
    let task; try { task = taskStore.readTask(input.rootSessionId, event.taskId); } catch { /* event remains deliverable without task details */ }
    // A `task.ready` nudge is only worth delivering if the task is still ready
    // by derived state — unowned, pending, and all dependencies satisfied. If the
    // parent already claimed/started it, or an upstream task was reopened and
    // re-blocked it, the nudge is stale; skip it but let the cursor advance past
    // it (continue, not break).
    if (event.type === "task.ready") {
      if (!readyCheckTasks) readyCheckTasks = taskStore.listTasks(input.rootSessionId, { reconcile: false });
      if (!isReadyWakeupStillActionable(task, readyCheckTasks)) continue;
      const hasLaterReady = taskEventRead.records.some((candidate) => candidate.taskId === event.taskId && candidate.sequence > event.sequence && candidate.type === "task.ready");
      if (hasLaterReady) continue;
      const eventMs = Date.parse(event.createdAt);
      if (Number.isFinite(eventMs) && (input.nowMs ?? Date.now()) - eventMs < TASK_READY_WAKEUP_DEBOUNCE_MS) { taskCursorBlocked = true; break; }
    }
    if (event.type === "task.result_submitted") {
      if (!task || task.status !== "result_ready" || task.result?.state !== "submitted" || !event.runId || task.owner?.runId !== event.runId) continue;
      const subscription = subscriptions.get(event.runId);
      const terminalNotifyEnabled = Boolean(subscription && subscription.notifyOn.some((type) => ["result", "completed", "failed", "cancelled", "expired"].includes(type)));
      let terminal: WakeupDelivery | undefined;
      if (terminalNotifyEnabled) {
        try { terminal = pendingForRun(input.store, input.parentRunId, event.runId, subscription?.notifyOn).find((item) => item.message.result); } catch { terminal = undefined; }
      }
      if (terminal) {
        const delivery = taskDelivery(event, task, terminal);
        if (input.modelFollowUpOnly && !isActionableModelWakeup(delivery)) continue;
        if (!claimDelivery(input.store, delivery.deliveryKey, input.ownerId, input.nowMs)) { taskCursorBlocked = true; break; }
        if (isWakeupKeyHandled(input.store, input.parentRunId, delivery.deliveryKey)) { releaseDeliveryClaim(input.store, delivery.deliveryKey); continue; }
        deliveries.push(delivery);
        const deliveredAt = new Date(input.nowMs ?? Date.now()).toISOString();
        state.delivered[delivery.deliveryKey] = deliveredAt;
        // The task-owned result wakeup is the canonical notification for this
        // completion. Mark the run terminal key handled too so the duplicate
        // plain subagent result cannot surface on a later subscription scan.
        state.handled[terminal.deliveryKey] = deliveredAt;
        stateChanged = true;
        deliveredKeys.push(delivery.deliveryKey);
        if (deliveries.length >= (input.limit ?? 5)) { taskCursorBlocked = true; break; }
        continue;
      }
      const eventMs = Date.parse(event.createdAt);
      if (terminalNotifyEnabled && Number.isFinite(eventMs) && (input.nowMs ?? Date.now()) - eventMs < TASK_TERMINAL_WAKEUP_COALESCE_MS) { taskCursorBlocked = true; break; }
    }
    const delivery = taskDelivery(event, task);
    if (input.modelFollowUpOnly && !isActionableModelWakeup(delivery)) continue;
    if (!claimDelivery(input.store, delivery.deliveryKey, input.ownerId, input.nowMs)) { taskCursorBlocked = true; break; }
    if (isWakeupKeyHandled(input.store, input.parentRunId, delivery.deliveryKey)) { releaseDeliveryClaim(input.store, delivery.deliveryKey); continue; }
    if (event.type === "task.ready") {
      const currentTask = taskStore.readTask(input.rootSessionId, event.taskId);
      const currentTasks = taskStore.listTasks(input.rootSessionId, { reconcile: false });
      if (!isReadyWakeupStillActionable(currentTask, currentTasks)) { releaseDeliveryClaim(input.store, delivery.deliveryKey); continue; }
    }
    deliveries.push(delivery);
    const deliveredAt = new Date(input.nowMs ?? Date.now()).toISOString();
    state.delivered[delivery.deliveryKey] = deliveredAt;
    stateChanged = true;
    deliveredKeys.push(delivery.deliveryKey);
    if (deliveries.length >= (input.limit ?? 5)) { taskCursorBlocked = true; break; }
  }
  if (!taskCursorBlocked && taskEventRead.cursor.eventOffset !== cursor.eventOffset) {
    state.taskEventCursors = { ...(state.taskEventCursors ?? {}), [input.rootSessionId]: taskEventRead.cursor };
    stateChanged = true;
  }
  const suppressedRunIds = new Set(deliveries.filter((delivery) => delivery.message.result).map((delivery) => delivery.runId));
  const records = deliveries.length >= (input.limit ?? 5) ? [] : subscriptions.size
    ? (input.records ?? input.store.listDirectChildren(input.parentRunId)).filter((record) => subscriptions.has(record.runId) && !suppressedRunIds.has(record.runId))
    : [];
  for (const record of records) {
    const subscription = subscriptions.get(record.runId);
    for (const delivery of pendingForRun(input.store, input.parentRunId, record.runId, subscription?.notifyOn)) {
      if (input.modelFollowUpOnly && !isActionableModelWakeup(delivery)) continue;
      if (state.delivered[delivery.deliveryKey] || state.handled[delivery.deliveryKey]) continue;
      if (!claimDelivery(input.store, delivery.deliveryKey, input.ownerId, input.nowMs)) continue;
      if (isWakeupKeyHandled(input.store, input.parentRunId, delivery.deliveryKey)) continue;
      deliveries.push(delivery);
      const deliveredAt = new Date(input.nowMs ?? Date.now()).toISOString();
      state.delivered[delivery.deliveryKey] = deliveredAt;
      stateChanged = true;
      deliveredKeys.push(delivery.deliveryKey);
      if (deliveries.length >= (input.limit ?? 5)) break;
    }
    if (deliveries.length >= (input.limit ?? 5)) break;
  }
  if (stateChanged) writeDeliveryState(input.store, state);
  for (const key of deliveredKeys) releaseDeliveryClaim(input.store, key);
  return deliveries;
}
