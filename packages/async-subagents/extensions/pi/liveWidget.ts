import { RunStore } from "../../src/runStore.js";
import { readWatcherSnapshot, type RunSummaryRow } from "../../src/watcher.js";
import { formatRunRow, type TextTheme } from "./renderers.js";

export interface LiveWidgetInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
  maxRows?: number;
}

function visible(row: RunSummaryRow): boolean {
  if (row.resultReady || row.result) return true;
  return ["created", "queued", "running", "waiting_for_input", "blocked", "stalled"].includes(row.state);
}

export function renderLiveWidget(input: LiveWidgetInput, theme?: TextTheme): string[] {
  const maxRows = input.maxRows ?? 4;
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
  });
  const rows = snapshot.rows.filter(visible);
  if (!rows.length) return [];
  const header = `Async subagents: ${snapshot.activeRunIds.length} active - ${snapshot.blockedRunIds.length} blocked - ${snapshot.resultReadyRunIds.length} result`;
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
