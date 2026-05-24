# Source Search

Use this skill when setting up or debugging Source Search.

- `ranked_search` is broad lexical/BM25 repository discovery, not semantic search. Try synonyms, identifiers, filenames, and related terms.
- Prefer `ranked_search` first when the startup prompt says Source Search is available, then use `read` or `grep` for exact evidence.
- Use `grep` for exact strings/regex and `read` for known files.
- Do not parse `AGENTS.md` as Source Search configuration. Use explicit `.bravo/source-search.json` config.

## Config

Repo or parent-workspace config path:

- `.bravo/source-search.json` for Bravo-owned Source Search config and workspace registries

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

- `NoWorkspaceRegistry`: run from a git checkout or create explicit workspace config.
- `ConfigError`: validate JSON and remove unknown/unsafe keys.
- `IndexUnavailableError`: force rebuild; purge if corruption persists.
- Checkout changed/stale warnings: rerun the query or force an index rebuild.

For dev/prod/branch comparisons, configure separate worktree checkout paths rather than treating branches as separate repos in one mutable folder.
