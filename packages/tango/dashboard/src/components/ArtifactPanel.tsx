import type { ArtifactViewModel } from "../types";

function encodePathSegments(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export default function ArtifactPanel({ artifacts }: { artifacts: ArtifactViewModel[] }) {
  if (!artifacts.length) {
    return <div className="empty-state">No artifacts.</div>;
  }
  return (
    <div className="card-grid">
      {artifacts.map((a) => {
        const href = a.url || `/a/${encodeURIComponent(a.artifactId)}/${encodeURIComponent(a.token)}/${encodePathSegments(a.entry)}`;
        return (
          <div key={a.artifactId} className="card artifact-card">
            <div>
              <div><strong>{a.title || a.artifactId}</strong></div>
              <div className="agent-meta">
                {a.status === "revoked" ? "Revoked" : "Active"} · {a.entry}
              </div>
            </div>
            <a href={href} target="_blank" rel="noreferrer">Open</a>
          </div>
        );
      })}
    </div>
  );
}
