import { RunStore } from "../../src/runStore.js";
import { readWatcherSnapshot, type RunSummaryRow } from "../../src/watcher.js";
import { renderWidgetCard, widgetRowFromSummary, type WidgetRowInput } from "./renderers.js";

export interface LiveWidgetInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
  maxRows?: number;
  terminalCompletedVisibleMs?: number;
  // Optional explicit width — when omitted (the production path), pi tells the
  // widget its real container width via the Component.render(width) callback.
  // This is required: pi's widget container is narrower than the full terminal,
  // so picking `process.stdout.columns` would overflow and wrap the chrome.
  width?: number;
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

// Clamp into the chrome's supported range. The lower bound is the smallest
// width the card layout (`pickWidgetLayout`) can still draw legibly; the upper
// bound keeps very wide containers from stretching the card across the screen.
function clampWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 64;
  return Math.max(28, Math.min(96, Math.floor(width)));
}

interface BuildResult {
  rows: RunSummaryRow[];
  totalCost: number | undefined;
}

function buildSnapshot(input: LiveWidgetInput, now: number, terminalCompletedVisibleMs: number): BuildResult {
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
  });
  const rows = snapshot.rows
    .filter((row) => visible(row, now, terminalCompletedVisibleMs))
    .sort((a, b) => rowPriority(a) - rowPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
  let total = 0;
  let any = false;
  for (const row of rows) {
    const cost = row.metrics?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      total += cost;
      any = true;
    }
  }
  return { rows, totalCost: any ? total : undefined };
}

function renderAt(input: LiveWidgetInput, width: number, now: number): string[] {
  const maxRows = input.maxRows ?? 5;
  const terminalCompletedVisibleMs = input.terminalCompletedVisibleMs ?? 5 * 60_000;
  const { rows, totalCost } = buildSnapshot(input, now, terminalCompletedVisibleMs);
  if (!rows.length) return [];
  const widgetRows: WidgetRowInput[] = rows.map((row) => widgetRowFromSummary(row, now));
  return renderWidgetCard({ width: clampWidth(width), rows: widgetRows, maxRows, totalCost });
}

// Exposed for tests and the few callers that want a one-shot static render
// (e.g. plain-text transcripts). The production code path goes through the
// factory below so pi can pass its real container width on every redraw.
export function renderLiveWidget(input: LiveWidgetInput): string[] {
  const now = Date.now();
  // When width is explicit (tests / fixtures) honor it; otherwise fall back to
  // the previous heuristic so non-component callers keep working.
  const width = input.width ?? (() => {
    const term = typeof process !== "undefined" ? process.stdout?.columns : undefined;
    return typeof term === "number" && term > 0 ? term : 64;
  })();
  return renderAt(input, width, now);
}

interface LiveWidgetComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

function createLiveWidgetComponent(input: LiveWidgetInput): LiveWidgetComponent {
  // Pi calls `render(width)` with the actual container width on every redraw,
  // so the snapshot is always fresh — there's no need to cache it across
  // frames. Trust the width arg; do not consult `process.stdout.columns`.
  return {
    render(width: number) {
      return renderAt(input, width, Date.now());
    },
    invalidate() {},
    dispose() {},
  };
}

interface UiSetWidget {
  setWidget?: (
    key: string,
    value: string[] | undefined | ((tui: unknown, theme: unknown) => LiveWidgetComponent),
    options?: Record<string, unknown>,
  ) => void;
}

export function updateLiveWidget(ctx: unknown, input: LiveWidgetInput): void {
  const ui = (ctx as { ui?: UiSetWidget } | undefined)?.ui;
  if (!ui?.setWidget) return;
  // Cheap probe so we can drop the widget entirely when there's nothing to
  // show — pi keeps showing the previous content otherwise. The probe uses a
  // 64-wide render purely for the visibility check; the factory below will
  // re-evaluate at the real container width.
  const probeLines = renderAt(input, 64, Date.now());
  if (!probeLines.length) {
    ui.setWidget("async-subagents-live", undefined, { placement: "belowEditor" });
    return;
  }
  ui.setWidget(
    "async-subagents-live",
    () => createLiveWidgetComponent(input),
    { placement: "belowEditor" },
  );
}
