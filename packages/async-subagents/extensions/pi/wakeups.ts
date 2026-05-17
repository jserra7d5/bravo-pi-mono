import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "../../src/jsonl.js";
import { ownsRootSessionLease } from "../../src/leases.js";
import { isInterestingEvent } from "../../src/schemas.js";
import { RunStore } from "../../src/runStore.js";
import type { DeliverySubscription, EventType, RunEvent, RunResult } from "../../src/types.js";
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
  atomicWriteJson(deliveryPath(store, state.parentRunId), state);
}

export function resultDeliveryKey(runId: string, result: RunResult): string {
  return `terminal:${runId}:${result.createdAt}`;
}

export function eventDeliveryKey(event: RunEvent): string {
  return `event:${event.runId}:${event.eventId}`;
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
      body: result.body,
      result,
      next: [{ tool: "subagent_result", args: { runId } }],
    },
  };
}

function eventDelivery(event: RunEvent): WakeupDelivery {
  return {
    deliveryKey: eventDeliveryKey(event),
    runId: event.runId,
    message: {
      kind: "subagent_wakeup",
      title: `Subagent ${event.type}`,
      runId: event.runId,
      state: event.type,
      summary: event.summary,
      body: event.body,
      event,
      next: event.type === "question" || event.type === "blocked" ? [{ tool: "subagent_message", args: { runId: event.runId, type: "answer" } }] : [{ tool: "subagent_result", args: { runId: event.runId } }],
    },
  };
}

function pendingForRun(store: RunStore, runId: string, notifyOn?: EventType[]): WakeupDelivery[] {
  const allowed = notifyOn ? new Set(notifyOn) : undefined;
  const result = store.readResult(runId);
  if (result && (!allowed || allowed.has("result") || allowed.has(result.state))) return [resultDelivery(runId, result)];
  const events = store.readEvents(runId).records.filter((event) => isInterestingEvent(event.type, event.wake) && (!allowed || allowed.has(event.type)));
  return events
    .filter((event) => !["result", "completed", "failed", "cancelled", "expired"].includes(event.type))
    .map(eventDelivery);
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
    ? input.store.listDirectChildren(input.parentRunId).filter((record) => subscriptions.has(record.runId))
    : [];
  for (const record of records) {
    const subscription = subscriptions.get(record.runId);
    for (const delivery of pendingForRun(input.store, record.runId, subscription?.notifyOn)) {
      if (state.delivered[delivery.deliveryKey] || state.handled[delivery.deliveryKey]) continue;
      if (!claimDelivery(input.store, delivery.deliveryKey, input.ownerId, input.nowMs)) continue;
      deliveries.push(delivery);
      state.delivered[delivery.deliveryKey] = new Date(input.nowMs ?? Date.now()).toISOString();
      if (deliveries.length >= (input.limit ?? 5)) break;
    }
    if (deliveries.length >= (input.limit ?? 5)) break;
  }
  if (deliveries.length) writeDeliveryState(input.store, state);
  return deliveries;
}
