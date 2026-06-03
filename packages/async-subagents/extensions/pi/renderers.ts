import type { RunSummaryRow } from "../../src/watcher.js";
import type { DerivedTaskState, RunEvent, RunResult, RunStatus, SubagentMessageResult, SubagentStartResult, TaskEvent, TaskRecord } from "../../src/types.js";
import { deriveTaskState, unresolvedDependencies } from "../../src/taskState.js";

export interface TextTheme {
  fg?: (name: string, value: string) => string;
}

export interface RenderOptions {
  expanded?: boolean;
}

export type SubagentToolName =
  | "subagent_start"
  | "subagent_message"
  | "subagent_interrupt"
  | "subagent_continue"
  | "subagent_result"
  | "subagent_name_pack"
  | "subagent_status"
  | "task_create"
  | "task_list"
  | "task_get"
  | "task_accept_result"
  | "task_reopen"
  | "task_cancel"
  | "task_clear";

export interface TextRenderable {
  invalidate(): void;
  render(width: number): string[];
}

export interface WakeupMessage {
  kind: "subagent_wakeup" | "task_wakeup";
  title: string;
  runId: string;
  runDir?: string;
  state?: string;
  summary?: string;
  body?: string;
  bodyAvailable?: boolean;
  bodyTruncation?: Record<string, unknown>;
  event?: RunEvent;
  taskEvent?: TaskEvent;
  task?: { taskId: string; title?: string; status?: string; owner?: { runId?: string; displayName?: string; agent?: string }; receiptPath?: string };
  result?: RunResult;
  status?: { agentName?: string; displayName?: string };
  next?: Array<{ tool: string; args: Record<string, unknown> }>;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[38;2;106;191;115m",
  cyan: "\x1b[38;2;95;179;212m",
  amber: "\x1b[38;2;229;156;72m",
  red: "\x1b[38;2;220;88;88m",
  gray: "\x1b[38;2;110;110;110m",
  white: "\x1b[38;2;220;220;220m",
  gold: "\x1b[38;2;229;181;72m",
  // Mirrors the cost slot in .pi/extensions/codex-usage.ts so the
  // async-subagents header/status reads in the same hue as the pi footer.
  cost: "\x1b[38;2;200;220;200m",
};

// Cost is suppressed entirely under one cent — early sessions would otherwise
// render `$0.000` and waste a header slot before any meaningful spend.
const COST_DISPLAY_THRESHOLD = 0.01;

/**
 * Format a USD cost the same way the pi footer does: three decimals under a
 * dollar, two decimals at or above. Returns undefined when the input is
 * missing, non-finite, or below `COST_DISPLAY_THRESHOLD` so callers can drop
 * the segment entirely.
 */
export function formatCost(total: number | undefined): string | undefined {
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  if (total < COST_DISPLAY_THRESHOLD) return undefined;
  const formatted = total < 1 ? total.toFixed(3) : total.toFixed(2);
  return `$${formatted}`;
}

/**
 * Build the colored "$0.42 total" header/status segment, or undefined when the
 * cost is missing or below the display threshold. Kept here so both the widget
 * header and status line use the same color (`ANSI.cost`) and suffix.
 */
export function costHeaderSegment(total: number | undefined): string | undefined {
  const formatted = formatCost(total);
  if (!formatted) return undefined;
  return `${ANSI.cost}${formatted} total${ANSI.reset}`;
}

const IDENTITY_PALETTE = [
  "\x1b[38;2;229;145;91m",
  "\x1b[38;2;199;125;186m",
  "\x1b[38;2;123;201;123m",
  "\x1b[38;2;111;169;217m",
  "\x1b[38;2;155;123;217m",
  "\x1b[38;2;91;201;181m",
  "\x1b[38;2;217;195;111m",
  "\x1b[38;2;217;125;125m",
];

export function identitySlot(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  return h % IDENTITY_PALETTE.length;
}

export function identityColor(name: string): string {
  return IDENTITY_PALETTE[identitySlot(name)];
}

export function idBar(name: string, opts: { dim?: boolean; override?: string } = {}): string {
  if (opts.override) return opts.override + "▌" + ANSI.reset;
  return (opts.dim ? ANSI.dim : "") + identityColor(name) + "▌" + ANSI.reset;
}

export function idMention(name: string, opts: { bold?: boolean; dim?: boolean } = {}): string {
  const bold = opts.bold ? ANSI.bold : "";
  const dim = opts.dim ? ANSI.dim : "";
  return dim + identityColor(name) + bold + "@" + name + ANSI.reset;
}

function isDefaultEmojiWide(cp: number): boolean {
  return (
    cp === 0x00a9 || cp === 0x00ae ||
    cp === 0x203c || cp === 0x2049 ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 || cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 || (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 || cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x1f000 && cp <= 0x1faff)
  );
}

function canTakeEmojiPresentation(cp: number): boolean {
  return (
    isDefaultEmojiWide(cp) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff)
  );
}

// Width calculation that handles ANSI escapes and wide unicode (CJK, emoji).
function normalizeTabs(str: string): string {
  // Raw tabs expand at terminal tab stops, and embedded newlines split a single
  // TUI row into multiple physical terminal rows. Normalize both before
  // measuring/rendering so exact-width chrome stays aligned.
  return str.replace(/\t/g, "  ").replace(/\r?\n|\r/g, " ");
}

export function visWidth(str: string): number {
  const chars = [...normalizeTabs(str).replace(/\x1b\[[0-9;]*m/g, "")];
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    const nextCp = chars[i + 1]?.codePointAt(0);
    if (
      (nextCp === 0xfe0f && canTakeEmojiPresentation(cp)) ||
      isDefaultEmojiWide(cp) ||
      (cp >= 0x1100 && (
        cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3041 && cp <= 0x33ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xac00 && cp <= 0xd7a3)
      ))
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Truncate with ellipsis honoring ANSI escapes and cell widths. Always closes with reset.
export function truncAnsi(str: string, maxCells: number): string {
  str = normalizeTabs(str);
  if (visWidth(str) <= maxCells) return str;
  if (maxCells <= 1) return "…" + ANSI.reset;
  let out = "";
  let cells = 0;
  let i = 0;
  const limit = maxCells - 1;
  while (i < str.length) {
    if (str.charCodeAt(i) === 0x1b && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end === -1) break;
      out += str.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const cp = str.codePointAt(i);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    const nextIndex = i + ch.length;
    const nextCp = str.codePointAt(nextIndex);
    const cluster = nextCp === 0xfe0f && canTakeEmojiPresentation(cp) ? ch + String.fromCodePoint(nextCp) : ch;
    const w = visWidth(cluster);
    if (cells + w > limit) break;
    out += cluster;
    cells += w;
    i += cluster.length;
  }
  return out + "…" + ANSI.reset;
}

export interface Chrome {
  top(): string;
  bot(): string;
  topTitled(title: string, badge?: string): string;
  row(content: string): string;
  rowBar(bar: string, content: string): string;
  rowRight(left: string, right: string): string;
  emptyRow(): string;
}

export function chrome(width: number): Chrome {
  const top = () => ANSI.gray + "╭" + "─".repeat(Math.max(0, width - 2)) + "╮" + ANSI.reset;
  const bot = () => ANSI.gray + "╰" + "─".repeat(Math.max(0, width - 2)) + "╯" + ANSI.reset;
  const topTitled = (titleContent: string, badgeContent?: string) => {
    const left = "╭─ " + titleContent + " ";
    const wL = visWidth(left);
    const tryRight = badgeContent ? " " + badgeContent + " ─╮" : "╮";
    const wR = visWidth(tryRight);
    const slack = width - wL - wR;
    const right = slack >= 2 ? tryRight : "╮";
    const wRFinal = visWidth(right);
    const dashes = Math.max(2, width - wL - wRFinal);
    return ANSI.gray + left + "─".repeat(dashes) + right + ANSI.reset;
  };
  const row = (content: string) => {
    content = normalizeTabs(content);
    const final = truncAnsi(content, width - 4);
    const inner = " " + final + " ";
    const pad = Math.max(0, width - 2 - visWidth(inner));
    return ANSI.gray + "│" + ANSI.reset + inner + " ".repeat(pad) + ANSI.gray + "│" + ANSI.reset;
  };
  const rowBar = (bar: string, content: string) => {
    content = normalizeTabs(content);
    const final = truncAnsi(content, width - 4);
    const inner = " " + final + " ";
    const pad = Math.max(0, width - 2 - visWidth(inner));
    return bar + inner + " ".repeat(pad) + ANSI.gray + "│" + ANSI.reset;
  };
  const rowRight = (left: string, right: string) => {
    left = normalizeTabs(left);
    right = normalizeTabs(right);
    const innerR = right + " ";
    const wR = visWidth(innerR);
    const maxLeft = Math.max(1, width - 2 - 1 - wR - 1);
    const truncLeft = truncAnsi(left, maxLeft);
    const innerL = " " + truncLeft;
    const used = visWidth(innerL) + visWidth(innerR);
    const pad = Math.max(1, width - 2 - used);
    return ANSI.gray + "│" + ANSI.reset + innerL + " ".repeat(pad) + innerR + ANSI.gray + "│" + ANSI.reset;
  };
  const emptyRow = () => row("");
  return { top, bot, topTitled, row, rowBar, rowRight, emptyRow };
}

export interface StateGlyph {
  g: string;
  color: string;
  label: string;
}

// New glyph + color table per design decision #2. The return shape grew (label added)
// for card badges; the .g field preserves the single-char glyph for plain text.
export function stateGlyph(state: string | undefined, resultReady = false): StateGlyph {
  if (resultReady && (state === "completed" || state === undefined)) {
    return { g: "★", color: ANSI.gold, label: "result ready" };
  }
  switch (state) {
    case "ready": return { g: "▫", color: ANSI.gray, label: "ready" };
    case "running": return { g: "◐", color: ANSI.cyan, label: "working" };
    case "queued":
    case "created": return { g: "○", color: ANSI.gray, label: "starting" };
    case "idle": return { g: "○", color: ANSI.gray, label: "idle" };
    case "waiting_for_input":
    case "question": return { g: "?", color: ANSI.amber, label: "needs you" };
    case "blocked": return { g: "◌", color: ANSI.gray, label: "blocked" };
    case "paused": return { g: "⏸", color: ANSI.gray, label: "paused" };
    case "stalled": return { g: "◌", color: ANSI.amber, label: "stalled" };
    case "completed": return { g: "✓", color: ANSI.green, label: "done" };
    case "result_ready": return { g: "★", color: ANSI.gold, label: "result ready" };
    case "failed": return { g: "✗", color: ANSI.red, label: "failed" };
    case "cancelled": return { g: "⊘", color: ANSI.gray, label: "cancelled" };
    case "expired": return { g: "⊘", color: ANSI.gray, label: "expired" };
    default: return { g: "·", color: ANSI.gray, label: state ?? "unknown" };
  }
}

function safeWidth(width: unknown): number {
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
}

export function textBlock(value: string | string[]): TextRenderable {
  const lines = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return {
    invalidate() {},
    render(width: number) {
      const max = safeWidth(width);
      return lines.map((line) => {
        const normalized = normalizeTabs(line);
        return visWidth(normalized) <= max ? normalized : truncAnsi(normalized, max);
      });
    },
  };
}

// Build a TextRenderable from a card-building function that takes the render
// width. This lets the card adapt to the actual terminal width when Pi asks
// for layout. The builder MUST return lines that are exactly `width` cells wide.
export function chromeRenderable(build: (width: number) => string[]): TextRenderable {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
    render(width: number) {
      const w = Math.max(32, Math.min(96, safeWidth(width)));
      if (cachedWidth === w && cachedLines) return cachedLines.slice();
      cachedWidth = w;
      cachedLines = build(w).map((line) => {
        const normalized = normalizeTabs(line);
        return visWidth(normalized) <= w ? normalized : truncAnsi(normalized, w);
      });
      return cachedLines.slice();
    },
  };
}

export function preview(value: string | undefined, max = 120): string {
  if (!value) return "";
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, Math.max(0, max - 1))}...`;
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

// Cap visible cells of a display name so wide names don't destroy widget alignment.
const NAME_CAP_CELLS = 16;

function capName(name: string, cells = NAME_CAP_CELLS): string {
  return visWidth(name) <= cells ? name : truncAnsi(name, cells).replace(ANSI.reset, "");
}

function isUrgentState(state: string | undefined): boolean {
  return state === "waiting_for_input" || state === "blocked";
}

function isDoneState(state: string | undefined): boolean {
  return state === "completed" || state === "cancelled" || state === "expired";
}

function isTerminalWidgetState(state: string | undefined): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "expired";
}

export type WidgetLayout = "full" | "no-role" | "minimal";

export function pickWidgetLayout(width: number): WidgetLayout {
  if (width >= 70) return "full";
  if (width >= 54) return "no-role";
  return "minimal";
}

export interface WidgetRowInput {
  displayName: string;
  role: string;
  state: string;
  summary: string;
  age?: string;
  urgent?: boolean;
  done?: boolean;
  resultReady?: boolean;
  task?: {
    id: string;
    title: string;
    status: string;
    activeForm?: string;
  };
}

export function renderWidgetRow(width: number, ch: Chrome, r: WidgetRowInput): string {
  const layout = pickWidgetLayout(width);
  const gl = stateGlyph(r.state, r.resultReady);
  const urgent = Boolean(r.urgent) || isUrgentState(r.state);
  const done = Boolean(r.done) || isDoneState(r.state);
  const cappedName = capName(r.displayName);

  const bar = urgent
    ? idBar(cappedName, { override: ANSI.amber })
    : done
      ? idBar(cappedName, { dim: true })
      : idBar(cappedName);

  const name = urgent
    ? idMention(cappedName, { bold: true })
    : done
      ? idMention(cappedName, { dim: true })
      : idMention(cappedName);

  const role = done ? ANSI.dim + r.role + ANSI.reset : ANSI.white + r.role + ANSI.reset;
  const glyph = gl.color + (urgent ? ANSI.bold : "") + gl.g + ANSI.reset;

  if (r.task) {
    const statusText = (r.state === "result_ready" || r.resultReady)
      ? "result ready"
      : (r.state === "waiting_for_input" || r.state === "question")
        ? "needs input"
        : r.state === "blocked"
          ? "blocked"
          : r.age ?? "";

    const statusPart = statusText ? (done ? ANSI.dim + statusText + ANSI.reset : ANSI.white + statusText + ANSI.reset) : "";
    const taskText = `${r.task.id} ${r.task.title}`;

    if (layout === "full") {
      const namePart = name + "  " + role;
      const COL = 22;
      const padCol = " ".repeat(Math.max(1, COL - visWidth(namePart)));

      const leftWidth = 22 + 2; // namePart aligned + glyph
      const rightWidth = statusPart ? visWidth(statusPart) + 2 : 0;
      const maxTitleWidth = width - 4 - leftWidth - rightWidth;

      const truncatedTask = truncAnsi(taskText, maxTitleWidth);
      const centerPart = glyph + " " + truncatedTask;
      const padRight = " ".repeat(Math.max(0, width - 4 - leftWidth - visWidth(centerPart) - visWidth(statusPart)));

      return ch.rowBar(bar, namePart + padCol + centerPart + padRight + statusPart);
    }
    if (layout === "no-role") {
      const COL = 12;
      const padCol = " ".repeat(Math.max(1, COL - visWidth(name)));

      const leftWidth = 12 + 2; // name + glyph
      const rightWidth = statusPart ? visWidth(statusPart) + 2 : 0;
      const maxTitleWidth = width - 4 - leftWidth - rightWidth;

      const truncatedTask = truncAnsi(taskText, maxTitleWidth);
      const centerPart = glyph + " " + truncatedTask;
      const padRight = " ".repeat(Math.max(0, width - 4 - leftWidth - visWidth(centerPart) - visWidth(statusPart)));

      return ch.rowBar(bar, name + padCol + centerPart + padRight + statusPart);
    }
    // minimal
    const maxTitleWidth = width - 4 - 2;
    const truncatedTask = truncAnsi(taskText, maxTitleWidth);
    return ch.rowBar(bar, glyph + " " + truncatedTask);
  }

  const summary = urgent
    ? ANSI.white + r.summary + ANSI.reset
    : done
      ? ANSI.dim + r.summary + ANSI.reset
      : ANSI.gray + r.summary + ANSI.reset;
  const age = r.age ? ANSI.dim + "· " + r.age + ANSI.reset : "";

  if (layout === "full") {
    const namePart = name + "  " + role;
    const COL = 22;
    const padCol = " ".repeat(Math.max(1, COL - visWidth(namePart)));
    return ch.rowBar(bar, namePart + padCol + glyph + " " + summary + (age ? "  " + age : ""));
  }
  if (layout === "no-role") {
    const COL = 12;
    const padCol = " ".repeat(Math.max(1, COL - visWidth(name)));
    return ch.rowBar(bar, name + padCol + glyph + " " + summary + (age ? "  " + age : ""));
  }
  return ch.rowBar(bar, name + " " + glyph + " " + summary);
}

export interface WidgetCardInput {
  width: number;
  rows: WidgetRowInput[];
  maxRows?: number;
  // Cumulative cost across every row the widget is rendering (active +
  // terminal). When set and >= the display threshold, surfaces as the
  // right-most header segment; dropped first on width overflow.
  totalCost?: number;
  tasks?: TaskRecord[];
  allTasks?: TaskRecord[];
  taskStates?: Map<string, DerivedTaskState>;
  taskUnresolvedDependencyIds?: Map<string, string[]>;
  now?: number;
}

// True when topTitled can fit the badge at this width. Mirrors the slack math
// in `chrome().topTitled` — kept in sync so the header can decide whether to
// drop the cost segment before falling back.
function headerBadgeFits(width: number, title: string, badge: string): boolean {
  const left = "╭─ " + title + " ";
  const right = " " + badge + " ─╮";
  return visWidth(left) + visWidth(right) <= width;
}

function taskPriority(state: string): number {
  switch (state) {
    case "result_ready": return 1;
    case "running": return 2;
    case "ready": return 3;
    case "blocked": return 4;
    case "failed": return 5;
    case "completed": return 6;
    case "cancelled": return 7;
    default: return 8;
  }
}

export function renderTaskSectionRow(width: number, task: TaskRecord, allTasks: TaskRecord[], precomputedState?: DerivedTaskState, precomputedUnresolvedDependencyIds?: string[]): string {
  const state = precomputedState ?? deriveTaskState(task, allTasks);
  const gl = stateGlyph(state);
  const glyph = gl.color + gl.g + ANSI.reset;

  const taskId = ANSI.white + task.id + ANSI.reset;
  const title = task.title;

  const ownerName = task.owner?.displayName ?? task.owner?.agent;
  const owner = ownerName ? idMention(capName(ownerName)) : "";

  let statusText: string = state;
  if (state === "blocked") {
    const depIds = precomputedUnresolvedDependencyIds ?? unresolvedDependencies(task, allTasks).map(d => d.id);
    if (depIds.length > 0) {
      statusText = `blocked by ${depIds.join(", ")}`;
    }
  } else if (state === "result_ready") {
    statusText = "result ready";
  } else if (state === "running" && task.activeForm) {
    statusText = task.activeForm;
  }

  const status = statusText ? ANSI.dim + statusText + ANSI.reset : "";

  if (width >= 72) {
    const leftPart = "  " + glyph + " " + taskId + " ";
    const rightPart = (owner ? owner + "  " : "") + status;
    const leftWidth = 11;
    const rightWidth = visWidth(rightPart);
    const maxTitleWidth = width - 4 - leftWidth - (rightWidth ? rightWidth + 2 : 0);

    const truncatedTitle = truncAnsi(title, maxTitleWidth);
    const centerPart = leftPart + truncatedTitle;

    const padRight = " ".repeat(Math.max(0, width - 4 - visWidth(centerPart) - rightWidth));
    return centerPart + padRight + rightPart;
  } else if (width >= 54) {
    const leftPart = "  " + glyph + " " + taskId + " ";
    const rightPart = owner ? owner : status;
    const leftWidth = 11;
    const rightWidth = visWidth(rightPart);
    const maxTitleWidth = width - 4 - leftWidth - (rightWidth ? rightWidth + 2 : 0);

    const truncatedTitle = truncAnsi(title, maxTitleWidth);
    const centerPart = leftPart + truncatedTitle;

    const padRight = " ".repeat(Math.max(0, width - 4 - visWidth(centerPart) - rightWidth));
    return centerPart + padRight + rightPart;
  } else {
    const leftPart = "  " + glyph + " " + taskId + " ";
    const leftWidth = 11;
    const maxTitleWidth = width - 4 - leftWidth;
    const truncatedTitle = truncAnsi(title, maxTitleWidth);
    return leftPart + truncatedTitle;
  }
}

export function renderWidgetCard(input: WidgetCardInput): string[] {
  const width = input.width;
  const ch = chrome(width);
  const activeCount = input.rows.filter((r) => !isTerminalWidgetState(r.state) && !(r.done || isDoneState(r.state))).length;
  const urgentCount = input.rows.filter((r) => r.urgent || isUrgentState(r.state)).length;
  const readyCount = input.rows.filter((r) => r.resultReady || r.state === "result_ready").length;
  const baseSegments = [
    activeCount ? `${ANSI.cyan}${activeCount} active${ANSI.reset}` : "",
    urgentCount ? `${ANSI.amber}${urgentCount} need you${ANSI.reset}` : "",
    readyCount ? `${ANSI.gold}${readyCount} ready${ANSI.reset}` : "",
  ].filter(Boolean);
  const costSegment = costHeaderSegment(input.totalCost);
  const sep = `${ANSI.gray} · ${ANSI.reset}`;
  const title = `${ANSI.bold}subagents${ANSI.reset}`;
  const headerRightWithCost = [...baseSegments, ...(costSegment ? [costSegment] : [])].join(sep);
  const headerRightBase = baseSegments.join(sep);
  const headerRight = costSegment && !headerBadgeFits(width, title, headerRightWithCost)
    ? headerRightBase
    : headerRightWithCost;
  const out: string[] = [ch.topTitled(title, headerRight || undefined)];
  const visibleRows = input.rows.slice(0, input.maxRows ?? input.rows.length);
  for (const r of visibleRows) out.push(renderWidgetRow(width, ch, r));
  const hidden = input.rows.length - visibleRows.length;
  if (hidden > 0) {
    const hiddenUrgent = input.rows.slice(visibleRows.length).filter((r) => r.urgent || isUrgentState(r.state)).length;
    const tail = hiddenUrgent
      ? `${ANSI.gray}+${hidden} more${ANSI.reset} ${ANSI.gray}·${ANSI.reset} ${ANSI.amber}${hiddenUrgent} need you${ANSI.reset}`
      : `${ANSI.gray}+${hidden} more${ANSI.reset}`;
    out.push(ch.row(tail));
  }

  // Task section
  const allTasks = input.allTasks ?? [];
  const now = input.now ?? Date.now();
  // Match liveWidget.visibleTasksFor: keep just-finished tasks on screen briefly.
  const graceMs = 30_000;
  const taskStates = input.taskStates;
  const stateFor = (task: TaskRecord): DerivedTaskState => taskStates?.get(task.id) ?? deriveTaskState(task, allTasks);
  const visibleTasks = (input.tasks ?? []).filter(t => {
    const state = stateFor(t);
    if (state === "completed" || state === "failed" || state === "cancelled") {
      const updatedAtMs = Date.parse(t.updatedAt);
      if (Number.isFinite(updatedAtMs)) {
        return now - updatedAtMs <= graceMs;
      }
    }
    return true;
  });

  if (visibleTasks.length > 0) {
    let tReadyCount = 0;
    let tRunningCount = 0;
    let tResultReadyCount = 0;
    let tBlockedCount = 0;
    let tFailedCount = 0;
    for (const t of allTasks) {
      const state = stateFor(t);
      if (state === "ready") tReadyCount += 1;
      else if (state === "running") tRunningCount += 1;
      else if (state === "result_ready") tResultReadyCount += 1;
      else if (state === "blocked") tBlockedCount += 1;
      else if (state === "failed") tFailedCount += 1;
    }

    const taskSegments = [
      tReadyCount ? `${tReadyCount} ready` : "",
      tRunningCount ? `${tRunningCount} running` : "",
      tResultReadyCount ? `${tResultReadyCount} result ready` : "",
      tBlockedCount ? `${tBlockedCount} blocked` : "",
      tFailedCount ? `${tFailedCount} failed` : "",
    ].filter(Boolean);

    // Separator line
    out.push(ch.row(ANSI.gray + "─".repeat(width - 4) + ANSI.reset));

    const headerText = `${ANSI.bold}Tasks${ANSI.reset}  ` + taskSegments.join(` ${ANSI.gray}·${ANSI.reset} `);
    out.push(ch.row(headerText));

    if (width >= 36) {
      const sortedTasks = [...visibleTasks].sort((a, b) => {
        const pA = taskPriority(stateFor(a));
        const pB = taskPriority(stateFor(b));
        if (pA !== pB) return pA - pB;
        return a.id.localeCompare(b.id);
      });

      const maxTaskRows = 4;
      const visibleTaskRows = sortedTasks.slice(0, maxTaskRows);
      for (const task of visibleTaskRows) {
        const line = renderTaskSectionRow(width, task, allTasks, stateFor(task), input.taskUnresolvedDependencyIds?.get(task.id));
        out.push(ch.row(line));
      }

      const hiddenTasksCount = sortedTasks.length - visibleTaskRows.length;
      if (hiddenTasksCount > 0) {
        const omittedTasks = sortedTasks.slice(maxTaskRows);
        const omittedCounts: Record<string, number> = {};
        for (const task of omittedTasks) {
          const state = stateFor(task);
          omittedCounts[state] = (omittedCounts[state] || 0) + 1;
        }
        const omittedParts: string[] = [];
        const statesOrder = ["result_ready", "running", "ready", "blocked", "failed", "completed", "cancelled"];
        for (const st of statesOrder) {
          if (omittedCounts[st]) {
            const label = st === "result_ready" ? "result ready" : st;
            omittedParts.push(`${omittedCounts[st]} ${label}`);
          }
        }
        const overflowText = `${ANSI.gray}… +${omittedParts.join(", ")}${ANSI.reset}`;
        out.push(ch.row(overflowText));
      }
    }
  }

  out.push(ch.bot());
  return out;
}

export function widgetRowFromSummary(row: RunSummaryRow, now = Date.now()): WidgetRowInput {
  const summaryText = preview(row.needs ?? row.summary ?? row.event?.summary ?? row.result?.summary, 96);
  const age = (() => {
    if (typeof row.result?.durationMs === "number") return compactDuration(row.result.durationMs);
    return since(row.lastActivityAt ?? row.updatedAt, now);
  })();
  return {
    displayName: row.displayName ?? row.agentName,
    role: row.agentName,
    state: row.state,
    summary: summaryText,
    age,
    urgent: isUrgentState(row.state),
    done: isDoneState(row.state),
    resultReady: row.resultReady,
  };
}

// Plain-text fallback rendering for non-widget contexts (logs, narrow terminals,
// transcript text-mode messages). Mirrors the widget row content but skips chrome.
export function formatRunRow(row: RunSummaryRow): string {
  const input = widgetRowFromSummary(row);
  const gl = stateGlyph(input.state);
  const urgent = Boolean(input.urgent);
  const done = Boolean(input.done);
  const name = urgent
    ? idMention(input.displayName, { bold: true })
    : done
      ? idMention(input.displayName, { dim: true })
      : idMention(input.displayName);
  const glyph = gl.color + (urgent ? ANSI.bold : "") + gl.g + ANSI.reset;
  const role = done ? ANSI.dim + input.role + ANSI.reset : ANSI.white + input.role + ANSI.reset;
  const state = gl.color + gl.label + ANSI.reset;
  const summary = input.summary
    ? (urgent ? ANSI.white : done ? ANSI.dim : ANSI.gray) + " - " + input.summary + ANSI.reset
    : "";
  const age = input.age ? ANSI.dim + " " + input.age + ANSI.reset : "";
  return `${glyph} ${name} ${role} ${state}${age}${summary}`;
}

// ----------------------------------------------------------------------------
// Cards: launch / result / wake
// ----------------------------------------------------------------------------

const DEFAULT_CARD_WIDTH = 72;

function cardWidth(opts?: { width?: number }): number {
  if (opts?.width && opts.width > 20) return Math.min(96, Math.floor(opts.width));
  const term = typeof process !== "undefined" ? process.stdout?.columns : undefined;
  const raw = typeof term === "number" && term > 0 ? term : DEFAULT_CARD_WIDTH;
  return Math.max(32, Math.min(96, raw));
}

export interface LaunchCardInput {
  width?: number;
  displayName: string;
  role: string;
  state?: string;
  task?: string;
  model?: string;
  thinking?: string;
  skills?: string[];
  tools?: string[];
  budget?: string;
  context?: string;
}

export function renderLaunchCard(input: LaunchCardInput): string[] {
  const width = cardWidth(input);
  const ch = chrome(width);
  const gl = stateGlyph(input.state ?? "queued");
  const titleContent = `${idBar(input.displayName)} ${idMention(input.displayName)} ${ANSI.gray}·${ANSI.reset} ${ANSI.white}${input.role}${ANSI.reset}`;
  const badge = `${gl.color}${gl.g} ${gl.label}${ANSI.reset}`;
  const out: string[] = [ch.topTitled(titleContent, badge)];
  const label = (s: string) => ANSI.dim + s.padEnd(10) + ANSI.reset;
  if (input.task) out.push(ch.row(label("task") + ANSI.white + input.task + ANSI.reset));
  if (input.model) {
    const modelLine = ANSI.white + input.model + ANSI.reset
      + (input.thinking ? `  ${ANSI.gray}·${ANSI.reset}  ${ANSI.dim}thinking${ANSI.reset} ${ANSI.cyan}${input.thinking}${ANSI.reset}` : "");
    out.push(ch.row(label("model") + modelLine));
  }
  if (input.skills?.length) {
    out.push(ch.row(label("skills") + input.skills.map((s) => ANSI.cyan + s + ANSI.reset).join(ANSI.gray + " · " + ANSI.reset)));
  }
  if (input.tools?.length) {
    out.push(ch.row(label("tools") + input.tools.map((t) => ANSI.white + t + ANSI.reset).join(ANSI.gray + " · " + ANSI.reset)));
  }
  if (input.budget) out.push(ch.row(label("budget") + ANSI.white + input.budget + ANSI.reset));
  if (input.context) out.push(ch.row(label("context") + ANSI.white + input.context + ANSI.reset));
  out.push(ch.bot());
  return out;
}

export interface ResultCardInput {
  width?: number;
  displayName: string;
  role: string;
  state: string;
  duration?: string;
  summary?: string;
  body?: string;
  metrics?: string;
  artifacts?: string[];
}

export function renderResultCard(input: ResultCardInput): string[] {
  const width = cardWidth(input);
  const ch = chrome(width);
  const gl = stateGlyph(input.state);
  const isDone = input.state === "completed";
  const titleContent = `${idBar(input.displayName)} ${idMention(input.displayName)} ${ANSI.gray}·${ANSI.reset} ${ANSI.white}${input.role}${ANSI.reset}`;
  const badge = `${gl.color}${gl.g} ${isDone ? "done" : gl.label}${ANSI.reset}${input.duration ? ANSI.gray + " · " + ANSI.reset + ANSI.dim + input.duration + ANSI.reset : ""}`;
  const out: string[] = [ch.topTitled(titleContent, badge)];
  if (input.summary) {
    out.push(ch.row(ANSI.dim + "summary" + ANSI.reset));
    for (const line of input.summary.split("\n")) out.push(ch.row(ANSI.white + line + ANSI.reset));
  }
  if (input.body) {
    out.push(ch.row(""));
    for (const line of input.body.split("\n")) out.push(ch.row(ANSI.white + line + ANSI.reset));
  }
  if (input.metrics) {
    out.push(ch.row(""));
    out.push(ch.row(ANSI.dim + "metrics    " + ANSI.reset + ANSI.white + input.metrics + ANSI.reset));
  }
  if (input.artifacts?.length) {
    out.push(ch.row(ANSI.dim + "artifacts  " + ANSI.reset + input.artifacts.map((a) => ANSI.cyan + a + ANSI.reset).join(ANSI.gray + " · " + ANSI.reset)));
  }
  out.push(ch.bot());
  return out;
}

export interface WakeCardInput {
  width?: number;
  displayName: string;
  role: string;
  kind: string;
  badge?: string;
  headline?: string;
  body?: string;
}

export function renderWakeCard(input: WakeCardInput): string[] {
  const width = cardWidth(input);
  const ch = chrome(width);
  const gl = stateGlyph(input.kind);
  const isUrgent = input.kind === "waiting_for_input" || input.kind === "blocked" || input.kind === "failed";
  const titleContent = `${idBar(input.displayName)} ${idMention(input.displayName, { bold: true })} ${ANSI.gray}·${ANSI.reset} ${ANSI.white}${input.role}${ANSI.reset}`;
  const badgeText = input.badge ?? gl.label;
  const badge = `${gl.color}${isUrgent ? ANSI.bold : ""}${gl.g} ${badgeText}${ANSI.reset}`;
  const out: string[] = [ch.topTitled(titleContent, badge)];
  if (input.headline) out.push(ch.row(ANSI.bold + (isUrgent ? gl.color : ANSI.white) + input.headline + ANSI.reset));
  if (input.body) {
    out.push(ch.row(""));
    for (const line of input.body.split("\n")) out.push(ch.row(ANSI.white + line + ANSI.reset));
  }
  out.push(ch.bot());
  return out;
}

export interface ToolCallCardInput {
  width?: number;
  title: string;
  badge: string;
  rows?: Array<[string, string]>;
}

export function renderToolCallCard(input: ToolCallCardInput): string[] {
  const width = cardWidth(input);
  const ch = chrome(width);
  const titleContent = `${ANSI.bold}${input.title}${ANSI.reset}`;
  const out: string[] = [ch.topTitled(titleContent, ANSI.cyan + input.badge + ANSI.reset)];
  const label = (s: string) => ANSI.dim + s.padEnd(10) + ANSI.reset;
  for (const [key, value] of input.rows ?? []) {
    if (value) out.push(ch.row(label(key) + ANSI.white + value + ANSI.reset));
  }
  out.push(ch.bot());
  return out;
}

// ----------------------------------------------------------------------------
// Card adapters: turn tool args / wake payloads into card props.
// ----------------------------------------------------------------------------

function describeBudget(args: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (typeof args.maxRunSeconds === "number") parts.push(`${compactDuration(args.maxRunSeconds * 1000)} max`);
  if (typeof args.additionalRunSeconds === "number") parts.push(`+${compactDuration(args.additionalRunSeconds * 1000)}`);
  if (typeof args.maxSubagentDepth === "number") parts.push(`depth ${args.maxSubagentDepth}`);
  if (!parts.length) return undefined;
  return parts.join(" · ");
}

function describeContext(args: Record<string, unknown>): string | undefined {
  const ctx = typeof args.context === "string" ? args.context : undefined;
  if (ctx === "fork") return "forked from this session";
  if (ctx === "fresh") return "fresh session";
  return undefined;
}

function deriveWakeKind(state: string | undefined, hasResult: boolean): string {
  if (state === "waiting_for_input" || state === "blocked" || state === "failed" || state === "cancelled" || state === "expired") return state;
  if (state === "completed" || hasResult) return "completed";
  if (state === "paused") return "paused";
  return state ?? "running";
}

function deriveWakeBadge(kind: string): string {
  switch (kind) {
    case "waiting_for_input":
    case "question": return "needs you";
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "completed": return "result ready";
    case "result_ready": return "result ready";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    case "paused": return "paused";
    default: return kind;
  }
}

// ----------------------------------------------------------------------------
// Tool call / result renderers
// ----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function renderLaunchCardFromArgs(args: Record<string, unknown>, width?: number): string[] {
  const agent = typeof args.agent === "string" ? args.agent : "subagent";
  const variant = typeof args.variant === "string" ? args.variant : undefined;
  const task = typeof args.task === "string" ? args.task : undefined;
  const thinking = typeof args.thinkingLevel === "string" ? args.thinkingLevel : undefined;
  return renderToolCallCard({
    width,
    title: "start subagent",
    badge: "→ starting",
    rows: [
      ["role", variant ? `${agent}/${variant}` : agent],
      ["name", "from active pack"],
      ...(task ? [["task", task] as [string, string]] : []),
      ...(thinking ? [["thinking", thinking] as [string, string]] : []),
      ...(describeBudget(args) ? [["budget", describeBudget(args) as string] as [string, string]] : []),
      ...(describeContext(args) ? [["context", describeContext(args) as string] as [string, string]] : []),
    ],
  });
}

function selectedRunsLabel(args: Record<string, unknown>): string {
  const runIds = Array.isArray(args.runIds) ? args.runIds.filter((runId): runId is string => typeof runId === "string") : [];
  const runDirs = Array.isArray(args.runDirs) ? args.runDirs.filter((runDir): runDir is string => typeof runDir === "string") : [];
  if (typeof args.runId === "string" && args.runId) return args.runId;
  if (typeof args.runDir === "string" && args.runDir) return "run directory";
  if (runIds.length) return `${runIds.length} selected`;
  if (runDirs.length) return `${runDirs.length} run dirs`;
  return "direct children";
}

function renderSubagentCallCard(toolName: SubagentToolName | undefined, args: Record<string, unknown>, width?: number): string[] {
  switch (toolName) {
    case "subagent_status":
      return renderToolCallCard({ width, title: "subagent status", badge: "○ reading", rows: [["scope", selectedRunsLabel(args)]] });
    case "subagent_result":
      return renderToolCallCard({ width, title: "subagent result", badge: "★ reading", rows: [["target", selectedRunsLabel(args)]] });
    case "subagent_message":
      return renderToolCallCard({ width, title: "message subagent", badge: "→ sending", rows: [["target", selectedRunsLabel(args)], ["type", typeof args.type === "string" ? args.type : "instruction"], ["body", typeof args.body === "string" ? preview(args.body, 120) : ""]] });
    case "subagent_interrupt":
      return renderToolCallCard({ width, title: "interrupt subagent", badge: "⚠ control", rows: [["target", selectedRunsLabel(args)], ["action", typeof args.action === "string" ? args.action : "pause"]] });
    case "subagent_continue":
      return renderToolCallCard({ width, title: "continue subagent", badge: "→ resume", rows: [["target", selectedRunsLabel(args)], ["body", typeof args.body === "string" ? preview(args.body, 120) : "resume work"]] });
    case "subagent_name_pack":
      return renderToolCallCard({ width, title: "subagent name pack", badge: "○ config", rows: [["pack", typeof args.pack === "string" ? args.pack : "current"]] });
    case "task_create": {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      const rows: [string, string][] = [["count", String(tasks.length)]];
      if (tasks.length === 1 && tasks[0] && typeof tasks[0] === "object") {
        const t = tasks[0] as Record<string, unknown>;
        if (typeof t.title === "string") rows.push(["title", preview(t.title, 80)]);
      } else if (tasks.length > 1) {
        const list = tasks.map((t: any) => (t && typeof t === "object" && typeof t.title === "string") ? t.title : "untitled").join(", ");
        rows.push(["tasks", preview(list, 100)]);
      }
      return renderToolCallCard({ width, title: "create task", badge: "○ task", rows });
    }
    case "task_list": {
      const rows: [string, string][] = [];
      if (args.states !== undefined) {
        rows.push(["states", Array.isArray(args.states) ? args.states.join(", ") : String(args.states)]);
      }
      if (args.includeCompleted !== undefined) {
        rows.push(["include completed", args.includeCompleted ? "yes" : "no"]);
      }
      if (args.limit !== undefined) {
        rows.push(["limit", String(args.limit)]);
      }
      return renderToolCallCard({ width, title: "task list", badge: "○ reading", rows: rows.length ? rows : [["scope", "all tasks"]] });
    }
    case "task_get": {
      const rows: [string, string][] = [["taskId", typeof args.taskId === "string" ? args.taskId : ""]];
      if (args.view !== undefined) {
        rows.push(["view", String(args.view)]);
      }
      return renderToolCallCard({ width, title: "task status", badge: "○ reading", rows });
    }
    case "task_accept_result": {
      const rows: [string, string][] = [["taskId", typeof args.taskId === "string" ? args.taskId : ""]];
      if (args.summary !== undefined) {
        rows.push(["summary", preview(String(args.summary), 100)]);
      }
      return renderToolCallCard({ width, title: "accept task", badge: "✓ accept", rows });
    }
    case "task_reopen": {
      const rows: [string, string][] = [
        ["taskId", typeof args.taskId === "string" ? args.taskId : ""],
        ["reason", typeof args.reason === "string" ? preview(args.reason, 80) : ""]
      ];
      if (args.activeForm !== undefined) {
        rows.push(["activeForm", String(args.activeForm)]);
      }
      if (args.force !== undefined) {
        rows.push(["force", args.force ? "true" : "false"]);
      }
      return renderToolCallCard({ width, title: "reopen task", badge: "⚠ reopen", rows });
    }
    case "task_cancel": {
      const rows: [string, string][] = [
        ["taskId", typeof args.taskId === "string" ? args.taskId : ""],
        ["reason", typeof args.reason === "string" ? preview(args.reason, 80) : ""]
      ];
      return renderToolCallCard({ width, title: "cancel task", badge: "⊘ cancel", rows });
    }
    case "task_clear": {
      const rows: [string, string][] = [
        ["reason", typeof args.reason === "string" ? preview(args.reason, 80) : ""]
      ];
      return renderToolCallCard({ width, title: "clear tasks", badge: "⊘ clear", rows });
    }
    default:
      return renderToolCallCard({ width, title: "subagent tool", badge: "○ running", rows: [["scope", selectedRunsLabel(args)]] });
  }
}

function renderStartResultCard(details: Record<string, unknown>, width?: number): string[] | undefined {
  const runId = typeof details.runId === "string" ? details.runId : undefined;
  const agentName = typeof details.agentName === "string" ? details.agentName : undefined;
  if (!agentName) return undefined;
  const displayName = typeof details.displayName === "string" && details.displayName ? details.displayName : (runId ?? agentName);
  const variant = typeof details.variant === "string" ? details.variant : undefined;
  const model = typeof details.model === "string" ? details.model : undefined;
  const thinking = typeof details.thinkingLevel === "string" ? details.thinkingLevel : undefined;
  const contextPolicy = typeof details.contextPolicy === "string" ? details.contextPolicy : undefined;
  const state = typeof details.state === "string" ? details.state : "queued";
  const skills = Array.isArray(details.skills) ? details.skills.filter((s): s is string => typeof s === "string") : undefined;
  const tools = Array.isArray(details.tools) ? details.tools.filter((t): t is string => typeof t === "string") : undefined;
  const effectiveMaxRunMs = typeof details.effectiveMaxRunMs === "number" ? details.effectiveMaxRunMs : typeof details.maxRunSeconds === "number" ? details.maxRunSeconds * 1000 : undefined;
  const maxSubagentDepth = typeof details.maxSubagentDepth === "number" ? details.maxSubagentDepth : undefined;
  const budgetParts: string[] = [];
  if (effectiveMaxRunMs) budgetParts.push(`${compactDuration(effectiveMaxRunMs)} max`);
  if (maxSubagentDepth) budgetParts.push(`depth ${maxSubagentDepth}`);
  const budget = budgetParts.length ? budgetParts.join(" · ") : undefined;
  return renderLaunchCard({
    width,
    displayName,
    role: variant ? `${agentName}/${variant}` : agentName,
    state,
    model,
    thinking,
    skills: skills?.length ? skills : undefined,
    tools: tools?.length ? tools : undefined,
    budget,
    context: contextPolicy === "fork" ? "forked from this session" : contextPolicy === "fresh" ? "fresh session" : undefined,
  });
}

function renderTerminalResultCardFromDetails(result: Record<string, unknown>, width?: number): string[] | undefined {
  const agentName = typeof result.agentName === "string" ? result.agentName : undefined;
  if (!agentName) return undefined;
  const variant = typeof result.variant === "string" ? result.variant : undefined;
  const displayName = typeof result.displayName === "string" && result.displayName ? result.displayName : agentName;
  const state = typeof result.state === "string" ? result.state : "completed";
  const durationMs = typeof result.durationMs === "number" ? result.durationMs : undefined;
  const summary = typeof result.summary === "string" ? result.summary : undefined;
  const body = typeof result.body === "string" && result.body.trim() ? result.body : undefined;
  const metrics = (() => {
    const m = isRecord(result.metrics) ? result.metrics : undefined;
    if (!m) return undefined;
    const tokens = isRecord(m.tokens) ? m.tokens : undefined;
    const tokenInput = typeof tokens?.input === "number" ? `${tokens.input} in` : undefined;
    const tokenOutput = typeof tokens?.output === "number" ? `${tokens.output} out` : undefined;
    const toolCalls = typeof m.toolCalls === "number" ? `${m.toolCalls} tool calls` : undefined;
    const parts = [tokenInput, tokenOutput, toolCalls].filter(Boolean);
    return parts.length ? parts.join(" · ") : undefined;
  })();
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts.flatMap((a) => (isRecord(a) && typeof a.path === "string" ? [a.path] : []))
    : undefined;
  return renderResultCard({
    width,
    displayName,
    role: variant ? `${agentName}/${variant}` : agentName,
    state,
    duration: durationMs !== undefined ? compactDuration(durationMs) : undefined,
    summary,
    body,
    metrics,
    artifacts,
  });
}

export function renderSubagentToolCall(args: Record<string, unknown>, theme?: TextTheme, toolName?: SubagentToolName): string {
  // Plain-text fallback used by transcript text-mode and tests. Components use the
  // card path below.
  const target = typeof args.runId === "string" ? args.runId : typeof args.agent === "string" ? args.agent : selectedRunsLabel(args);
  const task = typeof args.task === "string" ? ` - ${preview(args.task, 90)}` : "";
  const accent = (v: string) => (theme?.fg ? theme.fg("accent", v) : v);
  const muted = (v: string) => (theme?.fg ? theme.fg("muted", v) : v);
  const titleText = "subagent";
  const title = theme?.fg ? theme.fg("toolTitle", titleText) : titleText;
  return `${title} ${accent(target)}${muted(task)}`;
}

export function renderSubagentToolCallComponent(args: Record<string, unknown>, theme?: TextTheme, toolName?: SubagentToolName): TextRenderable {
  if (typeof args.agent === "string") {
    return chromeRenderable((width) => renderLaunchCardFromArgs(args, width));
  }
  return chromeRenderable((width) => renderSubagentCallCard(toolName, args, width));
}

function resultBodyLines(details: Record<string, unknown>, expanded: boolean): string[] {
  if (!expanded) return [];
  if (typeof details.body === "string" && details.body.trim()) return ["", details.body];
  if (!Array.isArray(details.results)) return [];
  return details.results.flatMap((result) => {
    if (!isRecord(result) || typeof result.body !== "string" || !result.body.trim()) return [];
    const agent = typeof result.agentName === "string" ? result.agentName : "subagent";
    const displayName = typeof result.displayName === "string" ? result.displayName : agent;
    return ["", `${idMention(displayName)} ${agent}:`, result.body];
  });
}

export function renderSubagentToolResult(result: unknown, options?: RenderOptions, theme?: TextTheme): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const data = result as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
  const details = data.details ?? {};
  const text = data.content?.[0]?.text;
  const summary = typeof details.summary === "string" ? details.summary : text;
  const muted = (v: string) => (theme?.fg ? theme.fg("muted", v) : v);
  const lines = [muted(summary ?? JSON.stringify(details)), ...resultBodyLines(details, Boolean(options?.expanded))];
  return lines.join("\n");
}

export function renderSubagentToolResultComponent(result: unknown, options?: RenderOptions, theme?: TextTheme): TextRenderable {
  if (result && typeof result === "object") {
    const data = result as { details?: Record<string, unknown> };
    const details = data.details ?? {};
    // Terminal child result emitted by subagent_result tool — render the result card.
    if (typeof details.agentName === "string" && typeof details.state === "string" && (details.state === "completed" || details.state === "failed" || details.state === "cancelled" || details.state === "expired") && typeof details.success === "boolean") {
      return chromeRenderable((width) => renderTerminalResultCardFromDetails(details, width) ?? [renderSubagentToolResult(result, options, theme)]);
    }
    // SubagentStartResult — render the launch card.
    if (typeof details.runId === "string" && typeof details.agentName === "string" && typeof details.started === "boolean") {
      return chromeRenderable((width) => renderStartResultCard(details, width) ?? [renderSubagentToolResult(result, options, theme)]);
    }
  }
  return textBlock(renderSubagentToolResult(result, options, theme));
}

// ----------------------------------------------------------------------------
// Wake messages
// ----------------------------------------------------------------------------

function wakeCardInputFor(message: WakeupMessage, _options?: RenderOptions): WakeCardInput {
  const hasResult = Boolean(message.result);
  const kind = deriveWakeKind(message.state, hasResult);
  const result = message.result;
  const status = message.status;
  const agentName = result?.agentName ?? status?.agentName ?? message.title;
  const displayName = result?.displayName ?? status?.displayName ?? agentName;
  const summaryText = message.summary ?? message.result?.summary ?? message.event?.summary;
  const headline = summaryText ? preview(summaryText, 96) : undefined;
  const body = (() => {
    if (message.body !== undefined) return message.body;
    if (message.bodyAvailable) return hasResult ? "Full child body available via subagent_result if you need recovery, artifacts, metadata, or a reread." : "Child event body available in wakeup details.";
    return undefined;
  })();
  return {
    displayName,
    role: agentName,
    kind,
    badge: deriveWakeBadge(kind),
    headline,
    body,
  };
}

export function renderSubagentWakeMessage(message: WakeupMessage, options?: RenderOptions, _theme?: TextTheme): string {
  return renderWakeCard(wakeCardInputFor(message, options)).join("\n");
}

export function renderSubagentWakeMessageComponent(message: WakeupMessage, options?: RenderOptions, _theme?: TextTheme): TextRenderable {
  const input = wakeCardInputFor(message, options);
  return chromeRenderable((width) => renderWakeCard({ ...input, width }));
}

// ----------------------------------------------------------------------------
// Summaries (plain-text, used by tool-call response text and notifications)
// ----------------------------------------------------------------------------

export function summarizeStartResult(result: SubagentStartResult): string {
  const action = result.waited ? "started and waited" : "started";
  const agent = result.variant ? `${result.agentName}/${result.variant}` : result.agentName;
  const label = result.displayName ? `@${result.displayName} (${agent})` : agent;
  return `Subagent ${result.runId} ${action}: ${label} (${result.state}); async wakeups will report attention or results`;
}

function formatResultSummary(result: RunResult, options?: { includeSummary?: boolean; useLiteralState?: boolean }): string {
  const agent = result.variant ? `${result.agentName}/${result.variant}` : result.agentName;
  const label = result.displayName ? `@${result.displayName} ${agent}` : agent;
  const duration = typeof result.durationMs === "number" ? ` in ${compactDuration(result.durationMs)}` : "";
  const state = options?.useLiteralState ? result.state : stateGlyph(result.state).label;
  const summary = options?.includeSummary === false || !result.summary ? "" : ` - ${preview(result.summary, 96)}`;
  return `${label} ${state}${duration}${summary}`;
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
  const actionable = rows.filter((row) => ["blocked", "waiting_for_input", "paused"].includes(row.state)).length;
  const results = rows.filter((row) => ["completed", "failed", "cancelled", "expired"].includes(row.state)).length;
  const suffix = active > 0 && actionable === 0 ? "; no action needed for merely active runs until an async wakeup arrives" : "";
  return `Subagent status: ${active} active, ${results} terminal, ${rows.length} total${suffix}`;
}
