import type { RunSummaryRow } from "../../src/watcher.js";
import type { RunEvent, RunResult, RunStatus, SubagentMessageResult, SubagentStartResult, SubagentWaitResult } from "../../src/types.js";

export interface TextTheme {
  fg?: (name: string, value: string) => string;
}

export interface RenderOptions {
  expanded?: boolean;
}

export interface TextRenderable {
  invalidate(): void;
  render(width: number): string[];
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

function mention(displayName: string | undefined, fallback: string, theme?: TextTheme): string {
  const label = displayName ? `@${displayName}` : fallback;
  return color(theme, "agentMention", label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function knownDisplayNames(details: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (typeof details.displayName === "string" && details.displayName) names.push(details.displayName);
  if (Array.isArray(details.results)) {
    for (const result of details.results) {
      if (isRecord(result) && typeof result.displayName === "string" && result.displayName) names.push(result.displayName);
    }
  }
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

function colorKnownMentions(text: string, displayNames: string[], theme?: TextTheme): string {
  if (!theme?.fg || !displayNames.length) return text;
  const pattern = new RegExp(`@(${displayNames.map(escapeRegExp).join("|")})(?=$|[\\s.,;:!?\\])}])`, "g");
  return text.replace(pattern, (value) => color(theme, "agentMention", value));
}

function safeWidth(width: unknown): number {
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
}

function truncate(line: string, width: unknown): string {
  const max = safeWidth(width);
  return line.length <= max ? line : line.slice(0, Math.max(0, max - 1));
}

export function textBlock(value: string | string[]): TextRenderable {
  const lines = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return {
    invalidate() {},
    render(width: number) {
      return lines.map((line) => truncate(line, width));
    },
  };
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
    case "paused":
      return "|";
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

function humanState(state: string | undefined): string {
  switch (state) {
    case "created":
    case "queued":
      return "starting";
    case "running":
      return "working";
    case "idle":
      return "idle";
    case "waiting_for_input":
      return "waiting";
    case "blocked":
      return "blocked";
    case "stalled":
      return "stalled";
    case "paused":
      return "paused";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      return state ?? "unknown";
  }
}

function compactDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function since(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return compactDuration(now - time);
}

export function formatRunRow(row: RunSummaryRow, theme?: TextTheme): string {
  const status = humanState(row.state);
  const summary = preview(row.needs ?? row.summary ?? row.event?.summary ?? row.result?.summary, 72);
  const displayName = mention(row.displayName, row.agentName, theme);
  const activity = since(row.lastActivityAt ?? row.updatedAt);
  const duration = typeof row.result?.durationMs === "number" ? compactDuration(row.result.durationMs) : undefined;
  const timing = duration ? `in ${duration}` : activity ? `${activity} ago` : "";
  const glyph = color(theme, "accent", stateGlyph(row.state, row.resultReady || Boolean(row.result)));
  const kind = color(theme, "accent", row.agentName);
  const state = color(theme, "accent", status);
  return `${glyph} ${displayName} ${kind} ${state}${timing ? color(theme, "dim", ` ${timing}`) : ""}${summary ? color(theme, "muted", ` - ${summary}`) : ""}`;
}

export function summarizeStartResult(result: SubagentStartResult): string {
  const action = result.waited ? "started and waited" : "started";
  const label = result.displayName ? `@${result.displayName} (${result.agentName})` : result.agentName;
  return `Subagent ${result.runId} ${action}: ${label} (${result.state})`;
}

function formatResultSummary(result: RunResult, theme?: TextTheme): string {
  const label = result.displayName ? `${mention(result.displayName, result.agentName, theme)} ${result.agentName}` : result.agentName;
  const duration = typeof result.durationMs === "number" ? ` in ${compactDuration(result.durationMs)}` : "";
  const summary = result.summary ? ` - ${preview(result.summary, 96)}` : "";
  return `${label} ${humanState(result.state)}${duration}${summary}`;
}

export function summarizeWaitResult(result: SubagentWaitResult): string {
  if (result.state === "timeout") return `No subagent updates before timeout (${result.remainingRunIds.length} remaining)`;
  if (result.results.length) {
    const shown = result.results.slice(0, 2).map((readyResult) => formatResultSummary(readyResult)).join("; ");
    const more = result.results.length > 2 ? `; +${result.results.length - 2} more` : "";
    return `Subagent wait: ${result.results.length} result${result.results.length === 1 ? "" : "s"} - ${shown}${more}`;
  }
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
  return `Subagent result: ${formatResultSummary(result)}`;
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
  if (target === "subagents" && !task) return color(theme, "toolTitle", "subagents");
  return `${color(theme, "toolTitle", "subagent")} ${color(theme, "accent", target)}${color(theme, "muted", task)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function resultBodyLines(details: Record<string, unknown>, expanded: boolean, theme?: TextTheme): string[] {
  if (!expanded) return [];
  if (typeof details.body === "string" && details.body.trim()) return ["", details.body];
  if (!Array.isArray(details.results)) return [];
  return details.results.flatMap((result) => {
    if (!isRecord(result) || typeof result.body !== "string" || !result.body.trim()) return [];
    const agent = typeof result.agentName === "string" ? result.agentName : "subagent";
    const label = typeof result.displayName === "string" ? `${mention(result.displayName, agent, theme)} ${agent}` : agent;
    return ["", `${label}:`, result.body];
  });
}

export function renderSubagentToolResult(result: unknown, options?: RenderOptions, theme?: TextTheme): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const data = result as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
  const details = data.details ?? {};
  const text = data.content?.[0]?.text;
  const summary = typeof details.summary === "string" ? details.summary : text;
  const displayNames = knownDisplayNames(details);
  const renderedSummary = colorKnownMentions(summary ?? JSON.stringify(details), displayNames, theme);
  const lines = [color(theme, "muted", renderedSummary), ...resultBodyLines(details, Boolean(options?.expanded), theme)];
  return lines.join("\n");
}

export function renderSubagentToolCallComponent(args: Record<string, unknown>, theme?: TextTheme): TextRenderable {
  return textBlock(renderSubagentToolCall(args, theme));
}

export function renderSubagentToolResultComponent(result: unknown, options?: RenderOptions, theme?: TextTheme): TextRenderable {
  return textBlock(renderSubagentToolResult(result, options, theme));
}

export function renderSubagentWakeMessage(message: WakeupMessage, options?: RenderOptions, theme?: TextTheme): string {
  const title = message.result?.displayName
    ? `${mention(message.result.displayName, message.title, theme)} ${message.result.agentName ?? "subagent"}`
    : message.title;
  const lines = [
    `${color(theme, "accent", stateGlyph(message.state, Boolean(message.result)))} ${color(theme, "toolTitle", title)} ${color(theme, "dim", message.runId)}`,
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
  renderSubagentToolCallComponent,
  renderSubagentToolResultComponent,
  renderSubagentWakeMessage,
  formatRunRow,
  renderDetailCard,
};
