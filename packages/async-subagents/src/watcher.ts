import { isTerminalRunState } from "./schemas.js";
import { RunStore } from "./runStore.js";
import type { RunSummaryReadModel } from "./readModels.js";
import type { EventType, RunEvent, RunIndexRecord, RunMetrics, RunResult, RunState } from "./types.js";

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
  nowMs?: number;
  completedVisibleMs?: number;
  records?: RunIndexRecord[];
}

function priority(row: RunSummaryRow): number {
  if (row.resultReady) return 0;
  if (row.state === "blocked" || row.state === "waiting_for_input") return 1;
  if (!isTerminalRunState(row.state)) return 2;
  return 3;
}

export function readWatcherSnapshot(store: RunStore, input: ReadWatcherSnapshotInput = {}): WatcherSnapshot {
  const summaries: RunSummaryReadModel[] = input.records
    ? input.records.flatMap((record) => store.readRunSummary(record.runId) ?? [])
    : store.readRunSummaries({ parentRunId: input.parentRunId, rootSessionId: input.rootSessionId });
  const nowMs = input.nowMs ?? Date.now();
  const rows: RunSummaryRow[] = summaries
    .flatMap((summary) => {
      if (isTerminalRunState(summary.state) && typeof input.completedVisibleMs === "number") {
        const updatedAtMs = Date.parse(summary.updatedAt);
        if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > input.completedVisibleMs) return [];
      }
      const result = summary.resultReady ? store.readResult(summary.runId) : undefined;
      const row: RunSummaryRow = {
        runId: summary.runId,
        runDir: summary.runDir,
        agentName: summary.agentName ?? summary.resultAgentName ?? "subagent",
        displayName: summary.displayName,
        namePack: summary.namePack,
        state: summary.state,
        summary: summary.summary,
        needs: summary.needs,
        resultReady: summary.resultReady,
        updatedAt: summary.updatedAt,
        lastActivityAt: summary.lastActivityAt,
        event: summary.latestWakeEvent,
        result,
        metrics: result?.metrics ?? summary.metrics,
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
