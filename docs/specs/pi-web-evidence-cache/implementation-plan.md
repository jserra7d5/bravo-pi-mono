# Pi Web Evidence Cache Implementation Plan

## Inputs

This plan implements the design in `docs/specs/pi-web-evidence-cache/spec.md`.

Relevant upstream Pi constraints:

- Pi packages declare resources under `package.json` `pi.extensions`, `pi.skills`, `pi.prompts`, and `pi.themes`.
- Package extension paths are relative to the package root.
- Extension entrypoints are default-exported functions receiving `ExtensionAPI`.
- Custom native tools are registered with `pi.registerTool()` or `defineTool()`.
- Tool guidance belongs in `promptSnippet` and `promptGuidelines` so the usage contract travels with the tool.
- Visual tool cards should use `renderCall`, `renderResult`, and `renderShell: "self"`.
- Renderers must return width-aware Components; do not compute layout from `process.stdout.columns`.

Local repo conventions:

- New workspaces live under `packages/*`.
- Extension-only packages follow `packages/showcase` and `packages/caveman`.
- Rich renderer packages should follow `packages/showcase` and `packages/async-subagents`: pure renderer helpers, stable palette, ANSI-aware width math, and test-only render exports.

## Package Shape

Create a new workspace package:

```text
packages/web-evidence-cache/
  package.json
  tsconfig.json
  extensions/
    pi/
      index.ts
      renderers.ts
  src/
    brave.ts
    cache.ts
    chunking.ts
    config.ts
    errors.ts
    extract.ts
    filesystem.ts
    html.ts
    index.ts
    lookup.ts
    safety.ts
    search.ts
    sqlite.ts
    types.ts
  test/
    brave.test.ts
    chunking.test.ts
    extract.test.ts
    renderers.test.ts
    safety.test.ts
    sqlite.test.ts
    tools.test.ts
```

Package manifest:

```json
{
  "name": "@bravo/web-evidence-cache",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Pi extension for web discovery, temporary local web evidence artifacts, and BM25 lookup.",
  "keywords": ["pi-package"],
  "scripts": {
    "check": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test dist/test/*.test.js"
  },
  "dependencies": {
    "@mozilla/readability": "latest",
    "defuddle": "latest",
    "ipaddr.js": "latest",
    "linkedom": "latest",
    "node-html-markdown": "latest",
    "undici": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "engines": {
    "node": ">=22.13"
  },
  "pi": {
    "extensions": ["./extensions/pi"]
  }
}
```

Do not add a CLI for the MVP. This is a Pi extension package with reusable internal modules.

## Dependency Decisions

### Search

Use direct HTTP calls to the Brave Search API.

Do not add a Brave SDK. The API is small enough that a wrapper mostly adds licensing and freshness risk. The implementation should use direct HTTP through the declared `undici` dependency with `X-Subscription-Token`.

Configuration sources, in priority order:

1. `BRAVE_SEARCH_API_KEY`
2. `BRAVE_API_KEY`
3. optional package config file in a later version

If no key is available, `web_search` throws a `ContextError` with setup instructions. It should not silently degrade to random scraping.

Manual/live smoke testing should source the local key at `~/.keys/BRAVE_API_KEY` and export both names so the implementation exercises the normal extension lookup path:

```bash
export BRAVE_API_KEY="$(cat ~/.keys/BRAVE_API_KEY)"
export BRAVE_SEARCH_API_KEY="$BRAVE_API_KEY"
```

Keep this out of committed files and test output. The key may also be copied locally to `~/.keys/BRAVE_SEARCH_API_KEY` for developer convenience, but the extension itself should read environment variables.

### HTTP Fetch

Use `undici` as a direct dependency for evidence fetching. Do not rely on Pi's transitive dependencies for a direct import.

Evidence fetches need implementation-owned control over:

- redirects
- timeouts
- maximum response bytes
- accepted content types
- final URL
- abort signal propagation
- per-redirect SSRF validation

### URL/IP Safety

Use `dns.promises.lookup(host, { all: true })` and `ipaddr.js`.

Reject:

- non-HTTP(S) protocols
- URLs with embedded credentials
- localhost
- private ranges
- loopback
- link-local
- multicast
- IPv6 unique-local
- cloud metadata IPs
- any redirect whose resolved target is blocked

This is the highest-risk part of the implementation. Treat it as core product behavior, not a helper.

### DOM And Extraction

Default parser: `linkedom`.

Default extractor: `defuddle/node`.

Fallback extractor: `@mozilla/readability` over the parsed document.

Markdown conversion:

- Prefer Defuddle's Markdown output when available.
- For Readability fallback, use `node-html-markdown`.

Sanitization and semantic HTML normalization are mandatory regardless of extractor. Readability explicitly does not sanitize untrusted output, and fetched pages are prompt-injection-bearing untrusted input.

Important implementation rule: do not use Defuddle async fallback behavior if it calls third-party services for sparse/client-rendered pages. MVP extraction should be local and deterministic.

### SQLite

Preferred MVP: `node:sqlite`, with this package declaring Node `>=22.13`. Upstream Pi supports older Node versions, so this package intentionally narrows runtime compatibility unless the implementation chooses a different index engine before coding.

Required startup probe:

1. Open an in-memory SQLite database.
2. Create an FTS5 virtual table.
3. Insert one row.
4. Query with `bm25()`.
5. If any step fails, return a clear runtime error.

Fallback decision if runtime support is not acceptable:

- `better-sqlite3` is the best native fallback, but it introduces install/build friction.
- A pure TypeScript index such as MiniSearch can be a temporary fallback for lookup tests, but it does not satisfy the SQLite FTS5 plan and should not become a hidden second implementation unless explicitly chosen.

Architectural smell to watch: if we end up with both SQLite FTS5 and a pure-JS fallback under the same `web_lookup` semantics, ranking behavior may diverge. Prefer one supported index engine for the package contract.

## Data Model

Use one temp SQLite database per workspace/session evidence cache:

```text
${os.tmpdir()}/pi-web-cache/<workspace-hash>/<session-id>/web.sqlite
```

Tables:

```sql
CREATE TABLE search_results (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  source_result_id TEXT,
  url TEXT NOT NULL,
  final_url TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  extractor TEXT NOT NULL,
  confidence TEXT NOT NULL,
  artifact_dir TEXT NOT NULL,
  semantic_html_path TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  text_path TEXT NOT NULL,
  metadata_path TEXT NOT NULL,
  chunks_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE chunks (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  page_id TEXT NOT NULL REFERENCES pages(id),
  ordinal INTEGER NOT NULL,
  heading_path TEXT,
  semantic_html_path TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  text_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL
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

Maintain FTS rows transactionally with chunk inserts and explicitly duplicate searchable fields (`title`, `url`, `heading_path`, `text`) into the direct FTS table. Do not use an external-content FTS table unless every FTS column exists on the content table; the schema above intentionally avoids that invalid coupling.

## Temporary Files

Artifact layout:

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

`source.html` should be optional and controlled by internal debug config. It is useful for extraction fixtures but should not be necessary for normal use.

The extension should not expose a prune command. The OS temp directory owns cleanup. The extension may remove its own active session directory on `session_shutdown` only if doing so does not break user expectation that paths returned earlier in the same Pi process remain readable.

Recommendation for MVP: do not delete on `session_shutdown`; rely on OS temp cleanup. Manual deletion can be added later only if temp growth becomes a real problem.

## Session State

Keep a small in-memory registry per active Pi session:

```ts
type SessionRegistry = {
  workspaceHash: string;
  sessionId: string;
  rootDir: string;
  nextResultAlias: number;
  nextPageAlias: number;
  resultAliasToId: Map<string, string>;
  pageAliasToId: Map<string, string>;
};
```

Initialize lazily on first tool call. Do not require a `session_start` event to make the tools usable in non-interactive or RPC modes.

Use `ctx.cwd` to derive `workspaceHash`.

Use `ctx.sessionManager.getSessionId()` as the primary `sessionId`. Use a generated UUID only as a defensive fallback if the extension context cannot provide one. Keep this implementation detail hidden.

Aliases are session-global within the active evidence workspace: `r1`, `r2`, ... and `p1`, `p2`, ... should not reset per call.

## Tool Implementation

### `web_search`

Registration:

- `name`: `web_search`
- `label`: `Web Search`
- `renderShell`: `"self"`
- `promptSnippet`: short declaration that this searches the live web for candidate pages.
- `promptGuidelines`: teach that snippets are leads, fetched artifacts are evidence, and `web_lookup` searches fetched pages.

Parameters:

```ts
{
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  fetch_top: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  search_mode: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("exact"),
    Type.Literal("broad")
  ])),
  domains: Type.Optional(Type.Array(Type.String())),
  exclude_domains: Type.Optional(Type.Array(Type.String())),
  recency: Type.Optional(Type.Union([Type.String(), Type.Null()]))
}
```

Execution:

1. Validate config and arguments.
2. Translate `search_mode`, `domains`, `exclude_domains`, and `recency` into Brave parameters/query operators.
3. Call Brave Search.
4. Normalize results into internal `SearchResult`.
5. Assign UUIDs and `rN` aliases.
6. Store results in SQLite.
7. If `fetch_top > 0`, call the same internal fetch service used by `web_fetch` for the top N results.
8. Return an `AgentToolResult` whose `details` matches the `WebSearchResult` spec and whose `content` is a compact text summary of the same results.

Do not expose Brave raw response fields in normal output.

If `fetch_top > 0`, annotate each fetched search result with `fetched: true`, `page_id`, and `artifact_dir` in the returned details payload.

### `web_fetch`

Registration:

- `name`: `web_fetch`
- `label`: `Web Fetch`
- `renderShell`: `"self"`
- `promptSnippet`: fetches URLs or search result IDs into local temp artifacts.
- `promptGuidelines`: fetched pages become searchable automatically; read returned paths with filesystem tools.

Parameters:

```ts
{
  refs: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
  format: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("semantic_html"),
    Type.Literal("markdown"),
    Type.Literal("text")
  ])),
  refresh: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("force")
  ]))
}
```

Execution:

1. Resolve refs as alias, UUID, or URL.
2. Canonicalize URL and reject unsafe targets.
3. If `refresh: "auto"` and a page with the same canonical/final URL is already present, return existing artifacts without a network request.
4. Fetch with byte, redirect, and timeout limits.
5. Parse DOM with `linkedom`.
6. Extract with Defuddle. If weak/fails, fallback to Readability.
7. Produce simplified semantic HTML.
8. Produce Markdown and text views.
9. Chunk by headings/sections/lists/tables/code blocks, then split oversized blocks.
10. Write artifacts.
11. Insert page and chunks into SQLite/FTS in one transaction.
12. Return an `AgentToolResult` whose `details` matches the `WebFetchResult` spec and whose `content` summarizes the fetched pages and artifact paths.

`format` controls the preferred returned path and preview emphasis only. Always generate and return all three artifact views: semantic HTML, Markdown, and text. Content hashes are computed after fetch and used for metadata/dedupe decisions, not pre-fetch cache lookup.

### `web_lookup`

Registration:

- `name`: `web_lookup`
- `label`: `Web Lookup`
- `renderShell`: `"self"`
- `promptSnippet`: searches fetched local web artifacts only.
- `promptGuidelines`: use after `web_fetch`; open returned paths with filesystem tools.

Parameters:

```ts
{
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  format: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("semantic_html"),
    Type.Literal("markdown"),
    Type.Literal("text")
  ]))
}
```

Execution:

1. Normalize the query for FTS5.
2. Query `chunk_fts`.
3. Join chunks/pages.
4. Filter by domain if provided.
5. Return an `AgentToolResult` whose `details` matches the `WebLookupResult` spec and whose `content` is a compact lookup summary.

Do not return raw BM25 scores by default.

`format` controls the preferred `path` field and renderer emphasis only. FTS querying uses the normalized chunk text regardless of selected format, and all artifact paths remain available in `details`.

## Semantic HTML Normalizer

Implement `src/html.ts` as a pure module:

- Accept extracted HTML and source metadata.
- Parse into DOM.
- Remove unsafe/noisy tags.
- Drop all original `class`, `style`, event handler, and original `data-*` attributes.
- Remove `script`, `style`, `noscript`, `iframe`, comments, hidden elements, navigation chrome, duplicated sidebars, tracking wrappers, ad containers, and framework hydration payloads.
- Preserve structure-bearing attributes: `href`, `src`, `alt`, `title`, `datetime`, `id`, `aria-label`, `scope`, `headers`, `colspan`, `rowspan`.
- Normalize relative URLs to absolute URLs.
- Wrap output in a single `<article data-source-id="...">`.
- Generate stable section IDs where headings do not provide one.
- Add generated `data-chunk-id` only after chunking.

Keep tables as simplified HTML. Markdown conversion may degrade complex tables, so the semantic HTML artifact is the source of truth.

## Chunking

Implement structural chunking before token/character splitting:

1. Start at `article`.
2. Split by top-level sections/headings.
3. Keep code blocks atomic unless they exceed a hard cap.
4. Keep tables atomic unless they exceed a hard cap.
5. Preserve heading path for every chunk.
6. Add generated chunk IDs to semantic HTML.
7. Compute line starts/ends after writing the final artifact.

MVP can estimate token count by character length. Do not add tokenizer dependency unless a real need appears.

Suggested caps:

- target chunk: 1,500-2,500 words or equivalent characters
- hard chunk: 8,000-10,000 characters
- preview: 1,000-1,500 characters

Keep exact constants internal.

## Rendering Plan

Create `extensions/pi/renderers.ts` with pure functions:

- `renderSearchCall`
- `renderSearchResult`
- `renderFetchCall`
- `renderFetchResult`
- `renderLookupCall`
- `renderLookupResult`
- `renderErrorCard`

Use container chrome, not bookend chrome, because these are compact structured evidence cards rather than long file payloads.

Rendering rules:

- Use `renderShell: "self"` on all three tools.
- Use the identity palette already established in this repo.
- Use semantic glyphs consistently.
- Use ANSI-aware width helpers.
- Truncate long URLs/paths in the middle.
- Drop low-priority fields at narrow widths.
- Never wrap chrome.
- Show artifact paths prominently in fetch and lookup results.
- Do not render raw debug metadata.

Example result summaries:

```text
[r1] SQLite FTS5 Extension · brave
https://www.sqlite.org/fts5.html
snippet: ...
```

```text
[p1] SQLite FTS5 Extension · indexed
semantic: /tmp/.../page.semantic.html
markdown: /tmp/.../page.md
extract: defuddle/good
```

```text
[p1:chunk_7] SQLite FTS5 Extension > The BM25 function
path: /tmp/.../page.semantic.html:214
matched: bm25, external, content
```

Add test-only exports for renderer snapshots, following `packages/showcase`.

## Prompt Guidance

Each tool should include concise `promptSnippet` and `promptGuidelines`. Avoid a large standalone prompt unless later needed. Pi appends guidelines as flat bullets, so every guideline should name the relevant tool explicitly.

Shared guidance:

```text
Use web_search for live web discovery.
Use web_fetch to materialize promising results or URLs as local temp artifacts.
Use web_fetch knowing fetched pages become searchable automatically.
Use web_lookup to search within fetched artifacts.
Use normal filesystem tools to read artifact paths returned by web_fetch and web_lookup.
Use web_search snippets as leads, not evidence; cite fetched/read local artifacts or source URLs.
Use web_search and web_fetch to prefer primary sources and official documentation when available.
```

Tool descriptions should state decision boundaries:

- `web_search`: live discovery.
- `web_fetch`: local materialization/indexing.
- `web_lookup`: local fetched-corpus lookup.

## Error Semantics

Use tiered errors:

```ts
type WebToolError = {
  error_type: "ContextError" | "AdapterError" | "ToolExecutionError";
  message: string;
  suggested_action: string;
};
```

Map examples:

- Missing Brave key: `ContextError`.
- Brave timeout or 5xx: `AdapterError`.
- Invalid URL or unsupported protocol: `ToolExecutionError`.
- Private network blocked: `ToolExecutionError`.
- No fetched pages for lookup: `ToolExecutionError` with suggestion to call `web_fetch`.
- SQLite FTS unavailable: `ContextError` or package runtime error with clear Node/runtime guidance.

True tool failures should throw `WebToolError`/`Error` subclasses from `execute`; do not encode real failures as successful `{ content, details }` results or `{ isError: true }` payloads. The structured `WebToolError` shape is for internal classification, error messages, and renderer-friendly summaries where Pi provides error render context. Renderers must tolerate `context.isError === true` with missing or partial `details`.

## Testing Plan

### Unit Tests

`safety.test.ts`

- rejects `file://`
- rejects credentials in URL
- rejects localhost hostnames
- rejects private IPv4 and IPv6
- rejects metadata IPs
- rejects redirect to private target
- accepts public HTTP(S) URL

`brave.test.ts`

- maps Brave API results into stable internal shape
- assigns UUIDs and aliases
- applies domain/exclude-domain query shaping
- handles missing API key as `ContextError`
- handles 429/5xx as `AdapterError`

Use mocked fetch only. Do not call Brave in tests.

`extract.test.ts`

- Defuddle success path returns semantic HTML, markdown, text, metadata
- Readability fallback works when Defuddle fails
- sanitizer strips script/style/class/event/data attributes
- sanitizer strips `noscript`, `iframe`, comments, hidden elements, and framework hydration payloads
- links are absolutized
- complex table remains valid simplified HTML

`chunking.test.ts`

- headings produce heading paths
- code blocks remain atomic
- tables remain atomic
- oversized sections split deterministically
- line hints point into written artifacts

`sqlite.test.ts`

- FTS5 probe passes or fails with actionable error
- inserts page/chunks transactionally
- lookup returns ranked snippets
- domain filter works
- no raw BM25 score leaks through public return mapper
- direct FTS table stores duplicated searchable fields and joins back to chunks by `chunk_id`

`renderers.test.ts`

- all cards hold declared width
- long paths mid-truncate
- narrow-width cutoffs do not wrap
- success and error cards render
- palette/glyph usage matches repo conventions

`tools.test.ts`

- all three tools have `renderShell: "self"`
- all three tools have `promptSnippet` and `promptGuidelines`
- public tool `details` exactly match the spec return shapes and tool `content` is compact text
- `web_fetch` accepts aliases, UUIDs, and URLs
- `web_lookup` tells agent to fetch first when index is empty

### Integration Tests

Use local HTTP fixtures only:

- static docs page
- table-heavy API page
- code-heavy README-like page
- page with nav/sidebar boilerplate
- redirect to allowed URL
- redirect to blocked URL

End-to-end:

1. Search adapter returns fixture result.
2. Fetch ingests fixture URL.
3. Artifacts exist on disk.
4. SQLite index contains chunks.
5. Lookup finds exact API/error string.
6. Returned path can be read with normal filesystem tools.

Do not use live provider APIs or real API keys in tests.

Manual/live smoke tests may use the developer key at `~/.keys/BRAVE_API_KEY` by exporting both `BRAVE_API_KEY` and `BRAVE_SEARCH_API_KEY`. Never print the key or commit it.

## Build And Validation

After implementation:

```bash
npm run check --workspace @bravo/web-evidence-cache
npm test --workspace @bravo/web-evidence-cache
```

Because this is a new package with tests, run its specific tests. Do not run root `npm test`.

If implementation touches shared workspace config, run root `npm run check` after package-level check.

## Implementation Phases

### Phase 1: Package Skeleton

- Add package manifest and tsconfig.
- Add extension entrypoint registering placeholder tools.
- Add shared types and error helpers.
- Add renderer skeletons and tests that assert `renderShell: "self"` and prompt guidance.

Exit criteria:

- Package builds/checks.
- Pi package manifest is discoverable.
- Tools are registered with correct names and guidance.

### Phase 2: Search

- Implement config resolution for Brave API key.
- Implement Brave request/response adapter.
- Implement result UUID/alias registry.
- Implement `web_search` execute path.
- Implement search renderer.

Exit criteria:

- Mocked Brave tests pass.
- `web_search` returns stable result envelope.
- Missing key and provider errors are recoverable and clear.

### Phase 3: Temp Cache And SQLite

- Implement temp root derivation from `ctx.cwd`.
- Implement SQLite open/init/probe.
- Implement search result/page/chunk persistence.
- Implement lookup query path.

Exit criteria:

- FTS5 tests pass.
- `web_lookup` handles empty corpus correctly.
- Public lookup output returns paths and snippets, not DB internals.

### Phase 4: Fetch Safety And Extraction

- Implement URL canonicalization and SSRF checks.
- Implement bounded fetch with redirects.
- Implement Defuddle extraction.
- Implement Readability fallback.
- Implement semantic HTML sanitizer/normalizer.
- Implement Markdown/text derivation.

Exit criteria:

- Safety tests pass.
- Extraction fixtures pass.
- No unsafe tags/attributes survive semantic HTML.

### Phase 5: Artifacts And Chunking

- Write `page.semantic.html`, `page.md`, `page.txt`, `metadata.json`, `chunks.json`.
- Implement structural chunking and line mapping.
- Insert chunks into SQLite/FTS.
- Implement `web_fetch` execute path.
- Implement fetch renderer.

Exit criteria:

- End-to-end fixture test passes search-result ref -> fetch -> files -> lookup.
- Returned paths are readable and stable for the session.

### Phase 6: UX Polish

- Tune card layouts at narrow widths.
- Ensure all errors render cleanly.
- Add prompt guidance tests.
- Add package README with setup instructions for `BRAVE_SEARCH_API_KEY`.

Exit criteria:

- Renderer tests cover width cutoffs.
- Agent guidance is concise and unambiguous.
- Package-level check/test pass.

## Open Decisions Before Coding

1. Confirm that narrowing this package to Node `>=22.13` is acceptable. If not, choose `better-sqlite3` or revise the index implementation before coding.
2. Confirm whether `source.html` should be written by default. Recommendation: debug-only.
3. Confirm whether `fetch_top` should stay integer. Recommendation: yes, capped at 10.
4. Confirm whether config should be environment-only for MVP. Recommendation: yes, then add a command/config file later if needed.

## Risks

- SSRF protection is easy to get wrong. Treat redirect-time DNS/IP validation as required, not optional.
- `node:sqlite` may be runtime-fragile. Probe early and fail clearly.
- Defuddle extraction quality may vary on docs/API pages. Keep Readability fallback and fixtures broad.
- Semantic HTML can still carry prompt injection in text content. The tool should sanitize structure, but agents must still treat fetched content as untrusted evidence.
- Renderer polish can consume time. Build mockups or snapshot renderers early rather than after implementation.

## Hand-Off Notes

When assigning implementation, keep write scopes disjoint:

- Worker A: package skeleton, tool registration, prompt guidance, renderers.
- Worker B: search/config/Brave adapter.
- Worker C: cache/SQLite/lookup.
- Worker D: fetch/safety/extraction/chunking.

Do not run broad parallel writers in the same files. The extension entrypoint will integrate all modules, so either keep it lead-owned or assign it to one worker after module APIs are settled.
