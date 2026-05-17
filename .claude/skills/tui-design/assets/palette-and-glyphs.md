# Quick reference card — palette + glyphs

Copy-paste constants for new TUI work. The exact RGB triplets and glyph mappings used everywhere in this repo.

## TypeScript palette (drop into a new package)

```ts
const ANSI = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",

  // semantic threshold
  dim:    "\x1b[38;2;120;120;128m",   // #787880 — idle, dead, low priority
  muted:  "\x1b[38;2;160;160;170m",   // #A0A0AA — secondary text
  text:   "\x1b[38;2;220;220;221m",   // #DCDCDD — default content
  chrome: "\x1b[38;2;110;110;120m",   // #6E6E78 — card borders
  ok:     "\x1b[38;2;126;201;145m",   // #7EC991 — success
  warn:   "\x1b[38;2;229;181;72m",    // #E5B548 — attention
  bad:    "\x1b[38;2;232;111;111m",   // #E86F6F — error/urgent

  // domain accents
  branch: "\x1b[38;2;174;215;255m",   // #AED7FF — git branches
  cost:   "\x1b[38;2;200;220;200m",   // #C8DCC8 — money
  sub:    "\x1b[38;2;180;200;220m",   // #B4C8DC — subscription marker

  // diff
  diffAdd:    "\x1b[38;2;126;201;145m",  // green
  diffRm:     "\x1b[38;2;232;111;111m",  // red
  diffHunk:   "\x1b[38;2;174;215;255m",  // sky

  // showcase mode badges
  md:    "\x1b[38;2;229;181;72m",   // amber — prose
  code:  "\x1b[38;2;126;201;145m",  // green — source
  json:  "\x1b[38;2;232;200;126m",  // butter — data
  diff:  "\x1b[38;2;213;163;233m",  // lavender — diffs
  plain: "\x1b[38;2;160;160;170m",  // muted — plain text/logs
};

const IDENTITY_PALETTE = [
  "\x1b[38;2;229;181;72m",   // 0 gold
  "\x1b[38;2;126;201;145m",  // 1 green
  "\x1b[38;2;174;215;255m",  // 2 sky
  "\x1b[38;2;213;163;233m",  // 3 lavender
  "\x1b[38;2;232;156;126m",  // 4 coral
  "\x1b[38;2;126;212;201m",  // 5 teal
  "\x1b[38;2;232;200;126m",  // 6 butter
  "\x1b[38;2;200;160;220m",  // 7 violet
];

function identitySlot(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  return h % IDENTITY_PALETTE.length;
}

function identityColor(name: string): string {
  return IDENTITY_PALETTE[identitySlot(name)];
}
```

## Glyphs

```ts
const GLYPHS = {
  // state glyphs
  running:    "◐",   // U+25D0
  waiting:    "?",   // U+003F
  blocked:    "⚠",   // U+26A0
  completed:  "✓",   // U+2713
  ready:      "★",   // U+2605
  failed:     "✗",   // U+2717
  transition: "→",   // U+2192
  separator:  "·",   // U+00B7

  // bars
  barFill:    "▰",   // U+25B0
  barEmpty:   "▱",   // U+25B1

  // chrome
  cornerTL:   "╭",   // U+256D
  cornerTR:   "╮",   // U+256E
  cornerBR:   "╯",   // U+256F
  cornerBL:   "╰",   // U+2570
  dash:       "─",   // U+2500
  sideBar:    "│",   // U+2502
  identity:   "▌",   // U+258C
};
```

## State → glyph + color mapping

```ts
function stateGlyph(state: string): { glyph: string; color: string } {
  switch (state) {
    case "running":
    case "working":
    case "in_progress":
      return { glyph: GLYPHS.running, color: ANSI.text };

    case "waiting":
    case "waiting_for_input":
    case "question":
      return { glyph: GLYPHS.waiting, color: ANSI.warn };

    case "blocked":
    case "stalled":
      return { glyph: GLYPHS.blocked, color: ANSI.bad };

    case "completed":
    case "passed":
    case "verified":
    case "pass":
      return { glyph: GLYPHS.completed, color: ANSI.ok };

    case "ready":
    case "result_ready":
      return { glyph: GLYPHS.ready, color: ANSI.warn };  // gold/amber

    case "failed":
    case "fail":
    case "error":
      return { glyph: GLYPHS.failed, color: ANSI.bad };

    case "handoff":
    case "transitioning":
      return { glyph: GLYPHS.transition, color: ANSI.text };

    default:
      return { glyph: "·", color: ANSI.dim };
  }
}
```

## Threshold logic

For fills that GROW toward danger (context %, disk usage):

```ts
function fillThreshold(pct: number): string {
  if (pct >= 90) return ANSI.bad;
  if (pct >= 70) return ANSI.warn;
  if (pct >= 50) return ANSI.text;
  return ANSI.dim;
}
```

For levels that DEPLETE toward danger (rate-limit windows, time remaining):

```ts
function depleteThreshold(remainingPct: number): string {
  if (remainingPct <= 10) return ANSI.bad;
  if (remainingPct <= 30) return ANSI.warn;
  return ANSI.ok;
}
```

## Minimum-viable card render

A complete container-chrome card builder you can drop in:

```ts
function chrome(width: number, idColor: string) {
  const inner = width - 4;  // ▌ + space + content + space + │
  return {
    inner,
    top: (title: string, right?: string) => {
      const tw = visWidth(title);
      const rw = right ? visWidth(right) : 0;
      if (right) {
        const min = 4 + tw + 1 + 1 + rw + 1 + 2;
        if (min <= width) {
          const dashes = width - min;
          return `${idColor}╭─${ANSI.reset} ${title} ${ANSI.chrome}${"─".repeat(Math.max(2, dashes))}${ANSI.reset} ${right} ${idColor}─╮${ANSI.reset}`;
        }
      }
      const dashes = Math.max(2, width - 4 - tw - 2);
      return `${idColor}╭─${ANSI.reset} ${title} ${ANSI.chrome}${"─".repeat(dashes)}${ANSI.reset}${idColor}─╮${ANSI.reset}`;
    },
    row: (content: string) => {
      const cells = visWidth(content);
      const pad = Math.max(0, inner - cells);
      return `${idColor}▌${ANSI.reset} ${content}${" ".repeat(pad)} ${ANSI.chrome}│${ANSI.reset}`;
    },
    blank: () => `${idColor}▌${ANSI.reset} ${" ".repeat(inner)} ${ANSI.chrome}│${ANSI.reset}`,
    bot: () => `${idColor}╰${ANSI.chrome}${"─".repeat(width - 2)}${idColor}╯${ANSI.reset}`,
  };
}

// usage:
const ch = chrome(width, identityColor("my-agent"));
return [
  ch.top(`${ANSI.bold}@my-agent${ANSI.reset} ${ANSI.dim}·${ANSI.reset} worker`, `${ANSI.dim}1m${ANSI.reset}`),
  ch.row(`${ANSI.dim}task    ${ANSI.reset}${ANSI.text}Implement feature X${ANSI.reset}`),
  ch.row(`${ANSI.dim}status  ${ANSI.reset}${stateGlyph("working").color}${stateGlyph("working").glyph}${ANSI.reset} working`),
  ch.bot(),
].join("\n");
```

## Common widths

For your responsive cutoffs:

| Use case | Wide | Medium | Narrow | Tiny |
|---|---|---|---|---|
| Widget (in editor container) | 96 | 72 | 54 | 32 |
| Footer (full terminal width) | 120 | 80 | 60 | 40 |
| Tool card (full terminal width) | 120 | 96 | 72 | 56 |
| Mockup file (under 94-col tmux) | 88 | 72 | 56 | 44 |

Test at the boundaries: 79/80, 95/96, 119/120 — that's where off-by-one bugs live.
