import type {
  DashboardViewModel,
  OperationsViewModel,
  WorkstreamDetailViewModel,
  AgentTreeNode,
  AttentionItem,
  ArtifactViewModel,
  TimelineEvent,
} from "./types";

const TOKEN_KEY = "tango.dashboard.token";

function getToken(): string {
  const params = new URLSearchParams(location.search);
  const queryToken = params.get("token") || "";
  if (queryToken) {
    sessionStorage.setItem(TOKEN_KEY, queryToken);
    params.delete("token");
    const qs = params.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
    return queryToken;
  }
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

function authParams(): string {
  const t = getToken();
  return t ? `?token=${encodeURIComponent(t)}` : "";
}

function authHeaders(): HeadersInit | undefined {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : undefined;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "{}");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export type ServerEvent = { type: string; lastEventId?: string };

export function subscribeEvents(onEvent: (event: ServerEvent) => void, onError?: () => void, onOpen?: () => void): () => void {
  // EventSource cannot send Authorization headers; keep query-token compatibility for this stream only.
  const es = new EventSource(`/api/v1/events${authParams()}`);
  es.addEventListener("open", () => onOpen?.());
  es.addEventListener("hello", (event) => onEvent({ type: "hello", lastEventId: (event as MessageEvent).lastEventId }));
  es.addEventListener("event", (event) => onEvent({ type: "event", lastEventId: (event as MessageEvent).lastEventId }));
  es.addEventListener("error", () => onError?.());
  return () => es.close();
}

export function fetchDashboard(): Promise<DashboardViewModel> {
  return getJson("/api/v1/dashboard");
}

export function fetchOperations(): Promise<OperationsViewModel> {
  return getJson("/api/v1/operations");
}

export function fetchWorkstreamDetail(rootSessionId: string): Promise<WorkstreamDetailViewModel> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}`);
}

export function fetchWorkstreamAgents(rootSessionId: string): Promise<{ schemaVersion: 1; agents: AgentTreeNode[] }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/agents`);
}

export function fetchWorkstreamAttention(rootSessionId: string): Promise<{ schemaVersion: 1; attention: AttentionItem[] }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/attention`);
}

export function fetchWorkstreamArtifacts(rootSessionId: string): Promise<{ schemaVersion: 1; artifacts: ArtifactViewModel[] }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/artifacts`);
}

export function fetchWorkstreamTimeline(rootSessionId: string, limit = 200): Promise<{ schemaVersion: 1; events: TimelineEvent[]; limit: number; total: number }> {
  return getJson(`/api/v1/workstreams/${encodeURIComponent(rootSessionId)}/timeline?limit=${limit}`);
}

export function fetchGlobalAttention(): Promise<{ schemaVersion: 1; attention: AttentionItem[] }> {
  return getJson("/api/v1/attention");
}

export function fetchGlobalTimeline(limit = 200): Promise<{ schemaVersion: 1; events: TimelineEvent[]; limit: number; total: number }> {
  return getJson(`/api/v1/timeline?limit=${limit}`);
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
