import type { MonitorRecord, MonitorResult } from "../schema/types.js";

function truncate(value: string | undefined, max = 120): string | undefined {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function commandSummary(check: any): string | undefined {
  if (check?.type !== "command") return undefined;
  const parts = [`command=${JSON.stringify(truncate(check.command) ?? "")}`];
  if (check.cwd) parts.push(`cwd=${check.cwd}`);
  if (check.timeout_ms) parts.push(`timeout_ms=${check.timeout_ms}`);
  return parts.join(" ");
}

export function monitorRow(m: MonitorRecord): string {
  const check: any = m.check;
  const name = m.name ? ` ${m.name}` : "";
  const summary = commandSummary(check) ?? (check?.type === "file" ? `path=${check.path} mode=${check.mode}` : "");
  return `${m.monitor_id} state=${m.state} type=${check?.type ?? "unknown"}${name}${summary ? ` ${summary}` : ""}`;
}

export function resultSummary(r: MonitorResult | undefined): string | undefined {
  if (!r) return undefined;
  const obs: any = r.observation ?? {};
  const bits = [`recent_result=${r.status}`, `triggered=${r.triggered}`];
  if (obs.exit_code !== undefined) bits.push(`exit_code=${obs.exit_code}`);
  if (obs.signal !== undefined) bits.push(`signal=${obs.signal}`);
  if (r.error_message) bits.push(`error=${truncate(r.error_message, 100)}`);
  return bits.join(" ");
}

export function monitorLookText(m: MonitorRecord, results: MonitorResult[]): string {
  const check: any = m.check;
  const lines = [`Monitor ${m.monitor_id}${m.name ? ` ${m.name}` : ""}${m.description ? ` - ${m.description}` : ""}`, `state=${m.state} type=${check?.type ?? "unknown"}`];
  if (check?.type === "command") {
    lines.push(commandSummary(check)!);
    const latestObs: any = results[0]?.observation ?? {};
    if (latestObs.output_file) lines.push(`output_file=${latestObs.output_file}`);
  } else {
    const schedule = Object.entries(m.schedule ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
    if (schedule) lines.push(`schedule ${schedule}`);
    if (m.next_run_at) lines.push(`next_run_at=${m.next_run_at}`);
    if (m.last_run_at) lines.push(`last_run_at=${m.last_run_at}`);
  }
  const recent = resultSummary(results[0]);
  if (recent) lines.push(recent);
  return lines.join("\n");
}
