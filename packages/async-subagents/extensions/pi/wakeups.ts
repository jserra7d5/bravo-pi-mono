import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "../../src/jsonl.js";
import { ownsRootSessionLease } from "../../src/leases.js";
import { isInterestingEvent, isTerminalRunState } from "../../src/schemas.js";
import { RunStore } from "../../src/runStore.js";
import { withFileMutationLockSync } from "../../src/runLock.js";
import { updateRunStatus } from "../../src/status.js";
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

function parentLockKey(parentRunId: string): string {
  const readable = parentRunId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
  return `${readable}.${createHash("sha256").update(parentRunId).digest("hex").slice(0, 16)}`;
}

function deliveryLockPath(store: RunStore, parentRunId: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", "locks", `${parentLockKey(parentRunId)}.delivery.lock`);
}

function subscriptionsLockPath(store: RunStore, parentRunId: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", "locks", `${parentLockKey(parentRunId)}.subscriptions.lock`);
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
function defaultDeliveryState(parentRunId: string): DeliveryState { return { schemaVersion: SCHEMA_VERSION, parentRunId, delivered: {}, handled: {} }; }
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
    const state = { schemaVersion: SCHEMA_VERSION, parentRunId, delivered: parsed.delivered ?? {}, handled: parsed.handled ?? {} };
    memoryDeliveryStateCaches.set(path, { state: current, deliveryState: cloneDeliveryState(state) });
    return cloneDeliveryState(state);
  } catch (error) {
    memoryDeliveryStateCaches.delete(path);
    throw error;
  }
}

function readDeliveryStateFresh(store: RunStore, parentRunId: string): DeliveryState {
  invalidateDeliveryStateCache(deliveryPath(store, parentRunId));
  return readDeliveryState(store, parentRunId);
}

function writeDeliveryStateUnlocked(store: RunStore, state: DeliveryState): void {
  const path = deliveryPath(store, state.parentRunId);
  atomicWriteJson(path, state);
  invalidateDeliveryStateCache(path);
}

function mutateDeliveryState(store: RunStore, parentRunId: string, mutate: (state: DeliveryState) => void): void {
  withFileMutationLockSync(deliveryLockPath(store, parentRunId), () => {
    const state = readDeliveryStateFresh(store, parentRunId);
    mutate(state);
    writeDeliveryStateUnlocked(store, state);
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

export const DEFAULT_WAKEUP_RESULT_BODY_CHAR_CAP = 32_000;
export const TERMINAL_WAKEUP_RETRY_INTERVAL_MS = 60_000;

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
  const transcriptBackedErrorCodes = new Set(["CLAUDE_EXITED_WITHOUT_RESULT", "MAX_RUN_SECONDS_EXPIRED"]);
  const suppressInlineBody = result.harness === "claude" && Boolean(result.transcriptPath) && transcriptBackedErrorCodes.has(String(result.error?.code ?? ""));
  const body = capResultBodyForWakeup(runId, suppressInlineBody ? undefined : result.body);
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
      bodyTruncation: { included: result.body !== undefined && !suppressInlineBody, truncated: body.truncated, originalChars: body.originalChars, returnedChars: body.returnedChars, maxChars: body.maxChars, suppressed: suppressInlineBody || undefined },
      result: redactedResult(result),
      next: body.truncated ? [{ tool: "subagent_result", args: { runId } }] : [],
    },
  };
}

function livenessNextActions(runId: string, state: string | undefined): Array<{ tool: string; args: Record<string, unknown> }> {
  if (!state || !["ack_pending", "rate_limited", "comatose", "stale_transport", "orphaned_process"].includes(state)) return [];
  const inspect = { tool: "subagent_status", args: { runIds: [runId], includeEvents: true, maxEvents: 10 } };
  if (state === "comatose" || state === "stale_transport" || state === "orphaned_process") return [inspect, { tool: "subagent_interrupt", args: { runId, action: "cancel" } }];
  return [inspect];
}

function eventDelivery(event: RunEvent, status?: { agentName?: string; displayName?: string } & Record<string, unknown>): WakeupDelivery {
  // Map the event type onto a run-state-ish string so wake-card glyph/badge selection works
  // (event types like "question" → "waiting_for_input").
  const state = event.type === "question"
    ? "waiting_for_input"
    : event.type === "liveness" && typeof event.data?.state === "string"
      ? event.data.state
      : event.type;
  const body = capEventBodyForWakeup(event.runId, event.body);
  const next = event.type === "question" || event.type === "blocked"
    ? [{ tool: "subagent_message", args: { runId: event.runId, type: "answer" } }]
    : state === "paused"
      ? [{ tool: "subagent_continue", args: { runId: event.runId, additionalRunSeconds: 900 } }, { tool: "subagent_interrupt", args: { runId: event.runId, action: "cancel" } }]
      : livenessNextActions(event.runId, state);
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
      next,
    },
  };
}

function statusForRun(store: RunStore, runId: string): ({ agentName?: string; displayName?: string } & Record<string, unknown>) | undefined {
  const summary = store.readRunSummary(runId);
  if (summary) return { ...summary, agentName: summary.agentName, displayName: summary.displayName };
  try {
    const status = store.readStatus(runId);
    return { ...status, agentName: status.agent?.name, displayName: status.displayName };
  } catch {
    return undefined;
  }
}

function isActionableModelWakeup(delivery: WakeupDelivery): boolean {
  if (delivery.message.result) return true;
  const eventType = delivery.message.event?.type;
  return eventType === "question" || eventType === "blocked" || eventType === "liveness" || (delivery.message.state as string | undefined) === "paused";
}

export function isResultWakeupCurrent(store: RunStore, parentRunId: string, runId: string, result: RunResult): boolean {
  // A durable result.json IS the terminal fact; status.json is written after it and
  // can lag or be lost to a torn finalization. Gating delivery on status.resultReady
  // meant a run that had genuinely finished was never announced, and the parent had
  // no other way to learn — the delivery key already makes redelivery idempotent, so
  // the handled set is the only check that belongs here.
  return !isWakeupKeyHandled(store, parentRunId, resultDeliveryKey(runId, result));
}

function isDeliverableAttentionEvent(event: RunEvent): boolean {
  if (["result", "completed", "failed", "cancelled", "expired"].includes(event.type)) return false;
  return isInterestingEvent(event.type, event.wake);
}

function pendingForRun(store: RunStore, parentRunId: string, runId: string, notifyOn?: EventType[]): WakeupDelivery[] {
  const allowed = notifyOn ? new Set(notifyOn) : undefined;
  const deliveries: WakeupDelivery[] = [];
  const summary = store.readRunSummary(runId);
  // `notifyOn` selects which ATTENTION events are worth interrupting the parent for.
  // It must never gate the terminal result: a lane ending is not an optional
  // notification, and under a Pi parent this wakeup is the only channel that exists.
  // A parent that subscribed with, say, ["completed","failed","blocked"] otherwise
  // never learns that a child expired or was cancelled — the run simply goes quiet
  // and the parent waits on a lane that is already dead.
  //
  // Read the result whenever the run is terminal rather than only when the summary
  // says resultReady: that flag lives in status.json, which is written after
  // result.json and can lag it or be lost entirely to a torn finalization.
  if (summary && (summary.resultReady || isTerminalRunState(summary.state))) {
    const result = store.readResult(runId);
    if (result && isResultWakeupCurrent(store, parentRunId, runId, result)) deliveries.push(resultDelivery(runId, result));
  }
  if (deliveries.some((delivery) => delivery.message.result)) return deliveries;
  const shouldScanEvents = !allowed || [...allowed].some((type) => !["result", "completed", "failed", "cancelled", "expired"].includes(type));
  const status = shouldScanEvents ? statusForRun(store, runId) : undefined;
  if (shouldScanEvents) {
    const events = store.readEvents(runId).records;
    let resolvedThrough = -1;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.type === "message.received" && (event.data?.messageType === "answer" || event.data?.messageType === "instruction")) resolvedThrough = index;
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (index <= resolvedThrough && (event.type === "question" || event.type === "blocked")) continue;
      if (!isDeliverableAttentionEvent(event) || (allowed && !allowed.has(event.type))) continue;
      deliveries.push(eventDelivery(event, status));
    }
  }
  return deliveries;
}

const DELIVERY_CLAIM_TTL_MS = 60_000;

function claimDelivery(store: RunStore, deliveryKey: string, ownerId: string, nowMs?: number): boolean {
  const path = claimPath(store, deliveryKey);
  let created = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        const stat = statSync(path);
        if ((nowMs ?? Date.now()) - stat.mtimeMs > DELIVERY_CLAIM_TTL_MS) rmSync(path, { force: true });
      } catch { rmSync(path, { force: true }); }
    }
    const fd = openSync(path, "wx");
    created = true;
    try {
      writeFileSync(fd, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, deliveryKey, ownerId, claimedAt: new Date(nowMs ?? Date.now()).toISOString() })}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    if (created) rmSync(path, { force: true });
    return false;
  }
}

function releaseDeliveryClaim(store: RunStore, deliveryKey: string): void {
  rmSync(claimPath(store, deliveryKey), { force: true });
}

export function markDeliveredWakeupHandled(store: RunStore, parentRunId: string, delivery: WakeupDelivery, handledAt = new Date().toISOString()): void {
  if (!delivery.message.result || delivery.message.bodyTruncation?.truncated === true) return;
  markWakeupKeyHandled(store, parentRunId, delivery.deliveryKey, delivery.runId, handledAt);
}

export function writeDeliverySubscription(store: RunStore, subscription: DeliverySubscription): void {
  const path = subscriptionsPath(store, subscription.parentRunId);
  withFileMutationLockSync(subscriptionsLockPath(store, subscription.parentRunId), () => {
    invalidateDeliverySubscriptionsCache(path);
    const subscriptions = readDeliverySubscriptions(store, subscription.parentRunId).filter((item) => item.runId !== subscription.runId);
    subscriptions.push(subscription);
    atomicWriteJson(path, { schemaVersion: SCHEMA_VERSION, parentRunId: subscription.parentRunId, subscriptions });
    invalidateDeliverySubscriptionsCache(path);
  });
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

export function markWakeupKeyHandled(store: RunStore, parentRunId: string, deliveryKey: string, runId?: string, handledAt = new Date().toISOString()): void {
  mutateDeliveryState(store, parentRunId, (state) => { state.handled[deliveryKey] = handledAt; });
  if (!deliveryKey.startsWith("terminal:") || !runId) return;
  try {
    const status = store.readStatus(runId);
    if (status.resultReady) store.writeStatus(updateRunStatus(status, { resultReady: false }));
  } catch {
    // Best effort: handled delivery state is authoritative for suppression.
  }
}

export function markWakeupHandled(store: RunStore, parentRunId: string, runId: string): void {
  const result = store.readResult(runId);
  const handledAt = new Date().toISOString();
  mutateDeliveryState(store, parentRunId, (state) => {
    if (result) state.handled[resultDeliveryKey(runId, result)] = handledAt;
    for (const key of Object.keys(state.delivered)) {
      if (key.includes(`:${runId}:`)) state.handled[key] = handledAt;
    }
  });
}

export function pollWakeups(input: WakeupPollInput): WakeupDelivery[] {
  if (!ownsRootSessionLease({ cwd: input.store.cwd, rootSessionId: input.rootSessionId, ownerId: input.ownerId, nowMs: input.nowMs })) return [];

  // Expensive run/event discovery deliberately stays outside the parent-key
  // delivery lock. Every candidate is re-read and committed under that lock.
  const cachedState = readDeliveryState(input.store, input.parentRunId);
  const subscriptions = new Map(readDeliverySubscriptions(input.store, input.parentRunId).map((item) => [item.runId, item]));
  const records = subscriptions.size
    ? (input.records ?? input.store.listDirectChildren(input.parentRunId)).filter((record) => subscriptions.has(record.runId))
    : [];
  const discovered: WakeupDelivery[] = [];
  for (const record of records) {
    const subscription = subscriptions.get(record.runId);
    for (const delivery of pendingForRun(input.store, input.parentRunId, record.runId, subscription?.notifyOn)) {
      if (input.modelFollowUpOnly && !isActionableModelWakeup(delivery)) continue;
      if (cachedState.handled[delivery.deliveryKey]) continue;
      const previousAttempt = cachedState.delivered[delivery.deliveryKey];
      if (previousAttempt) {
        const retryableFullInlineResult = Boolean(delivery.message.result) && delivery.message.bodyTruncation?.truncated !== true;
        const attemptedAtMs = Date.parse(previousAttempt);
        const retryDue = retryableFullInlineResult && Number.isFinite(attemptedAtMs)
          && (input.nowMs ?? Date.now()) - attemptedAtMs >= TERMINAL_WAKEUP_RETRY_INTERVAL_MS;
        if (!retryDue) continue;
      }
      discovered.push(delivery);
    }
  }

  const deliveries: WakeupDelivery[] = [];
  const limit = input.limit ?? 5;
  for (const candidate of discovered) {
    if (deliveries.length >= limit) break;
    if (!claimDelivery(input.store, candidate.deliveryKey, input.ownerId, input.nowMs)) continue;
    try {
      const committed = withFileMutationLockSync(deliveryLockPath(input.store, input.parentRunId), () => {
        const subscription = readDeliverySubscriptions(input.store, input.parentRunId).find((item) => item.runId === candidate.runId);
        if (!subscription) return undefined;
        const current = candidate.message.result
          ? (isResultWakeupCurrent(input.store, input.parentRunId, candidate.runId, candidate.message.result) ? candidate : undefined)
          : pendingForRun(input.store, input.parentRunId, candidate.runId, subscription.notifyOn)
            .find((delivery) => delivery.deliveryKey === candidate.deliveryKey);
        if (!current || (input.modelFollowUpOnly && !isActionableModelWakeup(current))) return undefined;

        const state = readDeliveryStateFresh(input.store, input.parentRunId);
        if (state.handled[current.deliveryKey]) return undefined;
        const previousAttempt = state.delivered[current.deliveryKey];
        if (previousAttempt) {
          const retryableFullInlineResult = Boolean(current.message.result) && current.message.bodyTruncation?.truncated !== true;
          const attemptedAtMs = Date.parse(previousAttempt);
          const retryDue = retryableFullInlineResult && Number.isFinite(attemptedAtMs)
            && (input.nowMs ?? Date.now()) - attemptedAtMs >= TERMINAL_WAKEUP_RETRY_INTERVAL_MS;
          if (!retryDue) return undefined;
        }

        // Discovery may race lease takeover. Ownership must still be current at
        // the serialization point immediately before delivery-state mutation.
        if (!ownsRootSessionLease({ cwd: input.store.cwd, rootSessionId: input.rootSessionId, ownerId: input.ownerId, nowMs: input.nowMs })) return undefined;
        const deliveredAt = new Date(input.nowMs ?? Date.now()).toISOString();
        state.delivered[current.deliveryKey] = deliveredAt;
        if (current.message.result) {
          for (const event of input.store.readEvents(current.runId).records) {
            if (isDeliverableAttentionEvent(event)) state.handled[eventDeliveryKey(event)] = deliveredAt;
          }
        }
        writeDeliveryStateUnlocked(input.store, state);
        return current;
      }).value;
      if (!committed) continue;
      if (committed.message.result) {
        for (let index = deliveries.length - 1; index >= 0; index -= 1) {
          if (deliveries[index].runId === committed.runId && !deliveries[index].message.result) deliveries.splice(index, 1);
        }
      } else if (deliveries.some((delivery) => delivery.runId === committed.runId && delivery.message.result)) {
        continue;
      }
      deliveries.push(committed);
    } finally {
      releaseDeliveryClaim(input.store, candidate.deliveryKey);
    }
  }
  return deliveries;
}
