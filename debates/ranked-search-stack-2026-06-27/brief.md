# Debate brief: ranked_search max call stack failures

Date: 2026-06-27

## Question

What long-term architecture should `@bravo/source-search` use to make `ranked_search` robust against max-call-stack / pathological-corpus failures while preserving its v1 contract: live, folder-portable, no index/cache/CLI/sidecar lifecycle, compact ranked lexical source discovery?

## Context

Source of truth read by moderator:

- `packages/source-search/README.md`
- `docs/specs/source-search-v1/design.md`
- `packages/source-search/src/live.ts`
- `packages/source-search/src/api.ts`
- `packages/source-search/extensions/pi/index.ts`
- `packages/source-search/src/render.ts`
- `packages/source-search/src/workspace.ts`
- `packages/source-search/test/live.test.ts`

Current behavior highlights:

- `ranked_search` is a Pi tool for live ranked lexical discovery.
- It should work from any cwd or explicit `path` without setup.
- Inside git, the design says corpus discovery should use `git ls-files -z -co --exclude-standard`.
- Outside git, it walks the filesystem live with conservative noise/secret excludes.
- Package must not add an agent-facing index/cache/manifest/status/purge/setup lifecycle.
- It currently has recursive `walkFiles(root, base)` in `src/live.ts`.
- `walkFiles` recursively collects arrays and uses `files.push(...await walkFiles(abs, base))`.
- `candidateFiles(repo, pathPrefix)` walks the filesystem directly when `pathPrefix` is supplied, even inside git.
- Ignore/config filters are applied after `candidateFiles`, not necessarily during traversal.
- If `git ls-files` fails, `candidateFiles` falls back to filesystem walking.
- User reports intermittent `Maximum call stack size exceeded` and no results.

Likely but not exhaustive failure classes:

- Deep recursion or large spread argument lists in recursive traversal.
- Explicit git path searches bypassing git-visible corpus selection.
- Huge ignored/generated/vendor trees reached before filters apply.
- Tool execution failing all-or-nothing instead of returning partial results and warnings.
- Potential serialization/rendering pressure from large details, snippets, or result bodies.
- Lack of corpus diagnostics/observability for why a search failed or degraded.

## Constraints / non-goals

- Do not solve by telling agents to avoid `.venv`; user wants a deeper long-term design.
- Preserve folder-portability and low ceremony.
- No routine agent-facing index/cache/CLI/setup/debug lifecycle unless the debater explicitly argues the v1 contract should change and explains the cost.
- Prefer practical implementation in TypeScript package and Pi extension.
- Keep safety policy for secrets/noise.
- Results should remain useful as source discovery evidence packets and still require `read`/`grep` for exact confirmation.

## Assigned positions

### Debater A — In-process robust live engine
Argue that v1 should stay in-process TypeScript and live-only, but replace brittle traversal/ranking internals with iterative, streaming, bounded algorithms and better failure semantics.

### Debater B — Delegate corpus discovery/search to battle-tested external primitives
Argue that long-term robustness should lean harder on `git`, `ripgrep`, or subprocess isolation rather than bespoke TypeScript traversal/scoring, while keeping the Pi tool surface simple.

### Debater C — Contract/observability/fault-isolation redesign
Argue that the deeper fix is an explicit resilient execution contract: budgets, partial results, diagnostics, typed failure modes, corpus stats, graceful degradation, and possibly worker isolation, not just swapping traversal code.

## Round cap

Default cap: 3 rounds. Minimum viable debate: opening, rebuttal, judge synthesis.

## Convergence criteria

Stop when remaining disagreements are about implementation taste rather than consequences for reliability, contract simplicity, and agent usefulness.
