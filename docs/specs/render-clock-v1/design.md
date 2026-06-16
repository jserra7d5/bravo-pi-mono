# Render Clock v1 — centralized Pi-extension TUI render loop

Status: implemented. Package: `@bravo/render-clock`.

## Context

The Pi CLI exhibited a terminal "glitch refresh" roughly every ~2000 ms in long /
resumed sessions (never in a fresh short session), and — separately — the
async-subagents "subagent runtime" widget did not tick its live elapsed-age
field. Root cause (audited across all installed extensions + Pi core):

- **The metronome.** `packages/async-subagents/extensions/pi/index.ts` ran
  `setInterval(tickPi, 2000)`; every tick called `setTasksStatusBadge`, which
  called `ui.setStatus(...)` twice with **no value diff**. Pi core's
  `setExtensionStatus` then calls `ui.requestRender()` unconditionally, so a
  render was forced every 2 s whether idle or busy. On a scrolled transcript the
  per-tick repaint travels far enough (and a bottom line such as the footer's
  live countdown differs) to repaint visibly. Resume rebuilds the tall transcript
  and rehydrates "zombie" rows (children that died without a terminal status,
  which had no age cutoff), keeping the widget mounted and the metronome firing.
- **The frozen panel** was the flip side: the live widget only `requestRender`s
  when a semantic signature changes, and that signature excluded elapsed age, so
  age never advanced on screen.
- Each extension also ran its **own** `setInterval` (async-subagents 2 s + 5 s;
  bravo-goals 1.5 s; footer 5 min poll + countdown).

Intended outcome: **one shared, change-aware render clock** so (a) idle sessions
issue zero repaints, (b) live fields tick via cheap ≤1-line diffs, and (c) there
is a single timer instead of N.

## Architecture

`@bravo/render-clock` is a dependency-free library exporting a single shared
clock that owns **one** `setInterval` for the whole Pi process, with a general
per-subscriber-interval scheduler and deterministic test injection. The clock
**never** calls `requestRender` itself — each *visual* subscriber calls
`tui.requestRender()` only when its own change detection says visible output
changed. (Pi already coalesces non-force `requestRender`; the bug was *no-op
render requests*, not "many timers." Gating is the cure; the clock delivers the
product goals: live age + one cadence.)

See `packages/render-clock/README.md` for the API and the full lifecycle
semantics (one lazy timer, per-subscriber interval clamped to base with no
catch-up, duplicate-id-replaces, idempotent unsubscribe, snapshot ticks,
per-subscriber failure isolation, async `inFlight` overlap guard, `globalThis`
singleton + `__resetRenderClockForTest` hook).

Key constraint honored throughout: Pi's differ repaints whole **changed lines**,
and a full clear (`\x1b[2J…`) is reachable from width/height change,
`clearOnShrink`, deleted-line paths, `firstChanged < prevViewportTop`, or any
forced render. So volatile fields use **fixed-width** formatting and reserve
their width before truncation, keeping an age/countdown tick to exactly one
width-stable changed line.

## Runtime invariants & verification seams

| Behavior (boundary) | Invariant | Faithful seam | Injected fault |
|---|---|---|---|
| TUI `requestRender` | A subscriber calls `requestRender()` iff its rendered visible output changed (bucket crossing renders; same-bucket does not; a layout that drops the field does not) | counting fake `tui` driving the real `updateLiveWidget`, compared on width/layout-aware rendered lines | same-bucket tick; bucket cross at age-showing vs age-dropped layout |
| `ui.setStatus` value-diff | Per `(ui,key)`, `setStatus` is called at most once per distinct value (incl. `undefined`); cache isolated per `ui` | fake `ui.setStatus` counter driving the real badge helper; two distinct `ui` objects | repeated identical value; on→off→on; same value on two `ui` |
| Live elapsed age | Age advances while row count + line width stay constant across bucket boundaries | real widget render with fake `now`; assert `visWidth` + line count + summary boundary | `9s→10s`, `59s→1m`, `99m→1h`; widths 54/55/70 |
| Zombie PID reconcile | A dead, process-owned, non-terminal row is finalized (cancel-request→`cancelled`, else `failed`) and ages out; unknown/EPERM/missing-pid/non-owned kept | injectable `pidProber` below `process.kill(pid,0)`; real RunStore read/write | `ESRCH`/`EPERM`/missing pid; bad cancel timestamp; real-FS status-write failure |
| Single-timer singleton | Exactly one base interval for N subscribers; starts on first; duplicate id replaces; a throwing subscriber doesn't starve others | fake scheduler counting `setInterval`/`clearInterval`; separate singleton-identity test | duplicate id; throwing/rejecting reconcile; module duplication |
| Stop at zero subs | After the last unsubscribe, no interval remains and no later reconcile runs; snapshot ticks; duplicate unsubscribe is a no-op | fake scheduler + call-recording subscribers | unsubscribe during a tick; duplicate unsubscribe |
| Footer countdown | Identical reset bucket ⇒ 0 renders; a bucket crossing ⇒ exactly one | injected `now` driving the real reset-bucket signature + counting `requestRender` | within-bucket ticks; boundary crossing |

### Definition of done

The real code path for each invariant has executed green against its faithful
seam, including at least one injected fault. The primary "no recurring idle
render" proof is the deterministic local seams above; a `PI_DEBUG_REDRAW=1`
long/resumed-session run is an optional smoke check, not the proof.

## Migrated surfaces

- **async-subagents** (`extensions/pi/index.ts`, `liveWidget.ts`, `renderers.ts`):
  the badge is value-gated; `tickPi` is split into a **session-long non-visual**
  subscriber (badge + task reconcile + wakeup polling, never renders) and a
  **visual** subscriber that runs `updateLiveWidget` only while a time-dependent
  visible item exists (active rows/tasks, terminal rows within expiry, finished
  tasks within the 30 s grace). Age uses a fixed-width formatter reserved before
  summary truncation; change detection is width/layout-aware. The async lease
  (5 s) is a non-render subscriber. Dead-pid rows are reconciled via an injectable
  `pidProber`.
- **bravo-goals** (`extensions/pi/index.ts`, `hud.ts`): the 1.5 s HUD poll is a
  clock subscription; the existing `setHudStatus` value-diff and `refreshInFlight`
  guard are retained; `visWidth`/truncation are aligned cell-for-cell with the
  canonical emoji-aware oracle (VS16 lookahead + wide ranges) to remove a
  width-undercount that could overflow a line and hard-exit Pi.
- **footer** (`.pi/extensions/codex-usage.ts`): the live reset countdown derives
  from an injected `now` and `requestRender`s only when the rendered reset-bucket
  signature changes; the 5 min usage poll is a non-render subscriber whose render
  stays gated by the existing semantic cache-change check.

The only `setInterval` remaining in any render surface is the one inside
`@bravo/render-clock`. (The child-control inbox poll is a child-side,
non-rendering timer and is intentionally out of scope.)

## Verification

Per-package, network- and credential-free:
`npm run test --workspace @bravo/render-clock` / `@bravo/async-subagents` /
`@bravo/goals`, plus the footer's `.pi/extensions/__tests__` clock tests. The
async package carries pre-existing failures unrelated to this work
(wakeups / session_compact / scout-prompt); this change introduced none.
