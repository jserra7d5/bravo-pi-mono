// Card grammar for bravo-goals tool-call renders. Mirrors
// packages/async-subagents/extensions/pi/renderers.ts in shape (chrome helpers,
// identity palette, width-aware truncation, Component factory pattern) so the
// two extensions share a visual language. Each `render<Tool>{Call,Result}`
// returns a factory-form TextRenderable that adapts to the width pi gives it
// at render time — never reads process.stdout.columns.

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[38;2;106;191;115m",
  cyan: "\x1b[38;2;95;179;212m",
  amber: "\x1b[38;2;229;181;72m",
  red: "\x1b[38;2;232;111;111m",
  gray: "\x1b[38;2;110;110;110m",
  white: "\x1b[38;2;220;220;220m",
  gold: "\x1b[38;2;229;181;72m",
};

// Same 8-RGB palette as async-subagents — keeps cross-extension identity
// stable so a single name/id pair reads as the same hue everywhere.
export const IDENTITY_PALETTE = [
  "\x1b[38;2;229;145;91m",
  "\x1b[38;2;199;125;186m",
  "\x1b[38;2;123;201;123m",
  "\x1b[38;2;111;169;217m",
  "\x1b[38;2;155;123;217m",
  "\x1b[38;2;91;201;181m",
  "\x1b[38;2;217;195;111m",
  "\x1b[38;2;217;125;125m",
];

export function identitySlot(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return h % IDENTITY_PALETTE.length;
}

export function identityColor(id: string): string {
  return IDENTITY_PALETTE[identitySlot(id)];
}

// Per-row bar painted in the goal's identity color (or red/amber when a
// verdict overrides it). Optional dim makes judge_event reads as a quieter
// administrative log strip.
export function idBar(goalId: string, opts: { dim?: boolean; override?: string } = {}): string {
  if (opts.override) return opts.override + "▌" + ANSI.reset;
  return (opts.dim ? ANSI.dim : "") + identityColor(goalId) + "▌" + ANSI.reset;
}

// Width calculation that honors ANSI escapes and wide unicode (CJK, emoji).
export function visWidth(str: string): number {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    if (
      cp >= 0x1100 && (
        cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3041 && cp <= 0x33ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0x1f300 && cp <= 0x1faff)
      )
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// End-truncate honoring ANSI escapes; always closes with a reset so following
// rows do not inherit color state mid-cell.
export function truncAnsi(str: string, maxCells: number): string {
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
    const w = visWidth(ch);
    if (cells + w > limit) break;
    out += ch;
    cells += w;
    i += ch.length;
  }
  return out + "…" + ANSI.reset;
}

// Mid-truncate a path — preserves head + tail so the directory and filename
// are both visible. Used for receipt paths and judge run paths.
function truncPath(p: string, maxCells: number): string {
  if (visWidth(p) <= maxCells) return p;
  if (maxCells <= 3) return truncAnsi(p, maxCells);
  const head = Math.ceil((maxCells - 1) / 2);
  const tail = Math.floor((maxCells - 1) / 2);
  return p.slice(0, head) + "…" + p.slice(-tail);
}

// End-truncate title text (head is salient).
function shortTitle(title: string, maxCells: number): string {
  if (title.length <= maxCells) return title;
  return title.slice(0, Math.max(0, maxCells - 1)) + "…";
}

// Mid-truncate slug (head + tail both meaningful).
function shortSlug(id: string, maxCells: number): string {
  if (id.length <= maxCells) return id;
  const head = Math.ceil((maxCells - 1) / 2);
  const tail = Math.floor((maxCells - 1) / 2);
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

// Title-budget shrinks at narrow widths so the state badge always stays
// visible. Numbers come from the mockup — kept identical so visual diff is 1:1.
export function titleMaxFor(width: number): number {
  if (width >= 120) return 60;
  if (width >= 96) return 44;
  if (width >= 72) return 28;
  if (width >= 56) return 18;
  return 12;
}

export interface Chrome {
  top(): string;
  bot(): string;
  topTitled(title: string, badge?: string): string;
  row(content: string): string;
  rowBar(bar: string, content: string): string;
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
    const final = truncAnsi(content, width - 4);
    const inner = " " + final + " ";
    const pad = Math.max(0, width - 2 - visWidth(inner));
    return ANSI.gray + "│" + ANSI.reset + inner + " ".repeat(pad) + ANSI.gray + "│" + ANSI.reset;
  };
  const rowBar = (bar: string, content: string) => {
    const final = truncAnsi(content, width - 4);
    const inner = " " + final + " ";
    const pad = Math.max(0, width - 2 - visWidth(inner));
    return bar + inner + " ".repeat(pad) + ANSI.gray + "│" + ANSI.reset;
  };
  const emptyRow = () => row("");
  return { top, bot, topTitled, row, rowBar, emptyRow };
}

// Aligned label · value row. Label padded to 10 cells, dim grey, then value.
function labelRow(ch: Chrome, bar: string, label: string, value: string): string {
  const labelStr = ANSI.dim + label.padEnd(10) + ANSI.reset;
  return ch.rowBar(bar, labelStr + value);
}

// Title row content for a normal card: identity bar · bold colored title · tool name.
function toolTitleContent(goalId: string, title: string, toolName: string, width: number): string {
  const titleMax = titleMaxFor(width);
  const titleBudget = Math.max(1, titleMax - 2); // "# " consumes 2 cells
  const c = identityColor(goalId);
  const label = `${c}${ANSI.bold}# ${shortTitle(title, titleBudget)}${ANSI.reset}`;
  return `${idBar(goalId)} ${label} ${ANSI.gray}·${ANSI.reset} ${ANSI.dim}${toolName}${ANSI.reset}`;
}

// Half-brightness title used by judge_event — bar is dim, title is dim+colored
// (NOT bold), tool name is dim. Reads as an administrative log strip.
function dimToolTitleContent(goalId: string, title: string, toolName: string, width: number): string {
  const titleMax = titleMaxFor(width);
  const titleBudget = Math.max(1, titleMax - 2);
  const label = `${ANSI.dim}${identityColor(goalId)}# ${shortTitle(title, titleBudget)}${ANSI.reset}`;
  return `${idBar(goalId, { dim: true })} ${label} ${ANSI.gray}·${ANSI.reset} ${ANSI.dim}${toolName}${ANSI.reset}`;
}

interface BadgeOpts {
  glyph: string;
  color: string;
  label: string;
  bold?: boolean;
}

function badge(opts: BadgeOpts): string {
  const bold = opts.bold ? ANSI.bold : "";
  return `${opts.color}${bold}${opts.glyph} ${opts.label}${ANSI.reset}`;
}

// Slug footer row — dim, indented 2 spaces. Canonical-id recovery without
// competing for attention with the title.
function slugFooter(ch: Chrome, bar: string, goalId: string, slugMax: number): string {
  return ch.rowBar(bar, `${ANSI.dim}  ${shortSlug(goalId, slugMax)}${ANSI.reset}`);
}

// Minimum sensible card width before chrome wraps. Below 44 we just refuse to
// render and let pi fall back to its default text path.
const MIN_WIDTH = 44;

function safeWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 72;
  return Math.max(MIN_WIDTH, Math.min(160, Math.floor(width)));
}

// ─── public option shapes ──────────────────────────────────────────────────

export interface TaskReceiptReadyCallOpts {
  goal_id: string;
  goal_title?: string;
  receipt_path?: string;
  summary?: string;
}

export interface TaskReceiptReadyResultOpts {
  goal_id: string;
  goal_title?: string;
  task_id: string;
  receipt_path: string;
  judge_run_id: string;
  judge_run_path?: string;
  judge_receipt_path?: string;
  next_action?: string;
}

export interface JudgeEventCallOpts {
  goal_id: string;
  goal_title?: string;
  event: string;
  run_id?: string;
  receipt_path?: string;
  note?: string;
}

export interface JudgeEventResultOpts {
  goal_id: string;
  goal_title?: string;
  event: string;
  run_id?: string;
  receipt_path?: string;
}

export type JudgeVerdictKind = "pass" | "fail" | "needs_more_evidence" | "blocked";

export interface JudgeFinishCallOpts {
  goal_id: string;
  goal_title?: string;
  run_id?: string;
  verdict?: JudgeVerdictKind;
}

export interface JudgeFinishResultOpts {
  goal_id: string;
  goal_title?: string;
  run_id?: string;
  verdict: JudgeVerdictKind;
  receipt_path: string;
  summary?: string;
  next_action?: string;
}

export interface FailureCardOpts {
  goal_id: string;
  goal_title?: string;
  tool: string;
  error: string;
  suggestion?: string;
}

export interface ValidateGoalStateCallOpts {
  goal_id: string;
  goal_title?: string;
}

export interface ValidateGoalStateIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ValidateGoalStateResultOpts {
  goal_id: string;
  goal_title?: string;
  state_path: string;
  ok: boolean;
  issue_count: number;
  issues: ValidateGoalStateIssue[];
}

// ─── task_receipt_ready ────────────────────────────────────────────────────

export function renderTaskReceiptReadyCall(opts: TaskReceiptReadyCallOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = idBar(opts.goal_id);
  const title = opts.goal_title ?? opts.goal_id;
  out.push(ch.topTitled(
    toolTitleContent(opts.goal_id, title, "task_receipt_ready", w),
    badge({ glyph: "→", color: ANSI.cyan, label: "ready for judge" }),
  ));
  const valueMax = w - 4 - 10;
  if (opts.receipt_path) {
    out.push(labelRow(ch, bar, "receipt", `${ANSI.cyan}${truncPath(opts.receipt_path, valueMax)}${ANSI.reset}`));
  }
  if (opts.summary) {
    out.push(labelRow(ch, bar, "summary", `${ANSI.white}${truncAnsi(opts.summary, valueMax)}${ANSI.reset}`));
  }
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

export function renderTaskReceiptReadyResult(opts: TaskReceiptReadyResultOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = idBar(opts.goal_id);
  const title = opts.goal_title ?? opts.goal_id;
  out.push(ch.topTitled(
    toolTitleContent(opts.goal_id, title, "task_receipt_ready", w),
    badge({ glyph: "✓", color: ANSI.green, label: "accepted" }),
  ));
  const valueMax = w - 4 - 10;
  const taskTail = w >= 72 ? `  ${ANSI.dim}→ awaiting_judge${ANSI.reset}` : "";
  out.push(labelRow(ch, bar, "task", `${ANSI.white}${opts.task_id}${ANSI.reset}${taskTail}`));
  out.push(labelRow(ch, bar, "receipt", `${ANSI.cyan}${truncPath(opts.receipt_path, valueMax)}${ANSI.reset}`));
  out.push(labelRow(ch, bar, "judge run", `${ANSI.gold}${opts.judge_run_id}${ANSI.reset}`));
  if (opts.judge_run_path && w >= 72) {
    out.push(labelRow(ch, bar, "run path", `${ANSI.dim}${truncPath(opts.judge_run_path, valueMax)}${ANSI.reset}`));
  }
  if (opts.judge_receipt_path && w >= 96) {
    out.push(labelRow(ch, bar, "receipt →", `${ANSI.dim}${truncPath(opts.judge_receipt_path, valueMax)}${ANSI.reset}`));
  }
  out.push(labelRow(ch, bar, "next", `${ANSI.cyan}${opts.next_action ?? "judge_pending_launch"}${ANSI.reset}`));
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

// ─── judge_event ──────────────────────────────────────────────────────────
// Low-emphasis administrative log. Dim bar + dim title so it does not
// compete with task_receipt_ready or judge_finish.

export function renderJudgeEventCall(opts: JudgeEventCallOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = idBar(opts.goal_id, { dim: true });
  const title = opts.goal_title ?? opts.goal_id;
  out.push(ch.topTitled(
    dimToolTitleContent(opts.goal_id, title, "judge_event", w),
    badge({ glyph: "·", color: ANSI.gray, label: "logging" }),
  ));
  out.push(labelRow(ch, bar, "event", `${ANSI.white}${opts.event}${ANSI.reset}`));
  if (opts.note) {
    const valueMax = w - 4 - 10;
    out.push(labelRow(ch, bar, "note", `${ANSI.dim}${truncAnsi(opts.note, valueMax)}${ANSI.reset}`));
  }
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

export function renderJudgeEventResult(opts: JudgeEventResultOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = idBar(opts.goal_id, { dim: true });
  const title = opts.goal_title ?? opts.goal_id;
  out.push(ch.topTitled(
    dimToolTitleContent(opts.goal_id, title, "judge_event", w),
    badge({ glyph: "→", color: ANSI.gray, label: "recorded" }),
  ));
  const evParts = [`${ANSI.white}${opts.event}${ANSI.reset}`];
  if (opts.run_id && w >= 56) evParts.push(`${ANSI.gray}run ${ANSI.reset}${ANSI.gold}${opts.run_id}${ANSI.reset}`);
  out.push(labelRow(ch, bar, "event", evParts.join(`${ANSI.gray}  ·  ${ANSI.reset}`)));
  if (opts.receipt_path && w >= 72) {
    const valueMax = w - 4 - 10;
    out.push(labelRow(ch, bar, "receipt", `${ANSI.dim}${truncPath(opts.receipt_path, valueMax)}${ANSI.reset}`));
  }
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

// ─── judge_finish ─────────────────────────────────────────────────────────
// Per-verdict visual weight. pass keeps identity hue; fail/blocked override
// to red; needs_more_evidence overrides to amber.

export function renderJudgeFinishCall(opts: JudgeFinishCallOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = idBar(opts.goal_id);
  const title = opts.goal_title ?? opts.goal_id;
  out.push(ch.topTitled(
    toolTitleContent(opts.goal_id, title, "judge_finish", w),
    badge({ glyph: "◐", color: ANSI.cyan, label: "judging" }),
  ));
  if (opts.run_id) out.push(labelRow(ch, bar, "judge run", `${ANSI.gold}${opts.run_id}${ANSI.reset}`));
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

interface VerdictTheme {
  bar: string;       // ANSI bar (identity, red, or amber)
  titleColor: string; // ANSI for title (identity, red, or amber)
  badge: BadgeOpts;
}

function verdictTheme(opts: JudgeFinishResultOpts, width: number): VerdictTheme {
  const isFail = opts.verdict === "fail";
  const isBlocked = opts.verdict === "blocked";
  const isNeeds = opts.verdict === "needs_more_evidence";

  const longLabel = (
    opts.verdict === "pass" ? "verdict pass" :
    isFail ? "verdict fail" :
    isNeeds ? "needs more evidence" :
    isBlocked ? "blocked" : "verdict"
  );
  const shortLabel = (
    opts.verdict === "pass" ? "pass" :
    isFail ? "fail" :
    isNeeds ? "needs more" :
    isBlocked ? "blocked" : "verdict"
  );
  const label = width >= 56 ? longLabel : shortLabel;

  if (isFail || isBlocked) {
    return {
      bar: `${ANSI.red}▌${ANSI.reset}`,
      titleColor: ANSI.red,
      badge: { glyph: isBlocked ? "⚠" : "✗", color: ANSI.red, label, bold: true },
    };
  }
  if (isNeeds) {
    return {
      bar: `${ANSI.amber}▌${ANSI.reset}`,
      titleColor: ANSI.amber,
      badge: { glyph: "?", color: ANSI.amber, label },
    };
  }
  // pass: keep identity hue on bar and title
  return {
    bar: `${identityColor(opts.goal_id)}▌${ANSI.reset}`,
    titleColor: identityColor(opts.goal_id),
    badge: { glyph: "✓", color: ANSI.green, label },
  };
}

export function renderJudgeFinishResult(opts: JudgeFinishResultOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];

  const theme = verdictTheme(opts, w);
  const title = opts.goal_title ?? opts.goal_id;
  const titleMax = titleMaxFor(w);
  const titleBudget = Math.max(1, titleMax - 2);
  const titleStr = `${theme.titleColor}${ANSI.bold}# ${shortTitle(title, titleBudget)}${ANSI.reset}`;

  out.push(ch.topTitled(
    `${theme.bar} ${titleStr} ${ANSI.gray}·${ANSI.reset} ${ANSI.dim}judge_finish${ANSI.reset}`,
    badge(theme.badge),
  ));

  const valueMax = w - 4 - 10;
  if (opts.run_id && w >= 56) {
    out.push(labelRow(ch, theme.bar, "judge run", `${ANSI.gold}${opts.run_id}${ANSI.reset}`));
  }
  out.push(labelRow(ch, theme.bar, "receipt", `${ANSI.cyan}${truncPath(opts.receipt_path, valueMax)}${ANSI.reset}`));

  if (opts.summary && w >= 56) {
    out.push(ch.rowBar(theme.bar, ""));
    const lines = opts.summary.split("\n");
    out.push(labelRow(ch, theme.bar, "summary", `${ANSI.white}${truncAnsi(lines[0] ?? "", valueMax)}${ANSI.reset}`));
    for (const line of lines.slice(1)) {
      out.push(ch.rowBar(theme.bar, " ".repeat(10) + `${ANSI.white}${truncAnsi(line, valueMax)}${ANSI.reset}`));
    }
  }
  if (opts.next_action && w >= 72) {
    out.push(ch.rowBar(theme.bar, ""));
    const naColor = opts.verdict === "pass" ? ANSI.green : ANSI.amber;
    out.push(labelRow(ch, theme.bar, "next", `${naColor}${opts.next_action}${ANSI.reset}`));
  }
  if (w >= 56) out.push(slugFooter(ch, theme.bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

// ─── validate_goal_state ─────────────────────────────────────────────────

export function renderValidateGoalStateCall(opts: ValidateGoalStateCallOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = idBar(opts.goal_id);
  const title = opts.goal_title ?? opts.goal_id;
  out.push(ch.topTitled(
    toolTitleContent(opts.goal_id, title, "validate_goal_state", w),
    badge({ glyph: "◐", color: ANSI.cyan, label: "checking" }),
  ));
  out.push(labelRow(ch, bar, "goal", `${ANSI.white}${opts.goal_id}${ANSI.reset}`));
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

export function renderValidateGoalStateResult(opts: ValidateGoalStateResultOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = opts.ok ? idBar(opts.goal_id) : `${ANSI.red}▌${ANSI.reset}`;
  const title = opts.goal_title ?? opts.goal_id;
  const titleBudget = Math.max(1, titleMaxFor(w) - 2);
  const titleColor = opts.ok ? identityColor(opts.goal_id) : ANSI.red;
  const titleStr = `${titleColor}${ANSI.bold}# ${shortTitle(title, titleBudget)}${ANSI.reset}`;
  out.push(ch.topTitled(
    `${bar} ${titleStr} ${ANSI.gray}·${ANSI.reset} ${ANSI.dim}validate_goal_state${ANSI.reset}`,
    opts.ok
      ? badge({ glyph: "✓", color: ANSI.green, label: "valid" })
      : badge({ glyph: "✗", color: ANSI.red, label: "invalid", bold: true }),
  ));
  const valueMax = w - 4 - 10;
  out.push(labelRow(ch, bar, "state", `${ANSI.cyan}${truncPath(opts.state_path, valueMax)}${ANSI.reset}`));
  if (!opts.ok) {
    out.push(labelRow(ch, bar, "issues", `${ANSI.red}${opts.issue_count}${ANSI.reset}`));
    const shown = opts.issues.slice(0, w >= 96 ? 4 : 2);
    for (const issue of shown) {
      const location = issue.path ? `${issue.path} ` : "";
      const text = `${location}${issue.code}: ${issue.message}`;
      const color = issue.severity === "error" ? ANSI.red : ANSI.amber;
      out.push(labelRow(ch, bar, issue.severity, `${color}${truncAnsi(text, valueMax)}${ANSI.reset}`));
    }
    if (opts.issue_count > shown.length && w >= 56) {
      out.push(labelRow(ch, bar, "more", `${ANSI.dim}${opts.issue_count - shown.length} additional issue(s)${ANSI.reset}`));
    }
  }
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

// ─── failure card (ContextError / tool throws) ────────────────────────────

export function renderFailureCard(opts: FailureCardOpts, width: number): string[] {
  const w = safeWidth(width);
  const ch = chrome(w);
  const out: string[] = [];
  const bar = `${ANSI.red}▌${ANSI.reset}`; // red overrides identity for errors
  const title = opts.goal_title ?? opts.goal_id;
  const titleBudget = Math.max(1, titleMaxFor(w) - 2);
  // Dim+colored title — acknowledges the goal exists but lets the error dominate.
  const titleStr = `${ANSI.dim}${identityColor(opts.goal_id)}# ${shortTitle(title, titleBudget)}${ANSI.reset}`;
  out.push(ch.topTitled(
    `${bar} ${titleStr} ${ANSI.gray}·${ANSI.reset} ${ANSI.dim}${opts.tool}${ANSI.reset}`,
    badge({ glyph: "✗", color: ANSI.red, label: "error", bold: true }),
  ));
  const valueMax = w - 4 - 10;
  const errLines = (opts.error ?? "").split("\n");
  out.push(labelRow(ch, bar, "error", `${ANSI.red}${truncAnsi(errLines[0] ?? "", valueMax)}${ANSI.reset}`));
  for (const line of errLines.slice(1)) {
    if (!line.trim()) continue;
    out.push(ch.rowBar(bar, " ".repeat(10) + `${ANSI.dim}${truncAnsi(line, valueMax)}${ANSI.reset}`));
  }
  if (opts.suggestion && w >= 56) {
    out.push(ch.rowBar(bar, ""));
    out.push(labelRow(ch, bar, "fix", `${ANSI.amber}${truncAnsi(opts.suggestion, valueMax)}${ANSI.reset}`));
  }
  if (w >= 56) out.push(slugFooter(ch, bar, opts.goal_id, w - 8));
  out.push(ch.bot());
  return out;
}

// ─── pi component factory wrappers ────────────────────────────────────────

export interface TextRenderable {
  invalidate(): void;
  render(width: number): string[];
}

// Wraps a card-building function so pi can call it with the actual render
// width. Lines are truncated defensively in case the builder over-runs.
export function chromeRenderable(build: (width: number) => string[]): TextRenderable {
  return {
    invalidate() {},
    render(width: number) {
      const w = safeWidth(width);
      const lines = build(w);
      return lines.map((line) => (visWidth(line) <= w ? line : truncAnsi(line, w)));
    },
  };
}

// Plain-text fallback used when no factory width is available — kept tiny.
export function textBlock(lines: string[]): TextRenderable {
  return {
    invalidate() {},
    render() {
      return [...lines];
    },
  };
}
