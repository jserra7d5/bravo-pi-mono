import type { EvidenceFormat, WebLookupResult, WebLookupResultItem } from "./types.js";

export function lookupContentSummary(results: WebLookupResultItem[]): string {
  if (!results.length) return "web_lookup found no matches in fetched evidence. This searches already-fetched artifacts only; no matches are not proof of absence. Recovery routes: try broader/synonym terms, remove domain filters, fetch more likely sources with web_fetch, or run web_search to discover additional pages.";
  return [
    `web_lookup found ${results.length} recall-oriented match${results.length === 1 ? "" : "es"} in already-fetched evidence. READ NEXT: open each best_path at the shown line when present, inspect surrounding artifact context before citing, and do not treat missing hits as proof of absence. Other artifact paths remain in result details for alternate views.`,
    ...results.map((r) => {
      const line = r.line_start ? `:${r.line_start}` : "";
      return `[${r.page_id}:${r.chunk_id}] ${r.title}${r.heading_path ? ` > ${r.heading_path}` : ""}\nREAD NEXT (${r.best_format}): ${r.best_path}${line}\nmatched (${r.matched_terms.length ? "any" : "none"}): ${r.matched_terms.join(", ") || "—"}\norientation snippet (not citable): ${r.snippet}\nnext step: read READ NEXT/best_path and verify the surrounding artifact text before using as evidence.`;
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

export function bestFormat(format: EvidenceFormat = "auto"): Exclude<EvidenceFormat, "auto"> {
  if (format === "markdown" || format === "semantic_html" || format === "text") return format;
  return "text";
}

export function preferredPath(item: { semantic_html_path: string; markdown_path: string; text_path: string }, format: EvidenceFormat = "auto"): string {
  const best = bestFormat(format);
  if (best === "markdown") return item.markdown_path;
  if (best === "text") return item.text_path;
  return item.semantic_html_path;
}
