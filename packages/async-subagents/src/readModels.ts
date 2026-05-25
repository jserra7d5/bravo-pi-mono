import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isInterestingEvent } from "./schemas.js";
import type { RunEvent, RunIndexRecord, RunMetrics, RunResult, RunState, RunStatus } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface RunSummaryReadModel {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  runDir: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  agentName?: string;
  displayName?: string;
  namePack?: string;
  state: RunState;
  summary?: string;
  needs?: string | null;
  resultReady: boolean;
  resultCreatedAt?: string;
  resultState?: RunResult["state"];
  resultSummary?: string;
  resultAgentName?: string;
  metrics?: RunMetrics;
  latestWakeEvent?: RunEvent;
}

export interface RunIndexCache {
  schemaVersion: typeof SCHEMA_VERSION;
  rebuiltAt: string;
  sourcePath: string;
  sourceMtimeMs: number;
  records: RunIndexRecord[];
  byRunId: Record<string, RunIndexRecord>;
  childrenByParentRunId: Record<string, string[]>;
  byRootSessionId: Record<string, string[]>;
}

export function summaryPathForRunDir(runDir: string): string {
  return join(runDir, "summary.json");
}

export function summaryFromStatus(status: RunStatus, runDir: string, previous?: RunSummaryReadModel): RunSummaryReadModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: status.runId,
    runDir,
    parentRunId: status.parentRunId,
    rootRunId: status.rootRunId,
    rootSessionId: status.rootSessionId,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    lastActivityAt: status.lastActivityAt,
    agentName: status.agent?.name,
    displayName: status.displayName,
    namePack: status.namePack,
    state: status.state,
    summary: status.summary,
    needs: status.needs,
    resultReady: status.resultReady,
    resultCreatedAt: previous?.resultCreatedAt,
    resultState: previous?.resultState,
    resultSummary: previous?.resultSummary,
    resultAgentName: previous?.resultAgentName,
    metrics: status.metrics ?? previous?.metrics,
    latestWakeEvent: previous?.latestWakeEvent,
  };
}

export function applyEventToSummary(summary: RunSummaryReadModel, event: RunEvent): RunSummaryReadModel {
  const next: RunSummaryReadModel = {
    ...summary,
    updatedAt: event.createdAt,
    lastActivityAt: event.createdAt,
    summary: event.summary ?? summary.summary,
  };
  if (isInterestingEvent(event.type, event.wake) && !["result", "completed", "failed", "cancelled", "expired"].includes(event.type)) {
    next.latestWakeEvent = event;
  }
  return next;
}

export function applyResultToSummary(summary: RunSummaryReadModel, result: RunResult): RunSummaryReadModel {
  return {
    ...summary,
    updatedAt: result.createdAt,
    lastActivityAt: result.createdAt,
    state: result.state,
    summary: result.summary ?? summary.summary,
    resultReady: true,
    resultCreatedAt: result.createdAt,
    resultState: result.state,
    resultSummary: result.summary,
    resultAgentName: result.agentName,
    metrics: result.metrics ?? summary.metrics,
  };
}

export function readSummaryFile(path: string): RunSummaryReadModel | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunSummaryReadModel;
  } catch {
    return undefined;
  }
}
