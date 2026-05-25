import { gitRoot, loadWorkspaceConfig, sourceSearchConfigExists, discoverChildGitRepos } from "./workspace.js";

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

  const candidates = await discoverChildGitRepos(cwd, 12).catch(() => []);
  if (candidates.length) return { kind: "workspace-candidates", cwd, childCandidates: candidates.map((repo) => repo.name) };
  return { kind: "none", cwd };
}

export function renderDiscoveryPrompt(discovery: Discovery): string {
  if (discovery.kind === "repo") {
    return "## Source Search\n\nranked_search is available for this git checkout. Use it as the default first-pass discovery tool for broad lexical repo search, then use read or grep to inspect exact evidence. Use typed boosts/excludeTerms for ranking noise control; do not put boost or boolean syntax in the query string. A Source Search index/cache is optional; if unavailable, ranked_search falls back to live git-aware scanning.";
  }
  if (discovery.kind === "workspace") {
    return `## Source Search\n\nranked_search is available for this workspace. Configured child checkouts: ${discovery.workspaceRepos?.join(", ")}. Use ranked_search as the default first-pass discovery tool across configured child checkouts, then use read or grep for exact evidence. Use typed boosts/excludeTerms for ranking noise control; do not put boost or boolean syntax in the query string. Configure dev/prod/worktree variants as separate checkout paths.`;
  }
  if (discovery.kind === "workspace-candidates") {
    return `## Source Search\n\nranked_search can opportunistically search detected immediate child git checkouts from this directory (conservative scope): ${discovery.childCandidates?.join(", ")}. For stable names/default repos, curated excludes, and performance, configure workspace.repos in .bravo/source-search.json.`;
  }
  return "## Source Search\n\nSource Search is installed, but this directory is not a git checkout and no searchable scope was detected. Run from a git checkout or a parent containing immediate child git checkouts; use config for curated workspace scope/performance.";
}

export function appendSourceSearchPrompt(systemPrompt: string, discovery: Discovery): string {
  return `${systemPrompt.trimEnd()}\n\n${renderDiscoveryPrompt(discovery)}`;
}
