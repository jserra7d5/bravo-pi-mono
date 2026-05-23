import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import { assertSafeRedirect, assertSafeUrl, canonicalizeUrl } from "./safety.js";
import { adapterError, toolExecutionError } from "./errors.js";
import { extractDocument } from "./extract.js";
import { chunkSemanticHtml } from "./chunking.js";
import { ensureDir, pageArtifactPaths, sha256, writeTextFile } from "./filesystem.js";
import type { SessionRegistry } from "./cache.js";
import { preferredPath } from "./lookup.js";
import type { EvidenceFormat, PageRecord, WebFetchResultItem } from "./types.js";
import type { WebCacheConfig } from "./config.js";
import { composeAbortSignal } from "./signals.js";

export interface FetchRef {
  url: string;
  sourceResultId?: string;
}

export async function fetchEvidence(ref: FetchRef, registry: SessionRegistry, config: WebCacheConfig, format: EvidenceFormat = "auto", refresh: "auto" | "force" = "auto", signal?: AbortSignal): Promise<WebFetchResultItem> {
  const canonical = canonicalizeUrl(ref.url);
  const existing = registry.db.findPageByUrlIdentity(canonical);
  if (refresh === "auto" && existing) return pageToFetchItem(existing, format, true);
  const fetched = await fetchHtml(canonical, config, signal);
  const pageId = existing?.id ?? randomUUID();
  const alias = existing?.alias ?? pageId;
  const extraction = await extractDocument(fetched.body, fetched.finalUrl, pageId);
  const paths = pageArtifactPaths(registry.rootDir, pageId);
  await ensureDir(paths.artifactDir);
  const chunked = chunkSemanticHtml({ pageId, semanticHtml: extraction.semanticHtml, text: extraction.text });
  const chunks = chunked.chunks.map((chunk) => ({
    ...chunk,
    page_id: pageId,
    semantic_html_path: paths.semanticHtmlPath,
    markdown_path: paths.markdownPath,
    text_path: paths.textPath,
  }));
  await writeTextFile(paths.semanticHtmlPath, chunked.semanticHtml);
  await writeTextFile(paths.markdownPath, extraction.markdown);
  await writeTextFile(paths.textPath, extraction.text);
  const page: PageRecord = {
    id: pageId,
    alias,
    source_result_id: ref.sourceResultId,
    url: canonical,
    final_url: fetched.finalUrl,
    canonical_url: canonicalizeUrl(fetched.finalUrl),
    title: extraction.title,
    fetched_at: new Date().toISOString(),
    content_hash: sha256(extraction.semanticHtml),
    extractor: extraction.engine,
    confidence: extraction.confidence,
    warnings: extraction.warnings,
    artifact_dir: paths.artifactDir,
    semantic_html_path: paths.semanticHtmlPath,
    markdown_path: paths.markdownPath,
    text_path: paths.textPath,
    metadata_path: paths.metadataPath,
    chunks_path: paths.chunksPath,
  };
  await writeTextFile(paths.metadataPath, `${JSON.stringify({ ...page, extraction: { engine: extraction.engine, confidence: extraction.confidence, warnings: extraction.warnings } }, null, 2)}\n`);
  await writeTextFile(paths.chunksPath, `${JSON.stringify(chunks, null, 2)}\n`);
  registry.db.insertPageWithChunks(page, chunks);
  registry.pageAliasToId.set(alias, pageId);
  return pageToFetchItem(page, format, true, extraction.text);
}

export async function fetchHtml(initialUrl: string, config: WebCacheConfig, signal?: AbortSignal): Promise<{ finalUrl: string; body: string; contentType?: string }> {
  let url = await assertSafeUrl(initialUrl);
  const requestSignal = composeAbortSignal(config.timeoutMs, signal);
  for (let redirect = 0; redirect <= config.maxRedirects; redirect++) {
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2", "Accept-Language": "en", "User-Agent": "pi-web-evidence-cache/0.1" },
        signal: requestSignal,
      });
    } catch (cause) {
      throw adapterError(`Fetch failed for ${url}.`, "Retry later or choose another source URL.", cause);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (redirect === config.maxRedirects) throw adapterError("Too many redirects while fetching web evidence.", "Fetch the final public URL directly.");
      url = await assertSafeRedirect(url, response.headers.get("location") ?? "");
      continue;
    }
    if (!response.ok) {
      throw adapterError(`Fetch returned HTTP ${response.status} for ${url}.`, "Choose another source or retry later.");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      throw toolExecutionError(`Unsupported content type: ${contentType || "unknown"}`, "Fetch an HTML or plain text page for the MVP.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw adapterError("Fetch returned no response body.", "Retry later or choose another source URL.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > config.maxBytes) {
          await reader.cancel();
          throw toolExecutionError(`Response exceeded ${config.maxBytes} bytes.`, "Choose a smaller source page.");
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { finalUrl: url, body: contentType.startsWith("text/plain") ? `<pre>${escapeHtml(body)}</pre>` : body, contentType };
  }
  throw adapterError("Too many redirects while fetching web evidence.", "Fetch the final public URL directly.");
}

function pageToFetchItem(page: PageRecord, format: EvidenceFormat, indexed: boolean, text?: string): WebFetchResultItem {
  const preview = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
  const best_format = fetchBestFormat(format);
  return {
    ...page,
    indexed,
    best_path: preferredPath(page, best_format),
    best_format,
    preview,
    extraction: {
      engine: page.extractor,
      confidence: page.confidence,
      warnings: page.warnings,
    },
  };
}

export function fetchContentSummary(results: WebFetchResultItem[]): string {
  if (!results.length) return "web_fetch fetched no pages. Next step: choose another URL/ref or run web_search for candidate pages.";
  return [
    `web_fetch materialized ${results.length} page${results.length === 1 ? "" : "s"} as local evidence artifacts. READ NEXT: open each best_path before citing; markdown is usually best for prose, semantic_html when structure matters, text for line-oriented lookup/citation. Other artifact paths are available in result details for alternate views. Extraction confidence: good=normal, partial=usable but verify against artifact context, weak=high risk of missing/poor extraction and should be corroborated or refetched from another source.`,
    ...results.map(fetchResultSummary),
  ].join("\n\n");
}

function fetchResultSummary(r: WebFetchResultItem): string {
  const warning = r.extraction.confidence === "good" ? "" : `\nWARNING: extraction ${r.extraction.confidence}; ${r.extraction.warnings.length ? r.extraction.warnings.join("; ") : "verify against the artifact before citing"}`;
  const orientation = r.preview ? `\norientation preview (not citable): ${r.preview.slice(0, 280)}${r.preview.length > 280 ? "…" : ""}` : "";
  return `[${r.id}] ${r.title} · indexed\nREAD NEXT (${r.best_format}): ${r.best_path}${warning}${orientation}\nnext step: read READ NEXT/best_path, then use web_lookup to find terms inside fetched artifacts if needed.`;
}

function fetchBestFormat(format: EvidenceFormat): Exclude<EvidenceFormat, "auto"> {
  if (format === "semantic_html" || format === "markdown" || format === "text") return format;
  return "markdown";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
