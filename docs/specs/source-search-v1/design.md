# Source Search v1 Design

Source Search v1 is a Pi package that exposes one agent-facing tool: `ranked_search`.

`ranked_search` performs live ranked lexical discovery across any searchable directory. It is folder-portable: it must work from any current directory, or from any explicit `path`, without setup or repo/workspace registration. Inside git checkouts it uses git-visible files; outside git it searches live filesystem files with conservative noise/secret excludes. It is not semantic search and does not replace exact `grep`/`read` evidence inspection.

## Tool surface

- Agent-facing Pi tools: `ranked_search` only.
- The extension registers the tool globally regardless of current working directory.
- The extension must not override bash, mutate `PATH`, or set `SOURCE_SEARCH_*` environment variables.
- The package ships no CLI binary and no source-search skill.
- No routine agent-facing index, cache, manifest, status, purge, or setup lifecycle exists.
- No workspace registry or configured repo list is active or required.

## Runtime model

Normal search is live-only TypeScript execution. It must not require or ship a Source Search CLI command or Rust sidecar binary.

Inside a git checkout, the searchable corpus is discovered with:

```bash
git ls-files -z -co --exclude-standard
```

Outside git, Source Search walks the requested/current directory live while skipping common noise and secret-bearing paths. The corpus additionally respects `.agentignore`, `.piignore`, and `.bravo/source-search.json` `exclude` patterns at the active search root. No ignored-path allowlist is part of v1 live search.

## Scope resolution

1. If the requested `path` exists inside a git checkout, search that checkout with `path` as the file/directory prefix.
2. Else, if the current directory exists inside a git checkout, search that checkout with the current directory as the prefix.
3. Else search the requested/current file or directory directly with live filesystem walking.
4. If a requested `path` does not exist, return a clear no-searchable-directory error. Do not broaden to a parent folder or repo.

`ranked_search` has no active workspace registry or configured-repo requirement. `.bravo/source-search.json` may provide local excludes, but it must not disable search or declare/constrain the set of searchable repos/directories. Legacy `enabled`, `workspace`, `repos`, and `defaultRepos` fields must not affect search scope.

## Query contract

Input parameters:

```ts
{
  query: string;
  path?: string;
  limit?: number; // 1..50, default 10
  boosts?: Array<{ term: string; weight: number }>;
  excludeTerms?: string[];
}
```

- `query` is plain lexical terms. Boolean, field, boost, and backend query syntax is rejected.
- `path` searches/restricts to that file or directory directly; no workspace/repo registry is required.
- `boosts` modify ranking only; they never filter.
- `excludeTerms` filter clearly unwanted noise and are not proof of absence.

## Response contract

Preserve the `QueryResponse` / `SearchHit` shape:

- `protocolVersion`
- `ok`
- `repoRoot` (legacy field name; contains the active search root/checkout)
- `query`
- `boosts`
- `excludeTerms`
- `hits`
- `count`
- `indexFreshness` is `live`
- `warnings`
- `error`

Each hit includes path, score, optional line/range fields, legacy `snippet`, structured `snippets`, and optional `matchedFields` using `filename`, `path`, and `content`.

## Prompting guidance

System/tool prompts should say:

- `ranked_search` is live ranked lexical source discovery, not semantic search.
- Use it as the default broad first pass when available.
- Confirm exact evidence with `read` or `grep`.
- Use typed `boosts` and `excludeTerms`; do not put query syntax in `query`.

Prompts must not direct agents to use index/cache/CLI/setup/debug workflows or repo/workspace setup. The always-loaded tool prompt and startup discovery prompt are the supported guidance surfaces; there is no separate source-search skill.
