# Web Evidence Cache Maintenance

This package is personal tooling. Optimize for a small, inspectable implementation over broad compatibility layers.

## Contracts

The agent-facing tool surface is intentionally small:

- `web_search`: live web discovery only.
- `web_fetch`: turn URLs or search result refs into local temp artifacts and index them.
- `web_lookup`: BM25 lookup over fetched local artifacts only.

Do not add provider-specific tools such as `brave_search`. Hide provider choice, query fanout, BM25 weights, chunk sizes, temp paths, redirect limits, and SQLite schema details behind implementation policy.

Every tool should return compact `content` plus structured `details`. Artifacts must remain readable through normal filesystem tools; do not add a custom web-read abstraction unless the filesystem contract stops working.

## Source Map

- `extensions/pi/index.ts`: Pi tool registration, schemas, prompt guidance, execute paths.
- `extensions/pi/renderers.ts`: width-aware TUI cards.
- `src/brave.ts`: Brave Search request/response adapter.
- `src/fetch.ts`: bounded fetch, redirects, extraction, artifact writes, indexing.
- `src/safety.ts`: URL canonicalization and SSRF target checks.
- `src/extract.ts`: Defuddle and Readability extraction.
- `src/html.ts`: semantic HTML sanitizer/normalizer.
- `src/chunking.ts`: structure-aware chunking and text line hints.
- `src/sqlite.ts`: temp SQLite schema, FTS5 probe, inserts, lookup.
- `src/cache.ts`: session/workspace temp cache registry.
- `src/signals.ts`: timeout/user abort signal composition.

## Safety Rules

Fetched web content is untrusted.

Keep these invariants:

- Allow only HTTP(S) fetch targets.
- Reject embedded URL credentials.
- Reject localhost, private IP ranges, link-local, multicast, and cloud metadata targets.
- Re-check every redirect target before fetching it.
- Enforce timeout, redirect, content type, and response byte limits.
- Do not send browser cookies or user credentials.
- Strip scripts, styles, iframes, noscript, comments, hidden elements, framework hydration payloads, event handlers, classes, styles, and original `data-*` attributes from semantic HTML.
- Preserve `href` and `src` only when they resolve to `http:` or `https:`.

SSRF protection validates DNS before `undici.fetch`; that is acceptable for this personal MVP, but it is not a complete defense against DNS rebinding. If this ever moves beyond personal tooling, revisit socket-level address pinning or an audited fetch layer.

## SQLite And Node

The package uses `node:sqlite` with SQLite FTS5. It requires Node `>=22.13`, and current Node 22 builds still mark `node:sqlite` as experimental. This is acceptable for this repo's personal tooling.

Routine scripts suppress the warning with Node's targeted flag:

```bash
--disable-warning=ExperimentalWarning
```

The package-local Pi helper appends the same flag to `NODE_OPTIONS` before launching Pi. Do not switch to `better-sqlite3` only to hide the warning; that adds native dependency friction. Reconsider only if `node:sqlite` API churn breaks the package or this becomes distributable production tooling.

## Search Provider

Brave Search is the only MVP provider. The adapter reads credentials in this order:

1. `BRAVE_SEARCH_API_KEY`
2. `BRAVE_API_KEY`

Tests must mock provider behavior or use local fixtures. Live smoke tests may use `~/.keys/BRAVE_API_KEY`, but must never print or commit the key.

## Lookup Behavior

SQLite FTS5 parses punctuation as query syntax. `normalizeFtsQuery()` must quote normalized terms so identifiers such as `node:sqlite`, `Type.Name`, `foo/bar`, and `hyphenated-token` do not crash lookup.

Domain filtering must match URL hostnames or subdomains only. Do not regress to substring matching against the whole URL.

Do not expose raw BM25 scores through public results. Return ranked hits, snippets, matched terms, paths, and location hints.

## Testing Checklist

Before committing package changes:

```bash
npm run check --workspace @bravo/web-evidence-cache
npm test --workspace @bravo/web-evidence-cache
```

For changes touching Brave, fetch, extraction, or artifacts, also run a live smoke manually with the local key without printing it:

```bash
export BRAVE_API_KEY="$(cat ~/.keys/BRAVE_API_KEY)"
export BRAVE_SEARCH_API_KEY="$BRAVE_API_KEY"
```

Then exercise:

- `web_search` returns result cards with title, HTTP(S) URL, and provider.
- `web_fetch` creates positive-size semantic HTML, Markdown, text, metadata, and chunks artifacts.
- fresh fetch returns `indexed: true`.
- `web_lookup` finds a normal term and a punctuation-heavy term without FTS syntax errors.

High-value regression tests should cover:

- unsafe `href`/`src` schemes are stripped.
- private/local/metadata targets and redirects are blocked.
- response byte and content type limits are enforced.
- punctuation-heavy lookup terms do not crash.
- domain filter cannot be fooled by path/query substrings.
- line hints match the returned path format.
- all tools use `renderShell: "self"` and include concise prompt guidance.

## TUI Rules

Renderers must follow the repo's Pi TUI conventions:

- return Components, not precomputed full-terminal strings.
- use `renderShell: "self"` on every tool.
- use width passed by Pi; never use `process.stdout.columns`.
- measure/truncate ANSI-aware text.
- keep paths visible but middle-truncated.
- do not render raw debug metadata.

