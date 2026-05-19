import { isInterestingEvent, isTerminalRunState } from "./schemas.js";
import { RunStore } from "./runStore.js";
import type { EventType, RunEvent, RunIndexRecord, RunMetrics, RunResult, RunState, RunStatus } from "./types.js";

export interface RunSummaryRow {
  runId: string;
  runDir: string;
  agentName: string;
  displayName?: string;
  namePack?: string;
  state: RunState;
  summary?: string;
  needs?: string | null;
  resultReady: boolean;
  updatedAt: string;
  lastActivityAt?: string;
  event?: RunEvent;
  result?: RunResult;
  metrics?: RunMetrics;
}

export interface WatcherSnapshot {
  activeRunIds: string[];
  blockedRunIds: string[];
  resultReadyRunIds: string[];
  rows: RunSummaryRow[];
}

export interface ReadWatcherSnapshotInput {
  parentRunId?: string;
  rootSessionId?: string;
  limit?: number;
}

function safeStatus(store: RunStore, record: RunIndexRecord): RunStatus | undefined {
  try {
    return store.readStatus(record.runId);
  } catch {
    return undefined;
  }
}

function latestInterestingEvent(store: RunStore, runId: string): RunEvent | undefined {
  try {
    const events = store.readEvents(runId).records;
    return events.filter((event) => isInterestingEvent(event.type, event.wake)).at(-1);
  } catch {
    return undefined;
  }
}

function priority(row: RunSummaryRow): number {
  if (row.resultReady) return 0;
  if (row.state === "blocked" || row.state === "waiting_for_input") return 1;
  if (!isTerminalRunState(row.state)) return 2;
  return 3;
}

export function readWatcherSnapshot(store: RunStore, input: ReadWatcherSnapshotInput = {}): WatcherSnapshot {
  const records = store.listRecentRuns({ parentRunId: input.parentRunId, rootSessionId: input.rootSessionId });
  const rows: RunSummaryRow[] = records
    .flatMap((record) => {
      const status = safeStatus(store, record);
      if (!status) return [];
      const result = store.readResult(record.runId);
      const row: RunSummaryRow = {
        runId: record.runId,
        runDir: record.runDir,
        agentName: status.agent.name,
        displayName: status.displayName,
        namePack: status.namePack,
        state: status.state,
        summary: status.summary,
        needs: status.needs,
        resultReady: status.resultReady,
        updatedAt: status.updatedAt,
        lastActivityAt: status.lastActivityAt,
        event: latestInterestingEvent(store, record.runId),
        result,
        // Prefer terminal result metrics (final) over the live status copy; either
        // surface may carry `cost.total`.
        metrics: result?.metrics ?? status.metrics,
      };
      return [row];
    })
    .sort((a, b) => priority(a) - priority(b) || b.updatedAt.localeCompare(a.updatedAt));

  const limitedRows = typeof input.limit === "number" ? rows.slice(0, input.limit) : rows;
  return {
    activeRunIds: rows.filter((row) => !isTerminalRunState(row.state) && row.state !== "blocked" && row.state !== "waiting_for_input").map((row) => row.runId),
    blockedRunIds: rows.filter((row) => row.state === "blocked" || row.state === "waiting_for_input").map((row) => row.runId),
    resultReadyRunIds: rows.filter((row) => row.resultReady).map((row) => row.runId),
    rows: limitedRows,
  };
}

export function notifyEventTypes(): EventType[] {
  return ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"];
}
