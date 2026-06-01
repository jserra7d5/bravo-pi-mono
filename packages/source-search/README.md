# @bravo/source-search

Source Search adds one Pi tool: `ranked_search`. It performs live ranked lexical discovery across any searchable directory. Inside git checkouts it uses git-visible files; outside git it walks the live filesystem with conservative noise/secret excludes. It is tool-call-only: no CLI, prebuilt binary, local index, cache, or setup command is required.

Results are compact evidence packets: ranked paths/scores, `matchedFields` (`filename`, `path`, `content`), and structured snippet windows with line ranges, text, optional context, and truncation flags. Use `grep` and `read` to confirm exact evidence.

## Build and test

```bash
npm run build --workspace @bravo/source-search
npm test --workspace @bravo/source-search
```

## Search behavior

Inside git, the live corpus comes from:

```bash
git ls-files -z -co --exclude-standard
```

Outside git, Source Search walks the requested/current directory directly while skipping common noise and secret-bearing paths. Source Search also respects repo-root `.agentignore`, `.piignore`, and `.bravo/source-search.json` `exclude` patterns. The optional `path` parameter restricts search to a file or directory.

Use plain query terms only. Do not put boolean, field, boost, or backend syntax in the query string. Use typed `boosts` for ranking preferences and `excludeTerms` for clearly unwanted noise.

The package intentionally ships no source-search skill. The tool schema, prompt snippet, startup discovery prompt, and this README are the supported agent guidance surfaces.
