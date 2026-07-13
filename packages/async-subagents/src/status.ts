import { nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import type { AgentDefinitionSource, AgentHarness, AgentMode, ClaudeAuthHome, ClaudeEffort, ClaudeExecutionMode, ClaudeInstalledSkill, ClaudeMemoryIsolation, ContextPolicy, HarnessBoundaryProvenance, LaunchHarness, ResultParser, RunState, RunStatus, SessionPolicy, ThinkingLevel } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createInitialStatus(input: {
  runId: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  runRoot?: string;
  displayName?: string;
  namePack?: string;
  agentName: string;
  agentSource: AgentDefinitionSource;
  definitionPath: string;
  mode: AgentMode;
  harness?: AgentHarness;
  launchHarness?: LaunchHarness;
  resultParser?: ResultParser;
  variant?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  thinkingLevel?: ThinkingLevel;
  effort?: ClaudeEffort;
  executionMode?: ClaudeExecutionMode;
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
  resolvedSkills?: string[];
  notInheritedAcrossHarness?: HarnessBoundaryProvenance[];
  excludedAcrossHarness?: HarnessBoundaryProvenance[];
  inheritedAcrossHarness?: HarnessBoundaryProvenance[];
  claudeHomeDir?: string;
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  claudeAuthHome?: ClaudeAuthHome;
  claudeMemoryIsolation?: ClaudeMemoryIsolation;
  claudeShellHomeDir?: string;
  claudeShellWrapperPath?: string;
  claudeTransport?: "mcp" | "none";
  claudeInstalledSkills?: ClaudeInstalledSkill[];
  launchLogPath?: string;
  inboxPath?: string;
  allowedFiles?: string[];
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
    runRoot: input.runRoot,
    displayName: input.displayName,
    namePack: input.namePack,
    agent: {
      name: input.agentName,
      source: input.agentSource,
      definitionPath: input.definitionPath,
      mode: input.mode,
      variant: input.variant,
    },
    harness: input.harness,
    launchHarness: input.launchHarness,
    resultParser: input.resultParser,
    variant: input.variant,
    model: input.model,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    thinkingLevel: input.thinkingLevel,
    effort: input.effort,
    executionMode: input.executionMode,
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
    resolvedSkills: input.resolvedSkills,
    notInheritedAcrossHarness: input.notInheritedAcrossHarness,
    excludedAcrossHarness: input.excludedAcrossHarness,
    inheritedAcrossHarness: input.inheritedAcrossHarness,
    claudeHomeDir: input.claudeHomeDir,
    claudeSettingsPath: input.claudeSettingsPath,
    claudeMcpConfigPath: input.claudeMcpConfigPath,
    claudeAuthHome: input.claudeAuthHome,
    claudeMemoryIsolation: input.claudeMemoryIsolation,
    claudeShellHomeDir: input.claudeShellHomeDir,
    claudeShellWrapperPath: input.claudeShellWrapperPath,
    claudeTransport: input.claudeTransport,
    claudeInstalledSkills: input.claudeInstalledSkills,
    launchLogPath: input.launchLogPath,
    inboxPath: input.inboxPath,
    allowedFiles: input.allowedFiles,
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
