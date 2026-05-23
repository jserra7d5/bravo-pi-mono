# Web Evidence Cache

`@bravo/web-evidence-cache` is a personal Pi extension package that gives agents a small web evidence workflow:

- `web_search` discovers candidate pages on the live web through Brave Search. It returns discovery leads only; titles and snippets are not evidence.
- `web_fetch` materializes selected URLs or search result refs into temporary local artifacts that agents can read, cite, and search.
- `web_lookup` searches only fetched local artifacts with SQLite FTS5/BM25; it is not live web search.

The package intentionally does not crawl or index the public web. Search snippets are leads, not evidence, and `web_search` does not auto-fetch results. Fetched artifact paths are the evidence surface; agents should read those paths with normal filesystem tools.

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

The canonical readable artifact is `page.semantic.html`. Markdown and text are derived views. Lookup defaults to text paths because current line hints are text-derived; semantic HTML and Markdown lookup results suppress text line hints.

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

