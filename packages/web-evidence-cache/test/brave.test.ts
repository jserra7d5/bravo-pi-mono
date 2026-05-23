import test from "node:test";
import assert from "node:assert/strict";
import { requireBraveApiKey } from "../src/config.js";
import { sanitizeBraveSnippet, shapeBraveQuery } from "../src/brave.js";
import { assignSearchIdentities, searchContentSummary } from "../src/search.js";
import { WebToolError } from "../src/errors.js";

test("Brave config accepts BRAVE_SEARCH_API_KEY before BRAVE_API_KEY", () => {
  assert.equal(requireBraveApiKey({ braveApiKey: "key1", maxBytes: 1, timeoutMs: 1, maxRedirects: 1 }), "key1");
});

test("Brave config throws ContextError when missing key", () => {
  assert.throws(() => requireBraveApiKey({ maxBytes: 1, timeoutMs: 1, maxRedirects: 1 }), (error) => {
    assert.ok(error instanceof WebToolError);
    assert.equal(error.error_type, "ContextError");
    return true;
  });
});

test("shapeBraveQuery applies exact mode and domain operators", () => {
  assert.equal(
    shapeBraveQuery({ query: "node sqlite fts5", search_mode: "exact", domains: ["nodejs.org"], exclude_domains: ["example.com"] }),
    '"node sqlite fts5" site:nodejs.org -site:example.com',
  );
});

test("shapeBraveQuery treats multiple included domains as alternatives", () => {
  assert.equal(
    shapeBraveQuery({ query: "terraform", domains: ["https://cloud.google.com/docs/terraform", "developer.hashicorp.com"] }),
    "terraform (site:cloud.google.com OR site:developer.hashicorp.com)",
  );
});

test("assignSearchIdentities adds UUIDs, aliases, ranks, and timestamps", () => {
  let n = 1;
  const rows = assignSearchIdentities([{ title: "A", url: "https://example.com", provider: "brave" }], { query: "a" }, () => `r${n++}`);
  assert.match(rows[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(rows[0].alias, "r1");
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].query, "a");
});

test("sanitizeBraveSnippet strips tags, decodes entities, and normalizes whitespace", () => {
  assert.equal(
    sanitizeBraveSnippet("Learn <strong>Node&nbsp;SQLite</strong> &amp; FTS5&#33;\n\tMore"),
    "Learn Node SQLite & FTS5! More",
  );
});

test("searchContentSummary shows both alias and UUID id", () => {
  const summary = searchContentSummary([{
    id: "123e4567-e89b-12d3-a456-426614174000",
    alias: "r7",
    title: "Example",
    url: "https://example.com",
    provider: "brave",
    query: "example",
    rank: 1,
    created_at: "2026-05-23T00:00:00.000Z",
  }]);
  assert.match(summary, /\[r7\] id 123e4567-e89b-12d3-a456-426614174000/);
  assert.match(summary, /next step: call web_fetch/);
});
