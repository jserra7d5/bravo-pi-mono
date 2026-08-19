import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export interface InstallerFs {
  exists(path: string): boolean;
  lstat(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean };
  readlink(path: string): string;
  ensureDir(path: string): void;
  symlink(target: string, path: string, type: "file" | "dir"): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}
export const realInstallerFs: InstallerFs = {
  exists: existsSync,
  lstat: lstatSync,
  readlink: readlinkSync,
  ensureDir: (path) => mkdirSync(path, { recursive: true }),
  symlink: (target, path, type) => symlinkSync(target, path, type),
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};
export interface InstallLink { name: string; source: string; destination: string; type: "file" | "dir" }
export interface InstallPlan { links: Array<InstallLink & { state: "absent" | "healthy" | "symlink" | "conflict" }>; force: boolean }
export interface InstallFailure { name: string; path: string; operation: "ensureDir" | "removeTemp" | "symlink" | "removeConflict" | "rename"; message: string }
export interface InstallApplyResult { ok: boolean; results: Array<Record<string, unknown>>; failure?: InstallFailure }

export class InstallApplyError extends Error {
  readonly result: InstallApplyResult;
  constructor(result: InstallApplyResult) {
    super(`install failed during ${result.failure?.operation ?? "unknown operation"} for ${result.failure?.path ?? "unknown path"}: ${result.failure?.message ?? "unknown error"}`);
    this.name = "InstallApplyError";
    this.result = result;
  }
}

export function planInstall(links: InstallLink[], force = false, fs: InstallerFs = realInstallerFs): InstallPlan {
  for (const link of links) if (!fs.exists(link.source)) throw new Error(`packaged install source is missing: ${link.source}`);
  const planned = links.map((link) => {
    let stat: ReturnType<InstallerFs["lstat"]>;
    try { stat = fs.lstat(link.destination); }
    catch { return { ...link, state: "absent" as const }; }
    if (!stat.isSymbolicLink()) return { ...link, state: "conflict" as const };
    return { ...link, state: fs.readlink(link.destination) === link.source ? "healthy" as const : "symlink" as const };
  });
  const conflict = planned.find((link) => link.state === "conflict");
  if (conflict && !force) throw new Error(`${conflict.destination} exists and is not a symlink; move it aside or pass --force`);
  return { links: planned, force };
}

export function applyInstall(plan: InstallPlan, fs: InstallerFs = realInstallerFs): InstallApplyResult {
  const results: Array<Record<string, unknown>> = [];
  for (const link of plan.links) {
    const perform = (operation: InstallFailure["operation"], path: string, body: () => void) => {
      try { body(); }
      catch (error) {
        throw new InstallApplyError({ ok: false, results: [...results], failure: { name: link.name, path, operation, message: error instanceof Error ? error.message : String(error) } });
      }
    };
    perform("ensureDir", dirname(link.destination), () => fs.ensureDir(dirname(link.destination)));
    if (link.state === "healthy") { results.push({ name: link.name, from: link.destination, to: link.source, action: "unchanged" }); continue; }
    const temp = `${link.destination}.tmp-${process.pid}`;
    perform("removeTemp", temp, () => fs.remove(temp));
    perform("symlink", temp, () => fs.symlink(link.source, temp, link.type));
    // POSIX rename atomically replaces an existing symlink. Real-path conflicts
    // authorized by --force must be removed first because directories cannot be
    // replaced by rename.
    if (link.state === "conflict") perform("removeConflict", link.destination, () => fs.remove(link.destination));
    perform("rename", link.destination, () => fs.rename(temp, link.destination));
    results.push({ name: link.name, from: link.destination, to: link.source, action: link.state === "absent" ? "linked" : "replaced", replaced: link.state });
  }
  return { ok: true, results };
}

export function installerLinks(packageRoot: string, home: string, claudeDir: string): InstallLink[] {
  return [
    { name: "launcher", source: join(packageRoot, "dist", "src", "cli.js"), destination: join(home, ".async-subagents", "bin", "async-subagents"), type: "file" },
    { name: "pi-async-subagents", source: join(packageRoot, "skills", "pi-async-subagents"), destination: join(claudeDir, "skills", "pi-async-subagents"), type: "dir" },
    { name: "budget-auto-swarm", source: join(packageRoot, "skills", "budget-auto-swarm"), destination: join(claudeDir, "skills", "budget-auto-swarm"), type: "dir" },
  ];
}
