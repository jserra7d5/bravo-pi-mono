import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "./jsonl.js";
import { RunStore } from "./runStore.js";
import { bucketForState } from "./schemas.js";
import type { RunIndexRecord, RunStatus } from "./types.js";

export interface RunListRow {
  runId: string;
  state?: string;
  bucket?: string;
  agentName?: string;
  displayName?: string;
  summary?: string;
  projectRoot: string;
  runDir: string;
  createdAt?: string;
  lastActivityAt?: string;
}

export interface ListRunsOptions {
  /** Include runs from every project, not just the store's cwd. */
  all?: boolean;
  /** Newest-first cap. The index is append-only and large; reading every status would be gratuitous. */
  limit?: number;
}

function readStatusAt(runDir: string): Partial<RunStatus> | undefined {
  const path = join(runDir, "status.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<RunStatus>;
  } catch {
    return undefined;
  }
}

function newestFirst(records: RunIndexRecord[]): RunIndexRecord[] {
  return [...records].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * List runs newest-first, for recovering a handle you no longer have.
 *
 * Every cwd hashes to its own project directory, so a run launched in one
 * worktree is invisible from another and there is no reliable way to name a run
 * you just started. Without this the only recourse is globbing the runtime's
 * private state directory, which is not an interface.
 *
 * State is read per run from status.json rather than trusted from the index,
 * because the index records a run at launch and is never rewritten as it moves.
 */
export function listRuns(store: RunStore, options: ListRunsOptions = {}): RunListRow[] {
  const limit = Math.max(1, options.limit ?? 20);
  let records: RunIndexRecord[];
  if (options.all) {
    const seen = new Set<string>();
    records = [];
    for (const path of store.lookupIndexPaths()) {
      if (!existsSync(path)) continue;
      for (const record of readJsonl<RunIndexRecord>(path).records) {
        if (!record?.runId || seen.has(record.runId)) continue;
        seen.add(record.runId);
        records.push(record);
      }
    }
  } else {
    records = store.listRecentRuns();
  }
  return newestFirst(records).slice(0, limit).map((record) => {
    const status = readStatusAt(record.runDir);
    return {
      runId: record.runId,
      state: status?.state,
      bucket: status?.state ? bucketForState(status.state) : undefined,
      agentName: status?.agent?.name,
      displayName: status?.displayName,
      summary: status?.summary,
      projectRoot: record.projectRoot,
      runDir: record.runDir,
      createdAt: record.createdAt,
      lastActivityAt: status?.lastActivityAt,
    };
  });
}
