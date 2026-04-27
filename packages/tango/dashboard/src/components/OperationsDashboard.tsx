import { useEffect, useMemo, useState } from "react";
import type {
  AgentSummary,
  OperationsViewModel,
  RootSessionCard,
  TimelineEvent,
} from "../types";
import StatusChip from "./StatusChip";

function titleFor(rs: RootSessionCard): string {
  return rs.title || rs.rootSessionId;
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 10)}…` : value;
}

function formatAge(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return "unknown";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function navigateToSession(rootSessionId: string) {
  location.hash = `/sessions/${encodeURIComponent(rootSessionId)}`;
}

function findSessionForAttention(
  item: { rootSessionId?: string; workstreamId?: string },
  sessions: RootSessionCard[]
): RootSessionCard | undefined {
  if (item.rootSessionId) return sessions.find((rs) => rs.rootSessionId === item.rootSessionId);
  if (item.workstreamId) return sessions.find((rs) => rs.workstreamId === item.workstreamId);
  return undefined;
}

/* ── Workstream rail ── */
function WorkstreamRail({
  sessions,
  selectedId,
}: {
  sessions: RootSessionCard[];
  selectedId?: string;
}) {
  if (!sessions.length) return <div className="empty-state compact">No workstreams.</div>;
  return (
    <div className="workstream-rail-list" role="list">
      {sessions.map((rs) => (
        <button
          key={rs.rootSessionId}
          className="rail-item"
          aria-current={selectedId === rs.rootSessionId ? "true" : undefined}
          onClick={() => navigateToSession(rs.rootSessionId)}
          title={titleFor(rs)}
        >
          <span className="rail-item-title">{titleFor(rs)}</span>
          <span className="rail-item-meta">{shortId(rs.workstreamId)} · {formatAge(rs.lastSeenAt)}</span>
          <span className="rail-counts">
            {rs.attentionCount > 0 ? <span className="mini-count attention">{rs.attentionCount}</span> : null}
            {rs.counts.active > 0 ? <span className="mini-count active">{rs.counts.active}</span> : null}
            <span className="mini-count">{rs.counts.total}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── KPI stat cards ── */
function KpiCards({ totals }: { totals: OperationsViewModel["counts"] }) {
  const cards = [
    { label: "Attention", value: totals.attention, hint: "Need action", kind: "attention" as const },
    { label: "Running", value: totals.active, hint: "Active now", kind: "running" as const },
    { label: "Recent", value: totals.recent, hint: "Last 24h", kind: "recent" as const },
    { label: "Total", value: totals.total, hint: "All agents", kind: "total" as const },
  ];
  return (
    <section className="ov-cards" aria-label="Global counts">
      {cards.map((c) => (
        <div key={c.kind} className={`ov-card ov-card--${c.kind}`}>
          <span className="ov-card__label">{c.label}</span>
          <span className="ov-card__value">{c.value}</span>
          <span className="ov-card__hint">{c.hint}</span>
        </div>
      ))}
    </section>
  );
}

/* ── Attention queue (hero) ── */
function AttentionQueue({ operations }: { operations: OperationsViewModel }) {
  const items = operations.attention.slice(0, 10);
  if (!items.length) return <div className="empty-state compact">No blocked or errored agents need attention.</div>;
  return (
    <div className="ov-attention-list">
      {items.map((item) => {
        const session = findSessionForAttention(item, operations.workstreams);
        const severity = item.status === "error" || item.status === "stopped" ? "danger" : "warn";
        return (
          <button
            key={`${item.runDir}-${item.reason}`}
            className={`ov-attention-item ${severity}`}
            onClick={() => session && navigateToSession(session.rootSessionId)}
            style={{ cursor: session ? "pointer" : "default" }}
          >
            <span className="ov-attention-icon" aria-hidden="true">
              <span className={`status-dot status-${item.status.toLowerCase()}`} />
            </span>
            <div className="ov-attention-body">
              <div className="ov-attention-title">
                <strong>{item.name}</strong>
                {item.needs ? <span className="need-chip">Needs: {item.needs}</span> : null}
              </div>
              <div className="agent-meta">{item.reason}{item.summary ? ` · ${item.summary}` : ""}</div>
              <div className="agent-meta">{session ? titleFor(session) : item.workstreamId || "Unscoped"}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ── Running now ── */
function RunningNow({ agents, sessions }: { agents: AgentSummary[]; sessions: RootSessionCard[] }) {
  if (!agents.length) return <div className="empty-state compact">No active agents right now.</div>;
  return (
    <div className="running-grid">
      {agents.slice(0, 8).map((agent) => {
        const session = findSessionForAttention(agent, sessions);
        return (
          <button
            key={agent.runDir}
            className="ov-recent__row actionable"
            onClick={() => session && navigateToSession(session.rootSessionId)}
            title={agent.commands.look}
          >
            <span className="ov-recent__key">
              <StatusChip status={agent.status} />
              <strong style={{ marginLeft: 6 }}>{agent.name}</strong>
            </span>
            <span className="ov-recent__time">{formatAge(agent.updatedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Recent completions ── */
function RecentCompletions({ events }: { events: TimelineEvent[] }) {
  const results = events.slice(0, 10);
  if (!results.length) return <div className="empty-state compact">No recent completed events.</div>;
  return (
    <div className="running-grid">
      {results.map((event, index) => {
        const rootSessionId = event.rootSessionId;
        return (
          <button
            key={`${event.runDir}-${event.time}-${index}`}
            className="ov-recent__row actionable"
            onClick={() => rootSessionId && navigateToSession(rootSessionId)}
          >
            <span className="ov-recent__key">
              <StatusChip status={event.status || event.type} />
              <strong style={{ marginLeft: 6 }}>{event.agent}</strong>
              {event.status === "done" && event.resultReady === false ? <span style={{ color: "var(--warn)", marginLeft: 6 }}>deliverable issue</span> : null}
              {event.status === "done" && event.resultReady ? <span style={{ color: "var(--success)", marginLeft: 6 }}>deliverable ready</span> : null}
            </span>
            <span className="ov-recent__time">{event.resultIssue || event.resultWarning || formatAge(event.time)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Recent artifacts ── */
function RecentArtifacts({ artifacts }: { artifacts: OperationsViewModel["recentArtifacts"] }) {
  if (!artifacts.length) return <div className="empty-state compact">No recent artifacts.</div>;
  return (
    <div className="running-grid">
      {artifacts.slice(0, 6).map((artifact) => (
        <a key={artifact.artifactId} className="ov-recent__row actionable" href={artifact.url} target="_blank" rel="noreferrer">
          <span className="ov-recent__key">{artifact.title || artifact.artifactId}</span>
          <span className="ov-recent__time">{formatAge(artifact.createdAt)}</span>
        </a>
      ))}
    </div>
  );
}

/* ── Timeline tail (collapsible) ── */
function TimelineTail({ events }: { events: TimelineEvent[] }) {
  const visible = events.slice(-20);
  if (!visible.length) return <div className="empty-state compact">No timeline events.</div>;
  return (
    <details className="card ov-event-log">
      <summary className="ov-expandable-toggle">
        <span>Global timeline tail</span>
        <span className="ov-count-badge">{events.length}</span>
      </summary>
      <div className="ov-event-log-list">
        {visible.map((e, i) => (
          <div key={`${e.runDir}-${e.time}-${i}`} className="ov-event-log-entry">
            <span className="ov-event-log-ts">{new Date(e.time).toLocaleTimeString()}</span>
            <span className="ov-event-log-name">{e.agent}</span>
            <span className="ov-event-log-status">{e.status || e.type}</span>
            {e.summary ? <span className="ov-event-log-payload">{e.summary}</span> : null}
            {e.needs ? <span className="ov-event-log-payload" style={{ color: "var(--warn)" }}>Needs: {e.needs}</span> : null}
            {e.resultIssue ? <span className="ov-event-log-payload" style={{ color: "var(--warn)" }}>Result issue: {e.resultIssue}</span> : null}
            {e.resultWarning ? <span className="ov-event-log-payload" style={{ color: "var(--warn)" }}>Result warning: {e.resultWarning}</span> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

export default function OperationsDashboard({
  operations,
}: {
  operations: OperationsViewModel;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => operations.suggestedRootSessionId ?? operations.workstreams[0]?.rootSessionId
  );

  useEffect(() => {
    if (!operations.workstreams.length) {
      setSelectedId(undefined);
      return;
    }
    if (!selectedId || !operations.workstreams.some((rs) => rs.rootSessionId === selectedId)) {
      setSelectedId(operations.suggestedRootSessionId ?? operations.workstreams[0].rootSessionId);
    }
  }, [operations.workstreams, operations.suggestedRootSessionId, selectedId]);

  const sortedSessions = useMemo(() => [...operations.workstreams], [operations.workstreams]);

  return (
    <div className="operations-dashboard">
      <aside className="workstream-rail" aria-label="Workstreams">
        <div className="rail-heading">
          <span>Workstreams</span>
          <span className="badge">{operations.workstreams.length}</span>
        </div>
        <WorkstreamRail sessions={sortedSessions} selectedId={selectedId} />
      </aside>

      <div className="operations-main">
        <KpiCards totals={operations.counts} />

        <div className="ops-middle-grid">
          <section className="ops-panel attention-panel-ops">
            <h3>Attention queue</h3>
            <AttentionQueue operations={operations} />
          </section>

          <div className="ops-right-stack">
            <section className="ops-panel">
              <h3>Running now</h3>
              <RunningNow agents={operations.activeAgents} sessions={operations.workstreams} />
            </section>
            <section className="ops-panel">
              <h3>Recent completed events</h3>
              <RecentCompletions events={operations.recentCompletions ?? operations.recentResults} />
            </section>
            <section className="ops-panel">
              <h3>Recent artifacts</h3>
              <RecentArtifacts artifacts={operations.recentArtifacts} />
            </section>
          </div>
        </div>

        <TimelineTail events={operations.timelineTail} />
      </div>
    </div>
  );
}
