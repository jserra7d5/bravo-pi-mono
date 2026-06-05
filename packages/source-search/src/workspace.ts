import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitRoot(start: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", start, "rev-parse", "--show-toplevel"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveRepoPath(cwd: string, inputPath?: string): Promise<{ repoRoot: string; pathPrefix?: string } | null> {
  const base = inputPath ? resolve(cwd, inputPath) : cwd;
  const root = await gitRoot(base);
  if (!root) return null;
  const canonicalRoot = await realpath(root);
  const canonicalBase = await realpath(base).catch(() => null);
  if (!canonicalBase) return null;
  const rel = relative(canonicalRoot, canonicalBase);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`)) return null;
  return { repoRoot: canonicalRoot, pathPrefix: rel && rel !== "." ? rel : undefined };
}

export function sourceSearchConfigExists(dir: string): boolean {
  return existsSync(join(dir, ".bravo", "source-search.json"));
}
