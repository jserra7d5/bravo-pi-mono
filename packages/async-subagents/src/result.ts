import { durationMs, nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import type { ArtifactRef, RunResult, TerminalRunState } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createRunResult(input: {
  runId: string;
  parentRunId: string;
  agentName: string;
  state: TerminalRunState;
  startedAt?: string;
  summary?: string;
  body?: string;
  artifacts?: ArtifactRef[];
  error?: RunResult["error"];
}): RunResult {
  const createdAt = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    state: input.state,
    success: input.state === "completed",
    createdAt,
    durationMs: input.startedAt ? durationMs(input.startedAt, createdAt) : undefined,
    summary: input.summary,
    body: input.body,
    artifacts: input.artifacts ?? [],
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
