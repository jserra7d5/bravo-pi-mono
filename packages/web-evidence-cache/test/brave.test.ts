import test from "node:test";
import assert from "node:assert/strict";
import { requireBraveApiKey } from "../src/config.js";
import { shapeBraveQuery } from "../src/brave.js";
import { assignSearchIdentities } from "../src/search.js";
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

test("assignSearchIdentities adds UUIDs, aliases, ranks, and timestamps", () => {
  let n = 1;
  const rows = assignSearchIdentities([{ title: "A", url: "https://example.com", provider: "brave" }], { query: "a" }, () => `r${n++}`);
  assert.match(rows[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(rows[0].alias, "r1");
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].query, "a");
});
