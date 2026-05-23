import type { EvidenceFormat, WebLookupResult, WebLookupResultItem } from "./types.js";

export function lookupContentSummary(results: WebLookupResultItem[]): string {
  if (!results.length) return "web_lookup found no matches in fetched evidence. This is recall-oriented over already-fetched artifacts only, not proof the claim is absent from the web or source.";
  return [
    `web_lookup found ${results.length} recall-oriented match${results.length === 1 ? "" : "es"} in already-fetched evidence; inspect artifacts before treating as proof, and do not treat missing hits as proof of absence.`,
    ...results.map((r) => {
      const line = r.line_start ? `:${r.line_start}` : "";
      return `[${r.page_id}:${r.chunk_id}] ${r.title}${r.heading_path ? ` > ${r.heading_path}` : ""}\nbest (${r.best_format}): ${r.best_path}${line}\nmatched (${r.matched_terms.length ? "any" : "none"}): ${r.matched_terms.join(", ") || "—"}\n${r.snippet}`;
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
