export function truncateToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 1) + "…";
}

export function formatMonitorRow(m: {
  monitor_id: string;
  name?: string;
  state: string;
  next_run_at?: string;
  last_run_at?: string;
  check: { type: string; path?: string; mode?: string };
}, width = 120): string {
  const icon = stateIcon(m.state);
  const name = (m.name || m.monitor_id).slice(0, 20);
  const state = m.state.padEnd(10);
  const timing = m.state === "paused" ? "—" : m.next_run_at ? `next ${formatShortDuration(Date.parse(m.next_run_at) - Date.now())}` : m.last_run_at ? `${formatShortDuration(Date.now() - Date.parse(m.last_run_at))} ago` : "—";
  const check = `${m.check.type}${m.check.mode ? ` ${m.check.mode}` : ""}${m.check.path ? ` ${m.check.path}` : ""}`;
  const line = `${icon} ${name.padEnd(22)} ${state} ${timing.padEnd(12)} ${check}`;
  return truncateToWidth(line, width);
}

function stateIcon(state: string): string {
  switch (state) {
    case "running": return "●";
    case "paused": return "⏸";
    case "triggered": return "!";
    case "failed": return "✗";
    case "succeeded": return "✓";
    case "stopped": return "■";
    default: return "○";
  }
}

function formatShortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}
