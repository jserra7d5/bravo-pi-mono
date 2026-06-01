import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "../../src/jsonl.js";
import { ownsRootSessionLease } from "../../src/leases.js";
import { isInterestingEvent } from "../../src/schemas.js";
import { RunStore } from "../../src/runStore.js";
import { updateRunStatus } from "../../src/status.js";
import { TaskStore } from "../../src/taskStore.js";
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

function readDeliveryState(store: RunStore, parentRunId: string): DeliveryState {
  const path = deliveryPath(store, parentRunId);
  if (!existsSync(path)) {
    return { schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: {}, taskEventCursors: {} };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeliveryState>;
  return {
    schemaVersion: SCHEMA_VERSION,
    parentRunId,
    delivered: parsed.delivered ?? {},
    handled: parsed.handled ?? {},
    taskEventCursors: parsed.taskEventCursors ?? {},
  };
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
  const existing = readDeliveryState(store, state.parentRunId);
  atomicWriteJson(deliveryPath(store, state.parentRunId), {
    schemaVersion: SCHEMA_VERSION,
    parentRunId: state.parentRunId,
    delivered: { ...existing.delivered, ...state.delivered },
    handled: { ...existing.handled, ...state.handled },
    taskEventCursors: mergeTaskEventCursors(existing.taskEventCursors, state.taskEventCursors),
  });
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

function taskDelivery(event: TaskEvent, task?: ReturnType<TaskStore["readTask"]>): WakeupDelivery {
  return {
    deliveryKey: taskEventDeliveryKey(event),
    runId: event.runId ?? task?.owner?.runId ?? event.taskId,
    message: {
      kind: "task_wakeup",
      title: event.type === "task.result_submitted" ? "Task result ready" : "Task attention",
      runId: event.runId ?? task?.owner?.runId ?? "",
      state: event.type,
      summary: event.summary,
      taskEvent: event,
      task: { taskId: event.taskId, title: task?.title, status: task?.status, owner: task?.owner ? { runId: task.owner.runId, displayName: task.owner.displayName, agent: task.owner.agent } : undefined, receiptPath: task?.result?.receiptPath },
      next: [{ tool: "task_get", args: { taskId: event.taskId } }],
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
  const subscriptions = readDeliverySubscriptions(store, subscription.parentRunId).filter((item) => item.runId !== subscription.runId);
  subscriptions.push(subscription);
  atomicWriteJson(subscriptionsPath(store, subscription.parentRunId), { schemaVersion: SCHEMA_VERSION, parentRunId: subscription.parentRunId, subscriptions });
}

export function readDeliverySubscriptions(store: RunStore, parentRunId: string): DeliverySubscription[] {
  const path = subscriptionsPath(store, parentRunId);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { subscriptions?: DeliverySubscription[] };
  return parsed.subscriptions ?? [];
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
  let taskCursorBlocked = false;
  for (const event of taskEventRead.records.filter((event) => event.parentRunId === input.parentRunId && event.wake === true && ["task.result_submitted", "task.failed", "task.needs_input", "task.ready"].includes(event.type))) {
    if (state.delivered[taskEventDeliveryKey(event)] || state.handled[taskEventDeliveryKey(event)]) continue;
    let task; try { task = taskStore.readTask(input.rootSessionId, event.taskId); } catch { /* event remains deliverable without task details */ }
    const delivery = taskDelivery(event, task);
    if (input.modelFollowUpOnly && !isActionableModelWakeup(delivery)) continue;
    if (!claimDelivery(input.store, delivery.deliveryKey, input.ownerId, input.nowMs)) { taskCursorBlocked = true; break; }
    if (isWakeupKeyHandled(input.store, input.parentRunId, delivery.deliveryKey)) { releaseDeliveryClaim(input.store, delivery.deliveryKey); continue; }
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
  const records = deliveries.length >= (input.limit ?? 5) ? [] : subscriptions.size
    ? (input.records ?? input.store.listDirectChildren(input.parentRunId)).filter((record) => subscriptions.has(record.runId))
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
