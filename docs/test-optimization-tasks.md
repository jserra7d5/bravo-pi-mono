# Agent prompt — implement the test-suite optimizations

> Hand this file to a `pi` agent (e.g. `pi --thinking medium @docs/test-optimization-tasks.md`)
> or a pi subagent. It is the implementation brief for the optimizations surfaced by a
> test-suite audit of this repo. **Do not** rewrite test behavior or weaken assertions —
> these are mechanical speedups and anti-slop fixes only.

## Context

- Repo: `bravo-pi-mono`, an npm-workspaces monorepo. Runner is **Node's built-in `node:test`**
  (TAP over compiled `dist/`; each package's `test` script is `npm run build && node --test dist/test/*.test.js`). Node v22.
- A standardized suite already exists: `docs/TESTING.md`, the safe-bucket list `docs/safe-tests.txt`,
  and a committed latency baseline `.quantiiv/test-baseline.json`. There is **no** network/credential
  dependency anywhere — the whole suite is safe to run locally.
- Whole-suite wall time today is **~40s serial** (~817 cases across 12 packages). The audit found the
  slow time is concentrated in (a) legitimately heavy subprocess/CLI integration tests, which we keep,
  and (b) a cluster of timer/budget/scheduler tests that **wait on the real wall clock** — those are
  the target.

## Hard rules

1. **Preserve behavior.** Do not change production code semantics. Only change *test mechanics*
   (virtual time) and *test assertions* (make implicit assertions explicit). Never weaken or delete an assertion to make a test pass or run faster.
2. **Do not delete any test.** If a test seems pointless, make it meaningful (see Task 2), don't remove it.
3. **No new dependencies.** Use `node:test`'s built-in mock timers (`t.mock.timers` / `MockTimers`), not a third-party fake-timer lib.
4. **If a test genuinely needs real elapsed time** to validate real timeout/latency semantics, leave it
   alone and note why — don't fake-clock something whose entire point is real wall-clock behavior.
5. **Leave changes uncommitted** for human review unless told otherwise. Do not force-push or rewrite history.

## Task 1 — Replace real-clock waits with `node:test` mock timers (perf)

Several unit tests sit at ~1.2–1.9s because they `await` real timers/`setTimeout`/budget ticks rather
than advancing virtual time. Convert these to `node:test` mock timers so virtual time advances instantly:

```js
import { test } from 'node:test';
test('…', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  // …arrange…
  t.mock.timers.tick(1500);   // advance virtual time instead of waiting
  // …assert… (timers auto-restore at test end)
});
```

Candidate hotspots from the audit (confirm by reading each — the pointer is the symptom, not a guarantee):

- **`packages/monitor`** — scheduler tests (e.g. `scheduler tick triggers timer monitor`) wait on real
  timers (~1.2s each, very tight min≈median). These also `spawn ps`; only the *timer wait* should be
  virtualized — leave the `ps` spawn as-is (it's a real-dependency signal, fine).
- **`packages/async-subagents`** — runtime-budget / live-widget tests (e.g. `manual pause suspends
  runtime budget …`, `live widget uses summary read-models …`) elapse real budget time (~1.3–1.9s).
- **`packages/pi-extension-background-bash`** — `bash timeout is seconds …` (~1.3s). **Caution:** this
  may legitimately exercise real timeout semantics. If virtualizing it wouldn't actually test the real
  timeout path, **leave it** and note that in your report (Hard rule 4).

For each test you change: confirm the assertion still checks the same behavior, just at virtual time.

## Task 2 — Give the `monitor` validator smoke tests teeth (anti-slop)

`packages/monitor/test/validation.test.ts` has 6 "accepts X" tests that call a validator and assert
**nothing** — they pass as long as the call doesn't throw:

```js
test('validateCheck accepts timer', () => { validateCheck({ type: 'timer' }); });
// …5 more: validateCheck accepts file exists, validateSchedule accepts empty/delay_ms,
//   validateCondition accepts always, validateCondition accepts and/or with children
```

Wrap each in `assert.doesNotThrow(...)` so the intent is explicit and a regression (validator wrongly
throwing on valid input) fails with a clear message:

```js
import assert from 'node:assert';
test('validateCheck accepts timer', () => {
  assert.doesNotThrow(() => validateCheck({ type: 'timer' }));
});
```

This is a behavior-preserving clarification — same coverage, now with teeth. Do not change the validators.

## Task 3 — (Optional, only if quick) de-couple the cwd-sensitive fixture

`packages/async-subagents/test/agentDefinitions.test.ts` reads `agents/scout.md` relative to the
current working directory, so it ENOENTs when run from the repo root and only passes per-package.
If it's a small change, resolve the fixture path relative to the test file / package root (e.g.
`fileURLToPath(import.meta.url)`-based) so it's cwd-independent. If it's involved, just flag it.

## Out of scope (report, don't fix)

- One **pre-existing failing test** (unrelated to these changes):
  `tango :: prune`.
  Leave it to the maintainer; just confirm your changes didn't introduce or mask it.

## Verify before you finish

1. Rebuild and run the affected packages: `npm test --workspace <pkg>` for each package you touched.
   **All previously-passing tests must still pass**, and the tests you virtualized should now be ~0ms
   of wait (sub-100ms).
2. Re-time the safe bucket and refresh the baseline using the **test-optimization** skill's helper
   (no new deps; `<test-opt>` = `Optimized-Development-Tooling/plugins/quantiiv-utils/skills/test-optimization`):
   ```bash
   node --test --test-reporter=tap $(cat docs/safe-tests.txt) > /tmp/run.tap
   python <test-opt>/scripts/bench_record.py parse --runner node --tap /tmp/run.tap > /tmp/run.json
   python <test-opt>/scripts/bench_record.py check  --baseline .quantiiv/test-baseline.json --run /tmp/run.json --abs-floor 0.05
   # after confirming green + faster, accept the new normal:
   python <test-opt>/scripts/bench_record.py update --baseline .quantiiv/test-baseline.json --run /tmp/run.json --date <today>
   ```
3. Report: per-package before/after median for every package you touched, the whole-suite before/after
   wall time, the list of files changed, any test you intentionally left on the real clock (and why),
   and confirmation that no assertion was weakened and no test deleted.
