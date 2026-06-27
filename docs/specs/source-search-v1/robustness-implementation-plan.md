# ranked_search Robustness Implementation Plan

## Summary

Implement the debate synthesis direction: keep `ranked_search` live, folder-portable, TypeScript-owned, and v1-compatible, but replace brittle corpus traversal and all-or-nothing execution with a staged bounded pipeline. The initial robustness work should fix recursion/spread/git-prefix failures, add budgets/cancellation/top-K ranking, and surface degraded execution with compact warning codes. Do not add an index, cache, CLI, sidecar, workspace registry, setup lifecycle, or agent-facing tool parameters.

## Source-of-truth constraints

Preserve the Source Search v1 contract from `docs/specs/source-search-v1/design.md` and `packages/source-search/README.md`:

- Agent-facing Pi surface remains exactly one tool: `ranked_search`.
- `QueryResponse` / `SearchHit` shape remains compatible: `protocolVersion`, `ok`, `repoRoot`, `query`, `boosts`, `excludeTerms`, `hits`, `count`, `indexFreshness`, `warnings`, `error`; hit fields remain compatible.
- `query` stays plain lexical text; no backend DSL syntax.
- `path` restricts search directly and missing paths do not broaden to a parent checkout.
- Inside git checkouts, the authoritative corpus command is `git ls-files -z -co --exclude-standard`, scoped as `git ls-files -z -co --exclude-standard -- <pathPrefix>` when a path/current-directory prefix applies.
- Outside git, search walks the live filesystem with conservative secret/noise excludes plus `.agentignore`, `.piignore`, and `.bravo/source-search.json` `exclude` at the active search root.
- `.bravo/source-search.json` legacy `enabled`, `workspace`, `repos`, and `defaultRepos` fields must not affect scope.
- Results remain discovery evidence packets; users must still confirm exact evidence with `read`/`grep`.

## Semantic ownership

| Behavior | Current owner | Implementation direction |
| --- | --- | --- |
| Scope resolution | `resolveRepoPath` as used by `packages/source-search/src/api.ts` and `packages/source-search/extensions/pi/index.ts` | Reuse; do not create a second resolver. Prefer making the Pi extension delegate to `rankedSearch()` so API owns execution. |
| Corpus discovery | `packages/source-search/src/live.ts` `candidateFiles`, `walkFiles`, `execGit` | Move to bounded git/fallback discovery and iterative filesystem traversal in the same owner. Do not delegate lexical semantics to `rg`. |
| Query validation, tokenization, scoring, boosts, excludes, snippets, safety | `packages/source-search/src/live.ts` helpers (`validate`, `termsFromQuery`, `scoreFile`, `matchedFields`, `bestSnippets`, `safeReadText`) | Reuse these semantics. Top-K changes must preserve full-run ordering; do not duplicate scoring in another engine. |
| Public package entry | `packages/source-search/src/api.ts` `rankedSearch` | Make this the canonical entry point used by the Pi extension. Add optional non-agent-facing cancellation support only if needed. |
| Agent rendering | `packages/source-search/src/render.ts` `renderQueryResult` | Preserve text shape and ensure warnings render compactly in success/no-hit/error cases. |
| Response schema | `packages/source-search/src/types.ts` | Keep `QueryResponse.warnings?: string[]`; warning codes can be typed internally/exported without adding required response fields. |

If implementation later adds worker/subprocess isolation, move the existing TypeScript owner into that boundary; do not create a parallel scoring implementation without a parity matrix.

## Runtime invariants

1. **Contract invariant:** Agent-facing schema and response shape stay v1-compatible; no setup/index/cache/CLI lifecycle appears.
2. **Scope invariant:** A requested path must either be searched directly or fail clearly; never broaden to a parent directory/repo.
3. **Git visibility invariant:** In a git checkout and absent a warning, candidates are exactly from `git ls-files -z -co --exclude-standard -- <pathPrefix>` for scoped searches.
4. **Safety invariant:** File reads never escape the real search root; denied secret/noise paths and configured ignores are skipped before content is read.
5. **Ranking parity invariant:** For a complete, non-budgeted, non-aborted run over the same candidate set, top results match the current scoring semantics and tie-break by score descending then path ascending.
6. **Bounded execution invariant:** Discovery/scoring uses no unbounded recursion, no unbounded `push(...largeArray)`, bounded candidate/read/render work, and periodically yields to the event loop.
7. **Truthfulness invariant:** Budget/fallback/read degradation returns partial results with warning codes; it must not silently look like authoritative “no matches.”
8. **Cancellation invariant:** A Pi `AbortSignal` stops discovery/scoring promptly and does not leave child processes running.

## Warning codes

Keep `warnings` as strings for schema compatibility, but prefix each emitted warning with a stable code:

- `git_timeout`: git listing timed out; any results are only candidates emitted before the timeout.
- `git_error`: git listing failed; no filesystem fallback is used inside git checkouts because fallback would broaden beyond the git-visible corpus.
- `candidate_budget_exceeded`: candidate discovery stopped at the configured candidate cap.
- `file_read_budget_exceeded`: file-read count cap stopped further reads.
- `byte_read_budget_exceeded`: total bytes-read cap stopped further reads.
- `depth_budget_exceeded`: filesystem traversal skipped directories deeper than the cap.
- `large_or_binary_files_skipped`: at least one candidate was skipped for per-file size or binary/NUL checks.
- `read_errors_omitted`: read/stat/permission errors occurred; include only bounded, non-sensitive samples.
- `search_aborted`: caller cancellation stopped the search.
- `render_truncated`: only if a render-layer total output cap is added.

`ok: true` is appropriate for degraded partial searches with useful results. Use `ok: false` for query validation errors, missing path/no searchable directory, pre-result cancellation, or unrecoverable internal failures.

## Target files and functions

### `packages/source-search/src/live.ts`

- Replace recursive `walkFiles(root, base)` with an iterative traversal, e.g. `walkFilesIterative(root, base, ctx): AsyncGenerator<string>`.
- Remove `files.push(...await walkFiles(...))` and any other spread-over-large-array pattern.
- Replace/extend `execGit` with a bounded git listing helper that supports timeout, abort, stderr sampling, and scoped `-- <pathPrefix>`.
- Change `candidateFiles(root, pathPrefix?)` into a budget-aware discovery function/generator that:
  - uses git first when available;
  - always passes `-- <pathPrefix>` when scoped;
  - does not filesystem-fallback after git failure/timeout inside a checkout, because fallback would broaden beyond the git-visible corpus;
  - applies `.agentignore`, `.piignore`, and `.bravo/source-search.json` excludes before filesystem descent where possible.
- Refactor `safeReadText` into a budget-aware read helper that returns an explicit skip reason instead of only `null`; compute `realpath(repo)` once per query.
- Refactor `queryRepo(...)` into the canonical bounded pipeline:
  - validate query as today;
  - load ignore patterns once;
  - discover candidates under budgets;
  - process candidates in an async loop with periodic yields;
  - honor an optional `AbortSignal`;
  - maintain a bounded top-K heap rather than collecting/sorting all hits;
  - return partial `QueryResponse` warnings when budgets/fallbacks/skips affect trustworthiness.
- Keep `scoreFile`, `matchedFields`, and `bestSnippets` as the semantic owners. Only change call timing if ranking parity is preserved.

Proposed initial internal budget constants, tunable during review:

```ts
const DEFAULT_SEARCH_BUDGET = {
  gitTimeoutMs: 10_000,
  wallClockMs: 20_000,
  maxCandidates: 100_000,
  maxFilesRead: 25_000,
  maxBytesRead: 128 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxDepth: 256,
  maxReadErrorSamples: 5,
  yieldEveryCandidates: 250,
  yieldEveryMs: 25,
};
```

Expose budget overrides only through non-agent-facing test/internal options on `queryRepo`; do not add Pi tool parameters or config lifecycle.

### `packages/source-search/src/api.ts`

- Make `rankedSearch(options)` catch all internal failures from `queryRepo`, including git-scoped calls, and return structured `QueryResponse` errors instead of throwing.
- Optionally extend `SourceSearchQueryOptions` with `signal?: AbortSignal` for programmatic callers; this is not an agent-facing schema change.
- Use `PROTOCOL_VERSION` instead of literal `1` in constructed error responses.
- Preserve existing missing-path behavior and limit normalization.

### `packages/source-search/extensions/pi/index.ts`

- Make the tool `execute` path call `rankedSearch({ cwd, query, path, limit, boosts, excludeTerms, signal })` and then `renderQueryResult(result)`.
- Remove duplicated scope-resolution/search execution from the extension once `rankedSearch` owns it.
- Keep the registered tool list, schema, prompt snippet, and environment behavior unchanged.

### `packages/source-search/src/render.ts`

- Ensure all warning-coded degraded responses are rendered in success, no-hit, and error cases.
- If adding a total rendered-character cap, append/render `render_truncated` without mutating result details unexpectedly.

### `packages/source-search/src/types.ts`

- Add optional exported types for warning codes/budgets if useful, but do not add required `QueryResponse` fields.
- Keep `protocolVersion` unchanged.

### `packages/source-search/test/live.test.ts`

Add faithful tests through the real public/package seams (`rankedSearch`, `queryRepo` only for internal budget overrides, and Pi tool execution where cancellation/rendering matters). Avoid fakes for ranking or traversal.

### Docs

- `packages/source-search/README.md`: add a short diagnostics section explaining that warnings mean partial/degraded live search and that no-match with warnings is not proof of absence.
- `docs/specs/source-search-v1/design.md`: document bounded execution, warning-code convention, and scoped git command with `-- <pathPrefix>` while reaffirming no index/cache/CLI/setup lifecycle.

## Phased implementation plan

### Phase 1 — Git prefix correctness and iterative filesystem traversal

1. Add a small query runtime context in `live.ts` for warnings, budgets, abort checks, root realpath, and sampled read errors.
2. Rewrite `walkFiles` as iterative traversal:
   - stack/queue of directories instead of recursion;
   - deterministic lexical entry ordering for reproducible budget behavior;
   - no following symlink directories;
   - early skip for `.git`, `node_modules`, `dist`, `build`, `target`, secret/noise names;
   - early skip/prune for `.agentignore`, `.piignore`, and config `exclude` patterns;
   - depth budget warning instead of descending forever.
3. Update git discovery so scoped searches use `git ls-files -z -co --exclude-standard -- <prefix>` rather than direct filesystem walking.
4. Preserve current non-git behavior except make traversal iterative and early-pruned.
5. Add tests for scoped git visibility and ignored-directory pruning.

### Phase 2 — Bounded scoring pipeline, top-K, and cancellation

1. Convert `queryRepo` from “collect all candidate files, collect all hits, sort all hits” to candidate iteration plus bounded top-K heap.
2. Keep score calculation identical; final heap output sorts by score descending then path ascending.
3. Track candidate count, files read, bytes read, per-file bytes, wall clock, depth, and read-error samples.
4. Yield periodically with a real event-loop yield during long candidate/read loops.
5. Thread an optional `AbortSignal` through `queryRepo`; check before/after git, directory reads, file reads, and yield points. Kill git child processes on abort/timeout.
6. Emit budget warnings and return partial useful results instead of throwing or returning silent empty hits.

### Phase 3 — API/Pi resilience and warning rendering

1. Make `rankedSearch` the canonical execution owner and wrap all internal exceptions into `QueryResponse`.
2. Simplify the Pi extension to delegate to `rankedSearch`, pass the Pi `AbortSignal`, and render the returned response.
3. Ensure `renderQueryResult` prints warning codes in every branch.
4. Keep the Pi tool schema and prompt guidance unchanged except for optional diagnostics wording if needed.

### Phase 4 — Docs and review hardening

1. Update README and v1 design docs for warning semantics and bounded live execution.
2. Add a review checklist and final commit criteria to the PR description using the checklist below.
3. Run automated tests and hand tests below.
4. Only after Phases 1-3 pass, consider optional `rg --files` for non-git listing as a separate follow-up. It must list files only; TypeScript remains owner of lexical scoring/snippets/safety. Do not add worker/subprocess scoring unless faithful stress evidence shows in-process bounded scoring still starves or destabilizes Pi.

## Automated validation plan

| Test | File/seam | Invariant proved | Failure/edge case proved |
| --- | --- | --- | --- |
| Scoped git path uses git-visible files | `live.test.ts` via `rankedSearch({ cwd: repo, path: "src" })` in a real git repo with `.gitignore` | Git visibility + scope invariant | Current direct-walk prefix bug would return ignored untracked files. |
| Missing path still does not broaden | Existing `rankedSearch` test | Scope invariant | Requested missing path returns `ok:false` no-searchable-directory. |
| Non-git deep tree finds leaf without stack overflow | `rankedSearch` on generated nested non-git tree | Bounded traversal invariant | Recursive traversal/spread failures become visible through real API seam. |
| Ignored huge directory is pruned before descent | `queryRepo`/`rankedSearch` on non-git tree with `.agentignore` and low test candidate budget | Safety + early-pruning invariant | Without early pruning, ignored candidates consume budget and visible file is missed/warned. |
| Candidate budget returns truthful partial result | `queryRepo(..., { budgets: { maxCandidates: small } })` | Truthfulness + bounded execution invariant | Returns `ok:true` with `candidate_budget_exceeded`, not throw/silent empty. |
| Read/byte budget returns truthful partial result | `queryRepo` with small `maxFilesRead` or `maxBytesRead` | Truthfulness + read budget invariant | Emits `file_read_budget_exceeded` or `byte_read_budget_exceeded`. |
| Large/binary/unreadable files are skipped diagnostically | `rankedSearch`/`queryRepo` with NUL-containing and oversized test files | Safety + observability invariant | Emits skip/read warning samples without reading unsafe content. |
| Top-K parity for normal runs | Existing ranking/boost/exclude tests plus a deterministic tie test | Ranking parity invariant | Heap ordering matches full sort for complete runs. |
| AbortSignal stops promptly | Pi tool built by `buildSourceSearchTools` and/or `rankedSearch` with an aborted/in-flight signal | Cancellation invariant | Returns/aborts with `search_aborted`; no child git process remains. |
| Git failure/timeout is explicit | Real malformed git marker in a test-only seam, or git timeout option | Truthfulness invariant | Emits `git_error`/`git_timeout` and does not filesystem-fallback into ignored/private content. |
| Warnings render in all branches | `renderQueryResult` with success/no-hit/error warning responses | Observability invariant | Agent-visible text includes warning codes. |
| Extension still registers only one tool and mutates no env | Existing extension test | Contract invariant | No CLI/sidecar/env lifecycle regression. |

Prefer real filesystem/git fixtures over in-memory fakes. Budget overrides are acceptable only as a test seam for forcing failure paths; they must exercise the same `queryRepo` implementation used by the tool.

## Hand-test commands and scenarios

Run with fail-fast timeouts from the repository root after implementation:

```bash
timeout 120s npm run build --workspace @bravo/source-search
timeout 120s npm run check --workspace @bravo/source-search
timeout 180s npm test --workspace @bravo/source-search
```

Deep non-git traversal scenario:

```bash
timeout 180s bash -lc '
set -euo pipefail
tmp=$(mktemp -d)
TMPROOT="$tmp" node --input-type=module <<"NODE"
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.TMPROOT;
let dir = root;
for (let i = 0; i < 800; i += 1) {
  dir = join(dir, "d");
  await mkdir(dir, { recursive: true });
}
await writeFile(join(dir, "leaf.txt"), "deep robustness needle\n");
NODE
TMPROOT="$tmp" node --input-type=module <<"NODE"
import { rankedSearch } from "./packages/source-search/dist/api.js";
const result = await rankedSearch({ cwd: process.env.TMPROOT, query: "robustness needle", limit: 5 });
if (!result.ok || !result.hits.some((hit) => hit.path.endsWith("leaf.txt"))) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
NODE
'
```

Wide/budgeted partial scenario using the real `queryRepo` seam and test-only budget override:

```bash
timeout 180s bash -lc '
set -euo pipefail
tmp=$(mktemp -d)
TMPROOT="$tmp" node --input-type=module <<"NODE"
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.TMPROOT;
await mkdir(root, { recursive: true });
for (let i = 0; i < 1000; i += 1) await writeFile(join(root, `f-${String(i).padStart(4, "0")}.txt`), `wide needle ${i}\n`);
NODE
TMPROOT="$tmp" node --input-type=module <<"NODE"
import { queryRepo } from "./packages/source-search/dist/live.js";
const result = await queryRepo(process.env.TMPROOT, "wide needle", 5, undefined, undefined, undefined, { budgets: { maxCandidates: 50 } });
if (!result.ok || !result.warnings?.some((warning) => warning.startsWith("candidate_budget_exceeded"))) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
NODE
'
```

Scoped git path scenario:

```bash
timeout 120s bash -lc '
set -euo pipefail
tmp=$(mktemp -d)
git -C "$tmp" init >/dev/null
mkdir -p "$tmp/src"
printf "src/ignored.ts\n" > "$tmp/.gitignore"
printf "export const visibleNeedle = true;\n" > "$tmp/src/visible.ts"
printf "export const ignoredNeedle = true;\n" > "$tmp/src/ignored.ts"
TMPROOT="$tmp" node --input-type=module <<"NODE"
import { rankedSearch } from "./packages/source-search/dist/api.js";
const visible = await rankedSearch({ cwd: process.env.TMPROOT, path: "src", query: "visibleNeedle", limit: 5 });
const ignored = await rankedSearch({ cwd: process.env.TMPROOT, path: "src", query: "ignoredNeedle", limit: 5 });
if (!visible.ok || !visible.hits.some((hit) => hit.path === "src/visible.ts") || ignored.hits.some((hit) => hit.path === "src/ignored.ts")) {
  console.error(JSON.stringify({ visible, ignored }, null, 2));
  process.exit(1);
}
NODE
'
```

Cancellation scenario:

```bash
timeout 60s node --input-type=module <<'NODE'
import { rankedSearch } from "./packages/source-search/dist/api.js";
const ac = new AbortController();
ac.abort();
const result = await rankedSearch({ cwd: process.cwd(), query: "needle", signal: ac.signal });
if (result.ok || !result.warnings?.some((warning) => warning.startsWith("search_aborted"))) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
NODE
```

If the package build output path differs from `packages/source-search/dist/*.js`, adjust only the import path according to the package build configuration; do not change the scenario semantics.

## Review checklist

- [ ] Only `ranked_search` remains registered; no CLI/index/cache/manifest/status/purge/setup workflow is added.
- [ ] Tool schema remains unchanged; no agent-facing budget/debug parameter is introduced.
- [ ] `QueryResponse` and `SearchHit` required shape remains compatible; `protocolVersion` remains `1`.
- [ ] Pi extension delegates search execution to `rankedSearch` and passes `AbortSignal`.
- [ ] Scoped git searches use `git ls-files -z -co --exclude-standard -- <pathPrefix>`.
- [ ] Filesystem traversal is iterative, early-pruned, deterministic, and has no large spread calls.
- [ ] Directory ignores/noise are applied before descent for filesystem walking.
- [ ] Reads use realpath containment and do not follow symlinks outside root.
- [ ] Secret/noise paths remain skipped; fallback after git failure is warning-coded.
- [ ] Complete-run ranking/top-K parity is covered by tests.
- [ ] Budget and abort failure paths are covered by tests that exercise real code paths.
- [ ] Warning codes are rendered in tool text and included in details.
- [ ] README and v1 design docs describe warnings without implying a new lifecycle.
- [ ] Build, check, unit tests, and hand-test scenarios pass with timeouts.

## Final commit criteria

A robustness commit is ready when:

1. Phases 1-3 are implemented and docs in Phase 4 are updated.
2. All automated validation cases above pass.
3. Hand tests for deep traversal, scoped git prefix, budgeted partial results, and cancellation pass.
4. No source-search CLI, sidecar, cache, index, or setup/status lifecycle exists.
5. No degraded execution path silently returns authoritative-looking empty results.
6. Review checklist is complete and any budget default changes are explicitly called out in the PR/commit message.

## Stop/replan triggers

Stop and ask for parent direction if any of the following occur:

- Preserving v1 response/tool schema appears impossible.
- Implementation requires an agent-facing setup/index/cache/debug lifecycle.
- Git fallback would broaden scope or include ignored/secret-bearing content without a safe mitigation.
- Top-K optimization cannot be proven ranking-equivalent for complete runs.
- Faithful stress tests still produce event-loop starvation, memory blowup, or uncaught max-call-stack errors after bounded in-process changes.
- Cancellation cannot be implemented without changing Pi tool execution semantics.
- Warning codes need structured response objects rather than compatible strings.
- Windows path/pathspec behavior differs enough to require contract decisions.
- Optional `rg` or worker/subprocess isolation becomes necessary for correctness rather than performance.

## Risks / unknowns

- **Budget defaults:** Too low causes unnecessary partial results; too high weakens robustness. Treat defaults as review-significant and tune with stress evidence.
- **Git fallback semantics:** Filesystem fallback cannot perfectly emulate `.gitignore`/git visibility. It must be warning-coded and safety-pruned; consider reading `.gitignore` only for fallback if needed.
- **Ignore semantics:** Current simple pattern matcher ignores negation. Early pruning should not claim full gitignore parity outside git.
- **Windows compatibility:** Path separators, git pathspecs, symlink behavior, and process signals need focused review/tests if Windows support matters.
- **Render cap:** Existing snippets are bounded per hit, but total output can still grow with `limit=50`. Add `render_truncated` only if a total cap is introduced.
- **Observability limits:** Warning strings are intentionally compact and local; there is no telemetry. This preserves contract simplicity but limits field diagnostics.
- **Security:** Warning samples must not include file contents and should avoid exposing secret-looking paths beyond what the search policy already permits.
