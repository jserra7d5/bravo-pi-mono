import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMetadata, AgentStatus } from "./types.js";
import { assertPathContained, dataRoot, projectRunRoot } from "./paths.js";
import { appendStatusEvent } from "./events.js";

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

export function updateStatus(runDir: string, status: AgentStatus, summary?: string, options: { needs?: string } = {}): AgentMetadata {
  return transitionStatus(runDir, status, summary, options);
}

export function transitionStatus(runDir: string, status: AgentStatus, summary?: string, options: { needs?: string } = {}): AgentMetadata {
  const meta = readMetadata(runDir);
  const previousStatus = meta.status;
  const previousSummary = meta.summary;
  const previousNeeds = meta.needs;
  const nextNeeds = options.needs !== undefined
    ? (options.needs || undefined)
    : (status === "done" || status === "stopped" ? undefined : previousNeeds);
  const nextSummary = summary ? summary : previousSummary;

  if (isTerminalStatusLocal(previousStatus)) {
    if (previousStatus !== status) {
      throw new Error(`Cannot transition terminal agent status from ${previousStatus} to ${status}. Terminal statuses are sticky.`);
    }
    if (nextSummary !== previousSummary || nextNeeds !== previousNeeds) {
      throw new Error(`Cannot modify terminal agent status ${previousStatus}; terminal status updates are immutable after finalization.`);
    }
    return meta;
  }

  if (summary) meta.summary = summary;
  if (options.needs !== undefined) {
    if (options.needs) meta.needs = options.needs;
    else delete meta.needs;
  } else if (status === "done" || status === "stopped") {
    delete meta.needs;
  }
  if (previousStatus === status) {
    writeMetadata(meta);
    if ((summary && summary !== previousSummary) || (options.needs !== undefined && options.needs !== previousNeeds)) appendStatusEvent(meta, previousStatus);
    return meta;
  }
  meta.status = status;
  writeMetadata(meta);
  appendStatusEvent(meta, previousStatus);
  return meta;
}

function isTerminalStatusLocal(status: AgentStatus): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

export function listMetadata(cwd?: string): AgentMetadata[] {
  const roots: string[] = [];
  if (cwd) roots.push(projectRunRoot(cwd, { create: false }));
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

export function removeRunDir(runDir: string): void {
  const safe = assertPathContained(join(dataRoot(), "runs"), runDir, "Run directory");
  if (existsSync(safe)) rmSync(safe, { recursive: true, force: true });
}
