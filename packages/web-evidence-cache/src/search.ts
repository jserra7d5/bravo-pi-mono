import { randomUUID } from "node:crypto";
import type { SearchResultRecord, WebSearchInput } from "./types.js";

export function assignSearchIdentities(results: Omit<SearchResultRecord, "id" | "alias" | "query" | "rank" | "created_at">[], input: WebSearchInput, nextAlias: () => string): SearchResultRecord[] {
  const now = new Date().toISOString();
  return results.map((result, index) => ({
    ...result,
    id: randomUUID(),
    alias: nextAlias(),
    query: input.query,
    rank: index + 1,
    created_at: now,
  }));
}

export function searchContentSummary(results: SearchResultRecord[]): string {
  if (!results.length) return "web_search found no results.";
  return [
    `web_search found ${results.length} discovery lead${results.length === 1 ? "" : "s"}. Titles and snippets are leads only; next step: call web_fetch with selected result aliases or UUID ids, then read artifacts before citing evidence.`,
    ...results.map((r) => `[${r.alias}] id ${r.id} — ${r.title}\n${r.url}${r.snippet ? `\nsnippet: ${r.snippet}` : ""}`),
  ].join("\n\n");
}
