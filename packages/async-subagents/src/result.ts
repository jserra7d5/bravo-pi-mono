import { durationMs, nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import type { ArtifactRef, ContextPolicy, RunMetrics, RunResult, SessionPolicy, TerminalRunState, ThinkingLevel } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createRunResult(input: {
  runId: string;
  parentRunId: string;
  agentName: string;
  displayName?: string;
  namePack?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  contextPolicy?: ContextPolicy;
  sessionPolicy?: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  forkFallback?: RunResult["forkFallback"];
  state: TerminalRunState;
  startedAt?: string;
  summary?: string;
  body?: string;
  artifacts?: ArtifactRef[];
  metrics?: RunMetrics;
  error?: RunResult["error"];
}): RunResult {
  const createdAt = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    displayName: input.displayName,
    namePack: input.namePack,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    contextPolicy: input.contextPolicy ?? "fresh",
    sessionPolicy: input.sessionPolicy ?? "record",
    piSessionPath: input.piSessionPath,
    requestedPiSessionPath: input.requestedPiSessionPath,
    forkSourceSessionFile: input.forkSourceSessionFile,
    forkSourceLeafId: input.forkSourceLeafId,
    forkFallback: input.forkFallback ?? null,
    state: input.state,
    success: input.state === "completed",
    createdAt,
    durationMs: input.startedAt ? durationMs(input.startedAt, createdAt) : undefined,
    summary: input.summary,
    body: input.body,
    artifacts: input.artifacts ?? [],
    metrics: input.metrics,
    error: input.error ?? null,
  };
}

export function readSubagentResult(store: RunStore, input: { runId: string; requireTerminal?: boolean }): RunResult | undefined {
  const result = store.readResult(input.runId);
  if (!result && input.requireTerminal) {
    const status = store.readStatus(input.runId);
    if (["completed", "failed", "cancelled", "expired"].includes(status.state)) {
      throw new Error(`terminal status exists without result for run: ${input.runId}`);
    }
  }
  return result;
}
