import type { TimelineEvent } from "../types";

const MAX_RENDERED_EVENTS = 200;

export default function TimelinePanel({ events }: { events: TimelineEvent[] }) {
  if (!events.length) {
    return <div className="empty-state">No timeline events.</div>;
  }
  const rendered = events.slice(-MAX_RENDERED_EVENTS);
  return (
    <div className="card">
      {events.length > rendered.length ? (
        <div className="agent-meta" style={{ marginBottom: 8 }}>
          Showing latest {rendered.length} of {events.length} fetched events.
        </div>
      ) : null}
      {rendered.map((e, i) => (
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
