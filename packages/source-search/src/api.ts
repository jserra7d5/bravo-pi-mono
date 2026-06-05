import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { queryRepo } from "./live.js";
import { resolveRepoPath } from "./workspace.js";
import type { QueryResponse, TermBoost } from "./types.js";

export type { QueryResponse, SearchHit, SearchSnippetWindow, TermBoost } from "./types.js";

export interface SourceSearchQueryOptions {
  cwd: string;
  query: string;
  path?: string;
  limit?: number;
  boosts?: TermBoost[];
  excludeTerms?: string[];
}

export interface SourceSearchPolicyDecision {
  allowed: boolean;
  reason?: string;
}

const SECRET_PATH_RE = /(^|\/)(\.git(?:\/|$)|\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|id_rsa$|id_dsa$|.*secret.*|.*credential.*|.*token.*)(?:\/|$)?/i;
const DENIED_DIR_RE = /(^|\/)(dist|build|target|node_modules)(\/|$)/i;

async function readIgnorePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  for (const rel of [".gitignore", ".agentignore", ".piignore"]) {
    try {
      const raw = await readFile(resolve(root, rel), "utf8");
      patterns.push(...raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!")));
    } catch {
      // Missing or unreadable ignore files are treated as no additional patterns.
    }
  }
  try {
    const raw = await readFile(resolve(root, ".bravo", "source-search.json"), "utf8");
    const parsed = JSON.parse(raw) as { exclude?: unknown };
    if (Array.isArray(parsed.exclude)) patterns.push(...parsed.exclude.filter((item): item is string => typeof item === "string"));
  } catch {
    // Missing or invalid Source Search config is handled by live query execution.
  }
  return patterns;
}

function simpleStarMatch(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return path === pattern;
  const anchoredStart = !pattern.startsWith("*");
  const anchoredEnd = !pattern.endsWith("*");
  const parts = pattern.split("*").filter(Boolean);
  if (!parts.length) return true;
  let remaining = path;
  for (let i = 0; i < parts.length; i += 1) {
    const pos = remaining.indexOf(parts[i]!);
    if (pos < 0) return false;
    if (i === 0 && anchoredStart && pos !== 0) return false;
    remaining = remaining.slice(pos + parts[i]!.length);
  }
  return anchoredEnd ? remaining.length === 0 : true;
}

function pathHasDirComponent(path: string, dirPattern: string): boolean {
  return path === dirPattern || path.startsWith(`${dirPattern}/`) || path.includes(`/${dirPattern}/`);
}

function simpleMatch(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedPattern.endsWith("/")) return pathHasDirComponent(path, normalizedPattern.slice(0, -1));
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (simpleStarMatch(prefix, path)) return true;
    for (let i = 0; i < path.length; i += 1) if (path[i] === "/" && simpleStarMatch(prefix, path.slice(0, i))) return true;
    return false;
  }
  return simpleStarMatch(normalizedPattern, path);
}

/**
 * Stable package API for callers that need Source Search retrieval without
 * importing Pi-extension internals.
 */
export async function rankedSearch(options: SourceSearchQueryOptions): Promise<QueryResponse> {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 10)));
  const scope = await resolveRepoPath(options.cwd, options.path);
  if (scope) return queryRepo(scope.repoRoot, options.query, limit, scope.pathPrefix, options.boosts, options.excludeTerms);

  const root = resolve(options.cwd, options.path ?? ".");
  const exists = await stat(root).catch(() => null);
  if (!exists || (!exists.isDirectory() && !exists.isFile())) return { protocolVersion: 1, ok: false, hits: [], count: 0, error: "No searchable directory found for ranked_search." };
  const searchRoot = exists.isFile() ? dirname(root) : root;
  const pathPrefix = exists.isFile() ? basename(root) : undefined;
  return queryRepo(searchRoot, options.query, limit, pathPrefix, options.boosts, options.excludeTerms);
}

/** Conservative TypeScript-side guard for paths read outside live search. */
export async function sourceSearchPolicy(cwd: string, candidatePath: string): Promise<SourceSearchPolicyDecision> {
  const normalized = candidatePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  if (SECRET_PATH_RE.test(lower) || DENIED_DIR_RE.test(lower)) return { allowed: false, reason: "path is denied by Source Search safety policy" };
  const root = await realpath(cwd).catch(() => cwd);
  const abs = resolve(root, normalized);
  const real = await realpath(abs).catch(() => abs);
  if (real !== root && !real.startsWith(`${root}/`)) return { allowed: false, reason: "path escapes search root" };
  const patterns = await readIgnorePatterns(root);
  const ignored = patterns.find((pattern) => simpleMatch(pattern, normalized));
  if (ignored) return { allowed: false, reason: `path is ignored by Source Search policy: ${ignored}` };
  return { allowed: true };
}
