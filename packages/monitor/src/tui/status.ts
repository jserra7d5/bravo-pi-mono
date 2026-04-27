export type MonitorStatusSummary = {
  active: number;
  triggered: number;
  failed: number;
  nextRunIn?: string;
};

export function computeStatusSummary(monitors: Array<{ state: string; next_run_at?: string }>): MonitorStatusSummary {
  const active = monitors.filter((m) => m.state === "running" || m.state === "paused").length;
  const triggered = monitors.filter((m) => m.state === "triggered").length;
  const failed = monitors.filter((m) => m.state === "failed").length;

  let nextRunIn: string | undefined;
  const nextRun = monitors
    .filter((m) => m.state === "running" && m.next_run_at)
    .map((m) => Date.parse(m.next_run_at!))
    .filter((t) => !Number.isNaN(t) && t > Date.now())
    .sort((a, b) => a - b)[0];
  if (nextRun !== undefined) {
    const ms = nextRun - Date.now();
    nextRunIn = formatShortDuration(ms);
  }

  return { active, triggered, failed, nextRunIn };
}

export function renderMonitorStatus(summary: MonitorStatusSummary): string | undefined {
  if (summary.active === 0 && summary.triggered === 0 && summary.failed === 0) {
    return "Monitors: idle";
  }
  const parts: string[] = [`${summary.active} active`];
  if (summary.triggered) parts.push(`${summary.triggered} triggered`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.nextRunIn) parts.push(`next ${summary.nextRunIn}`);
  return `Monitors: ${parts.join(" · ")}`;
}

function formatShortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}
