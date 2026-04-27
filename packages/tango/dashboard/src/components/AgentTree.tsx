
import type { AgentTreeNode } from "../types";
import StatusChip from "./StatusChip";
import CommandButton from "./CommandButton";

function AgentNode({ node, depth = 0 }: { node: AgentTreeNode; depth?: number }) {
  return (
    <div className="agent-node" style={{ marginLeft: depth > 0 ? 12 : 0 }}>
      <div className="agent-node-header">
        <StatusChip status={node.status} />
        <strong>{node.name}</strong>
        {node.role ? <span className="agent-meta">{node.role}</span> : null}
        <span className="agent-meta">
          {node.harness} / {node.mode}
        </span>
      </div>
      {node.summary ? <div className="agent-meta">{node.summary}</div> : null}
      {node.needs ? <div className="agent-meta" style={{ color: "var(--warn)" }}>Needs: {node.needs}</div> : null}
      <CommandButton command={node.commands.attach} />
      <CommandButton command={node.commands.look} />
      <CommandButton command={node.commands.result} />
      {node.children.length > 0 ? (
        <div className="agent-node-children">
          {node.children.map((child) => (
            <AgentNode key={child.runDir} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function AgentTree({ agents }: { agents: AgentTreeNode[] }) {
  if (!agents.length) {
    return <div className="empty-state">No agents in this session.</div>;
  }
  return (
    <div className="agent-tree">
      {agents.map((node) => (
        <AgentNode key={node.runDir} node={node} />
      ))}
    </div>
  );
}
