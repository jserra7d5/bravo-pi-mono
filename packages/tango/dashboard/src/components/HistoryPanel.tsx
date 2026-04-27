
interface AgentRow {
  name: string;
  status: string;
  cwd: string;
  runDir: string;
  summary?: string;
}

export default function HistoryPanel({
  historical,
  legacy,
}: {
  historical: AgentRow[];
  legacy: AgentRow[];
}) {
  return (
    <div>
      <h2 className="section-title">Historical (last 7 days)</h2>
      {historical.length ? (
        <div className="card-grid">
          {historical.map((a) => (
            <div key={a.runDir} className="card">
              <div><strong>{a.name}</strong> <span className="agent-meta">{a.status}</span></div>
              <div className="agent-meta">{a.cwd}</div>
              {a.summary ? <div className="agent-meta">{a.summary}</div> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">No historical agents.</div>
      )}

      <h2 className="section-title">Legacy (older than 7 days)</h2>
      {legacy.length ? (
        <div className="card-grid">
          {legacy.map((a) => (
            <div key={a.runDir} className="card">
              <div><strong>{a.name}</strong> <span className="agent-meta">{a.status}</span></div>
              <div className="agent-meta">{a.cwd}</div>
              {a.summary ? <div className="agent-meta">{a.summary}</div> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">No legacy agents.</div>
      )}
    </div>
  );
}
