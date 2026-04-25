import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/*.js -> package root, src/*.ts when run with tsx -> package root
  if (basename(here) === "dist" || basename(here) === "src") return dirname(here);
  return dirname(here);
}

export function dataRoot(): string {
  return process.env.TANGO_HOME ? resolve(process.env.TANGO_HOME) : join(homedir(), ".tango");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function projectSlug(cwd: string): string {
  const resolved = resolve(cwd);
  const base = basename(resolved).replace(/[^a-zA-Z0-9_.-]+/g, "-") || "root";
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function projectRunRoot(cwd: string): string {
  return ensureDir(join(dataRoot(), "runs", projectSlug(cwd)));
}

export function runDirFor(cwd: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return join(projectRunRoot(cwd), safe);
}

export function userRolesDir(): string { return join(dataRoot(), "roles"); }
export function userIncludesDir(): string { return join(dataRoot(), "includes"); }
export function userSkillsDir(): string { return join(dataRoot(), "skills"); }
export function packageRolesDir(): string { return join(packageRoot(), "roles"); }
export function packageIncludesDir(): string { return join(packageRoot(), "includes"); }
export function packageSkillsDir(): string { return join(packageRoot(), "skills"); }

export function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}
