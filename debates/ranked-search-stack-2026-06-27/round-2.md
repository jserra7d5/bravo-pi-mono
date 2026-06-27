# Round 2 — Rebuttals

## Debater A — In-process robust live engine (@Harper)

## Debater A — Round 2 Rebuttal

Strongest argument against my position is C’s: “iteration alone fixes today’s stack trace but not tomorrow’s silent fallback, timeout, OOM, render bloat, or recall mystery.” That is correct. The current problem is not only recursive `walkFiles()` and `files.push(...await walkFiles(...))`; it is also that `queryRepo()` has no budgets, no stage diagnostics, no cancellation use, and the Pi extension only catches `queryRepo()` failures in the non-git fallback branch. A live engine over arbitrary folders must treat pathological corpora as normal input, not exceptional failure.

I concede that my opening underweighted the execution contract. The robust in-process design must include C’s budgeted, diagnosable partial-success semantics, not merely an iterative walker. I also concede B is right that git should be used harder: inside a repo, explicit `pathPrefix` should be passed to `git ls-files -z -co --exclude-standard -- <prefix>` rather than bypassing git and walking the filesystem.

Where B overreaches is making `ripgrep` the long-term semantic owner of search. `git` owns git-visible corpus discovery; `live.ts` currently owns lexical scoring, boosts, excludes, snippets, safety skips, and `QueryResponse`. Replacing scoring/search with `rg --json` duplicates or moves that owner into a different query model. `rg` is excellent at exact/regex line matching, but this tool is compact ranked lexical discovery: filename/path/content fields, typed boosts, exclude terms, snippets, and deterministic result packets. A subprocess may avoid V8 stack failure, but it introduces PATH/platform dependency, dialect leakage, JSON-stream failure modes, and parity burden. If `rg` becomes a fallback accelerator, fine—but not the primary semantic engine without a parity matrix proving equivalent ranking/filtering/safety behavior.

Updated architecture: keep `queryRepo()` as the single owner and seam. Make candidate discovery an async generator. In git mode, always use `git ls-files` with optional prefix. In filesystem mode, use an iterative queue, prune denied/ignored dirs before descent, bound depth/candidates/files/bytes/wall time/render bytes, and never collect unbounded arrays. Read/score one file at a time, maintain only top-K plus sampled diagnostics. Return `ok: true` with warnings for partial trustworthy results; reserve `ok: false` for invalid query/scope or no trustworthy search root. Pi/API wrappers should both catch `queryRepo()` errors and forward `AbortSignal`.

I have not changed my mind on the core position: v1 should remain live, folder-portable, in-process TypeScript with no index/cache/CLI/sidecar lifecycle. I have sharpened it: “in-process” does not mean “unbounded” or “opaque.” It means the package owns the contract, the policy, and the ranking semantics directly. Worker isolation can be an implementation hardening later if evidence shows bounded in-process execution still cannot reliably return structured failure; it should not be the first architectural move.

## Debater B — External primitives / subprocess isolation (@Jordan)

# Round 2 Rebuttal: Debater B (Casey) — External Primitives / Subprocess Isolation

## Concessions to A and C

I concede to **Debater A (Emery)** that attempting to delegate the entire content querying and ranking pipeline directly to native `ripgrep` is a leaky abstraction. Mapping our custom BM25 lexical tokenization, word boundaries, boost weights, and phrase matching onto native `ripgrep` flags (such as `--json` and raw regex) introduces query dialect leakage, regex-injection risks, and semantic divergence from the v1 spec. Content parsing, scoring, and ranking must remain in TypeScript to preserve correct lexical invariants and ensure safety policies (such as `.agentignore` and `.bravo/source-search.json` rules) are consistently enforced.

I also concede to **Debater C (Gray)** that subprocess isolation alone does not guarantee resilience. Launching `ripgrep` or `git` without bounds can still lead to runaway CPU consumption, pathologically large output streams, or hang indefinitely on slow/dead filesystems. Any subprocess call must be wrapped in the resilient contract Gray outlines: strict wall-clock timeouts, memory caps, and partial-success diagnostics.

---

## Rebuttals to Debater A (In-process robust engine)

Emery’s argument that a purely in-process, iterative TypeScript directory walker resolves our stability issues is over-optimistic. While an iterative stack prevents `Maximum call stack size exceeded` errors, it fails to solve single-threaded CPU starvation:

1. **CPU/Event Loop Blocking**: Traversing, reading file stats, and filtering large, nested folders (e.g., containing 100,000+ files across vendor or cache directories) in a single Node.js thread blocks the event loop for seconds. This degrades terminal responsiveness and freezes the interactive Pi agent. Delegating filesystem crawling to native commands or isolated child processes is the only way to keep the host agent responsive.
2. **Binary Anxiety is Contradictory**: Emery is concerned with binary dependencies. Yet the current implementation *already* spawns `git` via `execGit()` as its primary search path. Utilizing external commands is already our established status quo. If `git` is available, we should leverage its optimized index. If not, we should fall back to ubiquitous native shell utilities (`find` on Unix, `where` on Windows) rather than forcing V8 to crawl the disk.

---

## Rebuttals to Debater C (Contract/observability/fault-isolation)

Gray argues for worker threads or subprocesses, but treats them as interchangeable isolation strategies. They are not:

Node.js `worker_threads` share the same V8 engine instance. Under heavy memory pressure or uncatchable native exceptions (e.g., during synchronous disk access or bad symlinks on network drives), a worker thread OOM or crash can bring down the entire parent Node process. Furthermore, thread termination is not guaranteed under all block conditions. 

Subprocess isolation, by contrast, provides an absolute OS-level boundary. A spawned helper process has its own isolated memory heap, can be strictly constrained by OS-level resource limits, and can be forcibly terminated with a guaranteed `SIGKILL` on timeout, leaving the parent agent completely unharmed.

---

## Sharpened Architecture: Hybrid Process Isolation

We update our position to combine the semantic precision of Emery's JS engine with the safety and speed of subprocess isolation, under the umbrella of Gray's resilience contract:

1. **Unified Subprocess Discovery**:
   - **Inside Git**: Always execute `git ls-files -z -co --exclude-standard -- <pathPrefix>`. This utilizes Git's pre-built index and filters scoped paths instantly without traversing the directory tree.
   - **Outside Git**: Spawn a native listing command (`find` on Unix, `where` on Windows) to return a raw file list, falling back to a chunked, asynchronous JS walker only if those commands fail. Apply ignore patterns during stream consumption to prune early.
2. **Process-Isolated Batch Reader & Scorer**:
   - Instead of tokenizing and scoring on the main thread, the main process spawns a short-lived helper subprocess (passing the list of candidate paths and the query parameters).
   - This helper process reads files in streamed batches, tokenizes them, runs the BM25 scoring algorithm, and returns the top-K matches.
   - **Budgets and Isolation**: The main process enforces a strict wall-clock timeout on the helper process. If it does not return within the budget (e.g., 2 seconds), the parent process kills it (`SIGKILL`) and returns a partial result based on already streamed matches, accompanied by a `timeout_partial_results` warning. This guarantees that the main thread never blocks, memory is strictly isolated, and lexical search semantics remain 100% identical.

## Debater C — Contract/observability/fault-isolation redesign (@Quinn)

## Debater C — Round 2 rebuttal

Strongest argument against my position: A and B are right that the most visible crash class has concrete mechanical causes, and fixing them does not require inventing a new product surface. `live.ts` has recursive `walkFiles()`, unbounded `files.push(...await walkFiles(...))`, post-discovery filtering, and a `pathPrefix` branch that bypasses `git ls-files`. A bounded generator plus git path-prefix handling, or delegation to `git`/`rg`, would eliminate a large fraction of today’s failures faster than a broad contract redesign.

I concede that. I also concede B’s point that subprocesses are already in the package via `execGit()`, so “external primitive” is not a philosophical violation by itself. If `git ls-files -z -co --exclude-standard -- <pathPrefix>` can provide the corpus, use it. If `rg --files` is present and faithfully respects ignore policy, it is a better filesystem crawler than bespoke JS.

But that does not defeat my position; it proves it. Both A and B still need a resilience contract to be correct.

A’s “just use existing `warnings`/`error`” under-specifies the invariant. Which budget was exceeded? Was git unavailable, timed out, or deliberately bypassed? Did results come from git-visible files, filesystem fallback, or a scoped single file? Were 20 files skipped as binary, 2,000 skipped by byte limit, or did traversal stop early? Today `execGit()` failure silently falls back; `safeReadText()` silently drops secrets/noise/escapes/large/binary/unreadable files; the Pi wrapper catches exceptions only in the non-git fallback path; and `_signal` is unused. An iterative walker can still return a misleading “no matches” after silently pruning half the corpus or timing out late.

B’s delegation also needs the same contract. `rg` can be missing, killed, incompatible, over-match due to different tokenization, hit max output, or disagree with Source Search’s safety policy. Subprocess isolation contains crashes, but it does not define truthfulness. A killed `rg` must not become “no results.” A fallback from git to filesystem must not be invisible. External primitives are implementation choices inside a staged execution model, not a substitute for one.

Updated architecture: I would sharpen my proposal to be less schema-heavy and more invariant-heavy.

1. Keep the agent surface exactly one tool: no index, no setup, no cache lifecycle.
2. Make `queryRepo()` return from a staged execution envelope: scope, discovery, filtering, read/search, scoring, render.
3. Each stage has hard defaults: wall-clock, candidate count, files read/searched, bytes read, per-file bytes, output/render bytes, sampled errors.
4. Diagnostics are compact and typed but not noisy: `mode=git|git_path|fs|fs_fallback|rg`, `partial=true`, counts, and warning codes like `git_timeout_fallback`, `candidate_budget_exceeded`, `read_errors_omitted`, `render_truncated`.
5. Use best primitive per stage: git for git corpora, optional rg for filesystem/search if available and policy-compatible, iterative JS fallback otherwise.
6. Fault isolation is tiered, not mandatory everywhere: subprocess boundaries count when using git/rg; worker isolation is reserved for JS filesystem scan/scoring paths or future evidence that in-process bounds are insufficient.
7. The Pi extension and API must share the same seam and always convert execution failure into structured failure/partial response, including honoring cancellation.

I changed my mind slightly: worker isolation should not be the first implementation requirement if git/rg plus hard budgets give equivalent containment for common paths. But I have not changed my core position. The long-term fix is not “iteration” or “ripgrep”; it is making live arbitrary-corpus search bounded, diagnosable, and incapable of lying by omission.
