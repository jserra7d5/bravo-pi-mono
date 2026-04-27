import type { RootSessionCard } from "../types";

export default function RootSessionList({
  sessions,
  onSelect,
}: {
  sessions: RootSessionCard[];
  onSelect: (id: string) => void;
}) {
  if (!sessions.length) {
    return <div className="empty-state">No sessions found.</div>;
  }
  return (
    <div className="card-grid">
      {sessions.map((rs) => (
        <button
          key={rs.rootSessionId}
          className="card"
          onClick={() => onSelect(rs.rootSessionId)}
          style={{ textAlign: "left", cursor: "pointer" }}
          aria-label={`Open session ${rs.title || rs.rootSessionId}`}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>{rs.title || rs.rootSessionId}</strong>
            {rs.attentionCount > 0 ? (
              <span className="count-pill attention">
                Attention: {rs.attentionCount}
              </span>
            ) : null}
          </div>
          <div className="agent-meta">
            {rs.kind} session · workstream {rs.workstreamId} · {rs.cwd || "—"}
          </div>
          <div className="count-row" style={{ marginTop: 8 }}>
            <span className="count-pill attention">Attention: {rs.counts.attention}</span>
            <span className="count-pill active">Active: {rs.counts.active}</span>
            <span className="count-pill">Recent: {rs.counts.recent}</span>
            <span className="count-pill">Historical: {rs.counts.historical}</span>
            <span className="count-pill">Legacy: {rs.counts.legacy}</span>
            <span className="count-pill">Total: {rs.counts.total}</span>
          </div>
          <div className="agent-meta" style={{ marginTop: 8 }}>
            Last seen: {new Date(rs.lastSeenAt).toLocaleString()}
          </div>
        </button>
      ))}
    </div>
  );
}
