# Round 1 — Opening positions

## Debater A — In-process robust live engine (@Emery)

Strongest claim: v1 should remain live, in-process TypeScript because that is the product contract; the bug is not the contract, it is brittle internals. `README.md` and `design.md` explicitly promise no CLI, sidecar, index/cache/setup lifecycle, and live folder-portable search. Current failures are explainable from `live.ts`: recursive `walkFiles`, `files.push(...await walkFiles(...))`, post-traversal filtering, `pathPrefix` bypassing git discovery, whole-corpus hit collection/sort, and weak partial-failure semantics.

Architecture sketch: keep the Pi/API surface unchanged, but make `queryRepo` a bounded streaming pipeline. Candidate discovery becomes an async generator. Inside git, always derive the corpus from `git ls-files -z -co --exclude-standard`, then apply a path-prefix boundary filter; explicit paths must not bypass git-visible selection. Outside git, replace recursive walking with an iterative queue/stack, prune `.git`, `node_modules`, `dist`, `build`, `target`, secret/noise paths, and local ignore patterns before descending, and never spread unbounded arrays. Reading/scoring should stream candidates one file at a time, enforce max file bytes, symlink/root safety, binary checks, and maintain only a top-K heap plus compact diagnostics instead of collecting every hit before sorting.

Failure semantics should also stay in-process: `QueryResponse` already has `warnings` and `error`. Use them. Preserve `ok: true` with partial ranked results when some files cannot be read, traversal hits a budget, git times out but filesystem fallback succeeds, or snippets are truncated. Return `ok: false` only for invalid query, missing requested path, or no searchable root. Add warnings such as `candidate_budget_exceeded`, `git_discovery_failed_fallback_used`, `file_read_errors_omitted`, and corpus counts. This improves robustness without creating a second operational lifecycle agents must understand.

This approach aligns ownership: `live.ts` already owns corpus discovery, filtering, reading, scoring, and snippet selection. We should reuse and harden that owner, not duplicate behavior in a CLI/sidecar or create an alternate search path. `api.ts` and the Pi extension should remain thin wrappers over the same `queryRepo` seam so API and tool behavior stay identical.

Tradeoffs: TypeScript traversal will never be as optimized as ripgrep for raw search, and subprocess isolation could contain crashes better. But v1’s value is zero ceremony and exact live portability. The reported max-call-stack class is solvable directly with iterative traversal, bounded queues, top-K ranking, and partial responses. Pulling in external search primitives risks query dialect leakage, platform dependencies, packaging complexity, and divergent safety semantics.

The assumption that most weakens this position: pathological corpora are large enough, or file contents hostile enough, that even bounded in-process Node execution can regularly exhaust memory/CPU before returning useful partial results. If that is true, worker or subprocess isolation becomes necessary despite the v1 contract cost.

## Debater B — External primitives / subprocess isolation (@Casey)

# Debater B Opening Argument: Delegation to External Primitives

## Strongest Claim
Bespoke TypeScript-based directory traversals, lexical tokenization, and scoring in a single-threaded Node.js runtime are inherently fragile and inefficient. To ensure long-term robustness and scale, `@bravo/source-search` must delegate filesystem crawling and content querying to native, industry-standard external primitives—specifically `git` and `ripgrep`—while maintaining a zero-lifecycle, simple Pi tool contract.

---

## Evidence & Root-Cause Analysis
The current implementation of `ranked_search` in `packages/source-search/src/live.ts` fails under three main structural bottlenecks:

1. **Unbounded Call-Stack Recursion & Argument Exhaustion**:
   The recursive file-walking algorithm in `walkFiles` accumulates paths and flattens them using array spreading:
   ```ts
   files.push(...await walkFiles(abs, base))
   ```
   For large folders, V8 runs out of call stack frames due to deep recursion. Even if recursion depth is bounded, array spreading is limited by the V8 call-argument limit (typically ~65,535 arguments). Exceeding this limit crashes the engine with a `Maximum call stack size exceeded` error.

2. **Deferred Exclusion/Ignore Logic**:
   In `queryRepo`, candidates are retrieved first, and ignores are applied only *after* the entire directory tree has been recursively walked:
   ```ts
   const files = (await candidateFiles(repo, prefix)).filter(
     (path) => !ignorePatterns.some((pattern) => simpleMatch(pattern, path))
   );
   ```
   If a repository contains a massive unignored directory (like `.venv`, `.cargo`, or `.next`), `candidateFiles` walks it entirely in JavaScript, reading file stats and generating thousands of nodes before ignore filters ever run.

3. **Bypassing Git and Event-Loop Blocking**:
   When a user supplies a `pathPrefix` to scope their search inside a git repository, `candidateFiles` bypasses git listing entirely:
   ```ts
   if (pathPrefix) {
     ...
     if (scopedStat.isDirectory()) return walkFiles(scoped, root);
   }
   ```
   This strips the execution of git's optimized index and forces an in-process filesystem walk. Furthermore, loading and tokenizing hundreds of files up to `MAX_FILE_BYTES = 1024 * 1024` each in a single Node.js thread blocks the event loop, degrading Pi's terminal responsiveness.

Since `execGit` is already used in the codebase, delegating to subprocesses is already accepted in this package. We should push this pattern to its logical conclusion.

---

## Concrete Architecture Sketch
We propose rewriting `candidateFiles` and search execution to offload resource-intensive operations to subprocesses, keeping the tool's schema, inputs, and outputs unchanged:

1. **Robust Git Path Prefixes**:
   Inside git repositories, if `pathPrefix` is supplied, append it directly to the git command: `git ls-files -z -co --exclude-standard -- <pathPrefix>`. This leverages Git's C-based index and immediately filters paths without touching the filesystem.

2. **Non-Git Subprocess Delegation**:
   Outside of git or as a fallback, use `ripgrep` (`rg`) to discover files and search contents. `ripgrep` is written in Rust, processes ignore files natively during traversal, and runs on a separate thread pool.
   - **To list files**: Run `rg --files --null --hidden -g "!.git/"` to retrieve files instantly while honoring `.gitignore`, `.ignore`, and `.rgignore`.
   - **To search and score**: Instead of reading and tokenizing every file in JavaScript, invoke `ripgrep` directly using:
     ```bash
     rg --json -w -F -i --max-filesize 1M <query>
     ```
     By parsing the resulting JSON stream, we receive matched lines, paths, and snippet context directly from `ripgrep`'s engine, completely bypassing manual file reading and BM25 scoring in Node.js.

3. **Graceful Fallbacks**:
   If `ripgrep` is missing on the host system, fall back to standard shell utilities (such as `find` or `grep` on Unix, and `dir` / `findstr` on Windows), or a non-recursive, chunked, and depth-limited TypeScript walker that yields partial results with warnings instead of failing completely.

---

## Risks & Tradeoffs
- **Binary Dependency**: Relying on external binaries introduces a runtime dependency on the host environment's `PATH`. However, developer workstations and CI runtimes already have `git` and `ripgrep` installed.
- **Behavior Divergence**: The regex/tokenization logic of `ripgrep` might produce slightly different result sets than our custom JS tokenization (`TOKEN_RE`). We can align this by passing strict flag combinations (e.g. `--word-regexp`) to `ripgrep`.

---

## The Weakening Assumption
The primary assumption of this position is that **Pi's host environments allow subprocess spawning and have standard development tools (`git`, `ripgrep`, or standard shell commands) available on the path.** If Pi is executed in a highly sandboxed, zero-dependency environment where launching child processes is blocked or native binaries cannot be located, this delegated architecture would fail, forcing us back onto a resource-constrained, in-process JS fallback.

## Debater C — Contract/observability/fault-isolation redesign (@Gray)

## Opening argument — Debater C: Contract/observability/fault-isolation redesign

The strongest long-term fix is not “replace recursion with iteration”; it is to make `ranked_search` an explicitly resilient execution contract. The current implementation can fail because traversal is brittle, but the deeper product bug is that callers have no bounded, diagnosable, partial-success semantics when any stage misbehaves.

Evidence in the current code:

- `packages/source-search/src/live.ts` has recursive `walkFiles()` and `files.push(...await walkFiles(abs, base))`, which can fail on depth or large spreads.
- `candidateFiles(repo, pathPrefix)` bypasses `git ls-files` whenever `pathPrefix` is supplied, even though the README/design say git checkouts should use git-visible files with the requested path as prefix.
- Ignore/config filtering happens after full candidate discovery: `const files = (await candidateFiles(...)).filter(...)`, so huge ignored/vendor trees may be traversed before being excluded.
- `execGit()` timeout/failure silently falls back to filesystem walking with no warning, so a degraded and potentially dangerous path is invisible.
- `queryRepo()` has no wall-clock budget, candidate budget, byte budget, file-error budget, or partial-result mode. It reads and scores all files before sorting.
- Skips in `safeReadText()` — secret/noise, path escape, too large, binary, unreadable — are silent. The caller receives no corpus stats explaining recall.
- The Pi tool catches exceptions only in the non-git fallback branch; when `resolveRepoPath()` succeeds, `queryRepo()` errors can propagate as tool failure instead of returning a structured degraded response.
- The `AbortSignal` passed to `execute()` is unused.

So the contract today is effectively all-or-nothing plus a few strings. That is the wrong invariant for live search over arbitrary folders. Pathological corpora, flaky git, unreadable files, symlink weirdness, huge generated trees, and render pressure are normal operating conditions, not exceptional surprises.

Architecture sketch:

1. Define an internal execution contract with fixed default budgets: max wall time, max discovered candidates, max files read, max bytes read, max per-file bytes, max directory depth, max snippet/render bytes, max sampled errors.
2. Make search a staged pipeline: scope resolution → corpus discovery → policy filtering → bounded reads → scoring → top-K heap → render. Each stage emits typed diagnostics.
3. Return partial success by default. `ok: true` with hits plus `warnings`/diagnostics when budgets are exceeded or fallback paths are used. Reserve `ok: false` for validation errors, missing scope, or total execution failure before any trustworthy result.
4. Add typed failure/degradation codes internally and in `details`, e.g. `git_timeout`, `git_failed_fs_fallback`, `traversal_budget_exceeded`, `read_budget_exceeded`, `file_read_errors`, `render_truncated`, `worker_crashed`.
5. Preserve the agent-facing simplicity: still one `ranked_search` tool, no index/cache/setup lifecycle. Diagnostics live in `details` and compact rendered warnings.
6. Use fault isolation for the risky live scan/scoring path: worker thread or subprocess with hard timeout and cancellation. The Pi extension wrapper should always be able to return a structured failure or partial response, even if the worker hits stack overflow or runaway traversal.
7. Apply policy during discovery, not after it, and make corpus mode explicit: `git`, `git_path_prefix`, `filesystem`, `filesystem_fallback`.

This does not compete with iterative traversal or external primitives; it makes them safe to adopt. Without a resilience contract, swapping recursion for an iterative walker only fixes today’s stack trace while preserving tomorrow’s silent fallback, timeout, OOM, render bloat, or recall mystery.

Tradeoffs: diagnostics add schema surface and implementation discipline; budgets can reduce recall; worker isolation adds serialization and lifecycle complexity. But those are controlled costs, and they align with the v1 promise: live, portable, compact discovery. The alternative is pretending arbitrary live filesystem search is deterministic and cheap.

The assumption that would most weaken my position: if `ranked_search` is only expected to run on small, trusted, mostly git-clean repos where failures can be surfaced as ordinary tool errors. If that is false — and the brief/user report says it is — resilience and observability are the core design, not garnish.
