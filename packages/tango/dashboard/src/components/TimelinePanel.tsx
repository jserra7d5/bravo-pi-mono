import type { TimelineEvent } from "../types";

export default function TimelinePanel({ events }: { events: TimelineEvent[] }) {
  if (!events.length) {
    return <div className="empty-state">No timeline events.</div>;
  }
  return (
    <div className="card">
      {events.map((e, i) => (
        <div key={`${e.runDir}-${e.time}-${i}`} className="timeline-item">
          <div className="timeline-time">{new Date(e.time).toLocaleString()}</div>
          <div>
            <strong>{e.agent}</strong>{" "}
            <span className="agent-meta">{e.status || e.type}</span>
            {e.summary ? <div className="agent-meta">{e.summary}</div> : null}
            {e.needs ? <div className="agent-meta" style={{ color: "var(--warn)" }}>Needs: {e.needs}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
