# @bravo/render-clock

A single shared, change-aware render clock for the Pi-extension TUI surfaces in
this monorepo. It owns **one** `setInterval` for the whole Pi process and lets
every extension that needs a periodic tick — live elapsed-age, animation frames,
countdown refresh, background I/O polls — subscribe to that one timer instead of
starting its own.

This is a plain, dependency-free TypeScript library (no Pi peer dependency); the
clock never imports Pi types. Subscribers own the decision to call
`tui.requestRender()`.

## Why

Each extension previously ran its own `setInterval`, and at least one poked the
Pi UI on every tick with no value diff. In long / resumed sessions that produced
a recurring terminal "glitch" repaint roughly every ~2 s. Centralizing on one
clock — and keeping every *visual* subscriber change-aware — means:

- idle sessions issue **zero** repaints,
- live fields (e.g. subagent elapsed age) tick via cheap one-line diffs, and
- there is a **single** timer instead of N.

**The clock never calls `requestRender` itself.** Each subscriber decides whether
its visible output actually changed and only then asks Pi to render. (Pi already
coalesces non-force `requestRender()`; the win is suppressing no-op render
requests, plus one shared cadence.)

## API

```ts
import { renderClock, createRenderClock } from "@bravo/render-clock";

const unsubscribe = renderClock.subscribe({
  id: "my-surface",        // a stable id; subscribing the same id again REPLACES
  intervalMs: 1000,        // effective cadence; clamped up to the base interval
  reconcile: ({ now, seq, reason }) => {
    // compute current rendered output; call tui.requestRender() ONLY on change.
    // may return void or a Promise (async I/O polls are overlap-guarded).
  },
});
// ...later
unsubscribe();             // idempotent
```

Exports: `renderClock` (production singleton), `createRenderClock({ baseIntervalMs?, scheduler? })`,
and the `RenderClock` / `RenderClockSubscriber` / `RenderClockScheduler` types.

### Semantics (the contract)

- **One lazy timer.** The real `setInterval` starts on the first `subscribe` and
  is cleared on the last `unsubscribe`. The handle is `unref()`'d.
- **Per-subscriber interval.** `intervalMs` is clamped up to the base
  (effective cadence = `max(base, intervalMs)`); due-times are computed from
  `scheduler.now()`. **No catch-up** — a missed window fires once.
- **Duplicate id replaces** the prior subscriber (no stacking); `subscriberCount`
  is unchanged by a replace.
- **Idempotent unsubscribe** — safe to call twice.
- **Snapshot ticks** — each tick iterates a snapshot taken at entry; a
  subscribe/unsubscribe *during* a tick takes effect on the next tick.
- **Failure isolation** — a throwing or rejecting `reconcile` is caught/logged;
  the remaining subscribers still run.
- **Async overlap guard** — a `Promise`-returning `reconcile` will not be
  re-entered while its previous run is still pending (`inFlight`).

## Singleton + test injection

The production `renderClock` is stored on
`globalThis[Symbol.for("@bravo/render-clock")]` so accidental module duplication
still yields one instance. For tests:

- prefer `createRenderClock({ scheduler })` with a fake scheduler for deterministic
  start/stop/interval behavior, and
- use `__resetRenderClockForTest(scheduler?)` only when you need to drive the real
  `renderClock` singleton (e.g. singleton-identity tests).

## Testing

```bash
npm run check --workspace @bravo/render-clock
npm run test  --workspace @bravo/render-clock
```

Network- and credential-free (pure unit). See
`docs/specs/render-clock-v1/design.md` for the full design, the runtime
invariants / verification-seam table, and which surfaces subscribe.
