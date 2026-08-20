import test from "node:test";
import assert from "node:assert/strict";
import { MAX_RENDER_CODE_POINTS, renderQueryResult } from "../src/render.js";
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
  assert.match(text, /lines 2-4:/);
  assert.doesNotMatch(text, /\(truncated/);
  assert.match(text, /    before\n      alpha\(\);\n    after/);
});

test("renders snippet enclosing context metadata", () => {
  const text = renderQueryResult({
    protocolVersion: 1,
    ok: true,
    query: "alpha",
    hits: [{
      path: "src/a.ts",
      score: 1,
      line: 2,
      snippet: "alpha",
      snippets: [{ lineStart: 1, lineEnd: 3, text: "function run() {\n  alpha();\n}", context: { kind: "function", name: "run", line: 1 } }],
    }],
    count: 1,
  });
  assert.match(text, /lines 1-3 in function run:/);
});

test("hides directional truncation labels without changing response details", () => {
  const result = {
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
  };
  const before = structuredClone(result);
  const text = renderQueryResult(result);
  assert.match(text, /lines 8-12:/);
  assert.doesNotMatch(text, /\(truncated/);
  assert.deepEqual(result, before);
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
  const text = renderQueryResult({ protocolVersion: 1, ok: false, hits: [], count: 0, warnings: ["lib: git unavailable", "switchyard: git unavailable"] });
  assert.match(text, /ranked_search failed: unknown error/);
  assert.match(text, /lib: git unavailable/);
  assert.match(text, /switchyard: git unavailable/);
});

test("renders no-match warnings", () => {
  const text = renderQueryResult({ protocolVersion: 1, ok: true, query: "missing", hits: [], count: 0, warnings: ["lib: git unavailable"] });
  assert.match(text, /No ranked_search matches/);
  assert.match(text, /lib: git unavailable/);
});

test("renders warning codes with successful hits", () => {
  const text = renderQueryResult({ protocolVersion: 1, ok: true, query: "alpha", hits: [{ path: "src/a.ts", score: 1, line: 1, snippet: "alpha" }], count: 1, warnings: ["candidate_budget_exceeded"] });
  assert.match(text, /Warnings: candidate_budget_exceeded/);
});

test("keeps a no-hit warning tail just below the Unicode cap intact", () => {
  const prefix = "candidate_budget_exceeded: ";
  const base = { protocolVersion: 1, ok: true, query: "missing", hits: [], count: 0, warnings: [prefix] };
  const baseLength = Array.from(renderQueryResult(base)).length;
  const detail = "😀".repeat(MAX_RENDER_CODE_POINTS - 1 - baseLength);
  const result = { ...base, warnings: [`${prefix}${detail}`] };
  const before = structuredClone(result);
  const text = renderQueryResult(result);
  assert.equal(Array.from(text).length, MAX_RENDER_CODE_POINTS - 1);
  assert.ok(text.endsWith(detail));
  assert.doesNotMatch(text, /details compacted/);
  assert.deepEqual(result, before);
});

test("compacts oversized warning tails for failure and hit branches", () => {
  const warning = `git_timeout: ${"😀".repeat(MAX_RENDER_CODE_POINTS + 100)}`;
  const responses = [
    { protocolVersion: 1, ok: false, error: "git failed", hits: [], count: 0, warnings: [warning] },
    { protocolVersion: 1, ok: true, query: "alpha", hits: [{ path: "src/a.ts", score: 1, line: 1, snippet: "alpha" }], count: 1, warnings: [warning] },
  ];
  for (const result of responses) {
    const before = structuredClone(result);
    const text = renderQueryResult(result);
    assert.ok(Array.from(text).length <= MAX_RENDER_CODE_POINTS);
    assert.match(text, /Warnings: git_timeout \[details compacted\]/);
    assert.match(text, /Output compacted/);
    assert.deepEqual(result, before);
  }
});

test("caps aggregate output by Unicode code points and omits lower-ranked blocks", () => {
  const hits = Array.from({ length: 10 }, (_, index) => ({
    path: `src/rank-${index}.ts`,
    score: 10 - index,
    line: 1,
    snippet: "legacy",
    snippets: [{ lineStart: 1, lineEnd: 1, text: `${"😀".repeat(1_000)} rank-${index}` }],
  }));
  const result = { protocolVersion: 1, ok: true, query: "rank", hits, count: hits.length, warnings: ["candidate_budget_exceeded"] };
  const before = structuredClone(result);
  const text = renderQueryResult(result);
  assert.ok(Array.from(text).length <= MAX_RENDER_CODE_POINTS);
  assert.match(text, /src\/rank-0\.ts/);
  assert.match(text, /lower-ranked results omitted to fit output limit/);
  assert.doesNotMatch(text, /src\/rank-9\.ts/);
  assert.match(text, /Warnings: candidate_budget_exceeded/);
  assert.deepEqual(result, before);
});

test("renders git checkout discovery prompt with result-limit guidance", () => {
  const text = renderDiscoveryPrompt({ kind: "repo", cwd: "/tmp/repo", repoRoot: "/tmp/repo" });
  assert.match(text, /ranked_search is available/);
  assert.match(text, /default 3 results/);
  assert.match(text, /narrow path\/query before increasing/);
  assert.match(text, /maximum 10/);
});
