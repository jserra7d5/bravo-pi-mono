import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gitRoot, loadWorkspaceConfig, sourceSearchConfigExists } from "./workspace.js";

export interface Discovery {
  kind: "repo" | "workspace" | "workspace-candidates" | "none";
  cwd: string;
  repoRoot?: string;
  hasConfig?: boolean;
  childCandidates?: string[];
  workspaceRepos?: string[];
}

export async function discoverSourceSearch(cwd: string): Promise<Discovery> {
  const repoRoot = await gitRoot(cwd);
  if (repoRoot) return { kind: "repo", cwd, repoRoot, hasConfig: sourceSearchConfigExists(repoRoot) };

  const workspace = loadWorkspaceConfig(cwd);
  if (workspace) return { kind: "workspace", cwd, workspaceRepos: workspace.defaultRepos.length ? workspace.defaultRepos : workspace.repos.map((r) => r.name) };

  const candidates: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    for (const entry of entries.slice(0, 100)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = join(cwd, entry.name);
      const git = join(child, ".git");
      if ((await stat(git).catch(() => null))) candidates.push(entry.name);
      if (candidates.length >= 12) break;
    }
  } catch {
    // best effort only
  }
  if (candidates.length) return { kind: "workspace-candidates", cwd, childCandidates: candidates };
  return { kind: "none", cwd };
}

export function renderDiscoveryPrompt(discovery: Discovery): string {
  if (discovery.kind === "repo") {
    return "## Source Search\n\nranked_search is available for this git checkout. Use it as the default first-pass discovery tool for broad lexical repo search, then use read or grep to inspect exact evidence. Use typed boosts/excludeTerms for ranking noise control; do not put boost or boolean syntax in the query string. The Source Search index is managed automatically on first use.";
  }
  if (discovery.kind === "workspace") {
    return `## Source Search\n\nranked_search is available for this workspace. Configured child checkouts: ${discovery.workspaceRepos?.join(", ")}. Use ranked_search as the default first-pass discovery tool across configured child checkouts, then use read or grep for exact evidence. Use typed boosts/excludeTerms for ranking noise control; do not put boost or boolean syntax in the query string. Configure dev/prod/worktree variants as separate checkout paths.`;
  }
  if (discovery.kind === "workspace-candidates") {
    return `## Source Search\n\nSource Search is installed, but this directory is not a git checkout and has no workspace registry. Detected child git checkouts are candidates only, not default search scope: ${discovery.childCandidates?.join(", ")}. Use the source-search skill to configure workspace.repos before relying on ranked workspace search.`;
  }
  return "## Source Search\n\nSource Search is installed, but this directory is not a git checkout and no configured searchable scope was detected. Use the source-search skill or source-search CLI for setup.";
}

export function appendSourceSearchPrompt(systemPrompt: string, discovery: Discovery): string {
  return `${systemPrompt.trimEnd()}\n\n${renderDiscoveryPrompt(discovery)}`;
}
