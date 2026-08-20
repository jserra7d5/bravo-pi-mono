import type { QueryResponse, SearchHit, SearchSnippetWindow } from "./types.js";

export const MAX_RENDER_CODE_POINTS = 8_000;

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function takeCodePoints(text: string, maximum: number): string {
  return Array.from(text).slice(0, Math.max(0, maximum)).join("");
}

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
  const context = window.context ? ` in ${window.context.kind} ${window.context.name}` : "";
  const heading = `  lines ${window.lineStart}${window.lineEnd !== window.lineStart ? `-${window.lineEnd}` : ""}${context}:`;
  const lines = window.text.split("\n");
  return [heading, ...lines.map((line) => `    ${line}`)];
}

function renderHit(hit: SearchHit): string {
  const loc = formatLocation(hit);
  const fields = formatFields(hit);
  if (hit.snippets?.length) {
    const lines = [`- ${loc} [${hit.score.toFixed(3)}]${fields}`];
    for (const snippet of hit.snippets) lines.push(...renderSnippetWindow(snippet));
    return lines.join("\n");
  }
  return `- ${loc} [${hit.score.toFixed(3)}]${fields} ${formatLegacySnippet(hit.snippet)}`;
}

function warningLine(result: QueryResponse): string | undefined {
  return result.warnings?.length ? `Warnings: ${result.warnings.join("; ")}` : undefined;
}

function compactWarningLine(result: QueryResponse): string | undefined {
  if (!result.warnings?.length) return undefined;
  const codes = result.warnings.map((warning) => {
    const colon = warning.indexOf(":");
    return (colon >= 0 ? warning.slice(0, colon) : warning.split(/\s/, 1)[0] ?? warning).trim();
  }).filter(Boolean);
  return `Warnings: ${codes.join("; ")} [details compacted]`;
}

/** Fit ancillary text into the hard cap without mutating the response details. */
function cappedText(parts: string[], requiredTail?: string, compactTail = requiredTail): string {
  const body = parts.filter(Boolean).join("\n");
  const full = requiredTail ? `${body}\n${requiredTail}` : body;
  if (codePointLength(full) <= MAX_RENDER_CODE_POINTS) return full;

  const marker = "[Output compacted to 8,000 code points.]";
  let tail = requiredTail;
  if (tail && codePointLength(marker) + codePointLength(tail) + 1 >= MAX_RENDER_CODE_POINTS) tail = compactTail;
  if (tail) {
    const maximumTail = MAX_RENDER_CODE_POINTS - codePointLength(marker) - 2;
    tail = takeCodePoints(tail, maximumTail);
  }
  const suffix = tail ? `${marker}\n${tail}` : marker;
  const bodyAllowance = MAX_RENDER_CODE_POINTS - codePointLength(suffix) - 1;
  return bodyAllowance > 0 ? `${takeCodePoints(body, bodyAllowance)}\n${suffix}` : suffix;
}

export function renderQueryResult(result: QueryResponse): string {
  const warnings = warningLine(result);
  const compactWarnings = compactWarningLine(result);
  if (!result.ok) {
    return cappedText([`ranked_search failed: ${result.error ?? "unknown error"}`], warnings, compactWarnings);
  }
  if (!result.hits.length) {
    return cappedText([`No ranked_search matches for ${JSON.stringify(result.query ?? "")}. Try broader terms or synonyms, then use grep for exact confirmation.`], warnings, compactWarnings);
  }
  const modifiers = [
    ...(result.boosts?.length ? [`boosts: ${result.boosts.map((boost) => `${boost.term}×${boost.weight}`).join(", ")}`] : []),
    ...(result.excludeTerms?.length ? [`excluded: ${result.excludeTerms.join(", ")}`] : []),
  ];
  const status = [result.indexFreshness, ...modifiers].filter(Boolean).join("; ");
  const header = `ranked_search found ${result.hits.length} match${result.hits.length === 1 ? "" : "es"}${status ? ` (${status})` : ""}:`;
  const blocks = result.hits.map(renderHit);
  const budgetedWarnings = warnings && codePointLength(warnings) < MAX_RENDER_CODE_POINTS ? warnings : compactWarnings;
  const reservedWarningLength = budgetedWarnings ? codePointLength(`\n${budgetedWarnings}`) : 0;
  const included: string[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const candidate = [header, ...included, blocks[index]!].join("\n");
    const remaining = blocks.length - index - 1;
    const notice = remaining ? `\n[${remaining} lower-ranked result${remaining === 1 ? "" : "s"} omitted to fit output limit.]` : "";
    if (codePointLength(candidate) + codePointLength(notice) + reservedWarningLength <= MAX_RENDER_CODE_POINTS) {
      included.push(blocks[index]!);
      continue;
    }
    break;
  }

  const omitted = blocks.length - included.length;
  const omissionNotice = omitted > 0 ? `[${omitted} lower-ranked result${omitted === 1 ? "" : "s"} omitted to fit output limit.]` : undefined;
  const tail = [omissionNotice, warnings].filter((part): part is string => Boolean(part)).join("\n");
  const compactTail = [omissionNotice, compactWarnings].filter((part): part is string => Boolean(part)).join("\n");
  return cappedText([header, ...included], tail || undefined, compactTail || undefined);
}
