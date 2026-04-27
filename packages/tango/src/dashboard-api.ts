import { resolve } from "node:path";
import { listMetadata } from "./metadata.js";
import { listRootSessions, listArtifacts, type RootSessionRecord, type ArtifactManifest } from "./server.js";
import { readRecentEvents } from "./events.js";
import { readMetrics } from "./metrics.js";
import type { AgentMetadata } from "./types.js";
import {
  classifyAgent,
  buildAgentForest,
  groupByRootSession,
  gatherAttentionItems,
  computeSessionCounts,
  buildAgentCommands,
  type AgentCommands,
  type AgentTreeNode,
  type AttentionItem,
  type SessionCounts,
} from "./rootSessions.js";

export interface DashboardViewModel {
  schemaVersion: 1;
  rootSessions: RootSessionCard[];
  globalAttention: AttentionItem[];
  globalCounts: SessionCounts;
}

export interface RootSessionCard {
  rootSessionId: string;
  workstreamId: string;
  title?: string;
  kind: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  counts: SessionCounts;
  attentionCount: number;
}

export interface WorkstreamDetailViewModel {
  schemaVersion: 1;
  rootSession: RootSessionRecord;
  counts: SessionCounts;
  agents: AgentTreeNode[];
  attention: AttentionItem[];
  artifacts: ArtifactViewModel[];
}

export interface OperationsViewModel {
  schemaVersion: 1;
  counts: SessionCounts;
  workstreams: RootSessionCard[];
  attention: AttentionItem[];
  activeAgents: AgentSummary[];
  recentResults: TimelineEvent[];
  recentCompletions: TimelineEvent[];
  recentArtifacts: ArtifactViewModel[];
  timelineTail: TimelineEvent[];
  suggestedRootSessionId?: string;
}

export interface AgentSummary {
  runId?: string;
  runDir: string;
  name: string;
  role?: string;
  status: string;
  mode: string;
  cwd: string;
  summary?: string;
  needs?: string;
  rootSessionId?: string;
  workstreamId?: string;
  updatedAt: string;
  commands: AgentCommands;
}

export interface ArtifactViewModel {
  artifactId: string;
  token: string;
  title?: string;
  status: "active" | "revoked";
  entry: string;
  url: string;
  createdAt: string;
  ownerRunDir?: string;
}

export interface TimelineEvent {
  time: string;
  type: string;
  agent: string;
  status?: string;
  summary?: string;
  needs?: string;
  runDir: string;
  runId?: string;
  rootSessionId?: string;
  workstreamId?: string;
  resultReady?: boolean;
  resultIssue?: string;
  resultWarning?: string;
}

const UNSCOPED_ROOT_SESSION_ID = "unscoped";
const UNSCOPED_WORKSTREAM_ID = "unscoped";

function unscopedAgents(agents: AgentMetadata[]): AgentMetadata[] {
  return agents.filter((a) => !a.rootSessionId && !a.workstreamId);
}

function unscopedRecord(agents: AgentMetadata[]): RootSessionRecord {
  const timestamps = agents.flatMap((a) => [a.createdAt, a.updatedAt]).filter(Boolean).sort();
  const first = timestamps[0] ?? new Date(0).toISOString();
  const last = timestamps[timestamps.length - 1] ?? first;
  return {
    schemaVersion: 1,
    rootSessionId: UNSCOPED_ROOT_SESSION_ID,
    workstreamId: UNSCOPED_WORKSTREAM_ID,
    kind: "restored",
    title: "Unscoped / legacy agents",
    createdAt: first,
    updatedAt: last,
    lastSeenAt: last,
  };
}

export function buildDashboard(now = Date.now()): DashboardViewModel {
  const agents = listMetadata(undefined);
  const rootSessions = listRootSessions();
  const attention = gatherAttentionItems(agents);
  const counts = computeSessionCounts(agents, now);

  const grouped = groupByRootSession(agents, rootSessions);

  const cards: RootSessionCard[] = rootSessions.map((rs) => {
    const rsAgents = grouped.get(rs.rootSessionId) ?? [];
    return {
      ...rs,
      counts: computeSessionCounts(rsAgents, now),
      attentionCount: gatherAttentionItems(rsAgents).length,
    };
  });

  const legacyAgents = unscopedAgents(agents);
  if (legacyAgents.length > 0 && !rootSessions.some((rs) => rs.rootSessionId === UNSCOPED_ROOT_SESSION_ID)) {
    const rs = unscopedRecord(legacyAgents);
    cards.push({
      ...rs,
      counts: computeSessionCounts(legacyAgents, now),
      attentionCount: gatherAttentionItems(legacyAgents).length,
    });
  }

  // Sort: attention first, then by lastSeenAt desc
  cards.sort((a, b) => {
    if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });

  return {
    schemaVersion: 1,
    rootSessions: cards,
    globalAttention: attention,
    globalCounts: counts,
  };
}

export function buildWorkstreams(now = Date.now()): { schemaVersion: 1; workstreams: RootSessionCard[] } {
  const vm = buildDashboard(now);
  return { schemaVersion: 1, workstreams: vm.rootSessions };
}

export function buildOperations(now = Date.now()): OperationsViewModel {
  const agents = listMetadata(undefined);
  const dashboard = buildDashboard(now);
  const timeline = buildTimeline(undefined, { limit: 80 })!;
  const activeAgents = agents
    .filter((a) => classifyAgent(a, now) === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12)
    .map(toAgentSummary);
  const recentCompletions = timeline.events
    .filter((e) => ["done", "error", "stopped"].includes((e.status || "").toLowerCase()))
    .slice(-10)
    .reverse();
  const recentArtifacts = (buildArtifacts()?.artifacts ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  return {
    schemaVersion: 1,
    counts: dashboard.globalCounts,
    workstreams: dashboard.rootSessions,
    attention: dashboard.globalAttention.slice(0, 20),
    activeAgents,
    recentResults: recentCompletions,
    recentCompletions,
    recentArtifacts,
    timelineTail: timeline.events.slice(-30),
    suggestedRootSessionId: suggestRootSessionId(dashboard.rootSessions, dashboard.globalAttention, activeAgents),
  };
}

function getWorkstreamAgents(rootSessionId: string): { rs: RootSessionRecord; agents: AgentMetadata[] } | undefined {
  const allAgents = listMetadata(undefined);
  if (rootSessionId === UNSCOPED_ROOT_SESSION_ID) {
    const agents = unscopedAgents(allAgents);
    if (!agents.length) return undefined;
    return { rs: unscopedRecord(agents), agents };
  }
  const rs = listRootSessions().find((r) => r.rootSessionId === rootSessionId);
  if (!rs) return undefined;
  const agents = allAgents.filter(
    (a) => a.rootSessionId === rs.rootSessionId || a.workstreamId === rs.workstreamId
  );
  return { rs, agents };
}

function filterArtifactsByWorkstream(
  artifacts: ArtifactManifest[],
  rs: RootSessionRecord,
  agents: AgentMetadata[]
): ArtifactManifest[] {
  const runDirs = new Set(agents.map((a) => resolve(a.runDir)));
  return artifacts.filter((a) => {
    const hasRoot = !!a.rootSessionId;
    const hasWorkstream = !!a.workstreamId;
    // Conjunctive when both explicit lineage fields exist
    if (hasRoot && hasWorkstream) {
      return a.rootSessionId === rs.rootSessionId && a.workstreamId === rs.workstreamId;
    }
    if (hasRoot) {
      return a.rootSessionId === rs.rootSessionId;
    }
    if (hasWorkstream) {
      return a.workstreamId === rs.workstreamId;
    }
    // Fallback to ownerRunDir only when no explicit lineage fields exist
    if (a.ownerRunDir && runDirs.has(resolve(a.ownerRunDir))) return true;
    return false;
  });
}

export function buildWorkstreamDetail(rootSessionId: string, now = Date.now()): WorkstreamDetailViewModel | undefined {
  const wa = getWorkstreamAgents(rootSessionId);
  if (!wa) return undefined;
  const { rs, agents } = wa;
  const withMetrics = agents.map((a) => ({ ...a, metrics: readMetrics(a.runDir) }));
  const forest = buildAgentForest(withMetrics);

  return {
    schemaVersion: 1,
    rootSession: rs,
    counts: computeSessionCounts(agents, now),
    agents: forest,
    attention: gatherAttentionItems(agents),
    artifacts: filterArtifactsByWorkstream(listArtifacts(), rs, agents).map(toArtifactViewModel),
  };
}

export function buildWorkstreamAgents(rootSessionId: string, now = Date.now()): { schemaVersion: 1; agents: AgentTreeNode[] } | undefined {
  const rootSessions = listRootSessions();
  const rs = rootSessions.find((r) => r.rootSessionId === rootSessionId);
  if (!rs) return undefined;

  const agents = listMetadata(undefined).filter(
    (a) => a.rootSessionId === rs.rootSessionId || a.workstreamId === rs.workstreamId
  );
  const withMetrics = agents.map((a) => ({ ...a, metrics: readMetrics(a.runDir) }));
  return { schemaVersion: 1, agents: buildAgentForest(withMetrics) };
}

export function buildAttention(scope?: { rootSessionId?: string; workstreamId?: string }): { schemaVersion: 1; attention: AttentionItem[] } {
  let agents = listMetadata(undefined);
  if (scope?.rootSessionId) {
    const rs = listRootSessions().find((r) => r.rootSessionId === scope.rootSessionId);
    agents = agents.filter((a) => a.rootSessionId === scope.rootSessionId || (rs && a.workstreamId === rs.workstreamId));
  }
  // N-0011 TODO: replace status-derived attention with durable attention store / inbox projection
  return { schemaVersion: 1, attention: gatherAttentionItems(agents) };
}

export function buildArtifacts(rootSessionId?: string): { schemaVersion: 1; artifacts: ArtifactViewModel[] } | undefined {
  const artifacts = listArtifacts();
  if (!rootSessionId) {
    return { schemaVersion: 1, artifacts: artifacts.map(toArtifactViewModel) };
  }
  const wa = getWorkstreamAgents(rootSessionId);
  if (!wa) return undefined;
  return { schemaVersion: 1, artifacts: filterArtifactsByWorkstream(artifacts, wa.rs, wa.agents).map(toArtifactViewModel) };
}

export function buildTimeline(rootSessionId?: string, options: { limit?: number } = {}): { schemaVersion: 1; events: TimelineEvent[]; limit: number; total: number } | undefined {
  let events = readRecentEvents(5000, 2 * 1024 * 1024).events;
  if (rootSessionId) {
    const rs = listRootSessions().find((r) => r.rootSessionId === rootSessionId);
    if (!rs) return undefined;
    events = events.filter(
      (e) => e.rootSessionId === rootSessionId || (rs && e.workstreamId === rs.workstreamId)
    );
  }
  const limit = boundedLimit(options.limit, 200, 1000);
  const total = events.length;
  const limited = events.slice(-limit);
  return {
    schemaVersion: 1,
    limit,
    total,
    events: limited.map((e) => ({ 
      time: e.time,
      type: e.type,
      agent: e.agent,
      status: e.status,
      summary: e.summary,
      needs: e.needs,
      runDir: e.runDir,
      runId: e.runId,
      rootSessionId: e.rootSessionId,
      workstreamId: e.workstreamId,
      resultReady: e.resultReady,
      resultIssue: e.resultIssue,
      resultWarning: e.resultWarning,
    })),
  };
}

export function buildHistory(): { schemaVersion: 1; historical: AgentMetadata[]; legacy: AgentMetadata[] } {
  const agents = listMetadata(undefined);
  const now = Date.now();
  const historical = agents.filter((a) => classifyAgent(a, now) === "historical");
  const legacy = agents.filter((a) => classifyAgent(a, now) === "legacy");
  return { schemaVersion: 1, historical, legacy };
}

function toAgentSummary(a: AgentMetadata): AgentSummary {
  return {
    runId: a.runId,
    runDir: a.runDir,
    name: a.name,
    role: a.role,
    status: a.status,
    mode: a.mode,
    cwd: a.cwd,
    summary: a.summary,
    needs: a.needs,
    rootSessionId: a.rootSessionId,
    workstreamId: a.workstreamId,
    updatedAt: a.updatedAt,
    commands: buildAgentCommands(a),
  };
}

function suggestRootSessionId(
  workstreams: RootSessionCard[],
  attention: AttentionItem[],
  activeAgents: AgentSummary[]
): string | undefined {
  for (const item of attention) {
    const match = matchWorkstream(workstreams, item.rootSessionId, item.workstreamId);
    if (match) return match.rootSessionId;
  }
  for (const agent of activeAgents) {
    const match = matchWorkstream(workstreams, agent.rootSessionId, agent.workstreamId);
    if (match) return match.rootSessionId;
  }
  return workstreams[0]?.rootSessionId;
}

function matchWorkstream(
  workstreams: RootSessionCard[],
  rootSessionId?: string,
  workstreamId?: string
): RootSessionCard | undefined {
  if (rootSessionId) return workstreams.find((w) => w.rootSessionId === rootSessionId);
  if (workstreamId) return workstreams.find((w) => w.workstreamId === workstreamId);
  return undefined;
}

function toArtifactViewModel(a: ArtifactManifest): ArtifactViewModel {
  return {
    artifactId: a.artifactId,
    token: a.token,
    title: a.title,
    status: a.revokedAt ? "revoked" : "active",
    entry: a.entry,
    createdAt: a.createdAt,
    ownerRunDir: a.ownerRunDir,
    url: `/a/${encodeURIComponent(a.artifactId)}/${encodeURIComponent(a.token)}/${encodePathSegments(a.entry)}`,
  };
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function encodePathSegments(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
