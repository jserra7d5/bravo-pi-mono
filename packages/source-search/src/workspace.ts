import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceRepo { name: string; path: string; }
export interface WorkspaceConfig { repos: WorkspaceRepo[]; defaultRepos: string[]; }

export async function gitRoot(start: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", start, "rev-parse", "--show-toplevel"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspaceFrom(raw: unknown): WorkspaceConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.enabled === false) return null;
  const ws = obj.workspace;
  if (!ws || typeof ws !== "object" || Array.isArray(ws)) return null;
  const w = ws as Record<string, unknown>;
  if (!Array.isArray(w.repos)) return null;
  const repos: WorkspaceRepo[] = [];
  for (const entry of w.repos) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || typeof e.path !== "string" || isAbsolute(e.path) || e.path.includes("..")) continue;
    repos.push({ name: e.name, path: e.path });
  }
  const names = new Set(repos.map((r) => r.name));
  const defaultRepos = Array.isArray(w.defaultRepos)
    ? w.defaultRepos.filter((v): v is string => typeof v === "string" && names.has(v))
    : repos.map((r) => r.name);
  return repos.length ? { repos, defaultRepos } : null;
}

export function loadWorkspaceConfig(cwd: string): WorkspaceConfig | null {
  return workspaceFrom(readJson(join(cwd, ".bravo", "source-search.json")));
}

export async function resolveRepoPath(cwd: string, inputPath?: string): Promise<{ repoRoot: string; pathPrefix?: string } | null> {
  const base = inputPath ? resolve(cwd, inputPath) : cwd;
  const root = await gitRoot(base);
  if (!root) return null;
  const canonicalRoot = await realpath(root);
  const canonicalBase = await realpath(base).catch(() => realpath(dirname(base)));
  const rel = relative(canonicalRoot, canonicalBase);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`)) return null;
  return { repoRoot: canonicalRoot, pathPrefix: rel && rel !== "." ? rel : undefined };
}

export async function resolveWorkspaceSearch(cwd: string, inputPath?: string): Promise<{ workspaceRoot: string; repos: Array<{ name: string; repoRoot: string; pathPrefix?: string }> } | null> {
  const config = loadWorkspaceConfig(cwd);
  if (!config) return null;
  if (inputPath) {
    const abs = resolve(cwd, inputPath);
    for (const repo of config.repos) {
      const repoRoot = await realpath(resolve(cwd, repo.path)).catch(() => null);
      if (!repoRoot) continue;
      const relToRepo = relative(repoRoot, abs);
      if (relToRepo === "" || (!relToRepo.startsWith("..") && !isAbsolute(relToRepo))) {
        return { workspaceRoot: cwd, repos: [{ name: repo.name, repoRoot, pathPrefix: relToRepo || undefined }] };
      }
    }
    return { workspaceRoot: cwd, repos: [] };
  }
  const defaults = new Set(config.defaultRepos);
  const repos = [];
  for (const repo of config.repos.filter((r) => defaults.has(r.name))) {
    const repoRoot = await realpath(resolve(cwd, repo.path)).catch(() => null);
    if (repoRoot && await gitRoot(repoRoot)) repos.push({ name: repo.name, repoRoot });
  }
  return { workspaceRoot: cwd, repos };
}

export function sourceSearchConfigExists(dir: string): boolean {
  return existsSync(join(dir, ".bravo", "source-search.json"));
}
