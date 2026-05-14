import { nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import type { AgentDefinitionSource, AgentMode, RunState, RunStatus } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createInitialStatus(input: {
  runId: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  agentName: string;
  agentSource: AgentDefinitionSource;
  definitionPath: string;
  mode: AgentMode;
  cwd: string;
  state?: RunState;
}): RunStatus {
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    parentRunId: input.parentRunId,
    rootRunId: input.rootRunId,
    rootSessionId: input.rootSessionId,
    agent: {
      name: input.agentName,
      source: input.agentSource,
      definitionPath: input.definitionPath,
      mode: input.mode,
    },
    state: input.state ?? "created",
    writerRole: "launcher",
    cwd: input.cwd,
    createdAt: now,
    updatedAt: now,
    resultReady: false,
    error: null,
  };
}

export function updateRunStatus(status: RunStatus, patch: Partial<RunStatus>): RunStatus {
  return {
    ...status,
    ...patch,
    updatedAt: nowIso(),
  };
}

export function readSubagentStatus(store: RunStore, input: { runId: string }): RunStatus {
  return store.readStatus(input.runId);
}

export function isTerminalStatus(status: RunStatus): boolean {
  return isTerminalRunState(status.state);
}
