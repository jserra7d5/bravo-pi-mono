export const WEB_EVIDENCE_PROMPT_MODULE = `## Web Evidence

Use web evidence tools as a three-step workflow:

1. \`web_search\` discovers candidate public web pages only. Titles and snippets are navigation leads, not evidence.
2. \`web_fetch\` materializes selected URLs or search result refs into local artifacts. Normally call it with only \`{ refs }\`; omit \`format\` and \`refresh\` unless you specifically need an alternate view or forced refetch. Read \`READ NEXT\` / \`best_path\` before citing.
3. \`web_lookup\` searches only already-fetched artifacts. Default \`match_mode: "any"\` is recall, not verification; use \`"all"\` or \`"phrase"\` when common terms make hits noisy. No matches are not proof of absence; broaden terms or fetch more sources.

Prefer primary and official sources. Do not cite search snippets, lookup snippets, or orientation previews; cite only after reading the fetched artifact or source page.`;

export function appendWebEvidencePrompt(systemPrompt: string): string {
  if (systemPrompt.includes("## Web Evidence")) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${WEB_EVIDENCE_PROMPT_MODULE}`;
}
