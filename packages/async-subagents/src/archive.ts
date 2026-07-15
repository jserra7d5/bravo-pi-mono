import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { asyncSubagentsHome } from "./config.js";
import { appendJsonl } from "./jsonl.js";
import { reconcileUnderLock } from "./lifecycle.js";
import { retentionSkipReason } from "./retention.js";
import { RunStore } from "./runStore.js";
import { SCHEMA_VERSION, type ArchiveIndexRecord, type RunIndexRecord } from "./types.js";

export interface ArchiveRunsInput {
  olderThanDays?: number;
  dryRun?: boolean;
  cap?: number;
  nowMs?: number;
  /** Fault-injection seam for tests. */
  tarCommand?: string;
}

export interface ArchiveRunsResult {
  archived: string[];
  skipped: Array<{ runId: string; reason: string }>;
  errors: Array<{ runId: string; error: string }>;
  indexRecordsDropped: number;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code ?? signal ?? "unknown"}`)));
  });
}

function scopeForRun(home: string, runDir: string): string {
  const parts = relative(join(home, "projects"), runDir).split(/[\\/]/);
  return parts.length >= 3 && parts[1] === "runs" ? parts[0]! : "legacy";
}

function archiveCandidates(store: RunStore, cap?: number): RunIndexRecord[] {
  const latest = new Map<string, RunIndexRecord>();
  const reachedCap = () => cap !== undefined && latest.size >= cap;
  if (cap === undefined) {
    for (const record of store.readLookupRunIndex()) latest.set(record.runId, record);
  } else {
    store.visitLookupRunIndex((record) => {
      if (!existsSync(record.runDir)) return true;
      latest.set(record.runId, record);
      return !reachedCap();
    });
  }
  const legacyRoot = join(asyncSubagentsHome(store.env), "runs");
  if (!reachedCap() && existsSync(legacyRoot)) {
    for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || latest.has(entry.name)) continue;
      const runDir = join(legacyRoot, entry.name);
      latest.set(entry.name, { schemaVersion: SCHEMA_VERSION, runId: entry.name, runDir, projectRoot: "", parentRunId: "", createdAt: new Date(statSync(runDir).birthtimeMs).toISOString() });
      if (reachedCap()) break;
    }
  }
  return [...latest.values()];
}

/** Reconcile, archive eligible runs, then compact all affected project/global indexes. */
export async function archiveRuns(store: RunStore, input: ArchiveRunsInput = {}): Promise<ArchiveRunsResult> {
  const olderThanDays = input.olderThanDays ?? 7;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new Error("olderThanDays must be a non-negative number");
  if (input.cap !== undefined && (!Number.isInteger(input.cap) || input.cap < 0)) throw new Error("cap must be a non-negative integer");
  const nowMs = input.nowMs ?? Date.now();
  const olderThanMs = olderThanDays * 24 * 60 * 60 * 1000;
  const dryRun = input.dryRun === true;
  const home = asyncSubagentsHome(store.env);
  const archiveIndexPath = join(home, "archive", "archive-index.jsonl");
  const tarCommand = input.tarCommand ?? "tar";
  const result: ArchiveRunsResult = { archived: [], skipped: [], errors: [], indexRecordsDropped: 0 };
  const candidates = archiveCandidates(store, input.cap);
  const projectIndexes = new Set<string>([store.indexPath()]);
  for (const record of candidates) {
    const parent = dirname(record.runDir);
    if (basename(parent) === "runs") projectIndexes.add(join(dirname(parent), "run-index.jsonl"));
  }
  let examined = 0;

  for (const record of candidates) {
    if (!existsSync(record.runDir)) continue;
    if (input.cap !== undefined && examined >= input.cap) break;
    examined += 1;
    const runStore = new RunStore({ cwd: record.projectRoot || store.cwd, runRoot: dirname(record.runDir), env: store.env });
    let status;
    try {
      status = (await reconcileUnderLock(runStore, record.runId, { nowMs })).status;
    } catch (error) {
      result.errors.push({ runId: record.runId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const reason = retentionSkipReason(runStore, status, olderThanMs, nowMs);
    if (reason) {
      result.skipped.push({ runId: record.runId, reason });
      continue;
    }
    if (dryRun) {
      result.archived.push(record.runId);
      continue;
    }

    const archivedAt = new Date(nowMs).toISOString();
    const month = archivedAt.slice(0, 7);
    const archivePath = join(home, "archive", month, `${record.runId}.tar.zst`);
    let indexed = false;
    try {
      mkdirSync(dirname(archivePath), { recursive: true });
      await run(tarCommand, ["--zstd", "-cf", archivePath, "-C", dirname(record.runDir), basename(record.runDir)]);
      await run(tarCommand, ["--zstd", "-tf", archivePath]);
      const indexRecord: ArchiveIndexRecord = {
        schemaVersion: SCHEMA_VERSION,
        runId: record.runId,
        agentName: status.agent.name,
        state: status.state as ArchiveIndexRecord["state"],
        createdAt: status.createdAt,
        archivedAt,
        projectScope: scopeForRun(home, record.runDir),
        archivePath,
      };
      appendJsonl(archiveIndexPath, indexRecord);
      indexed = true;
      rmSync(record.runDir, { recursive: true });
      try { rmSync(dirname(record.runDir)); } catch { /* Other runs remain. */ }
      result.archived.push(record.runId);
      projectIndexes.add(join(dirname(dirname(record.runDir)), "run-index.jsonl"));
    } catch (error) {
      result.errors.push({ runId: record.runId, error: error instanceof Error ? error.message : String(error) });
      if (!indexed) try { rmSync(archivePath, { force: true }); } catch { /* Destination itself may be inaccessible. */ }
    }
  }

  // Capped opportunistic sweeps must not turn into an unbounded global-index compaction.
  // Explicit archive (no cap) retains full compaction behavior.
  if (!dryRun && input.cap === undefined) result.indexRecordsDropped = store.compactRunIndexes([...projectIndexes, store.globalIndexPath()]);
  return result;
}
