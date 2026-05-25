# @bravo/source-search

Source Search adds a Pi `ranked_search` tool for broad lexical/BM25 discovery across a git checkout. A local Tantivy index is an optional fast cache; basic search works without repo config or an existing cache by falling back to live `git ls-files` scanning. Use typed `boosts`/`excludeTerms` for ranking noise control, and use `grep` and `read` to confirm exact evidence.

Results are compact evidence packets: ranked paths/scores, `matchedFields` using `filename`, `path`, and `content`, and structured snippet windows with `lineStart`/`lineEnd`, text, optional enclosing `context`, and before/after truncation flags. Snippet windows are selected by match density and lightweight structural cues rather than simply first occurrence. Legacy `snippet`/`line` fields remain for compatibility.

## Build

```bash
npm run build --workspace @bravo/source-search
```

This compiles TypeScript and the Rust `source-search-sidecar`.

## CLI

```bash
source-search query --repo /path/to/repo --query "terms" --limit 20 --json
source-search query --repo /path/to/repo --query "labor location" --boosts '[{"term":"labor","weight":2},{"term":"location","weight":0.5}]' --exclude-terms '["fixture"]' --json
source-search index --repo /path/to/repo --force --json
source-search status --repo /path/to/repo --json
source-search config validate --repo /path/to/repo --json
source-search purge --repo /path/to/repo --json
```

Indexes are stored under `~/.cache/pi-coding-agent/source-search` with owner-only permissions where supported. `query` refreshes the index incrementally when possible and falls back to live scanning if index creation/refresh is unavailable. `index --force` performs an explicit full rebuild. The corpus is based on `git ls-files -z -co --exclude-standard`, never indexes `.git/`, validates paths against the repo root, and applies conservative secret/noise denies plus repo-root `.agentignore`/`.piignore` deny globs.

## Configuration

Optional repo or parent-workspace config lives at `.bravo/source-search.json`. It is for curated workspace scope, additional excludes, max file size, and performance—not required for basic single-checkout search. Parent workspaces can use this file with a `workspace.repos` registry of concrete child checkouts; without config, immediate child git checkouts may be searched opportunistically with conservative caps.

```json
{
  "enabled": true,
  "allowlist": [],
  "exclude": ["dist/**", "build/**", "generated/**"],
  "maxFileBytes": 1048576
}
```

Ignored path allowlisting can index sensitive files. Only add ignored paths with user approval.

## Runtime lookup

The TypeScript wrapper looks for the sidecar in this order: `SOURCE_SEARCH_SIDECAR`, packaged `vendor/<platform-arch>`, local `sidecar/target/debug`, local `sidecar/target/release`, and PATH only when `SOURCE_SEARCH_DEV=1`.
