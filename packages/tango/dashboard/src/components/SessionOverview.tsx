import { useState, useEffect, useCallback } from "react";
import type { WorkstreamDetailViewModel } from "../types";
import { fetchWorkstreamDetail, fetchWorkstreamTimeline } from "../api";
import type { TimelineEvent } from "../types";
import AgentTree from "./AgentTree";
import AttentionPanel from "./AttentionPanel";
import ArtifactPanel from "./ArtifactPanel";
import TimelinePanel from "./TimelinePanel";

type TabKey = "agents" | "attention" | "artifacts" | "timeline";

export default function SessionOverview({
  rootSessionId,
  onBack,
  refreshNonce = 0,
  onRefreshed,
}: {
  rootSessionId: string;
  onBack: () => void;
  refreshNonce?: number;
  onRefreshed?: () => void;
}) {
  const [detail, setDetail] = useState<WorkstreamDetailViewModel | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("agents");

  const refresh = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const next = await fetchWorkstreamDetail(rootSessionId);
      setDetail(next);
      if (tab === "timeline") setTimeline((await fetchWorkstreamTimeline(rootSessionId)).events);
      onRefreshed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rootSessionId, tab, onRefreshed]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshNonce]);

  useEffect(() => {
    if (tab !== "timeline") return;
    fetchWorkstreamTimeline(rootSessionId)
      .then((t) => setTimeline(t.events))
      .catch(() => setTimeline([]));
  }, [tab, rootSessionId, refreshNonce]);

  if (error && !detail) return <div className="empty-state" role="alert">Error: {error}</div>;
  if (!detail) return <div className="empty-state">Loading session…</div>;

  const rs = detail.rootSession;
  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 12 }}>
        ← Back to sessions
      </button>
      {error ? <div className="empty-state" role="alert">Refresh error: {error}</div> : null}
      {loading ? <div className="agent-meta" style={{ marginBottom: 8 }}>Refreshing session…</div> : null}
      <h2 style={{ marginTop: 0 }}>
        {rs.title || rs.rootSessionId}
        <span className="agent-meta" style={{ marginLeft: 10 }}>
          {rs.kind} session · workstream {rs.workstreamId} · {rs.cwd || "—"}
        </span>
      </h2>
      <div className="count-row" style={{ marginBottom: 12 }}>
        <span className="count-pill attention">Attention: {detail.counts.attention}</span>
        <span className="count-pill active">Active: {detail.counts.active}</span>
        <span className="count-pill">Recent: {detail.counts.recent}</span>
        <span className="count-pill">Historical: {detail.counts.historical}</span>
        <span className="count-pill">Legacy: {detail.counts.legacy}</span>
        <span className="count-pill">Total: {detail.counts.total}</span>
      </div>

      <div className="tabs" role="tablist" aria-label="Session sections">
        {(
          [
            ["agents", `Agents (${detail.agents.length})`],
            ["attention", `Attention (${detail.attention.length})`],
            ["artifacts", `Artifacts (${detail.artifacts.length})`],
            ["timeline", `Timeline (${timeline.length})`],
          ] as [TabKey, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className="tab"
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "agents" && <AgentTree agents={detail.agents} />}
      {tab === "attention" && <AttentionPanel items={detail.attention} />}
      {tab === "artifacts" && <ArtifactPanel artifacts={detail.artifacts} />}
      {tab === "timeline" && <TimelinePanel events={timeline} />}
    </div>
  );
}
