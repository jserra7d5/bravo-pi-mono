import type { RootSessionCard } from "../types";

export default function RootSessionList({
  sessions,
  onSelect,
}: {
  sessions: RootSessionCard[];
  onSelect: (id: string) => void;
}) {
  if (!sessions.length) {
    return <div className="empty-state">No root sessions found.</div>;
  }
  return (
    <div className="card-grid">
      {sessions.map((rs) => (
        <button
          key={rs.rootSessionId}
          className="card"
          onClick={() => onSelect(rs.rootSessionId)}
          style={{ textAlign: "left", cursor: "pointer" }}
          aria-label={`Open root session ${rs.title || rs.rootSessionId}`}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>{rs.title || rs.rootSessionId}</strong>
            {rs.attentionCount > 0 ? (
              <span className="badge" style={{ background: "var(--error)", color: "#fff" }}>
                {rs.attentionCount}
              </span>
            ) : null}
          </div>
          <div className="agent-meta">
            {rs.kind} · {rs.cwd || "—"}
          </div>
          <div className="agent-meta" style={{ marginTop: 6 }}>
            <span className="badge" title="Attention">{rs.counts.attention}</span>{" "}
            <span className="badge" title="Active">{rs.counts.active}</span>{" "}
            <span className="badge" title="Recent">{rs.counts.recent}</span>{" "}
            <span className="badge" title="Historical">{rs.counts.historical}</span>{" "}
            <span className="badge" title="Legacy">{rs.counts.legacy}</span>
          </div>
          <div className="agent-meta" style={{ marginTop: 4 }}>
            Last seen: {new Date(rs.lastSeenAt).toLocaleString()}
          </div>
        </button>
      ))}
    </div>
  );
}
