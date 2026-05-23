export const WEB_EVIDENCE_PROMPT_MODULE = `## Web Evidence

When web evidence tools are available, use them for live web discovery and local evidence collection.

Use \`web_search\` when you need candidate pages from the public web. Treat snippets as leads, not evidence.

Use \`web_fetch\` when a result or URL is worth reading, citing, or searching. Fetched pages become temporary local artifacts; read returned paths with normal filesystem tools.

Use \`web_lookup\` to search within pages already fetched in this session, especially for exact terms, identifiers, API names, error strings, and quoted phrases.

Prefer primary sources and official documentation when they are available. Do not cite claims from search snippets alone; cite the fetched/read artifact or the source URL.`;

export function appendWebEvidencePrompt(systemPrompt: string): string {
  if (systemPrompt.includes("## Web Evidence")) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${WEB_EVIDENCE_PROMPT_MODULE}`;
}
