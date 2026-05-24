import test from "node:test";
import assert from "node:assert/strict";
import { renderQueryResult } from "../src/render.js";
import { renderDiscoveryPrompt } from "../src/discovery.js";

test("renders ranked search hits", () => {
  const text = renderQueryResult({ protocolVersion: 1, ok: true, query: "alpha", hits: [{ path: "src/a.ts", score: 1.25, line: 3, snippet: "alpha beta" }], count: 1 });
  assert.match(text, /src\/a\.ts:3/);
  assert.match(text, /alpha beta/);
});

test("renders repo discovery prompt", () => {
  const text = renderDiscoveryPrompt({ kind: "repo", cwd: "/tmp/repo", repoRoot: "/tmp/repo" });
  assert.match(text, /ranked_search is available/);
});
