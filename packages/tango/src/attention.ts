import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataRoot } from "./paths.js";
import { readEvents, initialEventOffset } from "./events.js";
import type { TangoEvent } from "./events.js";
import type { AgentStatus } from "./types.js";

export type AttentionState = "new" | "delivered" | "seen" | "handled" | "dismissed" | "superseded";

export interface AttentionRecord {
  schemaVersion: 1;
  attentionId: string;
  recipientRunId?: string;
  recipientRunDir?: string;
  recipientRootSessionId?: string;
  targetRunId?: string;
  targetRunDir: string;
  targetAgentName: string;
  eventId: string;
  status: AgentStatus;
  previousStatus?: AgentStatus;
  state: AttentionState;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  needs?: string;
}

export interface RecipientContext {
  runId?: string;
  runDir?: string;
  rootSessionId?: string;
}

export function attentionStorePath(): string {
  return join(dataRoot(), "attention.jsonl");
}

function ensureDir(): void {
  mkdirSync(dirname(attentionStorePath()), { recursive: true });
}

function canonicalRecipientKey(recipient: RecipientContext): string {
  if (recipient.runId) return `runId:${recipient.runId}`;
  if (recipient.runDir) return `runDir:${resolve(recipient.runDir)}`;
  if (recipient.rootSessionId) return `rootSessionId:${recipient.rootSessionId}`;
  return "anonymous";
}

function recordKey(record: AttentionRecord): string {
  return `${canonicalRecipientKey({
    runId: record.recipientRunId,
    runDir: record.recipientRunDir,
    rootSessionId: record.recipientRootSessionId,
  })}|${record.targetRunDir}|${record.eventId}`;
}

function recipientMatch(record: AttentionRecord, recipient: RecipientContext): boolean {
  return canonicalRecipientKey({
    runId: record.recipientRunId,
    runDir: record.recipientRunDir,
    rootSessionId: record.recipientRootSessionId,
  }) === canonicalRecipientKey(recipient);
}

export function readAllAttentionRecords(): AttentionRecord[] {
  const path = attentionStorePath();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const byKey = new Map<string, AttentionRecord>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as AttentionRecord;
      byKey.set(recordKey(record), record);
    } catch {
      // skip malformed
    }
  }
  return Array.from(byKey.values());
}

export function findAttentionRecord(
  recipient: RecipientContext,
  targetRunDir: string,
  eventId: string
): AttentionRecord | undefined {
  return readAllAttentionRecords().find((r) =>
    r.targetRunDir === targetRunDir &&
    r.eventId === eventId &&
    recipientMatch(r, recipient)
  );
}

export function upsertAttentionFromEvent(
  event: TangoEvent,
  recipient: RecipientContext
): AttentionRecord {
  const existing = findAttentionRecord(recipient, event.runDir, event.eventId);
  const now = new Date().toISOString();
  let record: AttentionRecord;
  if (existing) {
    record = {
      ...existing,
      status: event.status,
      previousStatus: event.previousStatus ?? existing.previousStatus,
      summary: event.summary ?? existing.summary,
      needs: event.needs ?? existing.needs,
      updatedAt: now,
    };
    if (existing.state === "superseded" && event.previousStatus !== event.status) {
      record.state = "new";
    }
  } else {
    record = {
      schemaVersion: 1,
      attentionId: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      recipientRunId: recipient.runId,
      recipientRunDir: recipient.runDir,
      recipientRootSessionId: recipient.rootSessionId,
      targetRunId: event.runId,
      targetRunDir: event.runDir,
      targetAgentName: event.agent,
      eventId: event.eventId,
      status: event.status,
      previousStatus: event.previousStatus,
      state: "new",
      createdAt: now,
      updatedAt: now,
      summary: event.summary,
      needs: event.needs,
    };
    // Supersede older unresolved records for the same recipient+target
    const older = readAllAttentionRecords().filter((r) =>
      recipientMatch(r, recipient) &&
      r.targetRunDir === event.runDir &&
      r.eventId !== event.eventId &&
      r.state !== "handled" &&
      r.state !== "dismissed" &&
      r.state !== "superseded"
    );
    for (const old of older) {
      const superseded: AttentionRecord = { ...old, state: "superseded", updatedAt: now };
      appendAttentionRecord(superseded);
    }
  }
  appendAttentionRecord(record);
  return record;
}

export function markAttentionState(
  recipient: RecipientContext,
  targetRunDir: string,
  eventId: string,
  state: AttentionState
): AttentionRecord | undefined {
  const existing = findAttentionRecord(recipient, targetRunDir, eventId);
  if (!existing) return undefined;
  const record: AttentionRecord = { ...existing, state, updatedAt: new Date().toISOString() };
  appendAttentionRecord(record);
  return record;
}

export function markDelivered(
  recipient: RecipientContext,
  targetRunDir: string,
  eventId: string
): AttentionRecord | undefined {
  return markAttentionState(recipient, targetRunDir, eventId, "delivered");
}

export function markSeen(
  recipient: RecipientContext,
  targetRunDir: string,
  eventId: string
): AttentionRecord | undefined {
  const existing = findAttentionRecord(recipient, targetRunDir, eventId);
  if (!existing) return undefined;
  if (existing.state !== "new" && existing.state !== "delivered") return existing;
  return markAttentionState(recipient, targetRunDir, eventId, "seen");
}

export function markHandled(
  recipient: RecipientContext,
  targetRunDir: string,
  eventId: string
): AttentionRecord | undefined {
  return markAttentionState(recipient, targetRunDir, eventId, "handled");
}

export function markDismissed(
  recipient: RecipientContext,
  targetRunDir: string,
  eventId: string
): AttentionRecord | undefined {
  return markAttentionState(recipient, targetRunDir, eventId, "dismissed");
}

export function markSuperseded(
  recipient: RecipientContext,
  targetRunDir: string,
  eventId: string
): AttentionRecord | undefined {
  return markAttentionState(recipient, targetRunDir, eventId, "superseded");
}

export function markLatestDoneHandled(
  recipient: RecipientContext,
  targetRunDir: string
): AttentionRecord | undefined {
  const records = readAllAttentionRecords()
    .filter((r) => recipientMatch(r, recipient) && r.targetRunDir === targetRunDir && r.status === "done")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = records[0];
  if (latest) {
    return markHandled(recipient, targetRunDir, latest.eventId);
  }

  // No attention record yet; scan event log for latest done event for this target
  const { events } = readEvents({ offset: initialEventOffset(true), carry: "" });
  const doneEvents = events
    .filter((e) => e.runDir === targetRunDir && e.status === "done")
    .sort((a, b) => b.time.localeCompare(a.time));
  const latestEvent = doneEvents[0];
  if (!latestEvent) return undefined;

  upsertAttentionFromEvent(latestEvent, recipient);
  return markHandled(recipient, targetRunDir, latestEvent.eventId);
}

export function shouldDeliverEvent(
  event: TangoEvent,
  recipient: RecipientContext
): boolean {
  if (event.status === "done" && event.mode === "oneshot" && !event.resultFinalizedAt) return false;
  const record = findAttentionRecord(recipient, event.runDir, event.eventId);
  if (!record) return true;
  if (record.state === "dismissed" || record.state === "superseded") return false;
  if (event.status === "done" && record.state === "handled") return false;
  return true;
}

export function isHandledForRecipient(
  event: TangoEvent,
  recipient: RecipientContext
): boolean {
  const record = findAttentionRecord(recipient, event.runDir, event.eventId);
  return record?.state === "handled" || record?.state === "dismissed" || record?.state === "superseded";
}

export function listUnresolvedAttention(
  recipient?: RecipientContext
): AttentionRecord[] {
  return readAllAttentionRecords().filter((r) => {
    if (recipient && !recipientMatch(r, recipient)) return false;
    return r.state !== "handled" && r.state !== "dismissed" && r.state !== "superseded";
  });
}

function appendAttentionRecord(record: AttentionRecord): void {
  const path = attentionStorePath();
  ensureDir();
  writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "a" });
}

export function getRecipientContext(): RecipientContext {
  return {
    runId: process.env.TANGO_RUN_ID,
    runDir: process.env.TANGO_RUN_DIR,
    rootSessionId: process.env.TANGO_ROOT_SESSION_ID,
  };
}
