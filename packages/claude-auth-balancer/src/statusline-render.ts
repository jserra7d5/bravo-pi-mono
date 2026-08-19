// Statusline rendering.
//
// Visual language is deliberately the one already in use: solid `#` over dim
// `~`, coloured by threshold, percentage to the right. The point of this file
// is to add account attribution without changing how the bars look.
//
// Three rules shape everything here:
//
//   1. Width is finite and shared. Bars shrink before anything is dropped, and
//      what gets dropped is dropped in a fixed order, so the line never reflows
//      unpredictably as numbers change.
//   2. Active account attribution uses both a glyph and colour. Quota warnings
//      stay compact: the existing red bar plus a red account marker carries the
//      evacuation state without adding a large text label.
//   3. Salience tracks relevance. The account serving this session renders at
//      full strength; every other account renders one step down, hue intact.

import type { AccountView, StatuslineModel } from './statusline.js';

export const RESET = '\u001b[0m';
export const DIM = '\u001b[2m';
export const BOLD = '\u001b[1m';

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const MAGENTA = '\u001b[35m';

/**
 * Glyphs.
 *
 * `unicode` is the default. `ascii` exists because node writes UTF-8 bytes
 * regardless of the terminal's locale: on a Latin-1 terminal every block
 * character arrives as three garbage bytes, so a 12-cell bar draws 36 columns
 * and every line wraps. The CLI picks the set from `LC_ALL`/`LC_CTYPE`/`LANG`.
 *
 * The active/inactive markers are the fragile pair, not the blocks: the shade
 * blocks are legacy CP437 and present in every font people actually set as a
 * terminal font, whereas `▸` was found in 3 of 20 installed monospace families.
 * On a miss, fontconfig substitutes a proportional face whose advance is not
 * the cell width, and the column drifts.
 */
export type Glyphs = {
  fill: string;
  empty: string;
  active: string;
  inactive: string;
  reset: string;
  ellipsis: string;
};

export const UNICODE_GLYPHS: Glyphs = {
  fill: '█',
  empty: '░',
  active: '▸',
  inactive: '·',
  reset: '↺',
  ellipsis: '…',
};

export const ASCII_GLYPHS: Glyphs = {
  fill: '#',
  empty: '-',
  active: '>',
  inactive: '.',
  reset: '~',
  ellipsis: '...',
};

/**
 * Code points whose rendered width depends on the terminal's locale.
 *
 * East_Asian_Width=Ambiguous: one column in a Western locale, two under a CJK
 * one. `█` is ambiguous but `░` is NOT, so in a wide-ambiguous terminal a bar
 * physically grows as it fills and everything to its right slides — measured at
 * three columns of drift between two account rows that `visibleWidth` called
 * identical. Counting them correctly at least keeps the overflow arithmetic
 * honest; see the note in the followup ledger for the residual alignment drift.
 */
const AMBIGUOUS = new Set(['█', '▓', '▒', '·', '…']);

/**
 * Whether this terminal draws ambiguous-width characters double-wide. Set once
 * from the locale by {@link configureWidth}; defaults to the Western answer.
 */
let ambiguousIsWide = false;

const CJK_LOCALE = /(^|[._-])(zh|ja|ko|yue)([._-]|$)/i;

export function configureWidth(locale: string | undefined): void {
  ambiguousIsWide = locale !== undefined && CJK_LOCALE.test(locale);
}

/** Marks the account serving this session. */
export const ACTIVE_MARK = UNICODE_GLYPHS.active;

/**
 * Line-1 separator.
 *
 * Plain spaces, not `·`. `·` is the inactive-account marker two lines down, and
 * a glyph that means "not your account" in one place and "next field" in another
 * costs a beat of translation every time the eye lands on it.
 */
const SEP = '  ';

/** Matches an ANSI colour escape only at position 0. */
const ESCAPE_AT_START = /^\u001b\[[0-9;]*m/;

export type RenderOptions = {
  width?: number;
  color?: boolean;
  glyphs?: Glyphs;
};

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${RESET}` : text;
}

/**
 * One ramp, used by both quota and context.
 *
 * These previously ran on different ramps — blue/magenta/red for quota,
 * green/yellow/red for context — so the same "fine" state wore two colours and
 * neither could be learned. Low is green, high is red, everywhere.
 *
 * 90 is red because Fable routing evacuates at 95, while non-Fable routing
 * deliberately drains through it. Either way the operator should see an
 * account going hot before it reaches the hard limit.
 *
 * Colour is redundant here, never the sole carrier — the bar length and the
 * printed percentage say the same thing — which matters because green and red
 * collapse to a ΔE of 26 under deuteranopia.
 */
export function quotaColor(percent: number): string {
  if (percent >= 90) return RED;
  if (percent >= 75) return YELLOW;
  return GREEN;
}

/** Context fills toward a hard wall rather than a refill, so it warms earlier. */
export function contextColor(percent: number): string {
  if (percent >= 90) return RED;
  if (percent >= 70) return YELLOW;
  return GREEN;
}

/**
 * A bar. `undefined` renders as an unfilled bar rather than nothing, so the
 * columns stay aligned when one account has no observation yet.
 *
 * `dim` keeps the hue and drops the intensity — an inactive account at 96% is
 * still visibly red, just not shouting.
 */
export function bar(
  percent: number | undefined,
  width: number,
  color: (p: number) => string,
  enabled: boolean,
  dim = false,
  glyphs: Glyphs = UNICODE_GLYPHS,
): string {
  // Guard the floor: `barWidth` can be handed a 1-column terminal, and
  // `'#'.repeat(-1)` is a RangeError — a thrown statusline on every turn.
  const w = Math.max(0, Math.round(width));
  if (w === 0) return '';
  if (percent === undefined) {
    const track = glyphs.empty.repeat(w);
    return enabled ? `${DIM}${track}${RESET}` : track;
  }
  const p = Math.min(100, Math.max(0, percent));
  // Round, but never show an empty bar for a non-zero value or a full bar for
  // anything under 100 — a bar that reads "done" at 99.6% is a lie at a glance.
  let filled = Math.round((p / 100) * w);
  if (p > 0 && filled === 0) filled = 1;
  if (p < 100 && filled === w && w > 0) filled = w - 1;
  const empty = w - filled;
  if (!enabled) return glyphs.fill.repeat(filled) + glyphs.empty.repeat(empty);
  const hue = dim ? `${DIM}${color(p)}` : color(p);
  return `${hue}${glyphs.fill.repeat(filled)}${RESET}${DIM}${glyphs.empty.repeat(empty)}${RESET}`;
}

export function formatPercent(percent: number | undefined): string {
  if (percent === undefined) return '  --';
  return `${Math.round(percent).toString().padStart(3)}%`;
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Compact duration until an epoch-seconds reset. Empty when already past. */
export function formatReset(resetAtSeconds: number | undefined, nowMs: number): string {
  if (resetAtSeconds === undefined) return '';
  const diffMs = resetAtSeconds * 1000 - nowMs;
  if (diffMs <= 0) return '';
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH > 0 ? `${days}d${remH}h` : `${days}d`;
  }
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
}

/**
 * Printable width, ignoring ANSI.
 *
 * Iterates code points, not UTF-16 units, so an astral character counts once
 * rather than twice — and ambiguous-width code points count two under a CJK
 * locale, which is the only place they draw that way.
 */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(/\u001b\[[0-9;]*m/g, '')) {
    width += ambiguousIsWide && AMBIGUOUS.has(ch) ? 2 : 1;
  }
  return width;
}

/**
 * Bar width, scaled to the terminal.
 *
 * Two accounts each show two bars on one line, so the per-bar budget is roughly
 * a tenth of the width. Clamped so it never becomes decorative-only or absurd.
 */
export function barWidth(width: number): number {
  if (width <= 60) return 5;
  if (width <= 100) return 8;
  if (width <= 140) return 10;
  return 12;
}

/**
 * Cut to a visible width without slicing an escape sequence in half.
 *
 * A naive `slice` can cut mid-escape, which leaves the terminal painted in the
 * last colour for everything printed after it — the status bar then corrupts
 * the prompt below it. Closes with a RESET only when colour is on: emitting a
 * bare escape under `--no-color`/`NO_COLOR` is exactly the garbage those flags
 * exist to suppress.
 *
 * The cut is marked. An unmarked cut on an account row is not a shorter line,
 * it is a confident false statement — a 96% account whose `7d` bar fell off the
 * end reads as completely idle.
 */
export function truncateVisible(
  text: string,
  width: number,
  enabled = true,
  ellipsis = UNICODE_GLYPHS.ellipsis,
): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const markWidth = visibleWidth(ellipsis);
  const budget = width > markWidth ? width - markWidth : width;
  let out = '';
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < budget) {
    const escape = ESCAPE_AT_START.exec(text.slice(i));
    if (escape) {
      if (enabled) out += escape[0];
      i += escape[0].length;
      continue;
    }
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    const cpWidth = ambiguousIsWide && AMBIGUOUS.has(cp) ? 2 : 1;
    if (seen + cpWidth > budget) break;
    out += cp;
    seen += cpWidth;
    i += cp.length;
  }
  const mark = width > markWidth ? ellipsis : '';
  return enabled ? `${out}${mark}${RESET}` : `${out}${mark}`;
}

/**
 * Join `required` with as many `optional` tails as actually fit.
 *
 * Optional segments are dropped from the END, so what disappears first is what
 * was declared least important. The line degrades in a fixed order rather than
 * reflowing differently every time a number happens to change width.
 */
export function assemble(
  required: string,
  optional: string[],
  separator: string,
  width: number,
  enabled = true,
  ellipsis = UNICODE_GLYPHS.ellipsis,
): string {
  for (let kept = optional.length; kept > 0; kept -= 1) {
    const candidate = [required, ...optional.slice(0, kept)].join(separator);
    if (visibleWidth(candidate) <= width) return candidate;
  }
  return visibleWidth(required) <= width
    ? required
    : truncateVisible(required, width, enabled, ellipsis);
}

/**
 * A status note, width-fitted like every other line.
 *
 * Fitted rather than emitted raw because these are the lines that render when
 * something is already wrong, and a note that wraps pushes the account rows off
 * the visible status region — hiding the data at the exact moment it matters.
 */
function note(text: string, opts: Required<RenderOptions>): string {
  const full = `balancer: ${text}`;
  const fitted =
    visibleWidth(full) <= opts.width
      ? full
      : truncateVisible(text, opts.width, opts.color, opts.glyphs.ellipsis);
  return paint(fitted, DIM, opts.color);
}

function effortSegment(effort: StatuslineModel['effort'], enabled: boolean): string | undefined {
  if (effort === undefined) return undefined;
  let style: string;
  switch (effort.level) {
    case 'low': style = DIM; break;
    case 'medium': style = GREEN; break;
    case 'high': style = CYAN; break;
    case 'xhigh': style = YELLOW; break;
    case 'max': style = `${BOLD}${MAGENTA}`; break;
    default: return paint('effort ?', DIM, enabled);
  }
  return `${paint('effort', DIM, enabled)} ${paint(effort.level, style, enabled)}`;
}

function renderContextLine(model: StatuslineModel, opts: Required<RenderOptions>): string {
  const c = opts.color;
  const g = opts.glyphs;

  // Context leads and carries the only emphasis on this line. It is the number
  // the user acts on — everything else here is orientation, and orientation
  // does not need to be the brightest thing on the screen.
  let head = '';
  if (model.contextPercent !== undefined) {
    const w = barWidth(opts.width);
    const detail =
      model.contextTokens !== undefined && model.contextWindow
        ? `${formatTokens(model.contextTokens)}/${formatTokens(model.contextWindow)}`
        : '';
    head =
      `${paint('ctx', DIM, c)} ${bar(model.contextPercent, w, contextColor, c, false, g)} ` +
      `${paint(formatPercent(model.contextPercent), BOLD, c)}` +
      `${detail ? ` ${paint(detail, DIM, c)}` : ''}`;
  }

  const tail: string[] = [];
  // Emphasis is BOLD, never a bright-white foreground: `97m` is the background
  // on a light-theme terminal, so the thing marked most important is the one
  // thing that disappears.
  if (model.modelName) tail.push(model.modelName);
  const effort = effortSegment(model.effort, c);
  if (effort) tail.push(effort);
  if (model.agentType && model.agentType !== 'main') {
    tail.push(paint(`[${model.agentType}]`, CYAN, c));
  }
  if (model.project) tail.push(paint(model.project, DIM, c));
  if (model.costUsd !== undefined && model.costUsd > 0) {
    tail.push(paint(`$${model.costUsd.toFixed(2)}`, DIM, c));
  }

  if (!head) {
    const [first, ...rest] = tail;
    return assemble(first ?? '', rest, SEP, opts.width, c, g.ellipsis);
  }
  return assemble(head, tail, SEP, opts.width, c, g.ellipsis);
}

function renderAccountLine(
  account: AccountView,
  opts: Required<RenderOptions>,
  nowMs: number,
  labelWidth: number,
): string {
  const c = opts.color;
  const g = opts.glyphs;
  const w = barWidth(opts.width);
  const off = !account.active;
  const markGlyph = account.active ? g.active : g.inactive;
  const markStyle = account.evacuating
    ? account.active ? `${BOLD}${RED}` : RED
    : account.active ? `${BOLD}${GREEN}` : DIM;
  const mark = paint(markGlyph, markStyle, c);
  const label = padVisible(account.label, labelWidth);
  const name = account.active ? paint(label, BOLD, c) : paint(label, DIM, c);

  if (account.needsReauth) {
    // Through `assemble` like every other row, so it cannot be the one line in
    // the renderer that wraps on a narrow terminal.
    return assemble(
      `${mark} ${name}`,
      [paint('needs re-auth', off ? `${DIM}${RED}` : RED, c)],
      ' ',
      opts.width,
      c,
      g.ellipsis,
    );
  }

  // Required: identity plus both quota windows. Anything past this is a bonus
  // and gets dropped, in this order, when the terminal is narrow.
  const required =
    `${mark} ${name} ` +
    `${paint('5h', DIM, c)} ${bar(account.fiveHour, w, quotaColor, c, off, g)} ${formatPercent(account.fiveHour)}  ` +
    `${paint('7d', DIM, c)} ${bar(account.sevenDay, w, quotaColor, c, off, g)} ${formatPercent(account.sevenDay)}`;

  const optional: string[] = [];

  // The reset time leads the optional tail — it is the only thing here the bars
  // and evacuation marker do not already say.
  const sevenHotter = (account.sevenDay ?? 0) >= (account.fiveHour ?? 0);
  const binding = sevenHotter
    ? formatReset(account.sevenDayResetAt, nowMs)
    : formatReset(account.fiveHourResetAt, nowMs);
  // Labelled with its window: an unlabelled `↺ 3h14m` next to two bars is read
  // against whichever one the eye landed on last.
  if (binding) optional.push(paint(`${sevenHotter ? '7d' : '5h'}${g.reset}${binding}`, DIM, c));

  if (!account.evacuating && account.overageAllowed && (account.sevenDay ?? 0) >= 90) {
    optional.push(paint('overage ok', off ? DIM : YELLOW, c));
  }
  // "no observation at all" and "an observation from eleven hours ago" are
  // different problems and get different words.
  if (account.stale) optional.push(paint('no data', DIM, c));
  else if (account.aged) optional.push(paint('stale', DIM, c));

  return assemble(required, optional, '  ', opts.width, c, g.ellipsis);
}

/** Pad or cut to a visible width, counting code points rather than UTF-16 units. */
function padVisible(text: string, width: number): string {
  const cps = Array.from(text);
  if (cps.length >= width) return cps.slice(0, width).join('');
  return text + ' '.repeat(width - cps.length);
}

/**
 * The whole statusline.
 *
 * Returns multiple lines; Claude Code renders each. Accounts are listed in slot
 * order rather than sorted by usage, so a given account stays on a given row
 * and the eye learns where to look.
 */
export function render(
  model: StatuslineModel,
  options: RenderOptions = {},
  nowMs = Date.now(),
): string {
  const opts: Required<RenderOptions> = {
    width: options.width ?? 80,
    color: options.color ?? true,
    glyphs: options.glyphs ?? UNICODE_GLYPHS,
  };

  const lines: string[] = [];
  const context = renderContextLine(model, opts);
  if (context) lines.push(context);
  for (const warning of model.warnings ?? []) {
    lines.push(note(`warning: ${warning}`, opts));
  }

  if (model.accounts.length === 0) {
    lines.push(note(model.balancerUnknown ? 'no accounts found' : 'unavailable', opts));
    return lines.join('\n');
  }

  const labelWidth = Math.min(
    18,
    Math.max(...model.accounts.map(a => Array.from(a.label).length)),
  );
  for (const account of model.accounts) {
    lines.push(renderAccountLine(account, opts, nowMs, labelWidth));
  }

  // No row marked active means the proxy has not routed this session. Saying so
  // is the difference between "the balancer picked slot 1" and "the balancer is
  // not in the path" — which otherwise look identical, and the silent reading
  // is the reassuring one.
  if (!model.sessionAttributed) {
    lines.push(note(model.balancerUnknown ? 'not running' : 'session not routed yet', opts));
  }

  return lines.join('\n');
}
