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
  limit?: number; // 1..50, default 10
  boosts?: Array<{ term: string; weight: number }>;
  excludeTerms?: string[];
}
```

- `query` is plain lexical text. Do not use boolean, field, boost, regex, or backend query syntax.
- `path` searches/restricts to that file or directory directly. It does not need to be declared in any config.
- `boosts` change ranking only; they never filter.
- `excludeTerms` filter noisy terms and are not proof of absence.

Results are compact evidence packets: ranked paths/scores, `matchedFields` (`filename`, `path`, `content`), and structured snippet windows with line ranges, text, optional context, and truncation flags. Use `grep` and `read` to confirm exact evidence.

## Search behavior

Inside git, the live corpus comes from:

```bash
git ls-files -z -co --exclude-standard
```

If `path` or the current directory is inside a git checkout, Source Search searches that checkout with the requested/current path as a prefix. It includes tracked and untracked git-visible files while excluding standard ignored files via `git ls-files -co --exclude-standard`.

Outside git, Source Search walks the requested/current directory directly while skipping common noise and secret-bearing paths.

Requested paths must exist. A missing `path` returns a clear no-searchable-directory error; it must not broaden to a parent folder or repo.

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
