import { nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import type { AgentDefinitionSource, AgentMode, ContextPolicy, RunState, RunStatus, SessionPolicy, ThinkingLevel } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createInitialStatus(input: {
  runId: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  displayName?: string;
  namePack?: string;
  agentName: string;
  agentSource: AgentDefinitionSource;
  definitionPath: string;
  mode: AgentMode;
  variant?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  contextPolicy?: ContextPolicy;
  sessionPolicy?: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  continuedFromRunId?: string;
  continuationRootRunId?: string;
  continuationSequence?: number;
  continuationOfPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  forkFallback?: RunStatus["forkFallback"];
  fastTrack?: RunStatus["fastTrack"];
  userBuiltinTools?: string[];
  runtimeBuiltinTools?: string[];
  runtimeExtensionPaths?: string[];
  launchLogPath?: string;
  inboxPath?: string;
  effectiveMaxRunMs?: number;
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
    displayName: input.displayName,
    namePack: input.namePack,
    agent: {
      name: input.agentName,
      source: input.agentSource,
      definitionPath: input.definitionPath,
      mode: input.mode,
      variant: input.variant,
    },
    variant: input.variant,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    contextPolicy: input.contextPolicy ?? "fresh",
    sessionPolicy: input.sessionPolicy ?? "record",
    piSessionPath: input.piSessionPath,
    requestedPiSessionPath: input.requestedPiSessionPath,
    continuedFromRunId: input.continuedFromRunId,
    continuationRootRunId: input.continuationRootRunId,
    continuationSequence: input.continuationSequence,
    continuationOfPiSessionPath: input.continuationOfPiSessionPath,
    forkSourceSessionFile: input.forkSourceSessionFile,
    forkSourceLeafId: input.forkSourceLeafId,
    forkFallback: input.forkFallback ?? null,
    fastTrack: input.fastTrack,
    userBuiltinTools: input.userBuiltinTools ?? [],
    runtimeBuiltinTools: input.runtimeBuiltinTools ?? [],
    runtimeExtensionPaths: input.runtimeExtensionPaths ?? [],
    launchLogPath: input.launchLogPath,
    inboxPath: input.inboxPath,
    effectiveMaxRunMs: input.effectiveMaxRunMs,
    timeout: null,
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
