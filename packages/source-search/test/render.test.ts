import test from "node:test";
import assert from "node:assert/strict";
import { renderQueryResult } from "../src/render.js";
import { renderDiscoveryPrompt } from "../src/discovery.js";

test("renders ranked search hits", () => {
  const text = renderQueryResult({ protocolVersion: 1, ok: true, query: "alpha", hits: [{ path: "src/a.ts", score: 1.25, line: 3, snippet: "alpha beta" }], count: 1 });
  assert.match(text, /src\/a\.ts:3/);
  assert.match(text, /alpha beta/);
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
