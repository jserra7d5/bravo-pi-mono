import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { domainMatches, EvidenceDatabase, normalizeFtsQuery, probeSqliteFts5 } from "../src/sqlite.js";
import type { ChunkRecord, PageRecord } from "../src/types.js";

test("SQLite FTS5 probe passes on supported runtime", () => {
  assert.doesNotThrow(() => probeSqliteFts5());
});

test("EvidenceDatabase inserts page/chunks and returns lookup hits without scores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-cache-test-"));
  try {
    const db = await EvidenceDatabase.open(dir);
    const page: PageRecord = {
      id: "page1",
      alias: "p1",
      url: "https://sqlite.org/fts5.html",
      final_url: "https://sqlite.org/fts5.html",
      canonical_url: "https://sqlite.org/fts5.html",
      title: "SQLite FTS5",
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
    const chunks: ChunkRecord[] = [{
      id: "chunk1",
      page_id: "page1",
      ordinal: 0,
      heading_path: "BM25",
      semantic_html_path: page.semantic_html_path,
      markdown_path: page.markdown_path,
      text_path: page.text_path,
      line_start: 10,
      line_end: 12,
      text: "FTS5 provides a bm25 auxiliary function.",
      token_count: 10,
    }];
    db.insertPageWithChunks(page, chunks);
    const hits = db.lookup("bm25", 5, "sqlite.org", "markdown");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, page.markdown_path);
    assert.equal("score" in hits[0], false);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("EvidenceDatabase lookup handles punctuation-heavy identifiers without FTS syntax errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-cache-test-"));
  try {
    const db = await EvidenceDatabase.open(dir);
    const page = fixturePage(dir, "page1", "p1", "https://nodejs.org/api/sqlite.html");
    db.insertPageWithChunks(page, [{
      id: "chunk1",
      page_id: "page1",
      ordinal: 0,
      heading_path: "APIs",
      semantic_html_path: page.semantic_html_path,
      markdown_path: page.markdown_path,
      text_path: page.text_path,
      line_start: 4,
      line_end: 5,
      text: "Use node:sqlite with Type.Name, foo/bar, and hyphenated-token identifiers. The exact phrase is supported.",
      token_count: 20,
    }]);
    for (const query of ["node:sqlite", "Type.Name", "foo/bar", "hyphenated-token", '"exact phrase"']) {
      const hits = db.lookup(query, 5, null, "auto");
      assert.equal(hits.length, 1, query);
      assert.equal(hits[0].path, page.text_path);
      assert.equal(hits[0].line_start, 4);
    }
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("EvidenceDatabase domain filter matches hostnames, not spoofed paths or queries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-cache-test-"));
  try {
    const db = await EvidenceDatabase.open(dir);
    const good = fixturePage(dir, "good", "p1", "https://docs.example.com/page");
    const spoof = fixturePage(dir, "spoof", "p2", "https://evil.test/path/docs.example.com?q=docs.example.com");
    db.insertPageWithChunks(good, [fixtureChunk(good, "c1", "shared needle")]);
    db.insertPageWithChunks(spoof, [fixtureChunk(spoof, "c2", "shared needle")]);
    const hits = db.lookup("needle", 10, "example.com", "auto");
    assert.deepEqual(hits.map((hit) => hit.page_id), ["good"]);
    assert.equal(domainMatches("https://evil.test/path/example.com", "example.com"), false);
    assert.equal(domainMatches("https://sub.example.com/path", "example.com"), true);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lookup suppresses text line hints when returning semantic HTML or markdown paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-cache-test-"));
  try {
    const db = await EvidenceDatabase.open(dir);
    const page = fixturePage(dir, "page1", "p1", "https://example.com/page");
    db.insertPageWithChunks(page, [fixtureChunk(page, "chunk1", "linehint needle")]);
    assert.equal(db.lookup("needle", 5, null, "auto")[0].line_start, 10);
    assert.equal(db.lookup("needle", 5, null, "semantic_html")[0].line_start, undefined);
    assert.equal(db.lookup("needle", 5, null, "markdown")[0].line_start, undefined);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizeFtsQuery quotes dangerous punctuation instead of emitting FTS syntax", () => {
  assert.equal(normalizeFtsQuery('"exact phrase"'), '"exact phrase"');
  assert.equal(normalizeFtsQuery("node:sqlite Type.Name foo/bar hyphenated-token"), '"node sqlite" OR "Type Name" OR "foo bar" OR "hyphenated token"');
});

function fixturePage(dir: string, id: string, alias: string, url: string): PageRecord {
  return {
    id,
    alias,
    url,
    final_url: url,
    canonical_url: url,
    title: `Title ${id}`,
    fetched_at: new Date().toISOString(),
    content_hash: "hash",
    extractor: "fixture",
    confidence: "good",
    warnings: [],
    artifact_dir: dir,
    semantic_html_path: join(dir, `${id}.semantic.html`),
    markdown_path: join(dir, `${id}.md`),
    text_path: join(dir, `${id}.txt`),
    metadata_path: join(dir, `${id}.json`),
    chunks_path: join(dir, `${id}.chunks.json`),
  };
}

function fixtureChunk(page: PageRecord, id: string, text: string): ChunkRecord {
  return {
    id,
    page_id: page.id,
    ordinal: 0,
    heading_path: "Heading",
    semantic_html_path: page.semantic_html_path,
    markdown_path: page.markdown_path,
    text_path: page.text_path,
    line_start: 10,
    line_end: 11,
    text,
    token_count: 5,
  };
}
