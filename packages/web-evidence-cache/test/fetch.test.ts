import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceDatabase } from "../src/sqlite.js";
import { fetchEvidence } from "../src/fetch.js";
import type { SessionRegistry } from "../src/cache.js";
import type { ChunkRecord, PageRecord } from "../src/types.js";

test("refresh:auto reuses an existing page by original redirected URL without network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-cache-test-"));
  try {
    const db = await EvidenceDatabase.open(dir);
    const page: PageRecord = {
      id: "page1",
      alias: "p1",
      url: "https://example.com/start",
      final_url: "https://example.com/final",
      canonical_url: "https://example.com/final",
      title: "Redirected",
      fetched_at: new Date().toISOString(),
      content_hash: "hash",
      extractor: "fixture",
      confidence: "good",
      warnings: [],
      artifact_dir: dir,
      semantic_html_path: join(dir, "page.semantic.html"),
      markdown_path: join(dir, "page.md"),
      text_path: join(dir, "page.txt"),
      metadata_path: join(dir, "metadata.json"),
      chunks_path: join(dir, "chunks.json"),
    };
    const chunk: ChunkRecord = {
      id: "chunk1",
      page_id: page.id,
      ordinal: 0,
      semantic_html_path: page.semantic_html_path,
      markdown_path: page.markdown_path,
      text_path: page.text_path,
      text: "redirect cache",
      token_count: 2,
    };
    db.insertPageWithChunks(page, [chunk]);
    const registry = {
      rootDir: dir,
      nextPageAlias: 2,
      pageAliasToId: new Map(),
      db,
    } as unknown as SessionRegistry;
    const result = await fetchEvidence({ url: "https://example.com/start" }, registry, { maxBytes: 100, timeoutMs: 1, maxRedirects: 0 }, "auto", "auto");
    assert.equal(result.id, "page1");
    assert.equal(result.indexed, true);
    assert.equal(registry.nextPageAlias, 2);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
