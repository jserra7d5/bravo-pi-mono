import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contextError, toolExecutionError } from "./errors.js";
import { ensureDir } from "./filesystem.js";
import type { ChunkRecord, EvidenceFormat, LookupMatchMode, PageRecord, SearchResultRecord, WebLookupResultItem } from "./types.js";

export interface LookupHit extends WebLookupResultItem {}

export function probeSqliteFts5(): void {
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(body); INSERT INTO probe(body) VALUES ('hello sqlite fts5');");
    db.prepare("SELECT bm25(probe) AS score FROM probe WHERE probe MATCH ?").get("sqlite");
    db.close();
  } catch (cause) {
    throw contextError(
      "SQLite FTS5 is not available in this Node runtime.",
      "Run Pi with Node >=22.13 built with node:sqlite and FTS5 support; this package intentionally does not use a hidden fallback index.",
    );
  }
}

export class EvidenceDatabase {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static async open(rootDir: string): Promise<EvidenceDatabase> {
    probeSqliteFts5();
    await ensureDir(rootDir);
    const db = new DatabaseSync(join(rootDir, "web.sqlite"));
    const store = new EvidenceDatabase(db);
    store.init();
    return store;
  }

  close(): void {
    this.db.close();
  }

  init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS search_results (
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
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        source_result_id TEXT,
        url TEXT NOT NULL,
        final_url TEXT,
        canonical_url TEXT NOT NULL UNIQUE,
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
      CREATE TABLE IF NOT EXISTS chunks (
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
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        chunk_id UNINDEXED,
        page_id UNINDEXED,
        title,
        url,
        heading_path,
        text
      );
    `);
  }

  insertSearchResults(results: SearchResultRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO search_results
      (id, alias, provider, query, rank, title, url, snippet, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.withTransaction(() => {
      for (const r of results) stmt.run(r.id, r.alias, r.provider, r.query, r.rank, r.title, r.url, r.snippet ?? null, r.created_at);
    });
  }

  findSearchRef(ref: string): SearchResultRecord | undefined {
    return this.db.prepare("SELECT * FROM search_results WHERE id = ? OR alias = ? ORDER BY created_at DESC, rank ASC LIMIT 1").get(ref, ref) as SearchResultRecord | undefined;
  }

  findPageByCanonicalUrl(canonicalUrl: string): PageRecord | undefined {
    const row = this.db.prepare("SELECT * FROM pages WHERE canonical_url = ?").get(canonicalUrl) as (PageRecord & { metadata_json: string }) | undefined;
    return row ? rowToPage(row) : undefined;
  }

  findPageByUrlIdentity(url: string): PageRecord | undefined {
    const row = this.db.prepare("SELECT * FROM pages WHERE canonical_url = ? OR url = ? OR final_url = ?").get(url, url, url) as (PageRecord & { metadata_json: string }) | undefined;
    return row ? rowToPage(row) : undefined;
  }

  findPageByIdOrAlias(ref: string): PageRecord | undefined {
    const row = this.db.prepare("SELECT * FROM pages WHERE id = ? OR alias = ?").get(ref, ref) as (PageRecord & { metadata_json: string }) | undefined;
    return row ? rowToPage(row) : undefined;
  }

  insertPageWithChunks(page: PageRecord, chunks: ChunkRecord[]): void {
    const pageStmt = this.db.prepare(`
      INSERT OR REPLACE INTO pages
      (id, alias, source_result_id, url, final_url, canonical_url, title, fetched_at, content_hash, extractor, confidence, artifact_dir, semantic_html_path, markdown_path, text_path, metadata_path, chunks_path, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteChunk = this.db.prepare("DELETE FROM chunks WHERE page_id = ?");
    const deleteFts = this.db.prepare("DELETE FROM chunk_fts WHERE page_id = ?");
    const chunkStmt = this.db.prepare(`
      INSERT INTO chunks
      (id, page_id, ordinal, heading_path, semantic_html_path, markdown_path, text_path, line_start, line_end, text, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = this.db.prepare(`
      INSERT INTO chunk_fts (chunk_id, page_id, title, url, heading_path, text)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.withTransaction(() => {
      deleteFts.run(page.id);
      deleteChunk.run(page.id);
      pageStmt.run(
        page.id, page.alias, page.source_result_id ?? null, page.url, page.final_url ?? null, page.canonical_url, page.title,
        page.fetched_at, page.content_hash, page.extractor, page.confidence, page.artifact_dir, page.semantic_html_path,
        page.markdown_path, page.text_path, page.metadata_path, page.chunks_path,
        JSON.stringify({ warnings: page.warnings }),
      );
      for (const c of chunks) {
        chunkStmt.run(c.id, c.page_id, c.ordinal, c.heading_path ?? null, c.semantic_html_path, c.markdown_path, c.text_path, c.line_start ?? null, c.line_end ?? null, c.text, c.token_count);
        ftsStmt.run(c.id, c.page_id, page.title, page.final_url ?? page.url, c.heading_path ?? null, c.text);
      }
    });
  }

  hasChunks(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number };
    return row.count > 0;
  }

  lookup(query: string, limit: number, domain: string | null | undefined, format: EvidenceFormat = "auto", matchMode: LookupMatchMode = "any"): LookupHit[] {
    if (!this.hasChunks()) {
      throw toolExecutionError("No fetched web evidence is indexed yet.", "Call web_fetch on URLs or web_search result aliases before using web_lookup.");
    }
    const ftsQuery = normalizeFtsQuery(query, matchMode);
    const preferred = preferredPathExpression(format);
    const rows = this.db.prepare(`
      SELECT p.id AS page_id, p.alias AS page_alias, p.title, COALESCE(p.final_url, p.url) AS url,
        ${preferred} AS path,
        p.semantic_html_path, p.markdown_path, p.text_path,
        c.line_start, c.line_end, c.id AS chunk_id, c.heading_path, c.text AS text,
        snippet(chunk_fts, 5, '', '', ' ... ', 18) AS snippet
      FROM chunk_fts
      JOIN chunks c ON c.id = chunk_fts.chunk_id
      JOIN pages p ON p.id = c.page_id
      WHERE chunk_fts MATCH ?
      ORDER BY bm25(chunk_fts)
      LIMIT ?
    `).all(ftsQuery, domain ? Math.max(limit * 10, 50) : limit) as unknown as LookupHit[];
    const terms = matchedTerms(query);
    return rows
      .filter((row) => !domain || domainMatches(row.url, domain))
      .slice(0, limit)
      .map((row) => {
        const text = "text" in row && typeof row.text === "string" ? row.text : "";
        const matched = matchedTermsInText(terms, [row.title, row.heading_path ?? "", row.snippet, text].join("\n"));
        const { text: _text, ...publicRow } = row as LookupHit & { text?: string };
        const best_format = format === "markdown" || format === "semantic_html" || format === "text" ? format : "text";
        return {
          ...publicRow,
          best_path: publicRow.path,
          best_format,
          line_start: format === "markdown" || format === "semantic_html" ? undefined : row.line_start,
          line_end: format === "markdown" || format === "semantic_html" ? undefined : row.line_end,
          matched_terms: matched,
          match_mode: matchMode,
        };
      });
  }

  private withTransaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function rowToPage(row: PageRecord & { metadata_json?: string }): PageRecord {
  let warnings: string[] = [];
  try {
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) as { warnings?: unknown } : {};
    warnings = Array.isArray(metadata.warnings) ? metadata.warnings.filter((v): v is string => typeof v === "string") : [];
  } catch {
    warnings = [];
  }
  return { ...row, warnings };
}

export function normalizeFtsQuery(query: string, matchMode: LookupMatchMode = "any"): string {
  const trimmed = query.trim();
  if (!trimmed) throw toolExecutionError("web_lookup query is empty.", "Pass a non-empty term or phrase.");
  const terms = trimmed.match(/"[^"]+"|[^\s]+/g) ?? [];
  const ftsTerms = terms.flatMap((term) => {
    const raw = term.startsWith("\"") && term.endsWith("\"") ? term.slice(1, -1) : term;
    const parts = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!parts.length) return [];
    return [quoteFtsPhrase(parts.join(" "))];
  });
  if (!ftsTerms.length) throw toolExecutionError("web_lookup query has no searchable terms.", "Pass an identifier, word, or quoted phrase.");
  if (matchMode === "phrase") {
    const phraseParts = trimmed.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!phraseParts.length) throw toolExecutionError("web_lookup query has no searchable terms.", "Pass an identifier, word, or quoted phrase.");
    return quoteFtsPhrase(phraseParts.join(" "));
  }
  if (matchMode === "all") return ftsTerms.join(" AND ");
  return ftsTerms.join(" OR ");
}

export function matchedTerms(query: string): string[] {
  return Array.from(new Set((query.match(/[A-Za-z0-9_./:-]+/g) ?? []).map((s) => s.toLowerCase()))).slice(0, 8);
}

function matchedTermsInText(terms: string[], text: string): string[] {
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term));
}

function preferredPathExpression(format: EvidenceFormat): string {
  if (format === "markdown") return "p.markdown_path";
  if (format === "text" || format === "auto") return "p.text_path";
  return "p.semantic_html_path";
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function domainMatches(url: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  } catch {
    return false;
  }
}
