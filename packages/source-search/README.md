# @bravo/source-search

Source Search adds one Pi tool: `ranked_search`.

`ranked_search` performs live ranked lexical discovery across any searchable folder. It is intentionally folder-portable: it should work from any current directory, or from any explicit `path`, without setup or repo/workspace registration.

It is tool-call-only. The package ships no CLI binary, Rust sidecar, prebuilt index, cache, status/purge lifecycle, setup command, or source-search skill.

## Tool contract

Input shape:

```ts
{
  query: string;
  path?: string;
  limit?: number; // 1..10, default 3
  boosts?: Array<{ term: string; weight: number }>;
  excludeTerms?: string[];
}
```

- `query` is plain lexical text. Do not use boolean, field, boost, regex, or backend query syntax.
- `path` searches/restricts to that file or directory directly. It does not need to be declared in any config.
- `boosts` change ranking only; they never filter.
- `excludeTerms` filter noisy terms and are not proof of absence.
- Start with the default 3 results. Narrow `path` or `query` before increasing `limit`; all callers are capped at 10.

Results are compact evidence packets: ranked paths/scores, `matchedFields` (`filename`, `path`, `content`), and structured snippet windows with line ranges, text, optional context, and truncation flags. Use `grep` and `read` to confirm exact evidence. Agent-visible text omits truncation labels and is capped at 8,000 Unicode code points by retaining the highest-ranked complete hit blocks where possible and reporting omitted lower-ranked results. Structured response details retain all snippet truncation metadata.

## Search behavior

Inside git, the live corpus comes from:

```bash
git ls-files -z -co --exclude-standard
```

Scoped searches use the same git-visible corpus with a pathspec:

```bash
git ls-files -z -co --exclude-standard -- <pathPrefix>
```

If `path` or the current directory is inside a git checkout, Source Search searches that checkout with the requested/current path as a prefix. It includes tracked and untracked git-visible files while excluding standard ignored files via `git ls-files -co --exclude-standard`.

Outside git, Source Search walks the requested/current directory directly with bounded iterative traversal while skipping common noise and secret-bearing paths before reading file content.

Requested paths must exist. A missing `path` returns a clear no-searchable-directory error; it must not broaden to a parent folder or repo.

## Diagnostics and degraded responses

Search is live and bounded. Long or difficult searches may return partial results with compact warning codes in `warnings` and in rendered tool text, for example `candidate_budget_exceeded`, `file_read_budget_exceeded`, `byte_read_budget_exceeded`, `git_timeout`, `git_error`, `large_or_binary_files_skipped`, `read_errors_omitted`, or `search_aborted`.

A response with `ok: true` and warnings can still contain useful ranked evidence, but it is degraded. In particular, no matches plus warnings is not proof of absence; broaden the search or confirm with `grep`/`read` where needed.

## Configuration policy

No repo/workspace configuration is required or honored for scope.

At the active search root, Source Search may read:

- `.agentignore`
- `.piignore`
- `.bravo/source-search.json`

`.bravo/source-search.json` may provide local excludes only:

```json
{
  "exclude": ["dist/**", "coverage/**"]
}
```

It cannot disable search and cannot declare/constrain searchable repos or directories. Legacy `enabled`, `workspace`, `repos`, and `defaultRepos` fields must not affect search scope.

## Build and test

```bash
npm run build --workspace @bravo/source-search
npm run check --workspace @bravo/source-search
npm test --workspace @bravo/source-search
```

The tool schema, prompt snippet, startup discovery prompt, this README, and `docs/specs/source-search-v1/design.md` are the supported agent guidance surfaces.
