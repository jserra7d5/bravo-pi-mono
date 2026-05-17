---
name: tui-design
description: Guide for designing terminal UI elements in the bravo-pi-mono monorepo — general TUI principles plus pi-coding-agent CLI specifics (setFooter, setWidget factory form, renderShell:self, registerToolRenderer, identity palette, semantic glyphs, ANSI-aware width math, bookend vs container chrome). Use whenever creating or modifying ANY visual element here — tool-call cards, widgets, footers, status lines, glyphs, palettes, or any pi extension under .pi/extensions/ or packages/*/extensions/pi/. Trigger on "redesign the TUI", "this rendering is ugly", "add a widget", "tool call looks bad", "card chrome", "fix the footer", or any work touching a Component, setStatus, setWidget, or setFooter call. Also trigger when implementing a new pi extension with visual output even if design help isn't explicitly requested — the gotchas here (green-box wrapper, process.stdout.columns trap, ANSI width math, bookend vs container choice) prevent days of bug-hunting.
---

# Terminal UI design for bravo-pi-mono

You're designing or implementing a terminal UI element for the pi-coding-agent CLI in this monorepo. This skill encodes the design language and the platform-specific traps that have already cost real time to discover. Follow it from the start and you avoid the rework.

## The two-bucket mental model

Every TUI surface in this repo falls into one of two buckets. Pick the right one BEFORE you start drawing.

**Container chrome** — full rounded card with side bars on every row. Used when the content is structured state that benefits from visual containment: lifecycle cards, status widgets, tool-call summaries with key/value rows.

```
╭─ Title · subtitle ──────────────────────── right-tag ─╮
▌  label   value                                        │
▌  label   value                                        │
╰────────────────────────────────────────────────────────╯
```

**Bookend chrome** — top rule + bottom rule only, content flows freely between. Used when the content is itself the payload (a file, a slice of code, a markdown doc) — you don't want chrome impeding the reader.

```
╭─ filename · MODE · lines 1-12 ────────── parent/dir ─╮
  the content                                            <- no side bars
  flows freely
  here
╰────────────────────────────────────────────────────────╯
```

The async-subagents widget and bravo-goals tool cards use container chrome. The showcase tool uses bookend chrome. If you can't articulate which one your surface needs, you haven't thought hard enough about what's inside it.

## Design language quick reference

### Glyphs (carry meaning, not decoration)

| Glyph | Meaning | Where |
|---|---|---|
| ◐ | running / working | active state |
| ? | waiting for input / question | needs-attention state |
| ⚠ | blocked | error/blocked state |
| ✓ | completed / pass | success state |
| ★ | result ready / notable | high-signal terminal |
| ✗ | failed | error state |
| → | handing off / transitioning | mid-lifecycle |
| · | separator | between fields in a title bar |
| ▰ ▱ | filled bar / empty bar | progress, depletion |
| ▌ | identity bar | left edge of contained rows |
| ╭─╮ │ ╰─╯ | rounded chrome | card borders |

### Colors

The repo uses three families of color. Keep them straight:

1. **Semantic threshold colors** (state-driven, same RGB across all packages):
   - `dim` `#787880` — low priority, idle, dead-but-visible
   - `text` `#DCDCDD` — default content
   - `ok` / `green` `#7EC991` — success, healthy
   - `warn` / `amber` `#E5B548` — attention, intermediate, needs review
   - `bad` / `red` `#E86F6F` — error, blocked, urgent

2. **Identity palette** (8 hues, hashed off a stable ID — used for per-agent, per-goal, per-file color):
   ```
   #E5B548 gold        #7EC991 green       #AED7FF sky        #D5A3E9 lavender
   #E89C7E coral       #7ED4C9 teal        #E8C87E butter     #C8A0DC violet
   ```
   These exact RGBs live in `packages/async-subagents/extensions/pi/renderers.ts` as `IDENTITY_PALETTE`. The footer and bravo-goals both mirror them. **Do not invent a new palette — copy these.** Drift is a bug.

3. **Domain accents** (semantic, narrow use):
   - `branch` `#AED7FF` (sky) — git branches
   - `cost` `#C8DCC8` (pale green) — money
   - `sub` `#B4C8DC` (pale blue) — subscription markers

See `references/design-language.md` for ANSI escape constants, the full hash algorithm, and the rationale behind each choice.

## The pi extension API gotchas (read this before writing code)

These four have each cost real debugging time. They are the most common ways to ship a broken TUI on this platform.

### 1. The green-box wrapper

**Symptom:** Your beautiful card chrome renders inside a green/red tinted box that you didn't ask for.

**Cause:** Pi wraps every tool call in a `Box` with `toolPendingBg` (running) / `toolSuccessBg` (success) / `toolErrorBg` (failure) background by default. Your card sits inside this wrapper.

**Fix:** Set `renderShell: "self"` on every tool definition that renders cards. Pi then gives you a plain `Container` instead of the colored `Box`.

```ts
pi.registerTool(defineTool({
  name: "my_tool",
  renderShell: "self",   // <-- this line
  // ...
}));
```

Verify after wiring: read the actual tool definitions file and confirm `renderShell: "self"` is present. If you're adding 7 tools and only 6 get it, the 7th will look wrong.

### 2. The `process.stdout.columns` trap

**Symptom:** Widget chrome wraps onto the next line — top-right `╮` falls onto its own line, bottom-right `╯` does too. Looks fine in your dev terminal at one width; broken everywhere else.

**Cause:** You used `process.stdout.columns` to compute the widget width. Pi does NOT render the widget at full terminal width — it sits inside an editor-adjacent container with margins. Your widget renders at 90 cells when pi only has 87 to display, so each row overflows.

**Fix:** Use the **factory form** of `setWidget`:

```ts
// WRONG — string array uses your computed width
ui.setWidget("my-widget", linesArray, { placement: "belowEditor" });

// RIGHT — factory gets pi's actual render width
ui.setWidget("my-widget", (tui, theme) => ({
  invalidate() {},
  dispose() {},
  render(width) {
    return renderMyCard({ width });   // use the width pi gives
  },
}), { placement: "belowEditor" });
```

Same rule for tool `renderCall` / `renderResult` — return a Component, not a Text/string. Use the `chromeRenderable` pattern in `packages/async-subagents/extensions/pi/renderers.ts` as reference.

### 3. The `setFooter` escape hatch

**Symptom:** You want to redesign pi's built-in footer (the `↑27k ↓929 R57k $0.192 (sub) 4.7%/272k (auto) (openai-codex) gpt-5.5 • medium` line).

**Cause:** That line is pi core's `footer.js` in `node_modules`. You can't modify it in place — modifications won't survive `npm install`.

**Fix:** Use `pi.ui.setFooter(factory)`. The factory receives `(tui, theme, footerData)` and returns a Component. You CANNOT touch `ctx` from the factory directly — capture `ctx` in your event handler closure (`session_start`, `model_select`, `turn_end`, `agent_end`) and let the factory close over it. Read it live on every render.

See `.pi/extensions/codex-usage.ts` for a working example.

### 4. Status line vs widget — pick one

**Symptom:** Your data shows up in TWO places — once in a widget at the top, once in the footer status. Looks noisy. User reasonably asks why.

**Cause:** Both `pi.ui.setStatus(key, text)` and `pi.ui.setWidget(key, content)` are valid surfaces. They have different shapes:
- **status:** single-line, appended to pi's footer with other status segments
- **widget:** multi-line, above/below the editor, supports rich Components

If your widget already surfaces the same info, the status line is redundant. Delete it. Don't double-display.

Detailed coverage in `references/pi-extension-api.md`.

## ANSI and width math

Cards must be ANSI-aware. Every helper that measures, truncates, or pads content must strip ANSI escape codes before counting cells.

```ts
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visWidth = (s) => stripAnsi(s).length;
```

But there's more. Emoji and CJK characters are 2 cells. ZWJ (U+200D) and variation selectors (U+FE00–U+FE0F) are 0 cells. If your card has any emoji content (state glyphs in some terminals, user-supplied content), you need the full visWidth function from `references/ansi-and-widths.md`. Otherwise chrome will misalign for half your users.

Truncation must preserve ANSI escapes. Naive `slice(0, max)` will cut an escape sequence in half and color the rest of your terminal red. Use `truncAnsi(str, maxCells)` from the reference.

Mid-truncation for paths (`/long/path/to/file.ts` → `/long/path/…o/file.ts`): keep head and tail, `…` in the middle. End-truncation for everything else: `… ` at the end.

## Responsive layouts

Define explicit width cutoffs. At each cutoff, drop low-priority pieces. Examples from the existing packages:

| Surface | Cutoffs | What drops |
|---|---|---|
| async-subagents widget | 70, 54 | role at <70; age at <54 |
| footer | 120, 80, 60, 40 | codex bars shrink at each cutoff; greedy-drop right-to-left |
| bravo-goals tool cards | 96, 72, 56, 44 | run path + receipt callout at <72; title shrinks per `titleMaxFor` |

Test at the cutoff BOUNDARIES (79/80, 119/120) — those are where off-by-one bugs live.

Greedy drop from low-priority to high-priority. Last resort: hard-truncate with `…`. NEVER let chrome wrap.

## The mockup-first workflow

This is the working pattern that produced every successful redesign in this repo. Skip it and you do double the work.

1. **Mockup file in /tmp first.** `/tmp/<surface>-mockup.mjs` — executable Node, ANSI escapes inline, runs with `node /tmp/<surface>-mockup.mjs`. Show 4-6 sections: identity demo, primary states, edge cases, BEFORE/AFTER, responsive sweep at width boundaries.

2. **Render in tmux for the user.** A `tui-showcase` tmux session is the standard fixture. `tmux send-keys -t tui-showcase 'clear && node /tmp/<surface>-mockup.mjs' Enter`. Check your actual tmux pane width first (`tmux display-message -t tui-showcase -p '#{pane_width}'`) and pick a mockup width safely under that — overflow wraps look bad and undermine the design review.

3. **Stress file too.** `/tmp/<surface>-stress.mjs` — edge cases: long content, narrow widths (down to 32), missing fields, partial data, punctuation in user-supplied strings, identity color collisions.

4. **Then code.** Don't write the actual implementation until the user has signed off on the mockup. The mockup is cheap to revise; the implementation isn't.

Full workflow including agent coordination patterns in `references/workflow.md`.

## When to delegate to an agent

For non-trivial designs (more than one tool, more than one chrome variant), use this proven loop:

1. **Designer agent** — produces the mockup file + stress file. Renders to tmux. Reports design decisions and open questions.
2. **You review** — eyeball the mockup, confirm decisions, push back on anything weird.
3. **Implementer agent** — translates mockup to code. Mockup is the spec; deviations require justification.
4. **Reviewer agent** — separate Opus, checks mockup faithfulness, code quality, test coverage. Has authority to fix.

Agents must work on disjoint files. If two agents touch the same file in parallel, you lose work. The reference describes how to scope briefs to prevent conflicts.

## Where to go next

| If you're... | Read |
|---|---|
| Choosing chrome style, colors, glyphs | `references/design-language.md` |
| Writing the pi extension code | `references/pi-extension-api.md` |
| Doing the width/truncation math | `references/ansi-and-widths.md` |
| Coordinating mockup → impl → review | `references/workflow.md` |
| Need the exact RGB triplets | `assets/palette-and-glyphs.md` |
| Need a checklist before shipping | bottom of `references/pi-extension-api.md` |

## House rules (universal)

- Match the existing palette. Three packages already share the identity palette — adding a fourth means using the same 8 RGBs, not new ones.
- No `// removed:` comments or compat shims. Delete dead code.
- Comments only where WHY is non-obvious. Don't narrate WHAT — names do that.
- Tests for: identity stability + distribution, threshold boundaries, layout cutoffs, chrome holding declared width.
- ANSI handling: never measure raw strings; always go through `visWidth`.
- Don't `process.stdout.columns`. Use the width pi passes.
