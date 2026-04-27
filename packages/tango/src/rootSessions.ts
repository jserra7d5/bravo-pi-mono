import { resolve } from "node:path";
import type { AgentMetadata, AgentMetricsSnapshot, AgentStatus, AgentMode } from "./types.js";
import { readMetrics } from "./metrics.js";
import type { RootSessionRecord } from "./server.js";

export type AgentBucket = "attention" | "active" | "recent" | "historical" | "legacy";

export interface AgentTreeNode {
  runId?: string;
  runDir: string;
  name: string;
  role?: string;
  status: AgentStatus;
  harness: string;
  mode: AgentMode;
  cwd: string;
  summary?: string;
  needs?: string;
  metrics?: AgentMetricsSnapshot;
  children: AgentTreeNode[];
  bucket: AgentBucket;
  commands: AgentCommands;
}

export interface AgentCommands {
  attach?: string;
  look: string;
  result: string;
}

export interface AttentionItem {
  runId?: string;
  runDir: string;
  name: string;
  status: AgentStatus;
  needs?: string;
  summary?: string;
  reason: string;
  rootSessionId?: string;
  workstreamId?: string;
}

export interface SessionCounts {
  attention: number;
  active: number;
  recent: number;
  historical: number;
  legacy: number;
  total: number;
}

const RECENT_HOURS = 24;
const HISTORICAL_HOURS = 168; // 7 days

export function classifyAgent(meta: AgentMetadata, now = Date.now()): AgentBucket {
  // N-0011 TODO: durable attention classification may override status-derived
  if (meta.status === "blocked" || meta.status === "error" || meta.needs) return "attention";
  if (meta.status === "running" || meta.status === "created") return "active";

  const updated = Date.parse(meta.updatedAt || meta.createdAt);
  if (!Number.isFinite(updated)) return "legacy";

  const ageHours = (now - updated) / 3_600_000;
  if (ageHours <= RECENT_HOURS) return "recent";
  if (ageHours <= HISTORICAL_HOURS) return "historical";
  return "legacy";
}

export function buildAgentForest(agents: AgentMetadata[]): AgentTreeNode[] {
  const nodeMap = new Map<string, AgentTreeNode>();
  const byRunId = new Map<string, AgentTreeNode>();

  for (const a of agents) {
    const node = toNode(a);
    nodeMap.set(a.runDir, node);
    if (a.runId) byRunId.set(a.runId, node);
  }

  const roots: AgentTreeNode[] = [];

  for (const a of agents) {
    const node = nodeMap.get(a.runDir)!;
    const parent = findParent(a, byRunId, nodeMap);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function findParent(
  a: AgentMetadata,
  byRunId: Map<string, AgentTreeNode>,
  nodeMap: Map<string, AgentTreeNode>
): AgentTreeNode | undefined {
  if (a.parentRunId) {
    const p = byRunId.get(a.parentRunId);
    if (p) return p;
  }
  if (a.parentRunDir) {
    const norm = resolve(a.parentRunDir);
    for (const [runDir, node] of nodeMap) {
      if (resolve(runDir) === norm) return node;
    }
    for (const [, node] of byRunId) {
      if (resolve(node.runDir) === norm) return node;
    }
  }
  return undefined;
}

function toNode(a: AgentMetadata): AgentTreeNode {
  return {
    runId: a.runId,
    runDir: a.runDir,
    name: a.name,
    role: a.role,
    status: a.status,
    harness: a.harness,
    mode: a.mode,
    cwd: a.cwd,
    summary: a.summary,
    needs: a.needs,
    metrics: readMetrics(a.runDir),
    children: [],
    bucket: classifyAgent(a),
    commands: buildAgentCommands(a),
  };
}

export function buildAgentCommands(meta: AgentMetadata): AgentCommands {
  if (meta.runId) {
    return {
      attach: meta.mode === "interactive" ? `cd ${shellQuote(meta.cwd)} && tango attach --run-id ${shellQuote(meta.runId)}` : undefined,
      look: `cd ${shellQuote(meta.cwd)} && tango look --run-id ${shellQuote(meta.runId)} --lines 200`,
      result: `cd ${shellQuote(meta.cwd)} && tango result --run-id ${shellQuote(meta.runId)}`,
    };
  }
  return {
    attach: meta.mode === "interactive" ? `cd ${shellQuote(meta.cwd)} && tango attach ${shellQuote(meta.name)}` : undefined,
    look: `cd ${shellQuote(meta.cwd)} && tango look ${shellQuote(meta.name)} --lines 200`,
    result: `cd ${shellQuote(meta.cwd)} && tango result ${shellQuote(meta.name)}`,
  };
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function groupByRootSession(
  agents: AgentMetadata[],
  rootSessions: RootSessionRecord[]
): Map<string, AgentMetadata[]> {
  const map = new Map<string, AgentMetadata[]>();
  for (const rs of rootSessions) {
    map.set(rs.rootSessionId, []);
  }
  const workstreamToRoot = new Map<string, string>();
  for (const rs of rootSessions) {
    workstreamToRoot.set(rs.workstreamId, rs.rootSessionId);
  }

  for (const a of agents) {
    if (a.rootSessionId && map.has(a.rootSessionId)) {
      map.get(a.rootSessionId)!.push(a);
    } else if (a.workstreamId && workstreamToRoot.has(a.workstreamId)) {
      const rsId = workstreamToRoot.get(a.workstreamId)!;
      map.get(rsId)!.push(a);
    } else {
      if (!map.has("_legacy")) map.set("_legacy", []);
      map.get("_legacy")!.push(a);
    }
  }
  return map;
}

export function gatherAttentionItems(agents: AgentMetadata[]): AttentionItem[] {
  // N-0011 TODO: replace status-derived attention with durable attention store
  return agents
    .filter((a) => a.status === "blocked" || a.status === "error" || a.needs)
    .map((a) => ({
      runId: a.runId,
      runDir: a.runDir,
      name: a.name,
      status: a.status,
      needs: a.needs,
      summary: a.summary,
      reason: a.needs ? `needs: ${a.needs}` : a.status === "blocked" ? "blocked" : a.status === "error" ? "error" : "attention",
      rootSessionId: a.rootSessionId,
      workstreamId: a.workstreamId,
    }));
}

export function computeSessionCounts(agents: AgentMetadata[], now = Date.now()): SessionCounts {
  const counts: SessionCounts = { attention: 0, active: 0, recent: 0, historical: 0, legacy: 0, total: agents.length };
  for (const a of agents) {
    counts[classifyAgent(a, now)]++;
  }
  return counts;
}

export function computeGlobalCounts(agents: AgentMetadata[], now = Date.now()): SessionCounts {
  return computeSessionCounts(agents, now);
}
