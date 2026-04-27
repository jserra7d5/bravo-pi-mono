import React from "react";

export default function AppShell({
  children,
  active,
  onNavigate,
  live,
}: {
  children: React.ReactNode;
  active: string;
  onNavigate: (page: string) => void;
  live?: { connected: boolean; stale: boolean; error: string; lastUpdated?: Date };
}) {
  const links = [
    { key: "sessions", label: "Operations" },
    { key: "attention", label: "Attention" },
    { key: "artifacts", label: "Artifacts" },
    { key: "timeline", label: "Timeline" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">Tango</h1>
          <nav className="app-nav" aria-label="Main navigation">
            {links.map((l) => (
              <a
                key={l.key}
                href={`#/${l.key}`}
                aria-current={active === l.key ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(l.key);
                }}
              >
                {l.label}
              </a>
            ))}
          </nav>
          {live ? (
            <div className={`live-indicator ${live.connected ? "live-connected" : "live-disconnected"} ${live.stale ? "live-stale" : ""}`} title={live.error || undefined}>
              <span>{live.connected ? "Live" : "Polling"}</span>
              <span>·</span>
              <span>{live.lastUpdated ? `Updated ${live.lastUpdated.toLocaleTimeString()}` : "Waiting for data"}</span>
              {live.stale ? <span>· Stale</span> : null}
            </div>
          ) : null}
        </div>
      </header>
      <main className="app-main" role="main">
        {children}
      </main>
    </div>
  );
}
