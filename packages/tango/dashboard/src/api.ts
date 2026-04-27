import type {
  DashboardViewModel,
  WorkstreamDetailViewModel,
  AgentTreeNode,
  AttentionItem,
  ArtifactViewModel,
  TimelineEvent,
} from "./types";

function getToken(): string {
  const params = new URLSearchParams(location.search);
  return params.get("token") || "";
}

function authParams(): string {
  const t = getToken();
  return t ? `?token=${encodeURIComponent(t)}` : "";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path + authParams());
  if (!res.ok) {
    const body = await res.text().catch(() => "{}");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export function subscribeEvents(onEvent: () => void): () => void {
  const auth = authParams();
  const es = new EventSource(`/api/v1/events${auth}`);
  es.addEventListener("event", onEvent);
  return () => es.close();
}

export function fetchDashboard(): Promise<DashboardViewModel> {
  return getJson("/api/v1/dashboard");
}

export function fetchWorkstreamDetail(
  rootSessionId: string
): Promise<WorkstreamDetailViewModel> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}`);
}

export function fetchWorkstreamAgents(
  rootSessionId: string
): Promise<{ schemaVersion: 1; agents: AgentTreeNode[] }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/agents`);
}

export function fetchWorkstreamAttention(
  rootSessionId: string
): Promise<{ schemaVersion: 1; attention: AttentionItem[] }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/attention`);
}

export function fetchWorkstreamArtifacts(
  rootSessionId: string
): Promise<{ schemaVersion: 1; artifacts: ArtifactViewModel[] }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/artifacts`);
}

export function fetchWorkstreamTimeline(
  rootSessionId: string
): Promise<{ schemaVersion: 1; events: TimelineEvent[] }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/timeline`);
}

export function fetchGlobalAttention(): Promise<{ schemaVersion: 1; attention: AttentionItem[] }> {
  return getJson("/api/v1/attention");
}

export function fetchGlobalTimeline(): Promise<{ schemaVersion: 1; events: TimelineEvent[] }> {
  return getJson("/api/v1/timeline");
}

export function fetchHistory(): Promise<{
  schemaVersion: 1;
  historical: { name: string; status: string; cwd: string; runDir: string; summary?: string }[];
  legacy: { name: string; status: string; cwd: string; runDir: string; summary?: string }[];
}> {
  return getJson("/api/v1/history");
}

export function fetchArtifacts(): Promise<{ schemaVersion: 1; artifacts: ArtifactViewModel[] }> {
  return getJson("/api/v1/artifacts");
}
