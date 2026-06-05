import { extractCostFromSessionLogSync } from "./cost.js";
import { createResultEvent, createTerminalEvent } from "./events.js";
import { createRunResult } from "./result.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import { updateRunStatus } from "./status.js";
import type { RunMetrics, RunResult, TerminalRunState, WriterRole } from "./types.js";

export interface FinalizeTerminalRunInput {
  runId: string;
  parentRunId: string;
  agentName: string;
  state: TerminalRunState;
  writerRole: WriterRole;
  startedAt?: string;
  summary?: string;
  body?: string;
  effectiveMaxRunMs?: number;
  timeout?: RunResult["timeout"];
  error?: RunResult["error"];
}

function nextEventSequence(store: RunStore, runId: string): number {
  return store.readEvents(runId).records.length + 1;
}

function metricsForTerminalRun(statusMetrics: RunMetrics | undefined, costTotal: number | undefined, usesSharedContinuationSession: boolean): RunMetrics | undefined {
  if (usesSharedContinuationSession) {
    if (!statusMetrics) return undefined;
    const { cost: _cost, ...withoutCost } = statusMetrics;
    return Object.keys(withoutCost).length ? withoutCost : undefined;
  }
  return costTotal !== undefined || statusMetrics !== undefined
    ? { ...(statusMetrics ?? {}), ...(costTotal !== undefined ? { cost: { total: costTotal } } : {}) }
    : undefined;
}

export function finalizeTerminalRun(store: RunStore, input: FinalizeTerminalRunInput): RunResult {
  const status = store.readStatus(input.runId);
  const existingResult = store.readResult(input.runId);
  if (existingResult) {
    if (!isTerminalRunState(status.state) || status.state !== existingResult.state || !status.resultReady) {
      store.writeStatus(
        updateRunStatus(status, {
          state: existingResult.state,
          writerRole: input.writerRole,
          resultReady: true,
          lastActivityAt: existingResult.createdAt,
          summary: existingResult.summary,
          error: existingResult.error ?? null,
        }),
      );
    }
    return existingResult;
  }

  const usesSharedContinuationSession = Boolean(status.continuationOfPiSessionPath);
  const costTotal = usesSharedContinuationSession ? undefined : extractCostFromSessionLogSync(status.piSessionPath);
  const metrics = metricsForTerminalRun(status.metrics, costTotal, usesSharedContinuationSession);

  const result = createRunResult({
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    displayName: status.displayName,
    namePack: status.namePack,
    variant: status.variant,
    model: status.model,
    thinkingLevel: status.thinkingLevel,
    contextPolicy: status.contextPolicy,
    sessionPolicy: status.sessionPolicy,
    piSessionPath: status.piSessionPath,
    requestedPiSessionPath: status.requestedPiSessionPath,
    continuedFromRunId: status.continuedFromRunId,
    continuationRootRunId: status.continuationRootRunId,
    continuationSequence: status.continuationSequence,
    continuationOfPiSessionPath: status.continuationOfPiSessionPath,
    forkSourceSessionFile: status.forkSourceSessionFile,
    forkSourceLeafId: status.forkSourceLeafId,
    forkFallback: status.forkFallback,
    fastTrack: status.fastTrack,
    state: input.state,
    startedAt: input.startedAt ?? status.startedAt,
    summary: input.summary,
    body: input.body,
    effectiveMaxRunMs: input.effectiveMaxRunMs ?? status.effectiveMaxRunMs,
    timeout: input.timeout ?? status.timeout,
    metrics,
    error: input.error ?? null,
  });
  store.writeResult(result);

  const resultEvent = createResultEvent({ sequence: nextEventSequence(store, input.runId), result });
  store.appendEvent(input.runId, resultEvent);
  const terminalEvent = createTerminalEvent({
    sequence: nextEventSequence(store, input.runId),
    runId: input.runId,
    parentRunId: input.parentRunId,
    state: input.state,
    summary: result.summary,
    error: input.error,
  });
  store.appendEvent(input.runId, terminalEvent);

  store.writeStatus(
    updateRunStatus(status, {
      state: input.state,
      writerRole: input.writerRole,
      resultReady: true,
      lastActivityAt: result.createdAt,
      lastEventId: terminalEvent.eventId,
      summary: result.summary,
      effectiveMaxRunMs: result.effectiveMaxRunMs,
      timeout: result.timeout,
      metrics,
      error: input.error ?? null,
    }),
  );
  return result;
}
