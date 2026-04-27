import type { AttentionItem } from "../types";
import StatusChip from "./StatusChip";

export default function AttentionPanel({ items }: { items: AttentionItem[] }) {
  if (!items.length) {
    return <div className="empty-state">No attention items.</div>;
  }
  return (
    <div className="card">
      {items.map((item) => (
        <div key={`${item.runDir}-${item.reason}`} className="attention-item">
          <div>
            <StatusChip status={item.status} />
            <strong style={{ marginLeft: 8 }}>{item.name}</strong>
            <div className="agent-meta" style={{ marginTop: 4 }}>
              {item.reason}
              {item.needs ? ` · ${item.needs}` : ""}
            </div>
            {item.summary ? <div className="agent-meta">{item.summary}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
