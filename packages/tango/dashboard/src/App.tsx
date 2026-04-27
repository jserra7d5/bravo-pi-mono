import { useEffect, useState, useCallback, useRef } from "react";
import AppShell from "./components/AppShell";
import SessionOverview from "./components/SessionOverview";
import OperationsDashboard from "./components/OperationsDashboard";
import AttentionPanel from "./components/AttentionPanel";
import ArtifactPanel from "./components/ArtifactPanel";
import TimelinePanel from "./components/TimelinePanel";
import HistoryPanel from "./components/HistoryPanel";
import {
  fetchOperations,
  fetchGlobalAttention,
  fetchGlobalTimeline,
  fetchArtifacts,
  fetchHistory,
  subscribeEvents,
} from "./api";
import type { OperationsViewModel, AttentionItem, TimelineEvent, ArtifactViewModel } from "./types";

type Page =
  | { page: "sessions" }
  | { page: "session"; rootSessionId: string }
  | { page: "attention" }
  | { page: "artifacts" }
  | { page: "timeline" }
  | { page: "history" };

type LiveState = { connected: boolean; stale: boolean; error: string; lastUpdated?: Date };

function parseHash(): Page {
  const hash = location.hash.replace(/^#\/?/, "");
  if (!hash) return { page: "sessions" };
  if (hash.startsWith("sessions/")) {
    const id = decodeURIComponent(hash.slice("sessions/".length));
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
  const pageRef = useRef<Page>(page);
  const [operations, setOperations] = useState<OperationsViewModel | null>(null);
  const [globalAttention, setGlobalAttention] = useState<AttentionItem[]>([]);
  const [globalTimeline, setGlobalTimeline] = useState<TimelineEvent[]>([]);
  const [globalArtifacts, setGlobalArtifacts] = useState<ArtifactViewModel[]>([]);
  const [history, setHistory] = useState<{ historical: any[]; legacy: any[] } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [live, setLive] = useState<LiveState>({ connected: false, stale: true, error: "" });

  useEffect(() => { pageRef.current = page; }, [page]);

  const markRefreshed = useCallback(() => {
    setLive((s) => ({ ...s, stale: false, error: "", lastUpdated: new Date() }));
  }, []);

  const refreshActive = useCallback(async (reason = "manual") => {
    const active = pageRef.current;
    setLoadError("");
    try {
      if (active.page === "sessions") {
        const nextOperations = await fetchOperations();
        setOperations(nextOperations);
        setGlobalTimeline(nextOperations.timelineTail);
        setRefreshNonce((n) => n + 1);
      } else if (active.page === "attention") setGlobalAttention((await fetchGlobalAttention()).attention);
      else if (active.page === "artifacts") setGlobalArtifacts((await fetchArtifacts()).artifacts);
      else if (active.page === "timeline") setGlobalTimeline((await fetchGlobalTimeline()).events);
      else if (active.page === "history") setHistory(await fetchHistory());
      else if (active.page === "session") setRefreshNonce((n) => n + 1);
      markRefreshed();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setLoadError(message);
      setLive((s) => ({ ...s, stale: true, error: `${reason}: ${message}` }));
    }
  }, [markRefreshed]);

  useEffect(() => {
    refreshActive("page");
  }, [page, refreshActive]);

  useEffect(() => {
    let debounce: number | undefined;
    const schedule = (reason: string) => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => refreshActive(reason), 250);
    };
    const unsub = subscribeEvents(
      (event) => { if (event.type !== "hello") schedule("event"); },
      () => setLive((s) => ({ ...s, connected: false, stale: true, error: "Event stream disconnected; polling fallback active." })),
      () => setLive((s) => ({ ...s, connected: true, error: "" }))
    );
    const poll = window.setInterval(() => schedule("poll"), 10000);
    const freshness = window.setInterval(() => {
      setLive((s) => ({ ...s, stale: !s.lastUpdated || Date.now() - s.lastUpdated.getTime() > 30000 }));
    }, 5000);
    const onHash = () => setPage(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      window.clearTimeout(debounce);
      window.clearInterval(poll);
      window.clearInterval(freshness);
      unsub();
      window.removeEventListener("hashchange", onHash);
    };
  }, [refreshActive]);

  const navigate = useCallback((key: string) => {
    location.hash = `/${key}`;
  }, []);

  const activeNav = page.page === "session" ? "sessions" : page.page;

  return (
    <AppShell active={activeNav} onNavigate={navigate} live={live}>
      {loadError ? <div className="empty-state" role="alert">Refresh error: {loadError}</div> : null}

      {page.page === "sessions" && (
        <>
          {!operations ? <div className="empty-state">Loading operations dashboard…</div> : (
            <OperationsDashboard
              operations={operations}
            />
          )}
        </>
      )}

      {page.page === "session" && (
        <SessionOverview
          rootSessionId={page.rootSessionId}
          refreshNonce={refreshNonce}
          onRefreshed={markRefreshed}
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

      {page.page === "history" && (history ? <HistoryPanel historical={history.historical} legacy={history.legacy} /> : <div className="empty-state">Loading history…</div>)}
    </AppShell>
  );
}
