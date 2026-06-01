# Source Search v1 Design

Source Search v1 is a Pi package that exposes one agent-facing tool: `ranked_search`.

`ranked_search` performs live ranked lexical discovery across any searchable directory. Inside git checkouts it uses git-visible files; outside git it searches live filesystem files with conservative noise/secret excludes. It is not semantic search and does not replace exact `grep`/`read` evidence inspection.

## Tool surface

- Agent-facing Pi tools: `ranked_search` only.
- The extension registers the tool globally regardless of current working directory.
- The extension must not override bash, mutate `PATH`, or set `SOURCE_SEARCH_*` environment variables.
- The package ships no CLI binary and no source-search skill.
- No routine agent-facing index, cache, manifest, status, purge, or setup lifecycle exists.

## Runtime model

Normal search is live-only TypeScript execution. It must not require or ship a Source Search CLI command or Rust sidecar binary.

Inside a git checkout, the searchable corpus is discovered with:

```bash
git ls-files -z -co --exclude-standard
```

Outside git, Source Search walks the requested/current directory live while skipping common noise and secret-bearing paths. The corpus additionally respects repo-root `.agentignore`, `.piignore`, and `.bravo/source-search.json` `exclude` patterns. No ignored-path allowlist is part of v1 live search.

## Scope resolution

1. If the current directory or requested `path` is inside a git checkout, search that checkout.
2. Else, if `.bravo/source-search.json` defines `workspace.repos`, search configured default repos, or the configured repo containing the requested `path`.
3. Else, with no requested `path`, opportunistically search immediate child git checkouts from the current directory.
4. Else search the requested/current directory directly with live filesystem walking.

Configured workspace repo entries are concrete checkout paths with stable names. Separate dev/prod/branch comparisons should use separate clone/worktree paths.

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
- `path` restricts to a file or directory inside the selected checkout.
- `boosts` modify ranking only; they never filter.
- `excludeTerms` filter clearly unwanted noise and are not proof of absence.

## Response contract

Preserve the `QueryResponse` / `SearchHit` shape:

- `protocolVersion`
- `ok`
- `repoRoot`
- `query`
- `boosts`
- `excludeTerms`
- `hits`
- `count`
- `indexFreshness` may be `live` or a workspace aggregate such as `partial`
- `warnings`
- `error`

Each hit includes path, score, optional line/range fields, legacy `snippet`, structured `snippets`, and optional `matchedFields` using `filename`, `path`, and `content`.

## Prompting guidance

System/tool prompts should say:

- `ranked_search` is live ranked lexical repo discovery, not semantic search.
- Use it as the default broad first pass when available.
- Confirm exact evidence with `read` or `grep`.
- Use typed `boosts` and `excludeTerms`; do not put query syntax in `query`.

Prompts must not direct agents to use index/cache/CLI/setup/debug workflows. The always-loaded tool prompt and startup discovery prompt are the supported guidance surfaces; there is no separate source-search skill.
