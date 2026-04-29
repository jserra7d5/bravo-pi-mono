import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataRoot } from "./paths.js";
import { listMetadata } from "./metadata.js";
import { assessResultDeliverable } from "./result.js";
import type { AgentMetadata } from "./types.js";

export type InboxType = "ask" | "update" | "result" | "blocked" | "stalled" | "offline" | "broadcast" | "error";
export type InboxState = "unread" | "read" | "handled" | "dismissed";

export interface InboxRecipient {
  rootSessionId?: string;
  workstreamId?: string;
  runId?: string;
  runDir?: string;
}

export interface InboxSource {
  runId?: string;
  runDir: string;
  agentName: string;
}

export interface InboxItem {
  schemaVersion: 1;
  inboxId: string;
  type: InboxType;
  state: InboxState;
  recipient: InboxRecipient;
  source: InboxSource;
  summary?: string;
  body?: string;
  urgent?: boolean;
  result?: {
    ready: boolean;
    path?: string;
    finalizedAt?: string;
    issue?: string;
  };
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  readAt?: string | null;
  handledAt?: string | null;
}

export interface MessageRecord {
  schemaVersion: 1;
  messageId: string;
  type: "instruction" | "ask" | "update" | "result" | "state-change" | "broadcast";
  fromRunId?: string;
  fromRunDir?: string;
  toRunId?: string;
  toRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
  body: string;
  urgent?: boolean;
  attachments?: string[];
  createdAt: string;
  readAt?: string | null;
  handledAt?: string | null;
}

export function inboxStorePath(): string {
  return join(dataRoot(), "inbox.jsonl");
}

export function messagesStorePath(): string {
  return join(dataRoot(), "messages.jsonl");
}

function ensureStore(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendJsonl(path: string, value: unknown): void {
  ensureStore(path);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

export function readInboxItems(): InboxItem[] {
  const path = inboxStorePath();
  if (!existsSync(path)) return [];
  const byId = new Map<string, InboxItem>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as InboxItem;
      if (item?.schemaVersion === 1 && item.inboxId) byId.set(item.inboxId, item);
    } catch {
      // Ignore malformed append-only records.
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readMessageRecords(): MessageRecord[] {
  const path = messagesStorePath();
  if (!existsSync(path)) return [];
  const byId = new Map<string, MessageRecord>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as MessageRecord;
      if (msg?.schemaVersion === 1 && msg.messageId) byId.set(msg.messageId, msg);
    } catch {}
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function recipientFor(meta: AgentMetadata): InboxRecipient {
  return {
    rootSessionId: meta.rootSessionId,
    workstreamId: meta.workstreamId,
    runId: meta.parentRunId,
    runDir: meta.parentRunDir,
  };
}

function dedupeKey(type: InboxType, meta: AgentMetadata, suffix = "current"): string {
  return `${type}:${meta.runId ?? resolve(meta.runDir)}:${suffix}`;
}

function ageMs(iso?: string): number {
  const time = Date.parse(iso ?? "");
  return Number.isFinite(time) ? Date.now() - time : 0;
}

function processAlive(pid?: number): boolean | undefined {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export function derivedAttentionState(meta: AgentMetadata): "stalled" | "offline" | undefined {
  if (meta.status !== "running" && meta.status !== "created") return undefined;
  const alive = processAlive(meta.pid) ?? processAlive(meta.supervisorPid);
  if (alive === false) return "offline";
  const lastActivityAt = meta.metrics?.updatedAt ?? meta.lastReportAt ?? meta.updatedAt;
  if (ageMs(lastActivityAt) > 5 * 60_000) return "stalled";
  return undefined;
}

export function upsertInboxItem(input: Omit<InboxItem, "schemaVersion" | "inboxId" | "state" | "createdAt" | "updatedAt"> & { state?: InboxState; inboxId?: string }): InboxItem {
  const now = new Date().toISOString();
  const existing = readInboxItems().find((item) => item.dedupeKey === input.dedupeKey);
  const item: InboxItem = existing ? {
    ...existing,
    ...input,
    schemaVersion: 1,
    inboxId: existing.inboxId,
    state: existing.state,
    createdAt: existing.createdAt,
    updatedAt: now,
  } : {
    ...input,
    schemaVersion: 1,
    inboxId: input.inboxId ?? id("in"),
    state: input.state ?? "unread",
    createdAt: now,
    updatedAt: now,
    readAt: null,
    handledAt: null,
  };
  appendJsonl(inboxStorePath(), item);
  return item;
}

export function appendMessageRecord(input: Omit<MessageRecord, "schemaVersion" | "messageId" | "createdAt"> & { messageId?: string }): MessageRecord {
  const msg: MessageRecord = {
    schemaVersion: 1,
    messageId: input.messageId ?? id("msg"),
    createdAt: new Date().toISOString(),
    ...input,
  };
  appendJsonl(messagesStorePath(), msg);
  return msg;
}

export function markInboxItem(inboxId: string, state: InboxState): InboxItem | undefined {
  const existing = readInboxItems().find((item) => item.inboxId === inboxId);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const item: InboxItem = {
    ...existing,
    state,
    updatedAt: now,
    readAt: state === "read" || state === "handled" ? (existing.readAt ?? now) : existing.readAt,
    handledAt: state === "handled" ? now : existing.handledAt,
  };
  appendJsonl(inboxStorePath(), item);
  return item;
}

export function filterInboxItems(items: InboxItem[], scope: InboxRecipient = {}): InboxItem[] {
  return items.filter((item) => {
    if (scope.rootSessionId && item.recipient.rootSessionId !== scope.rootSessionId && item.source.runId !== scope.runId) return false;
    if (scope.workstreamId && item.recipient.workstreamId !== scope.workstreamId) return false;
    if (scope.runId && item.recipient.runId !== scope.runId && item.source.runId !== scope.runId) return false;
    if (scope.runDir && item.recipient.runDir !== scope.runDir && resolve(item.source.runDir) !== resolve(scope.runDir)) return false;
    return true;
  });
}

export function syncInboxFromAgents(agents = listMetadata(undefined)): InboxItem[] {
  for (const meta of agents) {
    const source: InboxSource = { runId: meta.runId, runDir: meta.runDir, agentName: meta.name };
    if (meta.status === "blocked") {
      upsertInboxItem({
        type: "blocked",
        recipient: recipientFor(meta),
        source,
        summary: meta.summary ?? "Agent is blocked",
        body: meta.needs ? `Needs: ${meta.needs}` : meta.summary,
        dedupeKey: dedupeKey("blocked", meta),
      });
    }
    const derived = derivedAttentionState(meta);
    if (derived) {
      upsertInboxItem({
        type: derived,
        recipient: recipientFor(meta),
        source,
        summary: derived === "offline" ? "Agent appears offline" : "Agent appears stalled",
        body: derived === "offline" ? "Expected process heartbeat is gone." : "Agent is alive but has not shown recent meaningful activity.",
        urgent: derived === "offline",
        dedupeKey: dedupeKey(derived, meta),
      });
    }
    if (meta.status === "error") {
      upsertInboxItem({
        type: "error",
        recipient: recipientFor(meta),
        source,
        summary: meta.summary ?? "Agent errored",
        body: meta.needs ? `Needs: ${meta.needs}` : meta.summary,
        urgent: true,
        dedupeKey: dedupeKey("error", meta),
      });
    }
    const assessment = assessResultDeliverable(meta);
    if (assessment.resultReady) {
      upsertInboxItem({
        type: "result",
        recipient: recipientFor(meta),
        source,
        summary: meta.summary ?? "Result ready",
        body: `${meta.name} completed and result is ready.`,
        result: {
          ready: true,
          path: assessment.resultFile,
          finalizedAt: meta.resultFinalizedAt ?? meta.resultSummaryOnlyAt,
          issue: assessment.resultIssue,
        },
        dedupeKey: dedupeKey("result", meta, meta.resultFinalizedAt ?? meta.resultSummaryOnlyAt ?? "ready"),
      });
    }
  }
  return readInboxItems();
}

export function markResultItemsHandled(meta: AgentMetadata): InboxItem[] {
  const items = readInboxItems().filter((item) =>
    item.type === "result" &&
    item.state !== "handled" &&
    item.state !== "dismissed" &&
    resolve(item.source.runDir) === resolve(meta.runDir)
  );
  return items.map((item) => markInboxItem(item.inboxId, "handled")!).filter(Boolean);
}
