import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { dataRoot } from "./paths.js";
import type { AgentMetadata, RunState } from "./types.js";

export type SubscriptionState = "active" | "notified" | "handled" | "dismissed" | "expired";

export interface SubscriptionRecipient {
  rootSessionId?: string;
  workstreamId?: string;
  cwd: string;
}

export interface SubscriptionTarget {
  runId?: string;
  runDir: string;
  name?: string;
  role?: string;
}

export interface ParentSubscription {
  schemaVersion: 1;
  subscriptionId: string;
  state: SubscriptionState;
  recipient: SubscriptionRecipient;
  target: SubscriptionTarget;
  createdAt: string;
  updatedAt: string;
  notifyOn: Array<"done" | "blocked" | "error">;
  lastDeliveredKey?: string;
  lastNotifiedOwnerId?: string;
  lastDeliveryError?: string;
  handledAt?: string;
  handledBy?: string;
}

export function subscriptionStorePath(): string {
  return join(dataRoot(), "subscriptions.jsonl");
}

function appendSubscription(record: ParentSubscription): void {
  const path = subscriptionStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

function normCwd(cwd: string): string {
  return resolve(cwd || process.cwd());
}

function recipientKey(recipient: SubscriptionRecipient): string {
  return [recipient.rootSessionId ?? "", recipient.workstreamId ?? "", normCwd(recipient.cwd)].join("|");
}

function targetKey(target: SubscriptionTarget): string {
  return target.runId ? `id:${target.runId}` : `dir:${resolve(target.runDir)}`;
}

function logicalKey(record: ParentSubscription): string {
  return `${recipientKey(record.recipient)}|${targetKey(record.target)}`;
}

export function readAllSubscriptions(): ParentSubscription[] {
  const path = subscriptionStorePath();
  if (!existsSync(path)) return [];
  const byKey = new Map<string, ParentSubscription>();
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as ParentSubscription;
      if (record?.schemaVersion !== 1 || !record.subscriptionId) continue;
      byKey.set(logicalKey(record), record);
    } catch {}
  }
  return [...byKey.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createSubscription(input: {
  recipient: SubscriptionRecipient;
  target: SubscriptionTarget;
  notifyOn?: Array<"done" | "blocked" | "error">;
}): ParentSubscription {
  const normalizedRecipient = { ...input.recipient, cwd: normCwd(input.recipient.cwd) };
  const normalizedTarget = { ...input.target, runDir: resolve(input.target.runDir) };
  const existing = readAllSubscriptions().find((r) =>
    recipientKey(r.recipient) === recipientKey(normalizedRecipient) && targetKey(r.target) === targetKey(normalizedTarget)
  );
  if (existing && !["handled", "dismissed", "expired"].includes(existing.state)) return existing;
  const now = new Date().toISOString();
  const record: ParentSubscription = {
    schemaVersion: 1,
    subscriptionId: existing?.subscriptionId ?? `sub_${Date.now()}_${randomBytes(4).toString("hex")}`,
    state: "active",
    recipient: normalizedRecipient,
    target: normalizedTarget,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    notifyOn: input.notifyOn ?? ["done", "blocked", "error"],
  };
  appendSubscription(record);
  return record;
}

export function listSubscriptionsForRecipient(recipient: SubscriptionRecipient, states: SubscriptionState[] = ["active", "notified"]): ParentSubscription[] {
  const key = recipientKey({ ...recipient, cwd: normCwd(recipient.cwd) });
  return readAllSubscriptions().filter((r) => recipientKey(r.recipient) === key && states.includes(r.state));
}

function updateSubscription(subscriptionId: string, mutate: (record: ParentSubscription) => ParentSubscription): ParentSubscription | undefined {
  const current = readAllSubscriptions().find((r) => r.subscriptionId === subscriptionId);
  if (!current) return undefined;
  const next = mutate({ ...current, recipient: { ...current.recipient }, target: { ...current.target }, notifyOn: [...current.notifyOn] });
  next.updatedAt = new Date().toISOString();
  appendSubscription(next);
  return next;
}

export function markSubscriptionNotified(subscriptionId: string, deliveryKey: string, ownerId: string): ParentSubscription | undefined {
  return updateSubscription(subscriptionId, (record) => ({
    ...record,
    state: "notified",
    lastDeliveredKey: deliveryKey,
    lastNotifiedOwnerId: ownerId,
    lastDeliveryError: undefined,
  }));
}

export function markSubscriptionDeliveryError(subscriptionId: string, error: string): ParentSubscription | undefined {
  return updateSubscription(subscriptionId, (record) => ({ ...record, lastDeliveryError: error }));
}

export function markSubscriptionHandled(target: { runId?: string; runDir?: string }, recipient?: SubscriptionRecipient, handledBy = "pi-tool"): ParentSubscription[] {
  const records = readAllSubscriptions().filter((r) => {
    if (!["active", "notified"].includes(r.state)) return false;
    if (recipient && recipientKey(r.recipient) !== recipientKey({ ...recipient, cwd: normCwd(recipient.cwd) })) return false;
    if (target.runId && r.target.runId === target.runId) return true;
    if (target.runDir && resolve(r.target.runDir) === resolve(target.runDir)) return true;
    return false;
  });
  const updated: ParentSubscription[] = [];
  for (const record of records) {
    const next = updateSubscription(record.subscriptionId, (r) => ({ ...r, state: "handled", handledAt: new Date().toISOString(), handledBy }));
    if (next) updated.push(next);
  }
  return updated;
}

export function deliveryKeyForMetadata(meta: AgentMetadata): string | undefined {
  if (meta.status === "done") {
    const ready = meta.resultFinalizedAt || meta.resultSummaryOnlyAt;
    if (!ready) return undefined;
    return `done:${meta.runId ?? meta.runDir}:${ready}`;
  }
  if (meta.status === "blocked" || meta.status === "error") {
    return `${meta.status}:${meta.runId ?? meta.runDir}:${meta.updatedAt}:${meta.needs ?? ""}:${meta.summary ?? ""}`;
  }
  return undefined;
}

export function deliveryKeyForRunState(state: RunState): string | undefined {
  if (state.agent.state === "done") {
    if (!state.result.ready) return undefined;
    return `done:${state.identity.runId ?? state.identity.runDir}:${state.result.finalizedAt ?? state.agent.updatedAt}`;
  }
  if (state.agent.state === "blocked" || state.agent.state === "error") {
    return `${state.agent.state}:${state.identity.runId ?? state.identity.runDir}:${state.agent.updatedAt}:${state.agent.needs ?? ""}:${state.agent.summary ?? ""}`;
  }
  return undefined;
}
