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
