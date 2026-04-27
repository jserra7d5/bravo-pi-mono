import React from "react";

export default function AppShell({
  children,
  active,
  onNavigate,
}: {
  children: React.ReactNode;
  active: string;
  onNavigate: (page: string) => void;
}) {
  const links = [
    { key: "sessions", label: "Sessions" },
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
        </div>
      </header>
      <main className="app-main" role="main">
        {children}
      </main>
      <footer className="app-footer">
        Tango orchestration dashboard · Local only
      </footer>
    </div>
  );
}
