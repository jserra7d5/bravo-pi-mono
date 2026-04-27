import { useState, useEffect } from "react";
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
}: {
  rootSessionId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<WorkstreamDetailViewModel | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string>("");
  const [tab, setTab] = useState<TabKey>("agents");

  useEffect(() => {
    fetchWorkstreamDetail(rootSessionId)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [rootSessionId]);

  useEffect(() => {
    if (tab !== "timeline") return;
    fetchWorkstreamTimeline(rootSessionId)
      .then((t) => setTimeline(t.events))
      .catch(() => setTimeline([]));
  }, [tab, rootSessionId]);

  if (error) return <div className="empty-state">Error: {error}</div>;
  if (!detail) return <div className="empty-state">Loading session…</div>;

  const rs = detail.rootSession;
  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 12 }}>
        ← Back to sessions
      </button>
      <h2 style={{ marginTop: 0 }}>
        {rs.title || rs.rootSessionId}
        <span className="agent-meta" style={{ marginLeft: 10 }}>
          {rs.kind} · {rs.cwd || "—"}
        </span>
      </h2>
      <div className="agent-meta" style={{ marginBottom: 12 }}>
        <span className="badge" title="Attention">
          {detail.counts.attention}
        </span>{" "}
        <span className="badge" title="Active">
          {detail.counts.active}
        </span>{" "}
        <span className="badge" title="Recent">
          {detail.counts.recent}
        </span>{" "}
        <span className="badge" title="Historical">
          {detail.counts.historical}
        </span>{" "}
        <span className="badge" title="Legacy">
          {detail.counts.legacy}
        </span>
      </div>

      <div className="tabs" role="tablist" aria-label="Session sections">
        {(
          [
            ["agents", `Agents (${detail.agents.length})`],
            ["attention", `Attention (${detail.attention.length})`],
            ["artifacts", `Artifacts (${detail.artifacts.length})`],
            ["timeline", "Timeline"],
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
