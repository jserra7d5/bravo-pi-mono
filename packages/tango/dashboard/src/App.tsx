import { useEffect, useState, useCallback } from "react";
import AppShell from "./components/AppShell";
import RootSessionList from "./components/RootSessionList";
import SessionOverview from "./components/SessionOverview";
import AttentionPanel from "./components/AttentionPanel";
import ArtifactPanel from "./components/ArtifactPanel";
import TimelinePanel from "./components/TimelinePanel";
import HistoryPanel from "./components/HistoryPanel";
import {
  fetchDashboard,
  fetchGlobalAttention,
  fetchGlobalTimeline,
  fetchArtifacts,
  fetchHistory,
  subscribeEvents,
} from "./api";
import type { DashboardViewModel, AttentionItem, TimelineEvent, ArtifactViewModel } from "./types";

type Page =
  | { page: "sessions" }
  | { page: "session"; rootSessionId: string }
  | { page: "attention" }
  | { page: "artifacts" }
  | { page: "timeline" }
  | { page: "history" };

function parseHash(): Page {
  const hash = location.hash.replace(/^#\/?/, "");
  if (!hash) return { page: "sessions" };
  if (hash.startsWith("sessions/")) {
    const id = hash.slice("sessions/".length);
    if (id) return { page: "session", rootSessionId: id };
  }
  if (hash === "attention") return { page: "attention" };
  if (hash === "artifacts") return { page: "artifacts" };
  if (hash === "timeline") return { page: "timeline" };
  if (hash === "history") return { page: "history" };
  return { page: "sessions" };
}

export default function App() {
  const [page, setPage] = useState<Page>(parseHash);
  const [dashboard, setDashboard] = useState<DashboardViewModel | null>(null);
  const [globalAttention, setGlobalAttention] = useState<AttentionItem[]>([]);
  const [globalTimeline, setGlobalTimeline] = useState<TimelineEvent[]>([]);
  const [globalArtifacts, setGlobalArtifacts] = useState<ArtifactViewModel[]>([]);
  const [history, setHistory] = useState<{ historical: any[]; legacy: any[] } | null>(null);

  const refreshAll = useCallback(() => {
    fetchDashboard().then(setDashboard).catch(() => {});
    fetchGlobalAttention().then((r) => setGlobalAttention(r.attention)).catch(() => {});
    fetchGlobalTimeline().then((r) => setGlobalTimeline(r.events)).catch(() => {});
    fetchArtifacts().then((r) => setGlobalArtifacts(r.artifacts)).catch(() => {});
    fetchHistory().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    refreshAll();
    const unsub = subscribeEvents(refreshAll);
    const onHash = () => setPage(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      unsub();
      window.removeEventListener("hashchange", onHash);
    };
  }, [refreshAll]);

  const navigate = useCallback((key: string) => {
    location.hash = `/${key}`;
  }, []);

  const activeNav = page.page === "session" ? "sessions" : page.page;

  return (
    <AppShell active={activeNav} onNavigate={navigate}>
      {page.page === "sessions" && (
        <>
          <h2 className="section-title">Root Sessions</h2>
          <RootSessionList
            sessions={dashboard?.rootSessions ?? []}
            onSelect={(id) => {
              location.hash = `/sessions/${encodeURIComponent(id)}`;
            }}
          />
          {dashboard && dashboard.globalAttention.length > 0 && (
            <>
              <h2 className="section-title">Global Attention</h2>
              <AttentionPanel items={dashboard.globalAttention} />
            </>
          )}
        </>
      )}

      {page.page === "session" && (
        <SessionOverview
          rootSessionId={page.rootSessionId}
          onBack={() => {
            location.hash = "/sessions";
          }}
        />
      )}

      {page.page === "attention" && (
        <>
          <h2 className="section-title">Global Attention</h2>
          <AttentionPanel items={globalAttention} />
        </>
      )}

      {page.page === "artifacts" && (
        <>
          <h2 className="section-title">All Artifacts</h2>
          <ArtifactPanel artifacts={globalArtifacts} />
        </>
      )}

      {page.page === "timeline" && (
        <>
          <h2 className="section-title">Global Timeline</h2>
          <TimelinePanel events={globalTimeline} />
        </>
      )}

      {page.page === "history" && history && (
        <HistoryPanel historical={history.historical} legacy={history.legacy} />
      )}
    </AppShell>
  );
}
