# Testing

> Standardized by the test-optimization skill (first-time setup, 2026-06-01).
> Latency baseline: `.quantiiv/test-baseline.json`.

This is an npm-workspaces monorepo. The test runner is **Node's built-in
`node:test`** over compiled output: each package's `test` script runs
`npm run build && node --test dist/test/*.test.js` (the `tango` package compiles
tests flat, so it uses `dist/*.test.js`). Test sources are `*.test.ts` under each
package's `test/` (most packages) or `src/` (tango). Node v22+.

Two packages — `caveman` and `tui-enhancements` — ship no tests.

## Test categories (by dependency)

`node:test` has no markers, and this repo does not use Jest/Vitest `projects`, so
categories are tracked **here** (and in `categorization.md` next to the skill).
The key finding from setup: **no test needs external network or cloud
credentials** — the whole suite is safe to run on any dev box. The "gates" are all
*local*: filesystem temp dirs, spawning local binaries, and in-process sqlite.

| Bucket | Meaning | Packages |
|--------|---------|----------|
| `pure-unit` | No IO of any kind; pure functions / renderers. Fastest tier. | `gemini-code-assist`, `showcase` (whole pkg); plus most files in `async-subagents`, `bravo-goals`, `monitor`, `web-evidence-cache` |
| `needs-fs` | Reads/writes real filesystem (tmp dirs, fixture files). Safe anywhere. | most packages, including `dynamic-skills` |
| `needs-subprocess` | Spawns a local binary — `process.execPath` (node) running the package CLI, or `git` / `ps` / `sqlite3`. Needs those tools on PATH. | `codex-auth-balancer`, `loom`, `monitor`, `source-search`, `tango` |
| `needs-db` | In-process sqlite (`node:sqlite` FTS5) or the `sqlite3` CLI on a real db file. No external DB server. | `web-evidence-cache` (sqlite.test.ts), `loom` |
| `integration` | Spans modules + a real local resource. `tango/src/server.test.ts` starts an **in-process** HTTP server on `127.0.0.1:0` and `fetch`es it — local only, no external network. | `tango` |

There is **no `needs-network` (external) and no `needs-adc` (cloud creds)** bucket
in this repo. Tests that looked like network/cloud from imports are local servers
or string literals — see the categorization report.

## How to run

| Suite | Command |
|-------|---------|
| One package (build + test) | `npm run test --workspace @bravo/<pkg>` |
| One package, skip rebuild (dist already built) | `node --test packages/<pkg>/dist/test/*.test.js` |
| tango (flat dist layout) | `node --test packages/tango/dist/*.test.js` |
| Fast tier only (pure-unit pkgs, sub-second) | `node --test packages/gemini-code-assist/dist/test/*.test.js packages/showcase/dist/test/*.test.js` |
| Everything (build all, then run all) | `npm run build && for p in async-subagents bravo-goals codex-auth-balancer dynamic-skills gemini-code-assist loom monitor pi-extension-background-bash showcase source-search web-evidence-cache; do node --test packages/$p/dist/test/*.test.js; done; node --test packages/tango/dist/*.test.js` |
| Slowest tier (subprocess-heavy; deselect from fast loop) | `loom`, `tango`, `pi-extension-background-bash`, `monitor` scheduler tests |

Whole-suite wall time is ~**40s** serial on a linux-x86_64 dev box (~837 test
cases across 13 packages). `loom` (~9s for 7 CLI-spawning tests) and `tango`
(~12s) dominate; the pure-unit packages run in well under 1s combined.

### Known pre-existing failures (as of baseline)

One test failed during baseline capture and is **not** caused by this setup:
- `tango` → `prune` (filesystem/timing sensitive)

These are flagged for the maintainer; the baseline records timings for passing tests.

## Latency regression check

The skill's `bench_record.py` cannot parse `node:test` TAP directly. The setup used
a small TAP-to-JSON adapter (`tap_to_runjson.py`, kept with the skill workspace) to
normalize `node --test --test-reporter=tap` output into the
`{test_id: [seconds]}` shape `bench_record.py` expects, keyed as
`<package>::<test name>`. To refresh or check the baseline:

```bash
SKILL=/home/joe/Documents/Quantiiv/Optimized-Development-Tooling/plugins/quantiiv-utils/skills/test-optimization

# 1. Capture TAP per package into a run dir (warm up once and discard, then 3 runs).
#    Run node --test --test-reporter=tap <pkg>/dist/test/*.test.js > rundir/<pkg>.tap

# 2. Normalize TAP -> {test_id:[seconds]} (adapter lives with the skill workspace):
python3 tap_to_runjson.py rundir-1 rundir-2 rundir-3 > /tmp/run.json

# 3. Check this run against the committed baseline (exits non-zero on regression):
python3 "$SKILL/scripts/bench_record.py" check \
  --baseline .quantiiv/test-baseline.json --run /tmp/run.json \
  --machine linux-x86_64 --abs-floor 0.05

# 4. Update the baseline ONLY after an intended change; commit the new baseline:
python3 "$SKILL/scripts/bench_record.py" update \
  --baseline .quantiiv/test-baseline.json --run /tmp/run.json \
  --runner node:test --machine linux-x86_64 --date <YYYY-MM-DD>
```

A test is flagged only when **both** its median (+25%) and its min (+15%) rise —
noise-robust. **Raise `--abs-floor` to 0.05s for this repo**: most `node:test`
unit tests run in 0–25ms, where the default 20ms floor lets OS jitter trip false
flags. Refresh the baseline deliberately, never just to silence a flag.
