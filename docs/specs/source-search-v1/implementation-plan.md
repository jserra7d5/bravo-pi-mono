# Source Search v1 Implementation Notes

This note supersedes the original index/sidecar implementation plan. Source Search v1 is now live-only and folder-portable.

## Current implementation shape

- Package: `packages/source-search`
- Pi tool: `ranked_search`
- Runtime: TypeScript-only live search
- No CLI binary, Rust sidecar, index/cache lifecycle, setup command, manifest, purge/status command, or source-search skill
- No workspace registry or configured repo list

## Folder-portable search contract

`ranked_search` must be usable from any directory without setup.

Resolution rules:

1. If `path` is provided and it exists inside a git checkout, search that checkout with `path` as the file/directory prefix.
2. Else, if the current directory exists inside a git checkout, search that checkout with the current directory as the prefix.
3. Else, search the requested/current file or directory directly with live filesystem walking.
4. If a requested `path` does not exist, fail with a clear no-searchable-directory error. Do not broaden to a parent folder or repo.

Git mode uses:

```bash
git ls-files -z -co --exclude-standard
```

Non-git mode walks the live filesystem under the requested/current root.

## Local policy files

At the active search root, Source Search may read:

- `.agentignore`
- `.piignore`
- `.bravo/source-search.json`

`.bravo/source-search.json` may contain only local search policy such as:

```json
{
  "exclude": ["dist/**", "coverage/**"]
}
```

It must not disable search and must not declare or constrain searchable repos/directories. Ignore any legacy `enabled`, `workspace`, `repos`, or `defaultRepos` fields for search scope.

## Safety filters

Live search skips common generated/noisy or secret-bearing paths, including `.git`, `.env*`, private key files, token/credential/secret-looking paths, `node_modules`, `dist`, `build`, and `target`.

These are safety/noise filters, not repo/workspace scoping.

## Validation

Run:

```bash
npm run check --workspace @bravo/source-search
npm test --workspace @bravo/source-search
```

Contract tests should cover:

- live git search without source-search config
- non-git directory search
- arbitrary child checkout search via `path` without workspace config
- `.bravo/source-search.json` excludes
- legacy `enabled:false` not disabling search
- missing requested path not broadening to parent checkout
- query syntax/boost validation
- structured snippets and rendering
