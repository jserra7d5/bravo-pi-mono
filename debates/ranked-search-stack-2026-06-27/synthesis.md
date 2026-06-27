# Synthesis — ranked_search robustness debate

## 1. Question restated

What long-term architecture should `@bravo/source-search` use to make `ranked_search` robust against max-call-stack / pathological-corpus failures while preserving its v1 contract: live, folder-portable, no index/cache/CLI/sidecar lifecycle, compact ranked lexical source discovery?

## 2. Convergence status

The debate converged on a hybrid, pragmatically isolated architecture. All sides agree on immediate mechanical fixes — unbounded recursion, array spreading, late filtering, git prefixes — and on the need for a resilient execution contract with strict resource budgets and structured diagnostic warning codes.

Remaining productive disagreement is limited to whether subprocess/worker boundaries are needed for the scoring loop versus in-process bounded/cooperative loops.

## 3. Recommended direction / long-term architecture

Implement a **staged, bounded pipeline with a resilient execution contract**.

- **Scope resolution**: Inside checkouts, use `git ls-files -z -co --exclude-standard -- <pathPrefix>` with a strict timeout. Outside checkouts, optionally use `rg --files --null --hidden -g "!.git/"` for file listing if available, falling back to a non-recursive iterative TypeScript walker.
- **Early directory pruning**: Prune ignored/denied directories during traversal before entering them.
- **Content read + scoring ownership**: Keep lexical tokenization, boosts, exclude terms, scoring, snippets, and safety policy in TypeScript to avoid query dialect drift.
- **Cooperative bounded execution**: Process files in an async loop, yielding to the event loop periodically to keep Pi responsive.
- **Top-K heap**: Maintain a bounded top-K heap instead of collecting/sorting every hit.
- **Resilient response contract**: Add typed warning/diagnostic codes and return trustworthy partial results (`ok: true`) rather than throwing or silently returning empty lists for degraded execution.

## 4. Points of agreement

- Stack overflows from recursive `walkFiles` and array spreads must be eliminated.
- Excludes/ignores must be applied early at directory/candidate discovery time, not after full traversal.
- Inside git checkouts, explicit directory scopes should use `git ls-files -- <pathPrefix>` instead of bypassing git.
- Ranking/tokenization/snippet semantics should remain in TypeScript unless a parity matrix proves an external engine equivalent.
- Keep the zero-setup, zero-lifecycle tool contract.
- Failures must be bounded, diagnosable, and not allowed to masquerade as “no matches.”

## 5. Live disagreements

### Iterative JS walker vs native utility discovery

- JS walker maximizes portability and contract ownership.
- Native discovery (`git`, optional `rg --files`) is faster and avoids main-thread filesystem traversal on pathological non-git trees.

Recommended synthesis: use git as authoritative inside repos; optionally use rg for non-git listing only when available/policy-compatible; keep JS iterative fallback.

### In-process scoring vs subprocess/worker-isolated scoring

- In-process cooperative scoring is simpler and preserves direct behavior.
- Subprocess isolation provides stronger memory/crash containment and kill semantics.

Recommended synthesis: implement in-process bounded scoring first, with diagnostics and budgets. Add subprocess isolation only if tests or field evidence show bounded in-process scoring still starves or destabilizes Pi.

## 6. Ordered implementation phases

### Phase 1 — Traversal and git-prefix correctness

- Replace recursive `walkFiles` in `packages/source-search/src/live.ts` with iterative traversal.
- Remove unbounded `files.push(...childFiles)` patterns.
- In git mode, always use `git ls-files -z -co --exclude-standard -- <pathPrefix>` when scoped.
- Apply ignore/noise pruning during discovery.

### Phase 2 — Budgets, cancellation, and streaming top-K

- Add `SearchBudget`: wall-clock, candidate count, files read, bytes read, per-file bytes, depth, render/snippet bytes, sampled errors.
- Turn discovery and scoring into a streaming pipeline.
- Maintain bounded top-K rather than whole-corpus `hits`.
- Yield periodically to avoid event-loop starvation.
- Honor the Pi `AbortSignal`.

### Phase 3 — Resilient response schema and warnings

- Add compact diagnostic warning codes: e.g. `git_timeout_fallback_used`, `candidate_budget_exceeded`, `read_budget_exceeded`, `read_errors_omitted`, `render_truncated`.
- Preserve current agent-facing simplicity; diagnostics can live in `details` with compact rendered warnings.
- Ensure API and Pi extension always catch tool internals and return structured degraded responses where possible.

### Phase 4 — Optional external primitive acceleration / isolation

- Add optional `rg --files` only for non-git file listing, not semantic ranking, if available and policy-compatible.
- Consider subprocess-isolated JS scoring only if bounded in-process scoring proves insufficient under faithful stress tests.

## 7. Validation targets

- Deep nested tree: no call stack overflow.
- Wide tree with >100k files: no spread/argument overflow; bounded partial result when budgets hit.
- Git path prefix: uses git-visible files and does not walk ignored generated/vendor directories.
- Ignored huge directory: pruned before descent.
- Git timeout/failure: warning distinguishes fallback from authoritative git mode.
- Unreadable/binary/large files: skipped with sampled diagnostics, not silent recall loss.
- Cancellation: Pi tool abort stops execution promptly.
- Render size: output remains compact and warning-aware.

## 8. Gaps not fully debated

- Windows path separator/subprocess behavior.
- Cyclic symlinks and realpath visitation sets in iterative traversal.
- GC pressure from string conversion/token arrays.
- Empty/non-token queries.
- Whether `QueryResponse` should version diagnostics under a new optional field or encode only strings in `warnings`.
