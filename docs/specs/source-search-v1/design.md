# Source Search V1

## Summary

Build **Source Search**, a Pi extension/package that adds one native agent tool, `ranked_search`, backed by a Tantivy index. The tool provides ranked lexical/full-text discovery across the current git repository or configured workspace checkouts while managing indexing automatically. Exact search remains the responsibility of existing `grep`/`bash`/`read` workflows.

V1 is not a knowledge graph, graph database, semantic vector index, or code-intelligence system. It is a practical ranked retrieval layer over repository files.

## Goals

- Provide stronger repo discovery than raw `ripgrep` for broad ranked lexical searches.
- Use Tantivy in V1, not as a deferred backend.
- Keep the native agent tool surface small: ideally only `ranked_search`.
- Hide index lifecycle details from the agent during normal search.
- Respect git ignore behavior by default.
- Allow repo-specific configuration for explicitly indexed ignored paths and excluded noisy paths.
- Keep `grep` as the exact/regex evidence tool.
- Make `ranked_search` a default discovery tool whenever startup discovery shows the current repo or workspace supports it.
- Surface discovered ranked-search availability in the agent's initial system prompt.
- Treat local indexes as sensitive cached copies of repository text.

## Non-goals

- No knowledge graph.
- No graph database.
- No semantic/vector search in V1.
- No daemon requirement in V1.
- No sourcegraph-style code-intelligence artifact generation.
- No native tools for routine index management unless V1 evidence proves they are necessary.

## Prior art

Relevant existing systems:

- **Zoekt / Sourcegraph indexed search**: git-repo-oriented code search with sharded mmap indexes, trigram search, symbol-aware ranking, and optional BM25-style scoring.
- **livegrep**: persistent index files and a separate query server for fast code search.
- **grepika**: local/MCP code search with SQLite FTS5, grep, trigram indexing, `.gitignore` handling, and incremental indexing.
- **AI-grep**: local directory indexer using SQLite FTS5 plus ripgrep, with incremental indexing and ignore configuration.
- **qmd**: local search store using SQLite FTS5 plus optional vector/reranking and filesystem rescans.
- **Tantivy**: Lucene-like Rust search library with BM25, field weighting, incremental indexing, snippets/highlighting, and strong performance characteristics.

Key lesson: useful systems separate index build/update from query execution, but agent-facing UX should not force the model to manage that lifecycle during normal retrieval.

## Tool-design stance

The native tool surface should stay tight. `ranked_search` is the agent's hand for ranked repo discovery. Index management is implementation detail, CLI concern, or skill-guided setup—not a normal agent choice.

### Native tool

Expose one native tool:

```text
ranked_search
```

Use it for broad ranked lexical discovery across the current git repo.

### Avoid native V1 tools

Do not expose these as native tools in V1 by default:

```text
repo_index_status
repo_index_refresh
repo_index_configure
```

These create tool-choice ambiguity. Agents may waste turns checking status, refreshing, configuring, then searching. The search tool should manage freshness automatically.

### CLI surface

Expose index management through a human/skill-oriented CLI instead:

```bash
source-search status
source-search index --force
source-search config validate
source-search purge
```

The agent can use this through `bash` only when the user explicitly asks for indexing setup/debug or when `ranked_search` returns an actionable failure.

### Skill surface

Ship a `source-search` skill that teaches:

- when to use `ranked_search` vs `grep` vs `read` vs `bash`
- that `ranked_search` is lexical/BM25, not semantic search
- where repo config lives
- how to allowlist ignored files/directories
- privacy implications of allowlisting ignored paths
- how to exclude noisy generated paths
- how to force rebuild or inspect status through the CLI
- how to recover from stale/failed index states

Do not preload detailed indexing docs into every agent prompt. Use a small tool-coupled prompt fragment and load the skill only for setup/debug tasks.

## Startup discovery and prompt injection

The Source Search Pi extension should run a lightweight discovery step in `before_agent_start` and append a compact prompt section describing ranked-search availability for the current session.

Discovery should be metadata-only and bounded. It must not build or refresh indexes at startup.

Startup discovery checks:

1. Current cwd inside a git checkout.
2. Current cwd is a configured workspace root with child checkout entries.
3. Current cwd has existing ranked-search config files.
4. Existing cache/index manifests for the current checkout or configured child checkouts.
5. Obvious immediate child git checkouts only as a bounded fallback, reported as unconfigured candidates rather than automatically enabled scope.

The injected prompt should tell the agent:

- whether `ranked_search` is available for the current checkout/workspace
- which configured child checkout names are searchable when running from a parent workspace
- whether indexes already exist, are missing, or have unknown freshness
- that the tool will manage refresh/build on first use
- to prefer `ranked_search` for broad ranked lexical discovery when available
- to use `grep` for exact string/regex confirmation
- to use the `source-search` skill or `source-search` CLI only for setup/debug failures

Example prompt section for a single repo:

```text
## Source Search

ranked_search is available for this git checkout. Use it as the default first-pass discovery tool for broad lexical repo search, then use read or grep to inspect exact evidence. The Source Search index is managed automatically on first use.
```

Example prompt section for a parent workspace:

```text
## Source Search

ranked_search is available for this workspace. Configured child checkouts: lib, switchyard, skills, playbooks, gateway, roger, tooling. Use ranked_search as the default first-pass discovery tool across configured child checkouts, then use read or grep for exact evidence. Configure dev/prod/worktree variants as separate checkout paths.
```

Example prompt section when no configured scope exists but candidates are detected:

```text
## Source Search

Source Search is installed, but this directory is not a git checkout and has no workspace registry. Detected child git checkouts are candidates only, not default search scope. Use the source-search skill to configure workspace.repos before relying on ranked workspace search.
```

Keep this section compact. Do not inject full config, cache paths, manifest contents, or troubleshooting docs.

## User-facing behavior

Normal flow:

1. Startup discovery tells the agent whether ranked search is supported for this session scope.
2. Agent calls `ranked_search` first for broad lexical discovery when supported.
3. Tool detects git/workspace scope.
4. Tool loads repo config.
5. Tool creates or incrementally refreshes the Tantivy index within configured budgets, updating new/changed files and deleting removed or newly excluded files; incompatible indexes/manifests/configs fall back to a full rebuild.
6. Tool queries index.
7. Tool returns compact evidence packets: ranked paths/scores, matched fields, selected structured snippet windows, and optional enclosing context.
8. Agent uses `read` or exact `grep` to inspect/confirm promising results.

The agent should not need to know about Tantivy segments, cache paths, mtimes, locks, or manifest internals for normal use.

## Security and privacy

The index contains repository text and must be treated as sensitive. This is especially important because config can allowlist ignored files.

V1 requirements:

- Create cache directories and files with owner-only permissions (`0700` directories, `0600` files where applicable).
- Never index `.git/` contents.
- Reject symlink traversal that escapes the repo root.
- Normalize and validate every corpus path against the canonical repo root.
- Apply a default denylist even inside allowlisted paths for common secret-bearing files unless future config explicitly overrides with a warning:
  - `.env`, `.env.*`
  - `*.pem`, `*.key`, `*.p12`, `*.pfx`
  - `id_rsa`, `id_ed25519`, `known_hosts`
  - credential/token/cache files matching obvious names such as `*secret*`, `*credential*`, `*token*` when extension/content suggests plaintext secrets
- Warn when ignored paths are allowlisted: ignored files often contain secrets, local agent state, credentials, or customer data.
- Delete removed documents from the index during refresh.
- Rebuild or purge the index when config changes in a way that removes allowlisted/excluded corpus paths and deletion cannot be proven complete.
- Provide `source-search purge` to delete all cached index data for a repo.
- Do not include cache paths or indexed content in error messages unless needed for local diagnostics.

Moved/deleted repos can leave sensitive stale caches behind. The CLI status/purge workflow should expose cache cleanup.

## Workspace roots, checkouts, and corpus selection

The search unit is a concrete git checkout/worktree, not an abstract repository, branch, remote, or parent folder.

From a parent workspace, configured child checkout paths are the searchable units. A workspace registry points to concrete checkout paths; indexes are implementation caches behind those checkouts.

Workspace config example for a Quantiiv-style parent folder:

```json
{
  "workspace": {
    "repos": [
      { "name": "lib", "path": "Quantiiv-Lib" },
      { "name": "switchyard", "path": "Switchyard" },
      { "name": "skills", "path": "Quantiiv-Agent-Skills" },
      { "name": "playbooks", "path": "Quantiiv-Playbooks" },
      { "name": "gateway", "path": "Quantiiv-Agent-Gateway" },
      { "name": "roger", "path": "ROGER" },
      { "name": "tooling", "path": "Optimized-Development-Tooling" }
    ],
    "defaultRepos": ["lib", "switchyard", "skills", "playbooks", "gateway", "roger"]
  }
}
```

Dev/prod variants and git worktrees should be configured as separate entries:

```json
{
  "workspace": {
    "repos": [
      { "name": "roger-dev", "path": "ROGER" },
      { "name": "roger-prod", "path": "ROGER-prod" },
      { "name": "api-main", "path": "api" },
      { "name": "api-prod-worktree", "path": "api-prod-worktree" }
    ]
  }
}
```

Do not model branches as entries unless they are separate checkout paths. One mutable folder can only represent its current checkout safely.

Scope resolution for `ranked_search`:

1. If `path` resolves inside a configured child checkout, search that checkout and restrict to the path prefix.
2. Else if cwd is inside a git checkout, search that checkout.
3. Else if cwd is a configured workspace root, search configured default child checkouts.
4. Else return a setup-oriented message and, at most, bounded immediate child checkout candidates.

Default corpus for each checkout should be all text-like files visible to git ignore rules. Implement enumeration with NUL-delimited output or an equivalent safe library call:

```bash
git ls-files -z -co --exclude-standard
```

This includes tracked files and untracked non-ignored files.

Then union in explicitly configured allowlisted paths, even when ignored:

```text
indexed_files = git_visible_files ∪ allowlisted_files
```

Apply safety filters after the union:

- skip binary files
- skip files larger than `maxFileBytes` unless future config explicitly permits
- skip unreadable files with warning counts
- apply explicit excludes
- apply secret denylist
- normalize all stored paths relative to git root
- reject paths that resolve outside repo root

V1 symlink behavior: index symlink files only if their resolved target stays inside the repo root. Do not follow symlinked directories by default.

V1 submodule behavior: treat submodules as boundaries. Index the gitlink/path metadata from the parent repo, but do not recurse into submodule contents unless the tool is invoked from inside the submodule repo or future config explicitly enables nested repo indexing.

V1 sparse checkout behavior: index only files present in the working tree.

Git LFS pointer files are indexed as pointer text in V1; resolving LFS object contents is out of scope.

Branch/checkout safety:

- Manifest stores current branch, `HEAD`, git dir, git common-dir, and worktree root.
- Separate clones/worktrees get separate indexes.
- Same folder branch switches reuse the checkout cache only after refresh validates current files.
- If `HEAD` changed and refresh cannot complete within budget, fail closed with `CheckoutChangedError` rather than silently returning stale results from another checkout.
- If stale checkout results are ever returned in a degraded mode, filter paths that no longer exist and mark `indexFreshness: stale_checkout` with a prominent warning.
- If users frequently compare dev/prod branches, the Source Search skill should recommend separate worktrees and workspace entries.

## Repo configuration

Support repo-specific config:

```text
.bravo/source-search.json
```

Recommended behavior:

- `.bravo/source-search.json` is the canonical Bravo-owned Source Search config for a repo or parent workspace.
- Source Search intentionally targets the existing `.bravo` workspace root instead of introducing `.pi` / `.pi-local` config roots.

Deterministic config rules:

- Unknown keys are `ConfigError`.
- `enabled: false` disables automatic indexing/search for that repo or workspace; startup discovery reports it as disabled and `ranked_search` returns an actionable disabled message rather than building an index.
- `workspace.repos` entries are concrete checkout paths with stable names; workspace entries are declared directly in the Bravo-owned Source Search config.
- `workspace.defaultRepos` limits default multi-repo search scope; if absent, all configured repos are default unless count exceeds a safety cap.
- `allowlist` and `exclude` arrays replace defaults when present in `.bravo/source-search.json`.
- `fields` deep-merges by field name; configured values override defaults.
- `maxFileBytes`, budgets, and scalar options use config-over-default precedence.
- Invalid globs are `ConfigError`.
- Paths/globs must be repo-relative; absolute paths are rejected in V1.

Example:

```json
{
  "enabled": true,
  "allowlist": [
    "docs/generated/**",
    ".agents/**"
  ],
  "exclude": [
    "dist/**",
    "coverage/**"
  ],
  "maxFileBytes": 1048576,
  "maxFiles": 50000,
  "maxIndexBytes": 536870912,
  "refreshBudgetMs": 3000,
  "initialIndexBudgetMs": 15000,
  "fields": {
    "filename": 6,
    "path": 4,
    "symbols": 5,
    "headings": 4,
    "content": 1
  },
  "workspace": {
    "repos": [
      { "name": "lib", "path": "Quantiiv-Lib" },
      { "name": "roger", "path": "ROGER" }
    ],
    "defaultRepos": ["lib", "roger"]
  }
}
```

Config edits should use normal file editing. Do not add a native config mutation tool in V1.

## Index storage and repo identity

Store indexes outside the repo by default:

```text
~/.cache/pi-coding-agent/source-search/<repo-hash>/
```

`repo-hash` should be derived from the canonical realpath of the repo root plus the canonical git common-dir path. Include enough entropy to avoid collisions across worktrees and bind mounts. On manifest load, verify that the manifest `repoRoot` and `gitCommonDir` match the current repo identity; if not, refuse to reuse the cache and require rebuild or purge.

Directory contents:

```text
tantivy-index/
manifest.json
lock
```

The manifest tracks enough metadata for incremental refresh and compatibility checks:

```json
{
  "version": 1,
  "repoRoot": "/repo/path",
  "gitDir": "/repo/path/.git",
  "gitCommonDir": "/repo/path/.git",
  "worktreeRoot": "/repo/path",
  "branch": "main",
  "head": "...",
  "repoIdentityHash": "...",
  "configHash": "...",
  "schemaVersion": 1,
  "tantivyVersion": "...",
  "lastIndexedAt": "2026-05-23T00:00:00.000Z",
  "files": {
    "src/example.ts": {
      "mtimeMs": 123456789,
      "size": 456,
      "hash": "optional"
    }
  }
}
```

## Tantivy schema

V1 fields:

```text
doc_id: exact indexed string + stored
path_exact: exact indexed string + stored
path: text + stored
filename: text + stored
extension: text
language: text
symbols: text
headings: text
content: text, indexed, stored or retrievable for snippets
mtime_ms: u64 stored
size: u64 stored
```

`doc_id` and `path_exact` are required stable keys for updates. Update algorithm:

1. `delete_term(path_exact = repo_relative_path)`
2. add replacement document
3. commit writer

Removed-file cleanup uses the same `path_exact` key.

Default weighting:

```text
filename: 6
symbols: 5
path: 4
headings: 4
content: 1
```

`symbols` can be lightweight in V1. Use regex extraction for common constructs:

- JavaScript/TypeScript: `function`, `class`, `interface`, `type`, `const`, `let`, `var`, `export`
- Python: `def`, `class`
- Rust: `fn`, `struct`, `enum`, `trait`, `impl`
- Markdown headings into `headings`

Tree-sitter is optional future work, not a V1 requirement.

## Query semantics

V1 search is lexical BM25, not semantic search. Agents should try synonyms when terminology may differ and must follow with `read`/`grep` for evidence.

Query language V1:

- Plain text terms are supported.
- Matching is case-insensitive where the Tantivy analyzer folds case.
- Punctuation is tokenized by the configured analyzer; code symbols may need alternate spellings.
- Default operator should favor recall, e.g. OR across terms with BM25 ranking, unless implementation chooses an explicit query parser mode documented in tool help.
- Quoted phrases may be supported only if Tantivy query/parser configuration supports them reliably; otherwise quotes are treated as punctuation and documented as such.
- Agents must not write fielded, boolean, boost, regex, fuzzy, or semantic syntax in `query`; use typed parameters for supported ranking controls.
- `boosts` is the supported ranking-control surface. A boost is a plain lexical term or short phrase plus a positive weight. Weights above 1 prefer matching results, weights below 1 down-rank matching results, and boosts never filter inclusion. V1 may apply phrase controls and down-weight reranking after retrieving a bounded BM25 candidate set and must warn when it does.
- `excludeTerms` is the supported exclusion surface for clearly unwanted noise topics. It filters matching results and must not be treated as proof of absence.
- Invalid query syntax or invalid ranking-control parameters must return `QueryError`, not empty results.
- Enforce max query length, e.g. 512 characters, with a clear error.

Field weights and term boosts are applied by the sidecar query builder/scorer, not by asking agents to write fielded or backend query syntax.

## Snippets and line numbers

Return snippets should be compact and useful, but exact line ranges are best-effort.

V1 implementation may choose one of two strategies:

1. Store content in Tantivy and generate snippets from indexed content.
2. Store offsets/paths and reopen current filesystem content to generate line snippets.

The chosen strategy must report freshness caveats:

- If snippets come from indexed content, they reflect index state and may lag current disk until refresh.
- If snippets come from current files, they can disagree with ranked indexed hits when files changed after indexing.

`lineStart` and `lineEnd` are optional. Omit them when reliable mapping is unavailable. Structured snippet windows may include `truncatedBefore` / `truncatedAfter` booleans plus a legacy `truncated` summary flag, and may include deterministic enclosing `context` metadata such as `function`, `class`, or `heading` when cheaply detectable. Snippet selection should prefer useful evidence windows by term coverage, match density, and lightweight structure rather than mechanically returning only first occurrences. `matchedFields` should use the public names `filename`, `path`, and `content` when populated from reliable query/scoring explanation; otherwise omit or return a conservative field list.

## Passive indexing and budgets

`ranked_search` owns passive indexing. Default refresh mode is automatic but bounded.

On query:

1. Find git root.
2. Load and validate config.
3. Compute config hash.
4. Open index cache for repo hash.
5. If index missing, build within `initialIndexBudgetMs`.
6. If schema/config version changed, rebuild within budget or return partial/stale warning.
7. Else scan file metadata within `refreshBudgetMs`.
8. Delete removed docs.
9. Reindex changed docs.
10. Commit Tantivy writer.
11. Execute query.

Bounded behavior:

- If initial indexing exceeds budget, return partial results only if a usable partial index exists; otherwise return `IndexUnavailableError` with CLI rebuild guidance.
- If refresh exceeds budget and an existing index is usable, query stale index and return `indexFreshness: stale` plus warning.
- If file count exceeds `maxFiles` or total candidate bytes exceeds `maxIndexBytes`, index the safe subset only when deterministic and report `CorpusTooLargeWarning`; otherwise require config narrowing or CLI full index.
- Tool calls must respect cancellation signals and terminate/kill sidecar work promptly.

If another process holds the write lock, use the existing index when safe and return `LockBusyWarning` that refresh was skipped.

## Locking and recovery

Use an atomic lock implementation suitable for local filesystems. V1 expectations:

- Single writer per repo index.
- Readers may query the last committed Tantivy index while writer refreshes when Tantivy permits safe concurrent reads.
- Manifest writes are atomic: write temp file, fsync where practical, then rename.
- Tantivy commits complete before manifest claims files are indexed.
- Stale locks include PID/start-time or timestamp metadata and can be broken only after timeout and process-nonexistence checks.
- Corrupt index open failures trigger one automatic rebuild attempt. If rebuild fails, return `IndexUnavailableError` and suggest `source-search purge`.
- Disk full and permission errors must be explicit errors, not empty results.
- Version mismatch between wrapper and sidecar is explicit `VersionMismatchError`.

## Native tool contract

Name:

```text
ranked_search
```

Description:

> Search the current git repository with ranked lexical full-text retrieval. Use for relevance discovery when exact terms, filenames, or related keywords may appear across many files. The tool manages its Tantivy index automatically and respects gitignore plus repo config allowlists.

Use when:

- Finding likely relevant files for a feature, behavior, concept, or error domain.
- The user asks “where is X handled?” or “find code related to X.”
- Exact `grep` would be too literal or noisy.
- You need ranked context before deciding which files to read.

Avoid when:

- You need exact string or regex evidence; use `grep` or `bash rg`.
- You already know the file path; use `read`.
- You need git history, filesystem metadata, or shell pipelines; use `bash`.
- You need semantic similarity; try synonyms or other project-specific context instead.

Parameters V1:

```ts
{
  query: string,
  path?: string,
  limit?: number,
  boosts?: Array<{ term: string, weight: number }>,
  excludeTerms?: string[]
}
```

Parameter semantics:

- `query`: plain lexical search text, max 512 characters. Do not put boost, boolean, fielded, regex, fuzzy, or backend query syntax here.
- `path`: optional repo-relative file or directory prefix restricting search results and refresh scope. No glob semantics in V1. Must resolve inside repo root. Absolute paths and `..` escape attempts are rejected.
- `limit`: maximum results to return. Default 10. Hard max 50.
- `boosts`: optional ranking multipliers for plain lexical terms or short phrases. `weight > 1` ranks matching results higher, `0 < weight < 1` ranks matching results lower, and boosts do not filter results. Negative or zero weights are invalid. If V1 applies phrase controls or down-weighting after collecting a bounded candidate set, the response must warn.
- `excludeTerms`: optional plain lexical terms or short phrases to filter out clearly unwanted noise topics. Exclusion is a recall-control convenience, not proof of absence.

Keep parameters minimal. Consider `refresh?: "auto" | "force"` only if real usage shows agents need it. Default should remain automatic.

## Return shape

Return compact ranked results, not verbose internals.

Required fields per result:

- `path`
- `score`
- legacy `snippet` (compatibility summary)
- optional legacy `line`
- optional `snippets`: selected structured line windows with `lineStart`, `lineEnd`, `text`, optional enclosing `context`, and truncation metadata (`truncatedBefore`, `truncatedAfter`, legacy `truncated`)
- optional result-level `lineStart` / `lineEnd`
- optional `matchedFields` using `filename`, `path`, and `content`

Required envelope fields:

- `repoRoot`
- `indexFreshness`: `fresh`, `updated`, `stale`, `missing`, or `partial`
- indexed file count or compact status summary
- applied `boosts` / `excludeTerms` when present
- `results`
- `truncated`
- `warnings`

Human-readable rendering should look like:

```text
repo: /path/to/repo
index: updated, 2142 files, refreshed 3 changed files
query: "tool grep index tantivy"

results[5]:
1. packages/foo/src/search.ts score=12.4 fields=filename,content
   lines 41-55
   ... snippet ...

2. docs/specs/search/design.md score=10.8 fields=headings,content
   lines 8-19
   ... snippet ...

truncated: false
warnings: []
```

Do not include in normal output:

- Tantivy segment stats
- cache paths
- internal doc IDs
- per-term BM25 internals
- full manifest contents

Expose those through CLI diagnostics if needed.

## Error semantics

Errors should teach recovery.

- `NotGitRepoError`: ranked search requires a git repo. Use exact grep/bash or pass a path inside a repo.
- `ConfigError`: Source Search config is invalid. Report file path and line/field if possible.
- `QueryError`: query is invalid or too long. Simplify terms or remove unsupported syntax.
- `IndexUnavailableError`: index build/query failed. Exact grep remains available.
- `CorpusTooLargeWarning`: only a subset was indexed. Refine path/config or inspect CLI status.
- `LockBusyWarning`: existing index used; refresh skipped because another process is updating it.
- `CheckoutChangedError`: checkout `HEAD` changed and refresh could not complete safely. Use exact grep or run `source-search index --force`; configure separate worktrees for persistent dev/prod variants.
- `NoWorkspaceRegistry`: current directory is not a git checkout and no workspace registry exists. Configure child checkout paths with the Source Search skill.
- `VersionMismatchError`: Pi wrapper and sidecar protocol versions differ. Reinstall/rebuild package.
- `PermissionError`: cache or repo path cannot be read/written with current permissions.
- `DiskFullError`: index cannot be written because storage is exhausted.

Never return “no results” for an index failure. Empty results and failed retrieval must be distinguishable.

## Prompt/context presentation

The tool-coupled prompt fragment should be small:

```text
Use ranked_search as the default first-pass tool for broad ranked lexical discovery when Source Search startup discovery says the current repo or workspace supports it. It searches the current git checkout or configured workspace child checkouts and manages its Tantivy indexes automatically. It is not semantic search; try synonyms when terminology may differ. Use typed boosts when some terms should rank higher/lower and excludeTerms only for clearly unwanted noise topics; do not put boost, boolean, or field syntax in the query string. Use grep for exact strings/regex and read for known files. Configure dev/prod/worktree variants as separate checkout paths. If ranked_search reports config/index failure, use the source-search skill or source-search CLI for setup/debug.
```

Detailed configuration and troubleshooting live in the skill, not the always-loaded prompt.

## Sidecar protocol and implementation architecture

Recommended V1 architecture:

```text
Pi extension/tool
  -> TypeScript wrapper
      - tool schema/rendering
      - startup discovery and prompt injection
      - git/workspace scope detection
      - config resolution
      - sidecar invocation
      - timeout/cancellation mapping
  -> Rust sidecar binary
      - corpus enumeration
      - Tantivy schema/indexing/query
      - manifest/lock handling
      - JSON result output
```

Prefer a Rust sidecar over native Node bindings to avoid Node ABI/build complexity. The TypeScript wrapper stays thin.

Sidecar interface uses CLI subcommands with JSON output:

```bash
source-search query --repo /path --query "..." --limit 20 --json
source-search index --repo /path --force --json
source-search status --repo /path --json
source-search config validate --repo /path --json
```

Protocol requirements:

- Every JSON response includes `protocolVersion`.
- Wrapper refuses incompatible protocol versions with `VersionMismatchError`.
- Stdout is machine-readable JSON only when `--json` is set.
- Stderr is diagnostic text only and may be logged/truncated by wrapper.
- Exit code `0`: success.
- Exit code `1`: expected user/actionable error represented in JSON.
- Exit code `2`: config/query validation error.
- Exit code `3`: index unavailable/corrupt after recovery attempt.
- Exit code `4`: protocol/version mismatch.
- Exit code `>=10`: unexpected internal failure.
- Tool wrapper enforces timeout and forwards cancellation to the sidecar process.
- JSON response schemas for `query`, `status`, and `index` are versioned and tested.
- Sidecar binary discovery must be deterministic: packaged binary first, PATH fallback only in development.

## Future work

Potential post-V1 additions:

- Hybrid BM25 + exact ripgrep boosting.
- Tree-sitter-based symbol/chunk extraction.
- Multi-repo workspace index.
- Background watcher mode.
- Query result pagination/cursors.
- Better snippets/highlighting.
- Optional alternate backend only if needed.

Do not add semantic search, KG, graph DB, or code-intelligence workflows unless a later spec explicitly changes scope.
