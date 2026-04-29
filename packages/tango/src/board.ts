import { resolve } from "node:path";
import { listMetadata } from "./metadata.js";
import { readMetrics } from "./metrics.js";
import { assessResultDeliverable } from "./result.js";
import { derivedAttentionState, filterInboxItems, readInboxItems, syncInboxFromAgents, type InboxItem, type InboxRecipient } from "./inbox.js";
import type { AgentMetadata } from "./types.js";

export type BoardSection = "active" | "blocked" | "stalled" | "offline" | "unreadResults" | "recentCompletions" | "recentErrors";

export interface BoardItem {
  name: string;
  role?: string;
  harness: string;
  mode: string;
  runId?: string;
  runDir: string;
  parentRunId?: string;
  parentRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
  status: string;
  summary?: string;
  needs?: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastActivityAt?: string;
  activity?: string;
  resultReady?: boolean;
  unread?: boolean;
  inboxId?: string;
  next: "activity" | "inbox" | "result" | "none";
}

export interface BoardView {
  schemaVersion: 1;
  scope: InboxRecipient;
  counts: Record<BoardSection | "unread", number>;
  active: BoardItem[];
  blocked: BoardItem[];
  stalled: BoardItem[];
  offline: BoardItem[];
  unreadResults: BoardItem[];
  recentCompletions: BoardItem[];
  recentErrors: BoardItem[];
  inbox: InboxItem[];
}

function agentInScope(agent: AgentMetadata, scope: InboxRecipient): boolean {
  if (scope.rootSessionId && agent.rootSessionId !== scope.rootSessionId) return false;
  if (scope.workstreamId && agent.workstreamId !== scope.workstreamId) return false;
  if (scope.runId && agent.runId !== scope.runId && agent.parentRunId !== scope.runId) return false;
  if (scope.runDir) {
    const runDir = resolve(scope.runDir);
    if (resolve(agent.runDir) !== runDir && (!agent.parentRunDir || resolve(agent.parentRunDir) !== runDir)) return false;
  }
  return true;
}

function latestUnreadResult(inbox: InboxItem[], meta: AgentMetadata): InboxItem | undefined {
  return inbox.find((item) => item.type === "result" && item.state === "unread" && resolve(item.source.runDir) === resolve(meta.runDir));
}

function toItem(meta: AgentMetadata, inbox: InboxItem[], next: BoardItem["next"]): BoardItem {
  const metrics = meta.metrics ?? readMetrics(meta.runDir);
  const assessment = assessResultDeliverable(meta);
  const unreadResult = latestUnreadResult(inbox, meta);
  const lastActivityAt = metrics?.updatedAt ?? meta.lastReportAt ?? meta.updatedAt;
  const activity = metrics?.lastTool ? `${metrics.lastTool} ${age(lastActivityAt)} ago` : `updated ${age(lastActivityAt)} ago`;
  return {
    name: meta.name,
    role: meta.role,
    harness: meta.harness,
    mode: meta.mode,
    runId: meta.runId,
    runDir: meta.runDir,
    parentRunId: meta.parentRunId,
    parentRunDir: meta.parentRunDir,
    rootSessionId: meta.rootSessionId,
    workstreamId: meta.workstreamId,
    status: meta.status,
    summary: meta.summary,
    needs: meta.needs,
    updatedAt: meta.updatedAt,
    lastSeenAt: meta.updatedAt,
    lastActivityAt,
    activity,
    resultReady: assessment.resultReady,
    unread: !!unreadResult,
    inboxId: unreadResult?.inboxId,
    next,
  };
}

function age(iso?: string): string {
  if (!iso) return "unknown";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

export function buildBoard(scope: InboxRecipient = {}): BoardView {
  const agents = listMetadata(undefined).map((agent) => ({ ...agent, metrics: readMetrics(agent.runDir) })).filter((agent) => agentInScope(agent, scope));
  syncInboxFromAgents(agents);
  const inbox = filterInboxItems(readInboxItems(), scope);
  const unresolved = inbox.filter((item) => item.state === "unread" || item.state === "read");

  const stalledAgents = agents.filter((a) => derivedAttentionState(a) === "stalled");
  const offlineAgents = agents.filter((a) => derivedAttentionState(a) === "offline");
  const derivedRunDirs = new Set([...stalledAgents, ...offlineAgents].map((a) => resolve(a.runDir)));
  const active = agents.filter((a) => (a.status === "running" || a.status === "created") && !derivedRunDirs.has(resolve(a.runDir))).map((a) => toItem(a, inbox, "activity"));
  const blocked = agents.filter((a) => a.status === "blocked").map((a) => toItem(a, inbox, "inbox"));
  const recentCompletions = agents.filter((a) => a.status === "done" || a.status === "stopped").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map((a) => toItem(a, inbox, "result"));
  const recentErrors = agents.filter((a) => a.status === "error").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map((a) => toItem(a, inbox, "inbox"));
  const unreadResults = agents.filter((a) => latestUnreadResult(inbox, a)).map((a) => toItem(a, inbox, "result"));

  return {
    schemaVersion: 1,
    scope,
    counts: {
      active: active.length,
      blocked: blocked.length,
      stalled: stalledAgents.length,
      offline: offlineAgents.length,
      unreadResults: unreadResults.length,
      recentCompletions: recentCompletions.length,
      recentErrors: recentErrors.length,
      unread: unresolved.filter((item) => item.state === "unread").length,
    },
    active,
    blocked,
    stalled: stalledAgents.map((a) => ({ ...toItem(a, inbox, "inbox"), status: "stalled" })),
    offline: offlineAgents.map((a) => ({ ...toItem(a, inbox, "inbox"), status: "offline" })),
    unreadResults,
    recentCompletions,
    recentErrors,
    inbox: unresolved,
  };
}
