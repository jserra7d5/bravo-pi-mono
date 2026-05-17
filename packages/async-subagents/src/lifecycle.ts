import { createResultEvent, createTerminalEvent } from "./events.js";
import { createRunResult } from "./result.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import { updateRunStatus } from "./status.js";
import type { RunResult, TerminalRunState, WriterRole } from "./types.js";

export interface FinalizeTerminalRunInput {
  runId: string;
  parentRunId: string;
  agentName: string;
  state: TerminalRunState;
  writerRole: WriterRole;
  startedAt?: string;
  summary?: string;
  body?: string;
  error?: RunResult["error"];
}

function nextEventSequence(store: RunStore, runId: string): number {
  return store.readEvents(runId).records.length + 1;
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

  const result = createRunResult({
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    contextPolicy: status.contextPolicy,
    sessionPolicy: status.sessionPolicy,
    piSessionPath: status.piSessionPath,
    requestedPiSessionPath: status.requestedPiSessionPath,
    forkSourceSessionFile: status.forkSourceSessionFile,
    forkSourceLeafId: status.forkSourceLeafId,
    forkFallback: status.forkFallback,
    state: input.state,
    startedAt: input.startedAt ?? status.startedAt,
    summary: input.summary,
    body: input.body,
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
      error: input.error ?? null,
    }),
  );
  return result;
}
