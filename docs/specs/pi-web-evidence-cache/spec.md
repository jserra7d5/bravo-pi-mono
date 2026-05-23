# Pi Web Evidence Cache

## Purpose

Build Pi web tooling that lets agents discover live web pages, materialize selected pages into temporary local evidence artifacts, and search those fetched artifacts with local full-text search.

This is not a crawler, not a permanent web index, and not a replacement for existing filesystem tools. The core contract is:

- `web_search` finds candidate pages on the live web.
- `web_fetch` turns selected results or URLs into local temp files and indexes them.
- `web_lookup` searches only fetched local evidence and returns file paths plus location hints.
- Agents read local artifacts using normal filesystem tools.

## Goals

- Give agents high-quality web discovery without exposing provider-specific APIs.
- Make fetched pages readable as local artifacts, not opaque tool blobs.
- Preserve more document structure than plain text or naive Markdown.
- Support exact-term lookup across fetched sources with BM25.
- Keep all cache/artifact state temporary and unmanaged by users or agents.
- Keep the native tool surface small and easy for agents to choose correctly.

## Non-Goals

- Do not index the public web.
- Do not provide persistent web cache management.
- Do not expose provider-specific tools such as `brave_search` or `exa_search`.
- Do not require agents to manually index or prune fetched pages.
- Do not hide local files behind a custom read abstraction when filesystem tools can read them.
- Do not feed raw web HTML to agents by default.

## Tool Surface

The MVP exposes three native Pi tools.

### `web_search`

External discovery. Use when the agent needs candidate pages from the live web.

Avoid when the agent wants to search inside already fetched evidence; use `web_lookup`.

Parameters:

```ts
type WebSearchInput = {
  query: string;
  limit?: number;
  fetch_top?: number;
  search_mode?: "auto" | "exact" | "broad";
  domains?: string[];
  exclude_domains?: string[];
  recency?: string | null;
};
```

Behavior:

- Calls the configured external search provider.
- Returns ranked result cards with UUIDs and short aliases.
- If `fetch_top` is set, fetches and indexes the top N results as a convenience workflow.
- Does not treat search snippets as cited evidence. Snippets are leads until fetched.

Return shape:

```ts
// Pi AgentToolResult.details payload. The tool `content` should be a compact
// human/model-readable summary of these same results.
type WebSearchResult = {
  results: Array<{
    id: string;       // UUID4, canonical within the session
    alias: string;    // r1, r2, ...
    title: string;
    url: string;
    snippet?: string;
    provider: string;
    fetched?: boolean;
    page_id?: string;
    artifact_dir?: string;
  }>;
  count: number;
  truncated: boolean;
  next_cursor?: string | null;
};
```

### `web_fetch`

Materializes web evidence locally. Use when the agent has URLs or `web_search` result IDs worth reading or searching.

Parameters:

```ts
type WebFetchInput = {
  refs: string[]; // accepts result UUIDs, aliases, or URLs
  format?: "auto" | "semantic_html" | "markdown" | "text"; // preferred path/preview view
  refresh?: "auto" | "force";
};
```

Behavior:

- Resolves `refs` to URLs.
- Fetches each URL.
- Extracts the meaningful document content.
- Writes temporary local artifacts.
- Chunks the content by document structure.
- Indexes chunk text in SQLite FTS5.
- Returns artifact paths and a compact preview.
- Always writes semantic HTML, Markdown, and text artifacts. `format` only chooses the preferred returned `path`/preview emphasis; it does not suppress other artifacts.
- `refresh: "auto"` reuses an existing fetched artifact for the same canonical/final URL without a network request. `refresh: "force"` fetches again and updates content hashes after fetch.

Return shape:

```ts
// Pi AgentToolResult.details payload. The tool `content` should summarize the
// fetched pages and prominently include artifact paths.
type WebFetchResult = {
  results: Array<{
    id: string; // page UUID
    alias: string; // p1, p2, ...
    source_result_id?: string;
    title: string;
    url: string;
    final_url?: string;
    artifact_dir: string;
    semantic_html_path: string;
    markdown_path: string;
    text_path: string;
    metadata_path: string;
    chunks_path: string;
    indexed: boolean;
    preview: string;
    extraction: {
      engine: string;
      confidence: "good" | "partial" | "weak";
      warnings: string[];
    };
  }>;
  count: number;
  truncated: false;
};
```

### `web_lookup`

BM25 lookup over fetched evidence only. Use when the agent wants to find exact terms, identifiers, API names, error strings, or phrases inside pages already fetched in the current temporary evidence workspace.

Avoid when the agent needs new web discovery; use `web_search`.

Parameters:

```ts
type WebLookupInput = {
  query: string;
  limit?: number;
  domain?: string | null;
  format?: "auto" | "semantic_html" | "markdown" | "text"; // preferred returned path
};
```

Behavior:

- Searches the local SQLite FTS5 index.
- Returns ranked passage hits with artifact paths and line/chunk hints.
- Does not read large content into context. The agent should open the returned paths with filesystem tools.
- `format` selects the preferred `path` returned for each hit and renderer emphasis. All artifact paths remain present.

Return shape:

```ts
// Pi AgentToolResult.details payload. The tool `content` should be a compact
// lookup summary, not the full matched documents.
type WebLookupResult = {
  results: Array<{
    page_id: string;
    page_alias: string;
    title: string;
    url: string;
    path: string;
    semantic_html_path: string;
    markdown_path: string;
    text_path: string;
    line_start?: number;
    line_end?: number;
    chunk_id: string;
    heading_path?: string;
    snippet: string;
    matched_terms: string[];
  }>;
  count: number;
  truncated: boolean;
  next_cursor?: string | null;
};
```

## Hidden Implementation Policy

The agent should not choose or tune these values per call in the MVP:

- search provider
- provider fallback order
- Brave operator translation
- Brave Goggles generation
- query fanout strategy
- extractor engine selection
- chunk size
- BM25 field weights
- RRF constants
- temp directory layout
- SSRF policy
- redirect limits
- byte limits
- dedupe rules
- SQLite schema details

These belong in implementation config or internal policy. The agent expresses intent through `query`, `refs`, `domains`, `exclude_domains`, `search_mode`, `fetch_top`, and `format`.

## Search Provider

Default provider: Brave Search API.

Reasons:

- It is a straightforward external discovery API.
- It returns ordinary result cards rather than synthesized answers.
- It supports common query operators such as exact phrases, negative terms, `site:`, `intitle:`, `inbody:`, and file type filters.
- Brave Goggles can provide source/domain boosting and downranking when needed.
- It fits the architecture: the provider discovers candidates; local fetch and indexing provide the evidence layer.

Provider selection should be configured globally, not exposed as a routine tool parameter. MVP configuration is environment-only:

```bash
BRAVE_SEARCH_API_KEY=...
BRAVE_API_KEY=... # accepted fallback name
```

A future package config file can use this shape:

```json
{
  "search_provider": "brave",
  "brave_api_key": "...",
  "fallback_provider": null
}
```

Future providers can include Exa, Tavily, Serper, Kagi, or custom wrappers behind the same `web_search` contract.

## Query Intent

The first version should keep query shaping simple:

- `search_mode: "auto"` for normal discovery.
- `search_mode: "exact"` for identifiers, errors, symbols, quoted phrases, and API names.
- `search_mode: "broad"` for exploratory discovery.
- `domains` and `exclude_domains` for source constraints.
- Negative terms can be expressed in the query string where the provider supports them, e.g. `sqlite fts5 -elasticsearch`.

Do not expose a weighted query DSL in the MVP.

A later version may support structured intent:

```ts
type WeightedQueryIntent = {
  must?: string[];
  should?: Array<{ term: string; weight: number }>;
  must_not?: string[];
  boost_domains?: Record<string, number>;
  downrank_domains?: Record<string, number>;
};
```

If added, this should compile to provider-specific operators, source boosts, query fanout, and local reranking. It should not leak provider syntax into the agent-facing contract.

## Fetch And Extraction Pipeline

Default flow:

1. Validate URL and enforce network safety policy.
2. Fetch with native HTTP client.
3. Parse DOM.
4. Extract main content.
5. Normalize into simplified semantic HTML.
6. Derive Markdown and plain text.
7. Chunk by semantic document structure.
8. Write artifacts to temp storage.
9. Index chunks in SQLite FTS5.
10. Return paths, preview, and extraction confidence.

Preferred local extraction engine: Defuddle, if it works cleanly in the Node/Pi extension environment.

Fallback: Mozilla Readability plus custom semantic cleanup.

Browser rendering via Playwright can be added later as an explicit fallback for JS-heavy pages. It should not be the default fetch path.

## Semantic HTML Artifact

The canonical local representation is simplified semantic HTML. Markdown and text are derived views.

Preserve meaningful tags:

```text
article, main, section, header, footer
h1-h6
p
ul, ol, li
blockquote
pre, code
table, thead, tbody, tr, th, td
dl, dt, dd
figure, figcaption
a
img
time
strong, em
```

Preserve only structure-bearing attributes:

```text
href
src
alt
title
datetime
id
aria-label
scope
headers
colspan
rowspan
data-source-id   // generated by this tool
data-chunk-id    // generated by this tool
```

Remove by default:

```text
script
style
noscript
iframe
class
inline style
event handlers
original data-* attributes
hidden elements
tracking wrappers
ads
navigation chrome
duplicated sidebars
comments
framework hydration payloads
```

Example:

```html
<article data-source-id="web_42">
  <header>
    <h1>SQLite FTS5 Extension</h1>
    <p><a href="https://www.sqlite.org/fts5.html">Source</a></p>
  </header>

  <section id="bm25-function" data-chunk-id="chunk_7">
    <h2>The BM25 function</h2>
    <p>FTS5 provides a built-in auxiliary function named <code>bm25</code>.</p>
    <pre><code>SELECT * FROM email WHERE email MATCH ? ORDER BY bm25(email);</code></pre>
  </section>
</article>
```

## Temporary Storage

Artifacts live in OS temp storage. Users and agents should not manually prune them.

Suggested layout:

```text
${os.tmpdir()}/pi-web-cache/<workspace-hash>/<session-id>/
  web.sqlite
  pages/
    <page-uuid>/
      page.semantic.html
      page.md
      page.txt
      metadata.json
      chunks.json
      source.html        # optional debug/archive only
```

The OS may clear this on reboot. The extension may clean up session temp directories on Pi session shutdown if that is reliable, but cleanup should not be exposed as an agent responsibility.

## Local Full-Text Search

Use SQLite FTS5 for the local fetched corpus.

Reasons:

- Embedded local database.
- No daemon.
- BM25 scoring.
- Snippets and highlighting.
- SQL metadata joins.
- Works naturally with temporary artifact storage.

Conceptual schema:

```sql
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  fetched_at TEXT NOT NULL,
  content_hash TEXT,
  extractor TEXT,
  status TEXT,
  metadata_json TEXT
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  ordinal INTEGER NOT NULL,
  heading_path TEXT,
  semantic_html_path TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  text_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  text TEXT NOT NULL,
  token_count INTEGER
);

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  chunk_id UNINDEXED,
  page_id UNINDEXED,
  title,
  url,
  heading_path,
  text
);
```

The MVP should use a direct/contentless FTS table with duplicated searchable fields rather than an external-content FTS table whose columns do not exist on `chunks`. Actual schema can differ, but the contract should remain: fetched pages produce searchable chunks, and lookup returns local paths plus location hints.

## Ranking

`web_lookup` ranks local chunks with BM25. It should favor exact identifiers, symbols, API names, quoted phrases, error strings, and rare terms.

Do not expose raw BM25 scores in normal agent output. Scores are corpus-relative and can mislead agents. Return rank order, snippets, matched terms, and paths.

Future hybrid ranking may combine:

- external search rank
- local BM25 rank
- source/domain quality boosts
- freshness boosts
- optional vector rank

Use rank fusion rather than raw score arithmetic if hybrid ranking is added.

## Result Identity

Use UUID4 as canonical IDs:

- Search result IDs identify external result cards.
- Page IDs identify fetched local artifacts.
- Chunk IDs identify indexed sections/passages.

Also expose short aliases for ergonomic in-session use:

- `r1`, `r2`, ... for search results.
- `p1`, `p2`, ... for fetched pages.

Tools accepting refs should accept UUIDs, aliases, and URLs where appropriate.

## Error Semantics

Errors should teach recovery. In Pi, true tool failures should be thrown from `execute`, not encoded as successful tool results. The structured shape below is the internal/error-rendering payload carried by custom error classes where practical:

```ts
type WebToolError = {
  error_type: "ContextError" | "AdapterError" | "ToolExecutionError";
  message: string;
  suggested_action: string;
};
```

Examples:

- Missing Brave API key: `ContextError`; surface configuration gap.
- Brave request timeout: `AdapterError`; retry or fall back if configured.
- Invalid URL: `ToolExecutionError`; correct input and retry.
- Private network target blocked: `ToolExecutionError`; do not bypass without explicit user direction.
- Extraction weak: not necessarily an error; return `confidence: "weak"` with warnings and artifact paths if any content was recovered.

## Security And Safety

Default safety rules:

- Allow only HTTP(S) URLs.
- Block private IPs, localhost, link-local addresses, and metadata service addresses.
- Re-check resolved target after redirects.
- Limit redirects.
- Limit response bytes.
- Limit fetch timeout.
- Do not send credentials or browser cookies by default.
- Treat all fetched content as untrusted prompt-injection-bearing input.
- Never execute scripts from fetched pages.
- Sanitize semantic HTML before exposing it to agents or UI renderers.

## Agent Guidance

The extension should ship a concise prompt fragment:

```text
Use web_search for live web discovery.
Use web_fetch to materialize promising results or URLs as local temp artifacts.
Use web_fetch knowing fetched pages become searchable automatically.
Use web_lookup to search within fetched artifacts.
Use normal filesystem tools to read artifact paths returned by web_fetch and web_lookup.
Use web_search snippets as leads, not evidence; cite fetched/read local artifacts or source URLs.
Use web_search and web_fetch to prefer primary sources and official documentation when available.
```

## TUI Presentation

Tool renderers should use one consistent evidence-card style across search, fetch, and lookup.

Search card:

```text
[r1] SQLite FTS5 Extension
https://www.sqlite.org/fts5.html
provider: brave
snippet: ...
```

Fetch card:

```text
[p1] SQLite FTS5 Extension
semantic: /tmp/.../page.semantic.html
markdown: /tmp/.../page.md
indexed: yes
extraction: readability/good
```

Lookup card:

```text
[p1:chunk_7] SQLite FTS5 Extension > The BM25 function
path: /tmp/.../page.semantic.html:214
matched: bm25, external, content
snippet: ...
```

Do not render raw debug metadata by default.

## MVP Implementation Stack

- Pi extension package with native tools: `web_search`, `web_fetch`, `web_lookup`.
- Brave Search API for external discovery.
- Direct HTTP via a declared `undici` dependency.
- Defuddle for extraction if viable; Readability fallback.
- Custom semantic HTML sanitizer/normalizer.
- Markdown and text derived from semantic HTML.
- SQLite FTS5 for BM25 lookup.
- OS temp directory for artifacts and SQLite DB.
- MVP may require Node `>=22.13` if it uses `node:sqlite`.

## Open Questions

- Whether Defuddle is stable enough as the default extractor in the Pi extension runtime.
- Whether SQLite FTS5 is available in the Node SQLite binding chosen for this package without native build friction.
- Whether requiring Node `>=22.13` for `node:sqlite` is acceptable for the package, since upstream Pi itself supports older Node versions.
- Whether `fetch_top` should be a boolean or integer in the first version. This spec uses integer because it is more explicit.
- Whether raw `source.html` should be stored by default or only when debug mode is enabled.
