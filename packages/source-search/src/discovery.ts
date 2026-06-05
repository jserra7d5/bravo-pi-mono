import { gitRoot, sourceSearchConfigExists } from "./workspace.js";

export interface Discovery {
  kind: "repo" | "directory";
  cwd: string;
  repoRoot?: string;
  hasConfig?: boolean;
}

export async function discoverSourceSearch(cwd: string): Promise<Discovery> {
  const repoRoot = await gitRoot(cwd);
  if (repoRoot) return { kind: "repo", cwd, repoRoot, hasConfig: sourceSearchConfigExists(repoRoot) };
  return { kind: "directory", cwd };
}

export function renderDiscoveryPrompt(discovery: Discovery): string {
  if (discovery.kind === "repo") {
    return "## Source Search\n\nranked_search is available for this git checkout. Use it as the default first-pass discovery tool for live broad lexical source search, then use read or grep to inspect exact evidence. Use typed boosts/excludeTerms for ranking noise control; do not put boost, boolean, or field syntax in the query string.";
  }
  return "## Source Search\n\nranked_search is available for this directory. It searches git-visible files when inside a checkout, otherwise it searches live filesystem files under the current/requested directory with conservative noise/secret excludes.";
}

export function appendSourceSearchPrompt(systemPrompt: string, discovery: Discovery): string {
  return `${systemPrompt.trimEnd()}\n\n${renderDiscoveryPrompt(discovery)}`;
}
