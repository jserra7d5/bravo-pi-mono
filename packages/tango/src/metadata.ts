import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMetadata, AgentStatus } from "./types.js";
import { dataRoot, projectRunRoot } from "./paths.js";

export function metadataPath(runDir: string): string { return join(runDir, "metadata.json"); }

export function readMetadata(runDir: string): AgentMetadata {
  return JSON.parse(readFileSync(metadataPath(runDir), "utf8")) as AgentMetadata;
}

export function writeMetadata(meta: AgentMetadata): void {
  mkdirSync(meta.runDir, { recursive: true });
  meta.updatedAt = new Date().toISOString();
  const p = metadataPath(meta.runDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  renameSyncSafe(tmp, p);
}

function renameSyncSafe(tmp: string, dest: string) {
  renameSync(tmp, dest);
}

export function updateStatus(runDir: string, status: AgentStatus, summary?: string): AgentMetadata {
  const meta = readMetadata(runDir);
  meta.status = status;
  if (summary) meta.summary = summary;
  writeMetadata(meta);
  return meta;
}

export function listMetadata(cwd?: string): AgentMetadata[] {
  const roots: string[] = [];
  if (cwd) roots.push(projectRunRoot(cwd));
  else {
    const runs = join(dataRoot(), "runs");
    if (existsSync(runs)) for (const p of readdirSync(runs)) roots.push(join(runs, p));
  }
  const metas: AgentMetadata[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const runDir = join(root, name);
      const mp = metadataPath(runDir);
      if (!existsSync(mp)) continue;
      try { metas.push(readMetadata(runDir)); } catch {}
    }
  }
  return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findRunDir(name: string, cwd: string): string | undefined {
  const root = projectRunRoot(cwd);
  const direct = join(root, name);
  if (existsSync(metadataPath(direct))) return direct;
  const all = listMetadata(cwd).filter((m) => m.name === name);
  return all[0]?.runDir;
}

export function removeRunDir(runDir: string): void {
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
}
