---
name: source-search
description: Set up or debug Source Search ranked_search for a repo or Bravo workspace, including .bravo/source-search.json config, workspace registries, exclude/noise choices, CLI status/index/purge recovery, and when to use ranked_search versus grep/read.
---

# Source Search

Use this skill when setting up or debugging Source Search.

- `ranked_search` is broad lexical/BM25 repository discovery, not semantic search. Try synonyms, identifiers, filenames, and related terms.
- Prefer `ranked_search` first when the startup prompt says Source Search is available, then use `read` or `grep` for exact evidence.
- Basic single-checkout search does not require `.bravo/source-search.json` or a prebuilt index. Source Search may use a local Tantivy cache for speed, but falls back to live git-aware scanning when the cache is unavailable.
- Treat results as evidence packets: ranked path/score, matched fields (`filename`, `path`, `content`), and structured line-window snippets with optional enclosing context (`function`, `class`, `heading`, etc.). Snippets are chosen for match density/useful structure, but still inspect the source before citing conclusions.
- Use `boosts` for ranking influence only: weights above 1 prefer matching files, weights below 1 down-rank matching files, and boosts do not filter. If a phrase/down-weight warning says reranking used a bounded candidate set, broaden/adjust the query when recall matters.
- Use `excludeTerms` only for clearly unwanted noise topics. It filters results, but it is not proof of absence.
- Do not put boost, boolean, fielded, or Lucene/Tantivy syntax in `query`; pass plain terms plus typed `boosts`/`excludeTerms`.
- Use `grep` for exact strings/regex and `read` for known files.
- Do not parse `AGENTS.md` as Source Search configuration. Use `.bravo/source-search.json` only for curated workspace scope, excludes, file-size/performance tuning, and explicit ignored-path allowlists.

## Config

Repo or parent-workspace config path:

- `.bravo/source-search.json` for Bravo-owned Source Search config and workspace registries

Config is optional for basic repo search. Use it when you need stable parent-workspace repo names/defaults, curated excludes, max file-size tuning, or explicit allowlisting of ignored paths. Parent directories without config can search bounded immediate child git checkouts opportunistically, but config is preferred for durable workspace scope.

Example:

```json
{
  "enabled": true,
  "allowlist": [],
  "exclude": ["dist/**", "build/**", "generated/**"],
  "maxFileBytes": 1048576
}
```

Do not allowlist ignored paths without explicit user approval: ignored files often contain credentials, customer data, local agent state, or secrets.

## CLI recovery

Use the CLI only for setup/debug or after an actionable `ranked_search` failure:

```bash
source-search status --repo /path --json
source-search index --repo /path --force --json
source-search config validate --repo /path --json
source-search purge --repo /path --json
```

Common recovery:

- No searchable scope: run from a git checkout, a parent directory with immediate child git checkouts, or create explicit workspace config.
- `ConfigError`: validate JSON and remove unknown/unsafe keys.
- `IndexUnavailableError`: live fallback should keep basic search working; force rebuild or purge only when you need cache/index performance or diagnostics.
- Checkout changed/stale warnings: rerun the query; force an index rebuild only if the cache remains unhealthy.

For dev/prod/branch comparisons, configure separate worktree checkout paths rather than treating branches as separate repos in one mutable folder.
