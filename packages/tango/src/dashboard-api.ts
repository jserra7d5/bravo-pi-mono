import { resolve } from "node:path";
import { listMetadata } from "./metadata.js";
import { listRootSessions, listArtifacts, type RootSessionRecord, type ArtifactManifest } from "./server.js";
import { readEvents, type TangoEvent } from "./events.js";
import { readMetrics } from "./metrics.js";
import type { AgentMetadata } from "./types.js";
import {
  classifyAgent,
  buildAgentForest,
  groupByRootSession,
  gatherAttentionItems,
  computeSessionCounts,
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

export interface ArtifactViewModel {
  artifactId: string;
  token: string;
  title?: string;
  status: "active" | "revoked";
  entry: string;
  url?: string;
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

function getWorkstreamAgents(rootSessionId: string): { rs: RootSessionRecord; agents: AgentMetadata[] } | undefined {
  const rs = listRootSessions().find((r) => r.rootSessionId === rootSessionId);
  if (!rs) return undefined;
  const agents = listMetadata(undefined).filter(
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

export function buildTimeline(rootSessionId?: string): { schemaVersion: 1; events: TimelineEvent[] } | undefined {
  const state = { offset: 0, carry: "" };
  const allEvents = readEvents(state).events;
  let events = allEvents;
  if (rootSessionId) {
    const rs = listRootSessions().find((r) => r.rootSessionId === rootSessionId);
    if (!rs) return undefined;
    events = events.filter(
      (e) => e.rootSessionId === rootSessionId || (rs && e.workstreamId === rs.workstreamId)
    );
  }
  return {
    schemaVersion: 1,
    events: events.map((e) => ({
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

function toArtifactViewModel(a: ArtifactManifest): ArtifactViewModel {
  return {
    artifactId: a.artifactId,
    token: a.token,
    title: a.title,
    status: a.revokedAt ? "revoked" : "active",
    entry: a.entry,
    createdAt: a.createdAt,
    ownerRunDir: a.ownerRunDir,
  };
}
