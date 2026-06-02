# async-subagents — performance notes

A long-lived "lead" pi session drives a 2-second tick (`extensions/pi/index.ts` `tickPi`)
plus per-frame live-widget rendering. Earlier, several of these paths re-read or
re-derived the **entire** run/task history on every tick or frame, so lead-session CPU,
input lag, and dropped render frames grew in proportion to the cumulative number of
subagents/tasks ever dispatched — and never recovered, because completed runs are still
read from disk every tick. This file tracks the fixes that bound those costs.

The pi-mono host (TUI render loop, transcript re-render) is intentionally out of scope here.

## Fix 1 — run-index cache: O(1) lead-tick reads (`src/runStore.ts`, `src/jsonl.ts`)

**Before.** `readIndexCache()` `readFileSync` + `JSON.parse`d the whole
`run-index-cache.json` (all records) on *every* call, and it is called several times per
2s tick (`listRecentRuns`→`listDirectChildren`, `resolveRunDir`, `readRunSummaries`).
`appendRunIndex()` rebuilt the entire cache from the full index JSONL on *every* spawn —
O(N) per spawn → O(N²) per session.

**After.**
- A module-level in-memory cache, keyed by the resolved index + fallback source paths,
  holds the parsed `RunIndexCache`.
- Every read does only a cheap `statSync` per source and compares
  `size + mtime + ctime + dev + ino`. **Unchanged ⇒ no file read, no JSON.parse, no
  whole-cache clone** — the per-tick read path is O(1) in history size.
- On change it **tail-reads only the appended bytes** (`readJsonlRange()` in `jsonl.ts`)
  from the last parsed offset and applies them incrementally. Full rebuild only on
  shrink / identity change (rotation/replacement) / parse failure.
- `appendRunIndex()` no longer rebuilds the whole cache; it incrementally refreshes a warm
  cache and no longer maintains the on-disk `run-index-cache.json` on append (treated as
  derived; truth is the append-only JSONL validated by `stat`).

**Correctness.** The index files are shared across the lead process and many detached
supervisor processes (append-only via `O_APPEND`). Freshness is preserved by re-`stat`ing
on every call; `size` covers mtime coarseness, `dev`/`ino` cover rotation/replacement, and
the invariant *"a source is fresh only when identity matches **and** `parsedOffset === size`"*
guarantees an unparsed tail is always re-read rather than skipped. `parsedOffset` tracks the
last complete-line boundary, so a partial trailing line is re-read once completed. Tail-read
failures fall back to a full rebuild; a double failure deletes the cache key so a partial
cache is never retained. Public `readIndexCache()`/`readRunIndex()`/`listDirectChildren()`/
`listRecentRuns()`/`readLookupRunIndex()` return mutable defensive clones so callers cannot
corrupt the shared cache; only internal hot-path lookups use it by reference.

**Tests.** `test/runStore.test.ts` (no full re-parse when unchanged; external append
observed with mtime restored to prove size-based detection; partial-JSONL-tail regression)
and `test/performanceReadModels.test.ts` (live-widget repeated reads do not full-reparse).

> Implemented by a GPT-5.5 (`pi`) agent under adversarial GPT-5.5 review; approved after
> independent verification (`npm run check`, targeted `node --test`).

## Fix 2 — live-widget tick + per-frame render (`extensions/pi/liveWidget.ts`, `renderers.ts`, `src/runStore.ts`, `src/taskStore.ts`, `src/taskState.ts`)

**Before.** The 2s `tickPi` rebuilt the whole widget snapshot every tick:
`readWatcherSnapshot` `readFileSync`+`JSON.parse`d **every** run's `summary.json` (O(total
runs)/tick, including long-completed ones); `TaskStore.listTasks` `readdir`+read+parse
**every** task file each tick *and*, with reconcile on, could take the task lock whose
contention path `Atomics.wait`-sleeps the lead's main thread; `deriveTaskState` was called
per-task building a fresh `Map(allTasks)` each time → O(T²)/tick; and `renderAt` rebuilt
`runIdToTask` and re-derived task state on **every render frame**, with `renderWidgetCard`
doing five O(T²) count passes.

**After.**
- **Stat-validated per-summary and per-task-file caches** (same pattern as Fix 1:
  identity+size+mtime+ctime+dev+ino). Unchanged files are `stat`'d but not re-parsed; the
  dominant cost (`readFileSync`+`JSON.parse` of all history every tick) is gone. Caches
  return deep clones; summary writes invalidate the entry (no cross-process write race —
  summaries aren't lock-guarded), task writes update it (safe — task writes are
  `withLock`-serialized). Cache keys are `resolve()`-normalized.
- **One derived-state map per snapshot.** `deriveTaskStates(tasks)` builds a single
  `byId` map and derives every task's state in O(T) (semantics identical to
  `deriveTaskState`), threaded through `visibleTasksFor`, `renderAt`, and `renderWidgetCard`
  (which now counts in a single O(T) pass). No more O(T²).
- **Non-blocking reconciliation.** The widget reads tasks with a new
  `reconcile: "nonblocking"` mode backed by `tryWithLock` (atomic `mkdirSync` lock attempt,
  break-stale at most once, **never** `sleep`/`Atomics.wait`). Owner-run termination is
  still detected and still emits the `task.failed`/`needs_input` wake event (so autonomous
  failure detection is preserved), but the render/tick thread never blocks on the lock.
  Explicit/mutating task paths keep the blocking default.
- **Self-contained snapshot.** The prepared `LiveWidgetSnapshot` carries rows, task states,
  `runIdToTask`, and unresolved-dependency ids, so the mounted component's `render(width)`
  does **zero** filesystem reads, task/run scans, map rebuilds, or state derivation per
  frame — only cheap time-relative visibility/label recomputation from `now`.

**Trade-off.** A run read-memo that tried to skip even the `stat` of cold terminal runs was
removed as unsafe (it could permanently skip a run whose summary later changed). The
remaining per-tick cost is O(total) cheap `stat` syscalls with O(changed) parses — there is
no parent-dir change signal that would let a run's summary stat be safely skipped — which is
~50–100× cheaper than the previous O(total) read+parse and does not block on I/O of file
contents.

**Tests.** `test/liveWidget.test.ts` (non-blocking reconcile emits the wake event; contended
lock skips without sleeping; self-contained render after task/run files removed; one
derivation per snapshot) and `test/performanceReadModels.test.ts` (unchanged summaries are
not re-read from disk via a cache disk-read counter; active mutation and new runs reflected).

> Implemented by a GPT-5.5 (`pi`) agent under adversarial GPT-5.5 review + a confirmation
> review; approved after independent verification (88/88 targeted tests). One reviewer
> finding (`deriveTaskStates` "divergence") was rejected as a false positive after checking
> that the original `isTaskReady` already required `!task.owner`.

## Fix 3 — transcript card memoization (`extensions/pi/renderers.ts`)

**Before.** The async-subagents transcript cards (wakeup messages and tool-call/result
cards) are produced by `chromeRenderable(build)`, whose `render(width)` rebuilt the card and
re-ran per-codepoint `visWidth` ANSI/width math on **every** call, with a no-op
`invalidate()`. The pi host re-renders the whole transcript tree each frame with no
container-level caching, so every accumulated card re-ran its ANSI math every frame — CPU
that grew with the number of cards in the transcript (until the next compaction). Plain
`Text` cards in pi-tui already cache by `(text,width)`; these chrome cards were the
non-caching outliers.

**After.** `chromeRenderable` memoizes by **clamped** width: a same-width render returns the
cached lines without rebuilding or re-measuring; a width change or `invalidate()` rebuilds.
Card content is fixed at creation (all callers — `renderSubagentToolCallComponent`,
`renderSubagentToolResultComponent`, `renderSubagentWakeMessageComponent` — capture fixed
data with no time/mutable input), so width-keying is sufficient and output bytes are
identical. The internal cache is never exposed: `render()` returns a defensive `slice()` so a
caller mutating the returned array cannot poison the cache. The time-relative live-widget
component (`createLiveWidgetComponent`, which renders with `Date.now()`) is a separate path
and is intentionally left uncached.

(The other half originally scoped here — collapsing `renderWidgetCard`'s five O(T²)
`deriveTaskState` count passes into one — was already done in Fix 2 via the precomputed
`taskStates` map.)

**Scope note.** This bounds the *async-subagents* contribution to per-frame transcript cost.
The host-side full-transcript re-render + line-diff (pi-mono `tui.ts` `Container.render`) is
out of scope and remains; it is itself bounded by compaction, which rebuilds the transcript
from the compacted context.

**Tests.** `test/renderers.test.ts`: same-width render builds exactly once (build-count) and
is byte-equal; a different effective width rebuilds; `invalidate()` forces a rebuild.

> Implemented by a GPT-5.5 (`pi`) agent under adversarial GPT-5.5 review; approved after
> independent verification (47/47 renderer tests). Reviewer flagged returning the cached
> array by reference; resolved by returning a defensive `slice()`.

## Fix 4 — JSONL tail reads + O(1) task-event sequence (`src/jsonl.ts`, `src/taskStore.ts`)

**Before.** `readJsonl(path, { offset })` `readFileSync`'d the **whole** file and then sliced
to `offset`, so every cursor catch-up read of the task event log re-read all historical bytes
even when only the tail was wanted — the wakeup poll and `readEvents(cursor)` paid O(total
events) per call. Separately, `appendTaskEvent` allocated each event's sequence number with
`this.readEvents(rootSessionId).length + 1`, i.e. a **full read + parse of the entire event
log on every single append** — O(E) per event → O(E²) over a session, on the lock-held mutate
path.

**After.**
- **Tail reads.** `readJsonl(path, { offset })` with `offset > 0` now `openSync` +
  `fstatSync` + `readSync`s only `[offset, EOF)` (shared `readJsonlRangeInternal`), parsing
  just the appended bytes. `offset === 0` still whole-file reads. Absolute `nextOffset`,
  absolute `INVALID_JSONL` offsets, partial-trailing-line handling (advance only past the last
  complete newline), `maxRecords`, and the `offset >= size ⇒ { records: [], nextOffset: size }`
  result are all byte-for-byte preserved.
- **O(1) sequence allocation.** A per-session `event-highwatermark` file holds the last
  allocated sequence. `nextTaskEventSequence` reads it (tiny), returns `hwm + 1`, and persists
  the new hwm via `atomicWriteJson` **before** the event is appended — all under the existing
  `withLock`. The full event-log read is gone from the hot path.

**Crash-consistency.** Sequences/eventIds must never **duplicate** (they key delivery dedup);
gaps are fine. The hwm is committed before the append, so a crash between commit and append
leaves a *gap* (sequence skipped, never reused as a duplicate); a crash before the commit
leaves the hwm unchanged so the same sequence is safely retried. The allocator only trusts the
hwm when it parses to a **positive safe integer**; an absent/empty/corrupt hwm (migration of a
pre-existing session, or a torn write) recovers from `max(0, …existing event.sequence)` rather
than the record count — so a log with a pre-existing gap (e.g. sequences `[1,3]`) recovers to
`4`, never re-issuing `3`. For a contiguous legacy log of `L` events this yields `L + 1`,
byte-identical to the old `length + 1`. The whole allocator stays inside the per-session task
lock, so concurrent supervisors cannot interleave allocations.

**Tests.** `test/jsonl.test.ts` (offset reads preserve records/`nextOffset`/`lastId`/
`maxRecords`/partial-line/`offset>=size` with **zero** full-file reads via a read counter;
absolute invalid-offset reporting), `test/taskStore.test.ts` (new session sequences `1,2,…`
and writes the hwm; migrated session with `L` pre-existing events continues at `L+1`; empty
**and** corrupt hwm with a gapped log recover to `max+1` with no duplicate), and
`test/wakeups.test.ts` (a second unchanged poll catches up with no full-file event read).

> Implemented by a GPT-5.5 (`pi`) agent under adversarial GPT-5.5 review; approved after
> independent verification (`npm run check`, 38/38 targeted tests). Reviewer's BLOCKER —
> empty/corrupt hwm could re-init from record count and duplicate a sequence after a gap — was
> valid and fixed (strict positive-safe-integer validation + `max(sequence)` recovery). A
> second finding (`offset > size` no longer returning `nextOffset = size`) was rejected after
> verifying `readJsonlRangeInternal` returns `nextOffset = end = size`, identical to the old
> whole-file path.

## Fix 5 — delivery-state / subscription read cache (`extensions/pi/wakeups.ts`)

**Before.** `pollWakeups` runs on the ~2s lead tick. `readDeliveryState` did a full
`readFileSync` + `JSON.parse` of `delivery/<parentRunId>.json` on **every** tick — and that
file's `delivered` and `handled` maps grow **one entry per wakeup ever delivered/handled**, so
even in steady state (every subagent long completed, nothing new to deliver) each tick re-parsed
an ever-growing JSON blob: O(cumulative subagents) CPU + GC per tick that never recovered.
`readDeliverySubscriptions` was a second per-tick full parse. Both are also called by
`writeDeliveryState`'s merge-on-write and by every `markX`/`isWakeupKeyHandled` helper.

**After.** Stat-validated in-memory caches (same pattern as Fixes 1–2:
identity = `exists + size + mtimeMs + ctimeMs + dev + ino`) for both the delivery-state and the
subscriptions files. Each read `stat`s the file; unchanged ⇒ return a **deep clone** of the
cached value with **no read, no parse**; changed/absent ⇒ re-parse (or fresh default) and
recache. The dominant steady-state cost (whole-file parse every tick) is gone — a quiescent tick
is now a `stat` + clone.

**Correctness.**
- **Deep clones out.** `pollWakeups` mutates the returned state in place
  (`state.delivered[key] = …`, reassigns `state.taskEventCursors`) and the
  `markDeliveredWakeupHandled` / `markWakeupKeyHandled` / `markTaskWakeupHandled` /
  `markWakeupHandled` helpers read-modify-write it, so reads return a deep clone (recursing into
  the nested `taskEventCursors` `WaitCursor` objects); the cache can never be poisoned by a
  caller's mutation. The file-absent default is a fresh object each call.
- **Invalidate-on-write, not write-through.** `writeDeliveryState` /
  `writeDeliverySubscription` keep their existing read-existing → merge → `atomicWriteJson`
  flow and then **delete** the cache key. Write-through would be unsafe: another process could
  `atomicWriteJson` the same file between our write and a post-write `stat`, leaving us caching
  *our* merged value under *its* file identity — stale forever. Invalidation forces the next
  read to re-`stat` and parse whatever is actually on disk.
- **Cross-process freshness.** The delivery file is shared by the lead process and detached
  supervisor processes. Re-`stat`ing on every call (identity includes `size`/`ctime`/`dev`/`ino`,
  not just `mtime`) guarantees an external write is always observed — even one that restores the
  original `mtime`. No on-disk format, delivery-key, cursor, claim, or lease behavior changed;
  public output is byte-identical. Map growth is **not** pruned here (that is destructive and
  deferred); this fix only removes the redundant per-tick re-parse.

**Tests.** `test/wakeups.test.ts`: a parse counter (`deliveryCacheStatsForTest`) proves repeated
steady-state polls do **zero** delivery-state *and* subscription parses after warm-up (the run is
subscribed, so the subscriptions file exists and is genuinely cache-served); and an external
on-disk delivery-state change with its `mtime` restored via `utimesSync` is still re-parsed
exactly once and observed (the run's result key reads back as handled), proving stale state is
never returned.

> Implemented by a GPT-5.5 (`pi`) agent under adversarial GPT-5.5 review; approved after
> independent verification (`npm run check`, 36/36 targeted tests). One reviewer MINOR (parse
> counter incremented before `readFileSync`, so a stat→read race could over-count) was applied
> (increment moved to immediately before `JSON.parse`). A second MINOR (claiming the subscription
> cache test only exercised an absent file) was rejected after confirming the test's run is
> subscribed, so an existing subscriptions file is cache-served.
