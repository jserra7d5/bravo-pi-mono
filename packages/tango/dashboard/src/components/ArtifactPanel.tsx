import type { ArtifactViewModel } from "../types";

export default function ArtifactPanel({ artifacts }: { artifacts: ArtifactViewModel[] }) {
  if (!artifacts.length) {
    return <div className="empty-state">No artifacts.</div>;
  }
  return (
    <div className="card-grid">
      {artifacts.map((a) => (
        <div key={a.artifactId} className="card artifact-card">
          <div>
            <div><strong>{a.title || a.artifactId}</strong></div>
            <div className="agent-meta">
              {a.status === "revoked" ? "Revoked" : "Active"} · {a.entry}
            </div>
          </div>
          <a href={a.url} target="_blank" rel="noreferrer">Open</a>
        </div>
      ))}
    </div>
  );
}
