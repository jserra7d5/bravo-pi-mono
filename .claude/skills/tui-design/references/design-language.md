# Design language reference

Detailed coverage of the visual vocabulary used across all TUI surfaces in this repo. Read this when picking colors, glyphs, or chrome variants for a new element.

## Color palette — exact RGBs

These constants live in `packages/async-subagents/extensions/pi/renderers.ts` as `IDENTITY_PALETTE` and `ANSI`. The footer (`.pi/extensions/codex-usage.ts`) and bravo-goals (`packages/bravo-goals/extensions/pi/renderers.ts`) mirror them. **Do not introduce a fourth divergent copy.**

### Semantic threshold colors

ANSI true-color escapes for state signaling. Use these everywhere for consistency.

```ts
const ANSI = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[38;2;120;120;128m",   // #787880 — idle, dead-but-visible, low priority
  muted:  "\x1b[38;2;160;160;170m",   // #A0A0AA — secondary text
  text:   "\x1b[38;2;220;220;221m",   // #DCDCDD — default content
  chrome: "\x1b[38;2;110;110;120m",   // #6E6E78 — card border dashes
  ok:     "\x1b[38;2;126;201;145m",   // #7EC991 — success, healthy
  warn:   "\x1b[38;2;229;181;72m",    // #E5B548 — attention, intermediate
  bad:    "\x1b[38;2;232;111;111m",   // #E86F6F — error, blocked, urgent
};
```

### Identity palette — the 8 hues

```ts
const IDENTITY_PALETTE = [
  "\x1b[38;2;229;181;72m",   // gold     — slot 0
  "\x1b[38;2;126;201;145m",  // green    — slot 1
  "\x1b[38;2;174;215;255m",  // sky      — slot 2
  "\x1b[38;2;213;163;233m",  // lavender — slot 3
  "\x1b[38;2;232;156;126m",  // coral    — slot 4
  "\x1b[38;2;126;212;201m",  // teal     — slot 5
  "\x1b[38;2;232;200;126m",  // butter   — slot 6
  "\x1b[38;2;200;160;220m",  // violet   — slot 7
];
```

These 8 hues are chosen so adjacent slots are visually distinguishable on both light and dark terminal backgrounds. They are NOT randomly picked. Don't substitute.

### Identity hash algorithm

```ts
function identitySlot(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  }
  return h % IDENTITY_PALETTE.length;
}

function identityColor(name: string): string {
  return IDENTITY_PALETTE[identitySlot(name)];
}
```

Hash is `(h*31 + ch) >>> 0` (Java-style string hash, unsigned). Slot is modulo 8. **Use the same algorithm in every package** so the same name renders the same color everywhere.

What to hash:
- Agents → hash on agent display name
- Goals → hash on `goal_id` (stable; title can be edited)
- Files → hash on full path (so same file always renders same color across invocations)
- Models → hash on model id (gpt-5.5, claude-opus-4-7, etc.)

### Domain accents

Narrower-use colors for specific semantic contexts. Use sparingly — every new accent is a new thing the reader has to remember.

```ts
branch:   "\x1b[38;2;174;215;255m"   // #AED7FF (sky) — git branches
cost:     "\x1b[38;2;200;220;200m"   // #C8DCC8 (pale green) — money
sub:      "\x1b[38;2;180;200;220m"   // #B4C8DC (pale blue) — subscription marker
diffAdd:  "\x1b[38;2;126;201;145m"   // green — diff additions
diffRm:   "\x1b[38;2;232;111;111m"   // red — diff removals
diffHunk: "\x1b[38;2;174;215;255m"   // sky — diff @@ hunk headers
```

### Mode badges (for file rendering — showcase tool)

```ts
md:    "\x1b[38;2;229;181;72m"   // amber/gold — prose
code:  "\x1b[38;2;126;201;145m"  // green — source code
json:  "\x1b[38;2;232;200;126m"  // butter — data
diff:  "\x1b[38;2;213;163;233m"  // lavender — diffs
plain: "\x1b[38;2;160;160;170m"  // muted — plain text/logs
```

## Glyphs — what each one means

### State glyphs (lifecycle/status)

Each glyph carries semantic weight. Don't substitute for "looks cooler".

| Glyph | Code | State | Color |
|---|---|---|---|
| `◐` | U+25D0 | running / working | identity or text |
| `?` | U+003F | waiting for input / question | warn (amber) |
| `⚠` | U+26A0 | blocked / problem needing intervention | bad (red) |
| `✓` | U+2713 | completed / verified / pass | ok (green) |
| `★` | U+2605 | result ready / notable terminal | warn (amber/gold) |
| `✗` | U+2717 | failed | bad (red) |
| `→` | U+2192 | handing off / transitioning | text or identity |
| `·` | U+00B7 | field separator | dim |

### Bar glyphs (progress, depletion)

```
▰  U+25B0 — filled cell      (use for "amount used / consumed")
▱  U+25B1 — empty cell       (use for "amount remaining / track")
```

Render a bar:
```ts
function bar(pct, width, color) {
  const cells = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${color}${"▰".repeat(cells)}${ANSI.dim}${"▱".repeat(width - cells)}${ANSI.reset}`;
}
```

For codex-style rate-limit windows where the bar represents **depletion** (a full bar = nearly out), flip the threshold logic:

```ts
function codexThreshold(remainingPct) {
  if (remainingPct <= 10) return ANSI.bad;    // <=10% remaining = red
  if (remainingPct <= 30) return ANSI.warn;   // <=30% = amber
  return ANSI.ok;                              // >30% = green
}
```

For context-fill where the bar represents **usage** (a full bar = nearly out of room):

```ts
function ctxThreshold(usedPct) {
  if (usedPct >= 90) return ANSI.bad;
  if (usedPct >= 70) return ANSI.warn;
  if (usedPct >= 50) return ANSI.text;
  return ANSI.dim;
}
```

### Chrome glyphs (borders, identity bar)

```
╭ U+256D  top-left corner
╮ U+256E  top-right corner
╯ U+256F  bottom-right corner
╰ U+2570  bottom-left corner
─ U+2500  horizontal dash
│ U+2502  vertical side bar
▌ U+258C  identity left bar (half-block, takes 1 cell)
```

Use ROUNDED corners (`╭╮╰╯`), not square (`┌┐└┘`). Sharp corners read as more aggressive/utilitarian; rounded corners match the calmer, prose-friendly tone of the rest of the design.

## Chrome variants — three layouts

### Container chrome (full card)

Used for: structured state, lifecycle cards, status widgets, tool-call summaries with key/value rows.

```
╭─ Title · subtitle ──────────────────────── right-tag ─╮
▌  label   value                                        │
▌  label   value                                        │
▌                                                       │
▌  body text wrapping here                              │
╰────────────────────────────────────────────────────────╯
```

Anatomy:
- Top rule: `╭─ <title> ──── <right> ─╮` with identity-colored corners, dim chrome dashes, identity-colored title bold
- Body rows: `▌ <content padded to inner width> │` — both side glyphs identity-colored bar; content padded to `width - 4`
- Bottom rule: `╰────────────────╯` matching identity-colored corners

When to use: data with discrete fields that benefit from row-by-row alignment. Widgets, lifecycle cards, agent identity cards.

### Bookend chrome (rules only)

Used for: content that IS the payload — files, code slices, markdown documents, anything where side bars would impede the reader.

```
╭─ filename · MODE · lines 1-12 ────────── parent/dir ─╮
  the content
  flows freely
  no side bars
╰────────────────────────────────────────────────────────╯
```

Anatomy:
- Top rule: same as container
- Body: NO side bars, NO padding — just the raw content. Line numbers (when relevant) are part of the content.
- Bottom rule: same as container

When to use: showcase tool (renders files), any "here's the raw thing" surface. Critical user feedback: "ideally, nothing impeding or surrounding the content itself, just before and after the content".

### Half-card / inline (status line)

For single-line status updates that aren't full cards.

```
▌ @name · agent ◐ working · 1m  ──────────  ★ 2 ready
```

Or simpler:

```
@name ★ result · summary text...
```

Use sparingly. If the data needs more than one line, you want a widget instead.

## Title bar composition

The title bar in both chrome variants has this structure (left to right):

```
╭─ <PRIMARY> · <SECONDARY> · <TERTIARY> ──── <RIGHT> ─╮
```

- **PRIMARY**: the most important identifier. Bold, identity-colored. (filename, agent name, goal title, model id)
- **SECONDARY**: classifier. Semantic color. (mode badge, tool name, role)
- **TERTIARY**: detail. Dim. (line range, state label, count)
- **RIGHT**: contextual extra. Dim. (parent path, age, runtime) — first to drop on narrow widths

Separator between PRIMARY/SECONDARY/TERTIARY is dim ` · ` (space, middle-dot, space).

When the title bar can't fit everything, drop from RIGHT first, then TERTIARY, then SECONDARY. PRIMARY always survives — shrink it with mid-truncation if needed.

## Visual hierarchy rules

1. **Identity color = ownership.** A `▌` bar on the left tells the eye "this thing belongs to that thing". Reuse the same identity across every card for the same agent/goal/file. Visual continuity is the whole point.

2. **Bold = primary signal.** Use sparingly. Title only. Sometimes verdict ("pass" / "fail"). Not for body content.

3. **Dim = background information.** Slugs, timestamps, paths, separators. Anything the reader scans past unless they need it.

4. **Threshold colors override identity for danger.** A `judge_finish: fail` card overrides the identity hue with red on the bar AND the title. The continuity-vs-threat trade-off favors threat — you want fails to jump.

5. **Half-brightness for administrative items.** `judge_event` cards (lifecycle log entries) render at half-brightness: dim title (NOT bold), dim bar. They're scaffolding, not headlines.

6. **One verdict glyph per card.** Don't stack `✓` + `★` + `→` in a single card title. Pick the one that matches the dominant state.

## Anti-patterns

- **Don't introduce new colors.** If you need a new semantic color, you probably want to reuse an existing one. If you genuinely need a new one, propose it and add it to the global palette, not to a single package.
- **Don't use emoji for state.** ✓ ✗ ⚠ ? are 1-cell Unicode symbols. Emoji are 2-cell and render differently across terminals. The current glyph set is portable; emoji aren't.
- **Don't decorate.** Every glyph should mean something. No empty `★` or `◆` because "it looks nice".
- **Don't full-card content that wants to flow.** Markdown, code, prose — those need bookend chrome, not container chrome. Trying to wrap markdown in `▌ ... │` will look bad and fight the markdown renderer.
- **Don't side-bar the showcase.** The bookend feedback came from the user; respect it.
