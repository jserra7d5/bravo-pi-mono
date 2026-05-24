import type { QueryResponse } from "./types.js";

export function renderQueryResult(result: QueryResponse): string {
  if (!result.ok) return `ranked_search failed: ${result.error ?? "unknown error"}`;
  if (!result.hits.length) return `No ranked_search matches for ${JSON.stringify(result.query ?? "")}. Try broader terms or synonyms, then use grep for exact confirmation.`;
  const lines = [`ranked_search found ${result.hits.length} match${result.hits.length === 1 ? "" : "es"}${result.indexFreshness ? ` (${result.indexFreshness})` : ""}:`];
  for (const hit of result.hits) {
    const loc = hit.line ? `${hit.path}:${hit.line}` : hit.path;
    lines.push(`- ${loc} [${hit.score.toFixed(3)}] ${hit.snippet.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  if (result.warnings?.length) lines.push(`Warnings: ${result.warnings.join("; ")}`);
  return lines.join("\n");
}
