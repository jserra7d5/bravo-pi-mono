import test from "node:test";
import assert from "node:assert/strict";
import { chunkSemanticHtml } from "../src/chunking.js";

test("chunkSemanticHtml preserves heading paths and marks chunks", () => {
  const semanticHtml = `<article><h1>SQLite</h1><h2>BM25</h2><p>FTS5 provides bm25 ranking.</p><pre><code>SELECT bm25(chunk_fts)</code></pre></article>`;
  const text = "SQLite\nBM25\nFTS5 provides bm25 ranking.\nSELECT bm25(chunk_fts)\n";
  const result = chunkSemanticHtml({ pageId: "p", semanticHtml, text });
  assert.equal(result.chunks[0].heading_path, "SQLite > BM25");
  assert.match(result.semanticHtml, /data-chunk-id="p-c1"/);
  assert.ok(result.chunks.some((c) => c.text.includes("SELECT bm25")));
});
