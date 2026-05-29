import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "../../src/jsonl.js";
import { ownsRootSessionLease } from "../../src/leases.js";
import { isInterestingEvent } from "../../src/schemas.js";
import { RunStore } from "../../src/runStore.js";
import type { DeliverySubscription, EventType, RunEvent, RunIndexRecord, RunResult } from "../../src/types.js";
import { SCHEMA_VERSION } from "../../src/types.js";
import type { WakeupMessage } from "./renderers.js";

export interface DeliveryState {
  schemaVersion: typeof SCHEMA_VERSION;
  parentRunId: string;
  delivered: Record<string, string>;
  handled: Record<string, string>;
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
    return { schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: {} };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeliveryState>;
  return {
    schemaVersion: SCHEMA_VERSION,
    parentRunId,
    delivered: parsed.delivered ?? {},
    handled: parsed.handled ?? {},
  };
}

function writeDeliveryState(store: RunStore, state: DeliveryState): void {
  const existing = readDeliveryState(store, state.parentRunId);
  atomicWriteJson(deliveryPath(store, state.parentRunId), {
    schemaVersion: SCHEMA_VERSION,
    parentRunId: state.parentRunId,
    delivered: { ...existing.delivered, ...state.delivered },
    handled: { ...existing.handled, ...state.handled },
  });
}

export function resultDeliveryKey(runId: string, result: RunResult): string {
  return `terminal:${runId}:${result.createdAt}`;
}

export function eventDeliveryKey(event: RunEvent): string {
  return `event:${event.runId}:${event.eventId}`;
}

function redactedResult(result: RunResult): RunResult & { bodyAvailable?: boolean } {
  const { body, ...rest } = result;
  return { ...rest, bodyAvailable: body !== undefined } as RunResult & { bodyAvailable?: boolean };
}

function redactedEvent(event: RunEvent): RunEvent & { bodyAvailable?: boolean } {
  const { body, ...rest } = event;
  return { ...rest, bodyAvailable: body !== undefined } as RunEvent & { bodyAvailable?: boolean };
}

function resultDelivery(runId: string, result: RunResult): WakeupDelivery {
  const summary = result.summary ?? result.error?.message ?? `Run ${result.state}`;
  return {
    deliveryKey: resultDeliveryKey(runId, result),
    runId,
    message: {
      kind: "subagent_wakeup",
      title: `Subagent result: ${result.agentName}`,
      runId,
      state: result.state,
      summary,
      bodyAvailable: result.body !== undefined,
      result: redactedResult(result),
      next: [{ tool: "subagent_result", args: { runId } }],
    },
  };
}

function eventDelivery(event: RunEvent, status?: { agentName?: string; displayName?: string }): WakeupDelivery {
  // Map the event type onto a run-state-ish string so wake-card glyph/badge selection works
  // (event types like "question" → "waiting_for_input").
  const state = event.type === "question" ? "waiting_for_input" : event.type === "status" && event.data?.reason === "timeout" ? "paused" : event.type;
  return {
    deliveryKey: eventDeliveryKey(event),
    runId: event.runId,
    message: {
      kind: "subagent_wakeup",
      title: status?.displayName ?? status?.agentName ?? `Subagent ${event.type}`,
      runId: event.runId,
      state,
      summary: event.summary,
      bodyAvailable: event.body !== undefined,
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

function isActionableModelWakeup(delivery: WakeupDelivery): boolean {
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

function claimDelivery(store: RunStore, deliveryKey: string, ownerId: string, nowMs?: number): boolean {
  const path = claimPath(store, deliveryKey);
  try {
    mkdirSync(dirname(path), { recursive: true });
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
  const subscriptions = new Map(readDeliverySubscriptions(input.store, input.parentRunId).map((item) => [item.runId, item]));
  const records = subscriptions.size
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
      state.delivered[delivery.deliveryKey] = new Date(input.nowMs ?? Date.now()).toISOString();
      if (deliveries.length >= (input.limit ?? 5)) break;
    }
    if (deliveries.length >= (input.limit ?? 5)) break;
  }
  if (deliveries.length) writeDeliveryState(input.store, state);
  return deliveries;
}
