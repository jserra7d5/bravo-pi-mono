import { durationMs, nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import type { AgentHarness, ArtifactRef, ClaudeAuthHome, ClaudeEffort, ClaudeExecutionMode, ClaudeInstalledSkill, ClaudeLivenessState, ClaudeMemoryIsolation, ContextPolicy, HarnessBoundaryProvenance, LaunchHarness, ResultParser, RunMetrics, RunResult, SessionPolicy, TerminalRunState, ThinkingLevel } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createRunResult(input: {
  runId: string;
  parentRunId: string;
  agentName: string;
  displayName?: string;
  namePack?: string;
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
  forkFallback?: RunResult["forkFallback"];
  fastTrack?: RunResult["fastTrack"];
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
  livenessState?: ClaudeLivenessState;
  lastTerminalOutputAt?: string;
  terminalOutputBytes?: number;
  lastMcpCallAt?: string;
  lastNudgeAt?: string;
  pendingAckMessageIds?: string[];
  livenessReason?: string | null;
  supervisorPid?: number;
  childPid?: number;
  panePid?: number;
  processGroupId?: number;
  tmuxSocket?: string;
  tmuxSession?: string;
  tmuxPane?: string;
  transcriptPath?: string;
  state: TerminalRunState;
  startedAt?: string;
  summary?: string;
  body?: string;
  effectiveMaxRunMs?: number;
  timeout?: RunResult["timeout"];
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
    livenessState: input.livenessState,
    lastTerminalOutputAt: input.lastTerminalOutputAt,
    terminalOutputBytes: input.terminalOutputBytes,
    lastMcpCallAt: input.lastMcpCallAt,
    lastNudgeAt: input.lastNudgeAt,
    pendingAckMessageIds: input.pendingAckMessageIds,
    livenessReason: input.livenessReason,
    supervisorPid: input.supervisorPid,
    childPid: input.childPid,
    panePid: input.panePid,
    processGroupId: input.processGroupId,
    tmuxSocket: input.tmuxSocket,
    tmuxSession: input.tmuxSession,
    tmuxPane: input.tmuxPane,
    transcriptPath: input.transcriptPath,
    state: input.state,
    success: input.state === "completed",
    createdAt,
    durationMs: input.startedAt ? durationMs(input.startedAt, createdAt) : undefined,
    summary: input.summary,
    body: input.body,
    effectiveMaxRunMs: input.effectiveMaxRunMs,
    timeout: input.timeout ?? null,
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
