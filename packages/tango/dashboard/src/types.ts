export interface RootSessionRecord {
  schemaVersion: 1;
  rootSessionId: string;
  workstreamId: string;
  kind: "pi" | "cli" | "dashboard" | "restored";
  cwd?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface SessionCounts {
  attention: number;
  active: number;
  recent: number;
  historical: number;
  legacy: number;
  total: number;
}

export interface RootSessionCard extends RootSessionRecord {
  counts: SessionCounts;
  attentionCount: number;
}

export interface AgentCommands {
  attach?: string;
  look: string;
  result: string;
}

export interface AgentTreeNode {
  runId?: string;
  runDir: string;
  name: string;
  role?: string;
  status: string;
  harness: string;
  mode: string;
  cwd: string;
  summary?: string;
  needs?: string;
  metrics?: unknown;
  children: AgentTreeNode[];
  bucket: string;
  commands: AgentCommands;
}

export interface AttentionItem {
  runId?: string;
  runDir: string;
  name: string;
  status: string;
  needs?: string;
  summary?: string;
  reason: string;
  rootSessionId?: string;
  workstreamId?: string;
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

export interface DashboardViewModel {
  schemaVersion: 1;
  rootSessions: RootSessionCard[];
  globalAttention: AttentionItem[];
  globalCounts: SessionCounts;
}

export interface WorkstreamDetailViewModel {
  schemaVersion: 1;
  rootSession: RootSessionRecord;
  counts: SessionCounts;
  agents: AgentTreeNode[];
  attention: AttentionItem[];
  artifacts: ArtifactViewModel[];
}
