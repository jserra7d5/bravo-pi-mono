import type { EvidenceFormat, WebLookupResult, WebLookupResultItem } from "./types.js";

export function lookupContentSummary(results: WebLookupResultItem[]): string {
  if (!results.length) return "web_lookup found no matches in fetched evidence.";
  return [
    `web_lookup found ${results.length} match${results.length === 1 ? "" : "es"} in fetched evidence.`,
    ...results.map((r) => {
      const line = r.line_start ? `:${r.line_start}` : "";
      return `[${r.page_alias}:${r.chunk_id}] ${r.title}${r.heading_path ? ` > ${r.heading_path}` : ""}\npath: ${r.path}${line}\nmatched: ${r.matched_terms.join(", ")}\n${r.snippet}`;
    }),
  ].join("\n\n");
}

export function lookupResult(results: WebLookupResultItem[], limit: number): WebLookupResult {
  return {
    results,
    count: results.length,
    truncated: results.length >= limit,
    next_cursor: null,
  };
}

export function preferredPath(item: { semantic_html_path: string; markdown_path: string; text_path: string }, format: EvidenceFormat = "auto"): string {
  if (format === "markdown") return item.markdown_path;
  if (format === "text") return item.text_path;
  return item.semantic_html_path;
}
