import { RunStore } from "../../src/runStore.js";
import { readWatcherSnapshot, type RunSummaryRow } from "../../src/watcher.js";
import { formatRunRow, type TextTheme } from "./renderers.js";

export interface LiveWidgetInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
  maxRows?: number;
  terminalCompletedVisibleMs?: number;
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

function isTerminal(row: RunSummaryRow): boolean {
  return TERMINAL_STATES.has(row.state);
}

function visible(row: RunSummaryRow, now: number, terminalCompletedVisibleMs: number): boolean {
  if (!isTerminal(row)) return ["created", "queued", "running", "idle", "waiting_for_input", "blocked", "stalled", "paused"].includes(row.state);
  if (row.state !== "completed") return true;
  const updatedAt = Date.parse(row.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return now - updatedAt <= terminalCompletedVisibleMs;
}

function rowPriority(row: RunSummaryRow): number {
  if (row.state === "waiting_for_input" || row.state === "blocked") return 0;
  if (!isTerminal(row)) return 1;
  return 2;
}

export function renderLiveWidget(input: LiveWidgetInput, theme?: TextTheme): string[] {
  const maxRows = input.maxRows ?? 5;
  const now = Date.now();
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 5 * 60_000;
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
  });
  const rows = snapshot.rows
    .filter((row) => visible(row, now, terminalCompletedVisibleMs))
    .sort((a, b) => rowPriority(a) - rowPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
  if (!rows.length) return [];
  const finished = rows.filter((row) => row.state === "completed").length;
  const failed = rows.filter((row) => row.state === "failed" || row.state === "cancelled" || row.state === "expired").length;
  const terminal = [finished ? `${finished} finished` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" - ");
  const header = `Async subagents: ${snapshot.activeRunIds.length} running - ${snapshot.blockedRunIds.length} waiting${terminal ? ` - ${terminal}` : ""}`;
  const lines = [header, ...rows.slice(0, maxRows).map((row) => formatRunRow(row, theme))];
  if (rows.length > maxRows) lines.push(`+${rows.length - maxRows} more`);
  return lines;
}

export function updateLiveWidget(ctx: unknown, input: LiveWidgetInput): void {
  const ui = (ctx as { ui?: { setWidget?: (key: string, value: unknown, options?: Record<string, unknown>) => void } } | undefined)?.ui;
  if (!ui?.setWidget) return;
  const lines = renderLiveWidget(input);
  ui.setWidget("async-subagents-live", lines.length ? lines : undefined, { placement: "belowEditor" });
}
