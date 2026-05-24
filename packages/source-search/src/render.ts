import type { QueryResponse, SearchHit, SearchSnippetWindow } from "./types.js";

function formatLegacySnippet(snippet: string): string {
  return snippet.replace(/\s+/g, " ").slice(0, 240);
}

function formatLocation(hit: SearchHit): string {
  if (hit.snippets && hit.snippets.length > 1) {
    const ranges = hit.snippets
      .map((snippet) => snippet.lineEnd !== snippet.lineStart ? `${snippet.lineStart}-${snippet.lineEnd}` : `${snippet.lineStart}`)
      .join(",");
    return `${hit.path}:${ranges}`;
  }
  const start = hit.lineStart ?? hit.line ?? undefined;
  const end = hit.lineEnd ?? start;
  if (!start) return hit.path;
  if (end && end !== start) return `${hit.path}:${start}-${end}`;
  return `${hit.path}:${start}`;
}

function formatFields(hit: SearchHit): string {
  return hit.matchedFields?.length ? ` fields: ${hit.matchedFields.join(", ")}` : "";
}

function renderSnippetWindow(window: SearchSnippetWindow): string[] {
  const truncation = window.truncatedBefore || window.truncatedAfter
    ? ` (truncated ${[window.truncatedBefore ? "before" : "", window.truncatedAfter ? "after" : ""].filter(Boolean).join("/")})`
    : window.truncated ? " (truncated)" : "";
  const context = window.context ? ` in ${window.context.kind} ${window.context.name}` : "";
  const heading = `  lines ${window.lineStart}${window.lineEnd !== window.lineStart ? `-${window.lineEnd}` : ""}${context}${truncation}:`;
  const lines = window.text.split("\n");
  return [heading, ...lines.map((line) => `    ${line}`)];
}

export function renderQueryResult(result: QueryResponse): string {
  if (!result.ok) {
    const warningText = result.warnings?.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
    return `ranked_search failed: ${result.error ?? "unknown error"}${warningText}`;
  }
  if (!result.hits.length) {
    const warningText = result.warnings?.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
    return `No ranked_search matches for ${JSON.stringify(result.query ?? "")}. Try broader terms or synonyms, then use grep for exact confirmation.${warningText}`;
  }
  const modifiers = [
    ...(result.boosts?.length ? [`boosts: ${result.boosts.map((boost) => `${boost.term}×${boost.weight}`).join(", ")}`] : []),
    ...(result.excludeTerms?.length ? [`excluded: ${result.excludeTerms.join(", ")}`] : []),
  ];
  const status = [result.indexFreshness, ...modifiers].filter(Boolean).join("; ");
  const lines = [`ranked_search found ${result.hits.length} match${result.hits.length === 1 ? "" : "es"}${status ? ` (${status})` : ""}:`];
  for (const hit of result.hits) {
    const loc = formatLocation(hit);
    const fields = formatFields(hit);
    if (hit.snippets?.length) {
      lines.push(`- ${loc} [${hit.score.toFixed(3)}]${fields}`);
      for (const snippet of hit.snippets) lines.push(...renderSnippetWindow(snippet));
    } else {
      lines.push(`- ${loc} [${hit.score.toFixed(3)}]${fields} ${formatLegacySnippet(hit.snippet)}`);
    }
  }
  if (result.warnings?.length) lines.push(`Warnings: ${result.warnings.join("; ")}`);
  return lines.join("\n");
}
