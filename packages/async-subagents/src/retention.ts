import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isTerminalRunState } from "./schemas.js";
import { RunStore } from "./runStore.js";

export interface PruneRunsInput {
  olderThanMs: number;
  nowMs?: number;
  dryRun?: boolean;
  parentRunId?: string;
}

export interface PruneRunsResult {
  dryRun: boolean;
  prunedRunIds: string[];
  skipped: Array<{ runId: string; reason: string }>;
}

function deliveryStatePath(store: RunStore, parentRunId: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", `${parentRunId}.json`);
}

function hasUnhandledWakeup(store: RunStore, parentRunId: string, runId: string): boolean {
  const path = deliveryStatePath(store, parentRunId);
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { delivered?: Record<string, string>; handled?: Record<string, string> };
    for (const key of Object.keys(state.delivered ?? {})) {
      if (key.includes(`:${runId}:`) && !state.handled?.[key]) return true;
    }
  } catch {
    return true;
  }
  return false;
}

export function pruneRuns(store: RunStore, input: PruneRunsInput): PruneRunsResult {
  const nowMs = input.nowMs ?? Date.now();
  const result: PruneRunsResult = { dryRun: input.dryRun !== false, prunedRunIds: [], skipped: [] };
  for (const record of store.listRecentRuns({ parentRunId: input.parentRunId })) {
    let status;
    try {
      status = store.readStatus(record.runId);
    } catch {
      result.skipped.push({ runId: record.runId, reason: "missing-status" });
      continue;
    }
    if (!isTerminalRunState(status.state)) {
      result.skipped.push({ runId: record.runId, reason: "active" });
      continue;
    }
    if (status.resultReady || hasUnhandledWakeup(store, status.parentRunId, record.runId)) {
      result.skipped.push({ runId: record.runId, reason: "unhandled-wakeup" });
      continue;
    }
    const updatedAt = Date.parse(status.updatedAt);
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt < input.olderThanMs) {
      result.skipped.push({ runId: record.runId, reason: "too-recent" });
      continue;
    }
    result.prunedRunIds.push(record.runId);
    if (!result.dryRun) rmSync(record.runDir, { recursive: true, force: true });
  }
  return result;
}
