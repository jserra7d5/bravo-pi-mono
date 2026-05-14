import type { RunSummaryRow } from "../../src/watcher.js";
import type { RunEvent, RunResult, RunStatus, SubagentMessageResult, SubagentStartResult, SubagentWaitResult } from "../../src/types.js";

export interface TextTheme {
  fg?: (name: string, value: string) => string;
}

export interface RenderOptions {
  expanded?: boolean;
}

export interface WakeupMessage {
  kind: "subagent_wakeup";
  title: string;
  runId: string;
  runDir?: string;
  state?: string;
  summary?: string;
  body?: string;
  event?: RunEvent;
  result?: RunResult;
  next?: Array<{ tool: string; args: Record<string, unknown> }>;
}

function color(theme: TextTheme | undefined, name: string, value: string): string {
  return theme?.fg ? theme.fg(name, value) : value;
}

export function preview(value: string | undefined, max = 120): string {
  if (!value) return "";
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, Math.max(0, max - 1))}...`;
}

export function stateGlyph(state: string | undefined, resultReady = false): string {
  if (resultReady) return "*";
  switch (state) {
    case "running":
    case "queued":
    case "created":
      return "~";
    case "waiting_for_input":
    case "question":
      return "?";
    case "blocked":
      return "!";
    case "completed":
      return "+";
    case "failed":
      return "x";
    case "cancelled":
    case "expired":
      return "-";
    default:
      return "-";
  }
}

export function formatRunRow(row: RunSummaryRow, theme?: TextTheme): string {
  const status = row.resultReady || row.result ? "result" : row.state;
  const summary = preview(row.needs ?? row.summary ?? row.event?.summary ?? row.result?.summary, 72);
  const head = `${stateGlyph(row.state, row.resultReady || Boolean(row.result))} ${row.agentName} ${status}`;
  return `${color(theme, "accent", head)} ${color(theme, "dim", row.runId)}${summary ? color(theme, "muted", ` - ${summary}`) : ""}`;
}

export function summarizeStartResult(result: SubagentStartResult): string {
  const action = result.waited ? "started and waited" : "started";
  return `Subagent ${result.runId} ${action}: ${result.agentName} (${result.state})`;
}

export function summarizeWaitResult(result: SubagentWaitResult): string {
  if (result.state === "timeout") return `No subagent updates before timeout (${result.remainingRunIds.length} remaining)`;
  const parts = [
    `${result.readyRunIds.length} ready`,
    result.results.length ? `${result.results.length} result` : "",
    result.events.length ? `${result.events.length} event` : "",
  ].filter(Boolean);
  return `Subagent wait: ${parts.join(", ")}`;
}

export function summarizeMessageResult(result: SubagentMessageResult): string {
  if (result.unsupported) return `Message ${result.messageId} appended to ${result.runId}; live delivery unsupported`;
  return `Message ${result.messageId} appended to ${result.runId}${result.liveDelivered ? " and delivered" : ""}`;
}

export function summarizeRunResult(result: RunResult | undefined, runId: string): string {
  if (!result) return `Result not ready for ${runId}`;
  return `Subagent ${runId} result: ${result.state}${result.summary ? ` - ${preview(result.summary, 96)}` : ""}`;
}

export function summarizeStatusRows(rows: Array<Pick<RunStatus, "runId" | "state" | "summary">>): string {
  if (!rows.length) return "No subagent runs found";
  const active = rows.filter((row) => !["completed", "failed", "cancelled", "expired"].includes(row.state)).length;
  const results = rows.filter((row) => ["completed", "failed", "cancelled", "expired"].includes(row.state)).length;
  return `Subagent status: ${active} active, ${results} terminal, ${rows.length} total`;
}

export function renderSubagentToolCall(args: Record<string, unknown>, theme?: TextTheme): string {
  const target = typeof args.runId === "string" ? args.runId : typeof args.agent === "string" ? args.agent : "subagents";
  const task = typeof args.task === "string" ? ` - ${preview(args.task, 90)}` : "";
  return `${color(theme, "toolTitle", "subagent")} ${color(theme, "accent", target)}${color(theme, "muted", task)}`;
}

export function renderSubagentToolResult(result: unknown, _options?: RenderOptions, theme?: TextTheme): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const data = result as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
  const details = data.details ?? {};
  const text = data.content?.[0]?.text;
  const summary = typeof details.summary === "string" ? details.summary : text;
  return color(theme, "muted", summary ?? JSON.stringify(details));
}

export function renderSubagentWakeMessage(message: WakeupMessage, options?: RenderOptions, theme?: TextTheme): string {
  const lines = [
    `${color(theme, "accent", stateGlyph(message.state, Boolean(message.result)))} ${color(theme, "toolTitle", message.title)} ${color(theme, "dim", message.runId)}`,
  ];
  const summary = preview(message.summary ?? message.result?.summary ?? message.event?.summary, 120);
  if (summary) lines.push(color(theme, "muted", summary));
  if (options?.expanded && message.body) lines.push(preview(message.body, 500));
  return lines.join("\n");
}

export function renderDetailCard(details: Record<string, unknown>, expanded = false): string {
  const keys = expanded ? Object.keys(details) : Object.keys(details).slice(0, 8);
  return keys.map((key) => `${key}: ${JSON.stringify(details[key])}`).join("\n");
}

export const renderers = {
  renderSubagentToolCall,
  renderSubagentToolResult,
  renderSubagentWakeMessage,
  formatRunRow,
  renderDetailCard,
};
