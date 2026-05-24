# Web Evidence Cache

`@bravo/web-evidence-cache` is a personal Pi extension package that gives agents a small web evidence workflow:

- `web_search` discovers candidate pages on the live web through Brave Search. It returns discovery leads only; titles and sanitized snippets are not evidence. Each lead includes an alias and UUID id for navigation.
- `web_fetch` materializes selected URLs or search result refs (aliases or UUID ids from `web_search`) into temporary local artifacts that agents can read, cite, and search.
- `web_lookup` searches only fetched local artifacts with SQLite FTS5/BM25; it is not live web search.

The package intentionally does not crawl or index the public web. Search snippets are sanitized leads, not evidence, and `web_search` does not auto-fetch results. The next workflow step after discovery is normally to call `web_fetch` with only selected aliases/UUID ids or URLs in `refs`; `format` and `refresh` are optional advanced knobs that default to `auto`. Fetched artifact paths are the evidence surface; agents should read those paths with normal filesystem tools.

## Setup

Install or load this package through Pi's package/extension mechanism. For local development, the package exposes a helper that loads the extension and suppresses Node's current `node:sqlite` experimental warning:

```bash
npm run pi --workspace @bravo/web-evidence-cache -- [pi args...]
```

The helper runs:

```bash
pi -e packages/web-evidence-cache/extensions/pi/index.ts
```

with:

```bash
NODE_OPTIONS="$NODE_OPTIONS --disable-warning=ExperimentalWarning"
```

Brave Search requires one of:

```bash
export BRAVE_SEARCH_API_KEY=...
export BRAVE_API_KEY=... # accepted fallback
```

For local smoke tests, export one of those environment variables before starting Pi. This package does not read keys from `~/.keys`; do not commit keys, print keys, or put keys in fixtures.

## Runtime Behavior

Fetched pages are stored under OS temp storage:

```text
${os.tmpdir()}/pi-web-cache/<workspace-hash>/<session-id>/
  web.sqlite
  pages/<page-id>/
    page.semantic.html
    page.md
    page.txt
    metadata.json
    chunks.json
```

There is no prune command. Temp cleanup is owned by the OS. The extension should not make agents manage this cache manually.

Tool responses visually prioritize `READ NEXT`/`best_path`; read that artifact first before citing. Full semantic HTML, Markdown, text, metadata, and chunks paths remain in structured result details for alternate views. Orientation previews and lookup snippets are navigation aids only, not citable evidence. Partial or weak extraction warnings should be checked eagerly against the artifact and, when needed, corroborated by fetching another source.

Lookup defaults to text paths because current line hints are text-derived; semantic HTML and Markdown lookup results suppress text line hints. `web_lookup` also accepts `match_mode`: `any` (default, match at least one query term), `all` (require every query term/quoted phrase), or `phrase` (search the full query as one phrase). Use `all` or `phrase` when common terms make default recall too noisy. If lookup returns no matches, broaden/synonymize the query, remove domain filters, fetch additional likely sources, or run web_search; no matches are not proof of absence.

## Commands

```bash
npm run check --workspace @bravo/web-evidence-cache
npm test --workspace @bravo/web-evidence-cache
```

The test command builds the package and runs Node tests with `--disable-warning=ExperimentalWarning` so the expected `node:sqlite` warning does not make routine package validation noisy.

## Design References

- Package maintenance notes: `docs/maintenance.md`
- Durable spec: `../../docs/specs/pi-web-evidence-cache/spec.md`
- Implementation plan: `../../docs/specs/pi-web-evidence-cache/implementation-plan.md`

