import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isInterestingEvent } from "./schemas.js";
import type { AgentHarness, ClaudeEffort, ClaudeExecutionMode, ClaudeInstalledSkill, ClaudeLivenessState, LaunchHarness, ResultParser, RunEvent, RunIndexRecord, RunMetrics, RunResult, RunState, RunStatus } from "./types.js";
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
  harness?: AgentHarness;
  launchHarness?: LaunchHarness;
  resultParser?: ResultParser;
  variant?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  effort?: ClaudeEffort;
  executionMode?: ClaudeExecutionMode;
  claudeTransport?: "mcp" | "none";
  claudeInstalledSkills?: ClaudeInstalledSkill[];
  livenessState?: ClaudeLivenessState;
  lastTerminalOutputAt?: string;
  terminalOutputBytes?: number;
  lastMcpCallAt?: string;
  lastNudgeAt?: string;
  pendingAckMessageIds?: string[];
  livenessReason?: string | null;
  tmuxSocket?: string;
  tmuxSession?: string;
  tmuxPane?: string;
  panePid?: number;
  supervisorPid?: number;
  childPid?: number;
  processGroupId?: number;
  transcriptPath?: string;
  resolvedSkills?: string[];
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
  hasWakeEvents?: boolean;
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
    harness: status.harness,
    launchHarness: status.launchHarness,
    resultParser: status.resultParser,
    variant: status.variant,
    model: status.model,
    requestedModel: status.requestedModel,
    resolvedModel: status.resolvedModel,
    effort: status.effort,
    executionMode: status.executionMode,
    claudeTransport: status.claudeTransport,
    claudeInstalledSkills: status.claudeInstalledSkills,
    livenessState: status.livenessState,
    lastTerminalOutputAt: status.lastTerminalOutputAt,
    terminalOutputBytes: status.terminalOutputBytes,
    lastMcpCallAt: status.lastMcpCallAt,
    lastNudgeAt: status.lastNudgeAt,
    pendingAckMessageIds: status.pendingAckMessageIds,
    livenessReason: status.livenessReason,
    tmuxSocket: status.tmuxSocket,
    tmuxSession: status.tmuxSession,
    tmuxPane: status.tmuxPane,
    panePid: status.panePid,
    supervisorPid: status.supervisorPid,
    childPid: status.childPid,
    processGroupId: status.processGroupId,
    transcriptPath: status.transcriptPath,
    resolvedSkills: status.resolvedSkills,
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
    hasWakeEvents: previous?.hasWakeEvents,
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
    next.hasWakeEvents = true;
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
    resultParser: result.resultParser ?? summary.resultParser,
    claudeInstalledSkills: result.claudeInstalledSkills ?? summary.claudeInstalledSkills,
    livenessState: result.livenessState ?? summary.livenessState,
    livenessReason: result.livenessReason ?? summary.livenessReason,
    lastTerminalOutputAt: result.lastTerminalOutputAt ?? summary.lastTerminalOutputAt,
    terminalOutputBytes: result.terminalOutputBytes ?? summary.terminalOutputBytes,
    lastMcpCallAt: result.lastMcpCallAt ?? summary.lastMcpCallAt,
    lastNudgeAt: result.lastNudgeAt ?? summary.lastNudgeAt,
    pendingAckMessageIds: result.pendingAckMessageIds ?? summary.pendingAckMessageIds,
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
