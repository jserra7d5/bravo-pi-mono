import test from "node:test";
import assert from "node:assert/strict";
import { renderQueryResult } from "../src/render.js";
import { renderDiscoveryPrompt } from "../src/discovery.js";

test("renders ranked search hits", () => {
  const text = renderQueryResult({ protocolVersion: 1, ok: true, query: "alpha", boosts: [{ term: "alpha", weight: 2 }], excludeTerms: ["fixture"], hits: [{ path: "src/a.ts", score: 1.25, line: 3, snippet: "alpha beta" }], count: 1 });
  assert.match(text, /boosts: alpha×2/);
  assert.match(text, /excluded: fixture/);
  assert.match(text, /src\/a\.ts:3/);
  assert.match(text, /alpha beta/);
});

test("renders structured snippet windows without flattening whitespace", () => {
  const text = renderQueryResult({
    protocolVersion: 1,
    ok: true,
    query: "alpha",
    hits: [{
      path: "src/a.ts",
      score: 1.25,
      line: 3,
      snippet: "legacy alpha",
      snippets: [{ lineStart: 2, lineEnd: 4, text: "before\n  alpha();\nafter", truncated: true }],
      lineStart: 2,
      lineEnd: 4,
      matchedFields: ["content"],
    }],
    count: 1,
  });
  assert.match(text, /src\/a\.ts:2-4/);
  assert.match(text, /fields: content/);
  assert.match(text, /lines 2-4 \(truncated\):/);
  assert.match(text, /    before\n      alpha\(\);\n    after/);
});

test("renders directional snippet truncation metadata", () => {
  const text = renderQueryResult({
    protocolVersion: 1,
    ok: true,
    query: "alpha",
    hits: [{
      path: "src/a.ts",
      score: 1,
      line: 10,
      snippet: "alpha",
      snippets: [{ lineStart: 8, lineEnd: 12, text: "alpha", truncated: true, truncatedBefore: true, truncatedAfter: true }],
    }],
    count: 1,
  });
  assert.match(text, /lines 8-12 \(truncated before\/after\):/);
});

test("renders disjoint snippet ranges in the hit location", () => {
  const text = renderQueryResult({
    protocolVersion: 1,
    ok: true,
    query: "alpha",
    hits: [{
      path: "src/a.ts",
      score: 1,
      line: 3,
      snippet: "alpha",
      snippets: [
        { lineStart: 1, lineEnd: 3, text: "alpha" },
        { lineStart: 20, lineEnd: 22, text: "alpha" },
      ],
    }],
    count: 1,
  });
  assert.match(text, /src\/a\.ts:1-3,20-22/);
});

test("renders failed search warnings instead of hiding details behind unknown error", () => {
  const text = renderQueryResult({ protocolVersion: 1, ok: false, hits: [], count: 0, warnings: ["lib: sidecar missing", "switchyard: sidecar missing"] });
  assert.match(text, /ranked_search failed: unknown error/);
  assert.match(text, /lib: sidecar missing/);
  assert.match(text, /switchyard: sidecar missing/);
});

test("renders no-match warnings for partial workspace failures", () => {
  const text = renderQueryResult({ protocolVersion: 1, ok: true, query: "missing", hits: [], count: 0, warnings: ["lib: sidecar missing"] });
  assert.match(text, /No ranked_search matches/);
  assert.match(text, /lib: sidecar missing/);
});

test("renders repo discovery prompt", () => {
  const text = renderDiscoveryPrompt({ kind: "repo", cwd: "/tmp/repo", repoRoot: "/tmp/repo" });
  assert.match(text, /ranked_search is available/);
});
