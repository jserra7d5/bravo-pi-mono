import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

export function projectRunRoot(cwd: string, options: { create?: boolean } = {}): string {
  const root = join(dataRoot(), "runs", projectSlug(cwd));
  return options.create === false ? root : ensureDir(root);
}

export function validateAgentName(name: string): string {
  if (!name) throw new Error("Agent name must not be empty.");
  if (name !== name.trim()) throw new Error("Agent name must not start or end with whitespace.");
  if (name === "." || name === "..") throw new Error("Agent name must not be '.' or '..'.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new Error("Agent name may only contain letters, numbers, '_', '.', or '-', and must start with a letter or number.");
  }
  return name;
}

export function assertPathContained(parent: string, child: string, label = "path"): string {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && rel !== "..")) return target;
  throw new Error(`${label} escapes expected directory: ${target}`);
}

export function runDirFor(cwd: string, name: string, options: { createRoot?: boolean } = {}): string {
  const safe = validateAgentName(name);
  const root = projectRunRoot(cwd, { create: options.createRoot });
  return assertPathContained(root, join(root, safe), "Run directory");
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
