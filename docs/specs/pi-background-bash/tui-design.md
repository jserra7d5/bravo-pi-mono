# Pi Background Bash — TUI Visual Design

Status: design (pure visual spec — no implementation)
Date: 2026-05-31
Related: `design.md`, `implementation-plan.md`, `.agents/skills/tui-design/SKILL.md`
Inspiration: `packages/async-subagents/extensions/pi/renderers.ts`, `packages/bravo-goals/extensions/pi/renderers.ts`

This document specifies how every Background Bash surface should look in the Pi
TUI. It is the spec an implementer translates into `renderCall`/`renderResult`
components and a footer widget in Phase 4 of the implementation plan. It does
**not** prescribe TypeScript beyond the chrome/width contract the two existing
extensions already share.

Mockups are illustrative, ANSI-stripped render targets; the live cards are colored
per the mapping table in §2. Renderer tests/goldens must generate exact-width rows
at the supported breakpoints. During design review, a disposable local `/tmp` script
may be useful to verify widths, but it is not a committed artifact and is not a
durable reference for implementation.

---

## 1. Visual design principles

1. **Reuse the shared card grammar, do not invent one.** Background Bash is the
   third consumer of the `chrome()` container/bookend system that async-subagents
   and bravo-goals already share. Same corners (`╭╮╰╯`), same `▌` identity bar,
   same `│` side bars, same 8-hue `IDENTITY_PALETTE`, same `topTitled(title, badge)`
   title bar. A task card and a subagent card should read as siblings.

2. **A background task is an identity.** Each task gets a stable hue hashed off
   its `taskId` (the same `identitySlot`/`identityColor` algorithm). The `▌` bar,
   the short id in the title, and the id in the `/tasks` list all render in that
   hue, so the same task reads as the same color in its start card, its completion
   card, the list, and the detail view. Continuity across surfaces is the point.

3. **Call before id = plain chrome; result with id = identity bar.** This mirrors
   async-subagents exactly: the `bash({run_in_background:true})` *call* has no task
   id yet, so it renders with plain `renderToolCallCard` chrome (bold `bash` title,
   sky `→ starting` badge, `│` rows). The *result* — once a `taskId` exists —
   switches to the identity-bar card. Never fabricate an identity hue before the
   task is born.

4. **Threshold colors override identity for danger.** `failed` overrides the bar
   and the id to red; `timed_out` / visual output-cap / `orphaned` / `blocked` override
   to amber; `killed` and `unknown` go dim. A healthy task keeps its identity hue.
   This is the same continuity-vs-threat trade-off bravo-goals uses for verdicts —
   you want a failure to jump out of a list of green checks.

5. **High-signal by default, raw detail on demand.** The default card answers
   "what is this task, is it healthy, where is its output, what do I do next" in
   ≤6 rows. Full command, full path, pid/pgid, env, and raw metadata appear **only**
   in `/tasks show`, `/tasks tail`, or a normal `read` of the output path. No JSON,
   ever. (§5 is the disclosure contract.)

6. **One verdict glyph per card.** The title-bar badge carries the single state
   glyph. Body rows never repeat it. Don't stack `◐` + `★` + `→`.

7. **Quiet chrome, loud state.** Borders use the shared dim/chrome color (`#787880`), labels are
   dim, separators are dim `·`. Color is spent on the state glyph, the badge, and
   danger overrides — the things the eye should land on.

---

## 2. State / glyph / color mapping

Background task statuses come from `design.md` (`starting`, `running`, `exited`,
`failed`, `timed_out`, `killed`, `orphaned`, `unknown`) plus `blocked` (interactive
prompt watchdog). `output_cap` below is a visual terminal reason derived from a
result such as `stopReason: "output_cap"`; do not persist it as a `TaskStatus`
unless the task-types enum is explicitly updated.

The prompt's required glyph set is honored as the primary vocabulary. Two states
the prompt left unspecified borrow from the shared `stateGlyph` table:
`⊘` for `killed`/`stopped` (matches async-subagents `cancelled`/`expired`) and
`·` for `unknown`.

| Status        | Glyph | Badge label   | Glyph/badge color | Bar color        | Meaning |
|---------------|:-----:|---------------|-------------------|------------------|---------|
| `starting`    | `→`   | `starting`    | sky               | identity         | call accepted, task being born |
| `running`     | `◐`   | `running`     | sky               | identity         | process alive |
| `exited` (0)  | `✓`   | `done`        | green             | identity         | clean exit |
| `failed` (≠0) | `✗`   | `failed`      | red               | **red override** | nonzero exit / spawn error |
| `timed_out`   | `⚠`   | `timed out`   | amber             | **amber override** | max runtime reached, killed |
| `killed`      | `⊘`   | `stopped`     | gray              | **dim identity** | user/shutdown SIGTERM→SIGKILL |
| `blocked`     | `?`   | `blocked`     | amber             | **amber override** | interactive-prompt watchdog |
| `output_cap`  | `⚠`   | `output cap`  | amber             | **amber override** | hard output limit hit, stopped |
| `orphaned`    | `⚠`   | `orphaned`    | amber             | **amber override** | reattach failed, controls disabled |
| `unknown`     | `·`   | `unknown`     | gray              | **dim identity** | reconciliation incomplete |

Glyph for `→` (start/transition) and `·` (separator) match the prompt. Warning
badge `⚠` is shared by every amber attention state so the eye learns one shape.

### Colors — shared TUI skill palette

Color choices must align with `.agents/skills/tui-design/SKILL.md`. If existing
renderer constants differ, reconcile that drift before implementation; do not copy
divergent local values into this extension.

```ts
const ANSI = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[38;2;120;120;128m",   // #787880 low priority / chrome
  text:   "\x1b[38;2;220;220;221m",   // #DCDCDD default content
  green:  "\x1b[38;2;126;201;145m",   // #7EC991 exited / done
  amber:  "\x1b[38;2;229;181;72m",    // #E5B548 blocked / timed_out / output_cap / orphaned
  red:    "\x1b[38;2;232;111;111m",   // #E86F6F failed
  sky:    "\x1b[38;2;174;215;255m",   // #AED7FF running / starting accent
};

// Shared 8-hue identity palette — hashed off taskId.
const IDENTITY_PALETTE = [
  "\x1b[38;2;229;181;72m",   // #E5B548 gold
  "\x1b[38;2;126;201;145m",  // #7EC991 green
  "\x1b[38;2;174;215;255m",  // #AED7FF sky
  "\x1b[38;2;213;163;233m",  // #D5A3E9 lavender
  "\x1b[38;2;232;156;126m",  // #E89C7E coral
  "\x1b[38;2;126;212;201m",  // #7ED4C9 teal
  "\x1b[38;2;232;200;126m",  // #E8C87E butter
  "\x1b[38;2;200;160;220m",  // #C8A0DC violet
];
function identitySlot(id){ let h=0; for(let i=0;i<id.length;i++) h=((h*31)+id.charCodeAt(i))>>>0; return h%8; }
```

Hash background tasks on `taskId` (stable; the short `bg…abcdef` form is display
only — hash the full id).

---

## 3. Chrome decision per surface

| Surface | Chrome | `renderShell` | Why |
|---|---|---|---|
| Foreground `bash` call/result | **Pi built-in or faithfully recreated** | Phase-0 dependent | preserve existing look; override must not regress |
| Background start — call | container (plain, no bar) | `"self"` | structured key/value, pre-id |
| Background start — result | container (identity bar) | `"self"` | structured state card |
| Task state cards (all 8 terminal/live) | container (identity bar) | `"self"` | structured state card |
| `background_task_list` result | container (list) | `"self"` | table of rows |
| `background_task_status` result | container (identity bar) | `"self"` | one-task detail |
| `background_task_stop` result | container (identity bar) | `"self"` | terminal state card |
| `/tasks` list | container (list) | n/a (command) | table |
| `/tasks show` | container (identity bar, full) | n/a | detail |
| `/tasks tail`, `background_task_output` if implemented | **bookend** | n/a / `"self"` | content *is* the payload |
| Footer widget | single-line `setWidget` factory | n/a (`setWidget`) | operator awareness strip with width cutoffs |

`renderShell` is tool-definition scoped unless Phase 0 proves Pi supports
per-call or per-result shell selection. Every custom **tool** card requires
`renderShell: "self"` or it renders inside Pi's green/red
`toolPendingBg`/`toolSuccessBg` box (see §6 and the skill's gotcha #1). If
per-call/per-result shell selection is unavailable, choose one branch: either set
`renderShell: "self"` for the entire overridden `bash` tool and recreate the
foreground built-in chrome/parity in the extension renderer, or keep the default
shell for `bash` and use custom self-shell cards only for auxiliary background
task tools. Slash-command views are not tool calls.

---

## 4. Mockups (width 80)

### 4.1 Foreground `bash` — preserved

Foreground calls must keep Pi's existing rendering. Phase 0 must determine whether
that can be done by leaving foreground calls in the default shell while background
results use self-shell cards, or by recreating the built-in foreground chrome under
a tool-wide `renderShell: "self"`. Shown only for contrast:

```
  $ npm test
  > 42 passing (1.2s)
  (unchanged — override must not regress this)
```

The single visual requirement: when the extension registers `bash`, a
`{command, timeout?}` call with no `run_in_background` must render byte-for-byte
like the built-in. If foreground parity drifts, that is a visual regression (and a
Phase 2 gate failure), not a design choice.

### 4.2 Background start — call (pre-id, plain chrome)

```
╭─ bash · background ───────────────────────────────────────────── → starting ─╮
│ command   npm run dev                                                        │
│ runtime   max 5m                                                             │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Bold `bash` title, dim `· background` classifier, sky `→ starting` badge, plain
`│` rows (no identity bar — no task id yet). `runtime` row only appears when a
background `timeout` was set, and reads `max <dur>` to signal it is a runtime cap,
not a foreground wait.

### 4.3 Background start — result (running)

```
╭─ ▌ bg…abcdef · bash ───────────────────────────────────────────── ◐ running ─╮
▌ command   npm run dev                                                        │
▌ runtime   0s · max 5m                                                        │
▌ output    .pi/…/output.log                                                   │
▌                                                                              │
▌ read the output path or /tasks for status                                    │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Now the task exists: identity bar in the task's hue, short id `bg…abcdef`, sky
`◐ running` badge. Five default rows max: `command`, `runtime` (elapsed · max),
`output` (shortened path), a blank spacer, and one dim next-action hint. The hint
is the model-visible "what do I do now" line — it mirrors the text result block
the tool returns.

### 4.4 Background start — failed to start

```
╭─ ▌ bash · background ───────────────────────────────────────────── ✗ failed ─╮
▌ error     spawn npx ENOENT                                                   │
▌ command   npx some-missing-bin                                               │
▌                                                                              │
▌ command did not start; no task was created                                   │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Red bar override, red bold `✗ failed` badge, no task id (it never started). The
`error` row leads (the salient fact), then the command, then a hint making the
no-task-created fact explicit so the model doesn't go looking for a task to stop.

### 4.5 Terminal & live state cards

These are the core compact surfaces: completion notifications use this shape.
`background_task_status` should be explicit/detail-equivalent to `/tasks show`
(§4.7), while notifications stay compact. Bar and
badge color follow §2.

```
  — running —
╭─ ▌ bg…abcdef · bash ───────────────────────────────────── ◐ running · 2m14s ─╮
▌ command   npm run dev                                                        │
▌ runtime   2m14s · max 5m                                                     │
▌ output    .pi/…/output.log · 12 KB                                           │
╰──────────────────────────────────────────────────────────────────────────────╯
  — completed / exited —
╭─ ▌ bg…123456 · bash ────────────────────────────────────────── ✓ done · 38s ─╮
▌ command   npm test                                                           │
▌ exit      0                                                                  │
▌ output    .pi/…/output.log · 4 KB                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
  — failed —
╭─ ▌ bg…993bda · bash ──────────────────────────────────────── ✗ failed · 12s ─╮
▌ command   npm run build                                                      │
▌ exit      1                                                                  │
▌ output    .pi/…/output.log · 9 KB                                            │
▌                                                                              │
▌ read output.log for the failure                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
  — killed / stopped —
╭─ ▌ bg…abcdef · bash ───────────────────────────────────── ⊘ stopped · 5m31s ─╮
▌ command   npm run dev                                                        │
▌ signal    SIGTERM                                                            │
▌ output    .pi/…/output.log · 1.2 MB                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
  — timed out —
╭─ ▌ bg…abcdef · bash ──────────────────────────────────── ⚠ timed out · 5m0s ─╮
▌ command   npm run dev                                                        │
▌ runtime   5m0s · max 5m (reached)                                            │
▌ signal    SIGKILL                                                            │
▌ output    .pi/…/output.log · 8 KB                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
  — blocked (interactive) —
╭─ ▌ bg…77f3a2 · bash ───────────────────────────────────── ? blocked · 1m02s ─╮
▌ command   gh auth login                                                      │
▌ reason    waiting on interactive prompt                                      │
▌ tail      ? Authenticate with GitHub.com                                     │
▌                                                                              │
▌ /tasks stop bg…77f3a2  ·  or answer in a real terminal                       │
╰──────────────────────────────────────────────────────────────────────────────╯
  — output cap exceeded —
╭─ ▌ bg…abcdef · bash ────────────────────────────────── ⚠ output cap · 1m44s ─╮
▌ command   npm run dev                                                        │
▌ output    .pi/…/output.log · 10 MB (cap)                                     │
▌ stopped   output limit reached                                               │
╰──────────────────────────────────────────────────────────────────────────────╯
  — orphaned / unknown —
╭─ ▌ bg…abcdef · bash ──────────────────────────────────────────── ⚠ orphaned ─╮
▌ command   npm run dev                                                        │
▌ pid       49217 (ownership unverified)                                       │
▌ output    .pi/…/output.log                                                   │
▌                                                                              │
▌ controls disabled · verify before stopping                                   │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Per-state notes:

- **running** — no exit row; runtime shows `elapsed · max`. This is the only state
  that updates over time; updates are throttled (§6).
- **exited** — green `✓ done`, `exit 0` row in green.
- **failed** — red bar + red id + red badge; `exit N` in red; a hint pointing at
  the log. Spawn failures (no exit code) reuse this card with `error` instead of
  `exit` (§4.4 is the pre-id variant).
- **killed / stopped** — dim identity bar (user-initiated, not an error). `signal`
  row records what was sent. `⊘` matches the shared cancelled glyph.
- **timed_out** — amber; runtime row appends `(reached)`; `signal SIGKILL`.
- **blocked** — amber `?`; `reason` + a single bounded `tail` line showing the
  detected prompt; hint offers stop or "answer in a real terminal". The card never
  invites the model to type into the process (security posture, `design.md`).
- **output_cap** — amber `⚠`; output row marks `(cap)`; `stopped` row states why.
  This is a visual terminal reason from `stopReason: "output_cap"`, not a
  persisted `TaskStatus` unless the enum is updated.
- **orphaned / unknown** — orphaned uses amber `⚠`; unknown uses gray `·` with a
  dim identity bar. The `pid` row flags ownership unverified when present; hint
  states controls are disabled. This is the post-reload/restart safety card.

A `starting` state after a task id exists uses the same identity-bar card as
`running`, with the `→ starting` badge and no exit/signal row. `unknown` uses the
same compact card with gray `· unknown`; include only fields known after
reconciliation, plus the disabled-controls hint when ownership is not verified.

### 4.6 `/tasks` — compact list

Also the shape of the `background_task_list` result card.

```
╭─ tasks ───────────────────────── 2 running · 1 blocked · 1 failed · 5 total ─╮
│ ? bg…77f3a9  gh auth login                                    1m02s  blocked │
│ ✗ bg…993bda  npm run build                                     0m12s  exit 1 │
│ ◐ bg…abcdef  npm run dev                                      2m14s  running │
│ ◐ bg…77f3a2  vite build --watch                               0m48s  running │
│ ✓ bg…99c0de  npm test                                          0m38s  exit 0 │
╰──────────────────────────────────────────────────────────────────────────────╯
```

One container card (not per-row identity bars — the card has plain `│` borders).
Each row: state glyph (state color) · short id (identity color) · command (white,
end-truncated) · right-aligned `runtime` (dim) + status (state color). The title
badge summarizes counts (`N running · N blocked · N failed`) with a dim `N total`,
greedy-dropped right-to-left at narrow widths. Built with the `rowRight()` helper
so runtime/status stay flush right. Ordering: attention states first (blocked,
failed), then running, then terminal — mirror async-subagents `taskPriority`.

`/tasks all` uses the same card with retained completed tasks included; `/tasks`
(default) shows active + recently-terminal only.

### 4.7 `/tasks show <id>` — detail

The **only** card that exposes pid/pgid, the full output path, started timestamp,
and owner session. This is where progressive disclosure "opens up".

```
╭─ ▌ bg…abcdef · bash ───────────────────────────────────── ◐ running · 2m14s ─╮
▌ command   npm run dev                                                        │
▌ status    running                                                            │
▌ runtime   2m14s · max 5m                                                     │
▌ output    .pi/background-bash/bg_20260531_abcdef/output.log                  │
▌ size      12 KB                                                              │
▌ pid       49217 · pgid 49217                                                 │
▌ started   2026-05-31 12:00:00                                                │
▌ owner     session 7f3a…                                                      │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Full output path is mid-truncated (`truncPath`, head+tail) only when it overflows
the value column — at width 80 it fits whole; see §7 narrow variants where it
collapses to `.pi/background-…def/output.log`.

### 4.8 `/tasks tail <id> [lines]` — bookend chrome

The tail (and `background_task_output`, if implemented) is the one payload
surface: the log content *is* the thing, so it uses bookend chrome (top rule +
bottom rule, no side bars impeding the text).

```
╭─ bg…abcdef · output.log · last 5 lines ────────────────────────────── 12 KB ─╮
    VITE v5.2.0  ready in 412 ms

    ➜  Local:   http://localhost:5173/
    ➜  Network: use --host to expose
    12:02:14 [vite] hmr update /src/App.tsx
╰──────────────────────────────────────────────────────────────────────────────╯
```

Title bar: identity-colored short id · `output.log` · `last N lines`, with the
file size right-aligned. Body lines flow with a 2-space indent, dim, end-truncated
to width (raw log content is never measured for padding — it is the payload, not a
key/value row). The tail is **bounded** (default last N lines, never the whole
file); for the full log the card's guidance is "use `read` on the output path".

### 4.9 Footer / widget indicator

```
  normal     BG  2 running
  attention  BG  2 running · 1 failed
  blocked    BG  1 blocked
  mixed      BG  3 running · 1 blocked · 2 failed
  narrow     BG 2◐ 1? 1✗
  tiny       BG 1✗
```

Dim `BG` tag, then count segments: running in sky, blocked in amber, failed in
red — same threshold colors as the cards. Operator-awareness only; it never forces
a model turn. Greedy-drop and glyph-compaction at narrow widths (§7). Surface it with `setWidget` factory form, not `setStatus`, so the footer renderer
can receive Pi's actual width and apply the cutoffs below. Do not also call
`setStatus` for the same counts (skill gotcha #4); this awareness strip must not
be double-surfaced.

---

## 5. Progressive disclosure

### Default cards show only

- short task id (`bg…` + last 6 of the id);
- status glyph + label (the badge);
- elapsed runtime, and `· max <dur>` when a runtime cap is set;
- one-line, end-truncated command summary;
- shortened output path (`.pi/…/output.log`), with size when known;
- `exit <code>` or `signal <name>` once terminal;
- a warning badge (`⚠`/`?`/`✗`) for blocked / timed-out / output-cap / orphaned / failed;
- exactly one concise next-action hint (only when there is an action to take).

### Hidden by default — detail/expanded/`read` only

- full command (default card end-truncates it);
- full output path (default card shows `.pi/…/output.log`);
- pid / pgid;
- env policy / cwd;
- raw metadata JSON (never rendered as JSON anywhere);
- full stdout/stderr (use `read` on the path);
- large log tails (the bounded tail shows last N lines only).

### Where detail lives

| Want | Use |
|---|---|
| pid/pgid, full path, started, owner | `/tasks show <id>` (§4.7) or `background_task_status` (same detail level) |
| last N log lines, bounded | `/tasks tail <id> [lines]` (§4.8) |
| full log | `read` on the output path |
| all retained tasks | `/tasks all` |

Tool **result text** (model-visible) stays equally lean: the start result returns
the task id, status, output path, and the one-line monitoring hint — never the
full metadata record. The richer card is UI-only.

---

## 6. Renderer guidance for implementers

### Chrome source

Do not re-derive the chrome math. Lift `chrome()`, `visWidth()`, `truncAnsi()`,
`truncPath()`, `idBar()`, `identityColor()`, and the `ANSI`/`IDENTITY_PALETTE`
constants from `packages/async-subagents/extensions/pi/renderers.ts` (it has the
`rowRight()` helper the list needs). Centralize these helpers if possible; otherwise copy them verbatim from the shared
renderer so Background Bash does not create a divergent chrome/palette fork.

### Container vs bookend

- **Container** (`topTitled` + `row`/`rowBar`/`rowRight` + `bot`): every state
  card, the start call/result, the list, the detail, the status/stop results.
- **Bookend** (`topTitled` + raw indented content + `bot`): `/tasks tail` and
  `background_task_output` if implemented.

### `renderShell: "self"` feasibility gate

Phase 0 must verify whether Pi can choose `renderShell` per call/result or only per
tool definition. Custom card-rendering tools (`background_task_list`,
`background_task_status`, `background_task_stop`, and `background_task_output` if
implemented) should set `renderShell: "self"`. For the overridden `bash` tool, if
per-call/per-result shell selection is impossible, either make all `bash` rendering
self-shell and recreate foreground parity, or keep `bash` on the default shell and
limit custom self-shell cards to auxiliary task tools.

### Width comes from Pi, never from `process.stdout.columns`

Return a Component (factory form) from `renderCall`/`renderResult` and from
`setWidget`; build cards inside `render(width)` using the width Pi passes. Use the
`chromeRenderable(build)` wrapper pattern from the existing renderers. Use
`setWidget` factory form for the footer cutoffs; do not use `setStatus` for this
width-responsive footer. Reading `process.stdout.columns`
produces the wrap-onto-next-line bug from skill gotcha #2.

### Truncation rules

| Content | Rule | Helper |
|---|---|---|
| command summary | end-truncate (`…` at end); head is salient | `truncAnsi` |
| task id | never truncated — already `bg…` + 6 chars | — |
| output path (default card) | pre-shortened to `.pi/…/output.log` | static |
| output path (detail) | mid-truncate (head+tail) only on overflow | `truncPath` |
| tail/log lines | end-truncate to width; never measured for padding | `truncAnsi` |
| list status / runtime | fixed right column via `rowRight` | `rowRight` |

Inner content width is `width - 4` (`▌`/`│` + space each side). Any row content
must be truncated to that *before* padding; if it overruns, that's a missing test
case, not a render-time clamp.

### Update throttling

- **Never repaint per output chunk.** A chatty dev server writing hundreds of
  lines/sec must not trigger hundreds of card repaints.
- **Terminal transitions render immediately** (running→exited/failed/killed/etc.)
  — the user wants those now.
- **Running-state churn (runtime ticking, log size growing) is coalesced** to a low
  fixed cadence (≈1–2s). Drive it off a throttled timer, not the output stream.
- The footer indicator updates on task lifecycle transitions and the same throttled
  tick, not on output.

### ANSI / width safety

- Measure only through `visWidth` (it strips ANSI and counts CJK/emoji correctly).
- `truncAnsi` always closes with `\x1b[0m` so a cut mid-color can't bleed into the
  next row.
- If any user-supplied content (commands, log tails) can contain emoji, keep the
  full `visWidth` (the ported one handles `⚠️` vs `⚠`, ZWJ, variation selectors).
  Add regression tests with `✅`/`✓`/`⚠`/`⚠️` per the skill's crash-class note —
  an off-by-one on a default-wide emoji crashes Pi with "Rendered line exceeds
  terminal width".

### Tests to ship with the renderers

- chrome holds exact declared width at 44/56/72/96/120 for every card builder
  (the `--check` mode of the mockup is the template);
- identity hue is stable per `taskId` and distributes across the 8 slots;
- danger overrides (failed→red, timed_out/blocked/output-cap reason/orphaned→amber,
  killed/unknown→dim) apply to bar + badge + id;
- truncation boundaries: command end-truncation, output-path mid-truncation,
  list right-column flush;
- footer greedy-drop at the 34/12 cutoffs via the `setWidget` factory width.

---

## 7. Narrow-width variants

The card builders are width-driven; these are illustrative narrow render targets.
Renderer tests/goldens must verify exact row widths at each breakpoint.

### Width 60

```
╭─ ▌ bg…abcdef · bash ───────────────── ◐ running · 2m14s ─╮
▌ command   npm run dev                                    │
▌ runtime   2m14s · max 5m                                 │
▌ output    .pi/…/output.log · 12 KB                       │
╰──────────────────────────────────────────────────────────╯

╭─ ▌ bg…77f3a2 · bash ───────────────── ? blocked · 1m02s ─╮
▌ command   gh auth login                                  │
▌ reason    waiting on interactive prompt                  │
▌ tail      ? Authenticate with GitHub.com                 │
▌                                                          │
▌ /tasks stop bg…77f3a2  ·  or answer in a real terminal   │
╰──────────────────────────────────────────────────────────╯

╭─ tasks ───── 2 running · 1 blocked · 1 failed · 5 total ─╮
│ ? bg…77f3a9  gh auth login                1m02s  blocked │
│ ✗ bg…993bda  npm run build                 0m12s  exit 1 │
│ ◐ bg…abcdef  npm run dev                  2m14s  running │
│ ◐ bg…77f3a2  vite build --watch           0m48s  running │
│ ✓ bg…99c0de  npm test                      0m38s  exit 0 │
╰──────────────────────────────────────────────────────────╯
```

### Width 44

Badge drops from the title when it can't fit (the `topTitled` slack math falls
back to a plain corner; state remains in the body/detail rows where needed). The
list compresses commands and runtimes; detail mid-truncates the full path.

```
╭─ ▌ bg…abcdef · bash ─────────────────────╮
▌ command   npm run dev                    │
▌ status    running                        │
▌ runtime   0s · max 5m                    │
▌ output    .pi/…/output.log               │
▌                                          │
▌ read the output path or /tasks for stat… │
╰──────────────────────────────────────────╯

╭─ ▌ bg…abcdef · bash ─────────────────────╮
▌ command   npm run dev                    │
▌ runtime   2m14s · max 5m                 │
▌ output    .pi/…/output.log · 12 KB       │
╰──────────────────────────────────────────╯

╭─ ▌ bg…993bda · bash ──── ✗ failed · 12s ─╮
▌ command   npm run build                  │
▌ exit      1                              │
▌ output    .pi/…/output.log · 9 KB        │
▌                                          │
▌ read output.log for the failure          │
╰──────────────────────────────────────────╯

╭─ ▌ bg…abcdef · bash ──────── ⚠ orphaned ─╮
▌ command   npm run dev                    │
▌ pid       49217 (ownership unverified)   │
▌ output    .pi/…/output.log               │
▌                                          │
▌ controls disabled · verify before stopp… │
╰──────────────────────────────────────────╯

╭─ tasks ──────────────────────────────────╮
│ ? bg…77f3a9  gh auth log… 1m02s  blocked │
│ ✗ bg…993bda  npm run build 0m12s  exit 1 │
│ ◐ bg…abcdef  npm run dev  2m14s  running │
│ ◐ bg…77f3a2  vite build … 0m48s  running │
│ ✓ bg…99c0de  npm test      0m38s  exit 0 │
╰──────────────────────────────────────────╯

╭─ ▌ bg…abcdef · bash ─────────────────────╮
▌ command   npm run dev                    │
▌ status    running                        │
▌ runtime   2m14s · max 5m                 │
▌ output    .pi/background-…def/output.log │
▌ size      12 KB                          │
▌ pid       49217 · pgid 49217             │
▌ started   2026-05-31 12:00:00            │
▌ owner     session 7f3a…                  │
╰──────────────────────────────────────────╯
```

### Footer cutoffs

| Available cells | Form | Example |
|---|---|---|
| ≥ 34 | full labels | `BG  3 running · 1 blocked · 2 failed` |
| 12–33 | glyph-compacted | `BG 2◐ 1? 1✗` |
| < 12 | most-urgent single token | `BG 1✗` (failed > blocked > running) |

The tiny form always keeps the single most-urgent token so a failure is never
silently dropped at the narrowest widths.

---

## 8. Anti-patterns

- **No raw JSON, anywhere.** Not in cards, not in result text, not in the footer.
  Metadata renders as labeled rows or not at all.
- **No full argument dumps.** The card shows a truncated `command`; it never prints
  the whole `BashInput` object or every tool arg.
- **No full output dumps inline.** Output goes to the file; cards show a bounded
  tail or a path. The conversation never receives streamed stdout chunks.
- **No per-chunk repainting.** Coalesce running-state updates; only terminal
  transitions render immediately.
- **No identity hue before a task id exists.** The start *call* card is plain
  chrome; identity begins at the *result*.
- **No new palette.** Copy or centralize the shared `ANSI` + `IDENTITY_PALETTE`;
  reconcile live renderer constants with the TUI skill before copying.
- **No `process.stdout.columns`.** Width comes from Pi's `render(width)`.
- **No double-surfacing.** The footer indicator and any task widget must not show
  the same counts twice — pick one surface.
- **No stacked verdict glyphs.** One state glyph per card, in the badge.
- **No "answer the prompt for me" affordance on `blocked`.** The card offers stop
  or "answer in a real terminal"; it never types into the process or clones a
  permission prompt.
- **No destructive controls on `orphaned`/`unknown`.** Those cards state controls
  are disabled until ownership is verified.

---

## 9. Optional local mockup aid

Implementers may create a disposable local `/tmp` script to sanity-check width math
while translating this spec. Such a script is not committed, not implementation,
and not a durable reference artifact. The source of truth is this document plus the
shared chrome helpers/constants called out in §6.
