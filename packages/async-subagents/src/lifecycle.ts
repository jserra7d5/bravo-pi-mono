import { hostname } from "node:os";
import { extractCostFromSessionLogSync } from "./cost.js";
import { createResultEvent, createTerminalEvent } from "./events.js";
import { createRunResult } from "./result.js";
import { probeProcessIdentity, withRunMutationLock, type ProcessIdentitySnapshot } from "./runLock.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import { updateRunStatus } from "./status.js";
import type { RunMetrics, RunResult, RunStatus, TerminalRunState, WriterRole } from "./types.js";

export const SUPERVISOR_LAUNCH_GRACE_MS = 5 * 60 * 1000;

export type SupervisorAlive = "alive" | "dead" | "unknown";

export interface ReconcileResult {
  status: RunStatus;
  supervisorAlive: SupervisorAlive;
  repairedResult: boolean;
  promoted: boolean;
}

export interface ReconcileOptions {
  nowMs?: number;
  localHost?: string;
  probe?: (pid: number) => ProcessIdentitySnapshot;
}

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
    harness: status.harness,
    launchHarness: status.launchHarness,
    resultParser: status.resultParser,
    variant: status.variant,
    model: status.model,
    requestedModel: status.requestedModel,
    resolvedModel: status.resolvedModel,
    thinkingLevel: status.thinkingLevel,
    effort: status.effort,
    executionMode: status.executionMode,
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
    resolvedSkills: status.resolvedSkills,
    notInheritedAcrossHarness: status.notInheritedAcrossHarness,
    excludedAcrossHarness: status.excludedAcrossHarness,
    inheritedAcrossHarness: status.inheritedAcrossHarness,
    claudeHomeDir: status.claudeHomeDir,
    claudeSettingsPath: status.claudeSettingsPath,
    claudeMcpConfigPath: status.claudeMcpConfigPath,
    claudeAuthHome: status.claudeAuthHome,
    claudeMemoryIsolation: status.claudeMemoryIsolation,
    claudeShellHomeDir: status.claudeShellHomeDir,
    claudeShellWrapperPath: status.claudeShellWrapperPath,
    claudeTransport: status.claudeTransport,
    claudeInstalledSkills: status.claudeInstalledSkills,
    livenessState: status.livenessState,
    lastTerminalOutputAt: status.lastTerminalOutputAt,
    terminalOutputBytes: status.terminalOutputBytes,
    lastMcpCallAt: status.lastMcpCallAt,
    lastNudgeAt: status.lastNudgeAt,
    pendingAckMessageIds: status.pendingAckMessageIds,
    livenessReason: status.livenessReason,
    supervisorPid: status.supervisorPid,
    childPid: status.childPid,
    panePid: status.panePid,
    processGroupId: status.processGroupId,
    tmuxSocket: status.tmuxSocket,
    tmuxSession: status.tmuxSession,
    tmuxPane: status.tmuxPane,
    transcriptPath: status.transcriptPath,
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

function supervisorLiveness(status: RunStatus, localHost: string, probe: (pid: number) => ProcessIdentitySnapshot): SupervisorAlive {
  if (!status.supervisorPid || !status.supervisorHost || !status.supervisorStartedAtToken || status.supervisorHost !== localHost) return "unknown";
  const snapshot = probe(status.supervisorPid);
  if (snapshot.permissionDenied || snapshot.alive === undefined) return "unknown";
  if (snapshot.alive === false) {
    if (snapshot.identity && snapshot.identity !== status.supervisorStartedAtToken) return "unknown";
    return "dead";
  }
  return snapshot.identity === status.supervisorStartedAtToken ? "alive" : "unknown";
}

/** Result-first lifecycle repair and supervisor reconciliation under one run mutation lock. */
export async function reconcileUnderLock(store: RunStore, runId: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const runDir = store.pathsFor({ runId }).runDir;
  const localHost = options.localHost ?? hostname();
  const probe = options.probe ?? probeProcessIdentity;
  const nowMs = options.nowMs ?? Date.now();
  const reconciled = await withRunMutationLock(runDir, () => {
    let status = store.readStatus(runId);
    let repairedResult = false;
    const result = store.readResult(runId);
    if (result && (!isTerminalRunState(status.state) || status.state !== result.state || status.resultReady !== true)) {
      finalizeTerminalRun(store, {
        runId,
        parentRunId: result.parentRunId,
        agentName: result.agentName,
        state: result.state,
        writerRole: "parent-runtime",
        summary: result.summary,
        body: result.body,
        effectiveMaxRunMs: result.effectiveMaxRunMs,
        timeout: result.timeout,
        error: result.error ?? null,
      });
      status = store.readStatus(runId);
      repairedResult = true;
    }
    if (isTerminalRunState(status.state)) {
      return { status, supervisorAlive: supervisorLiveness(status, localHost, probe), repairedResult, promoted: false };
    }

    const supervisorAlive = supervisorLiveness(status, localHost, probe);
    let failure: { code: "SUPERVISOR_DIED" | "SUPERVISOR_LAUNCH_FAILED"; summary: string; message: string } | undefined;
    if (status.state === "created" || status.state === "queued") {
      const createdAt = Date.parse(status.createdAt);
      const stale = Number.isFinite(createdAt) && nowMs - createdAt >= SUPERVISOR_LAUNCH_GRACE_MS;
      const hasCompleteIdentity = Boolean(status.supervisorPid && status.supervisorHost && status.supervisorStartedAtToken);
      if (stale && (!hasCompleteIdentity || supervisorAlive === "dead")) {
        failure = { code: "SUPERVISOR_LAUNCH_FAILED", summary: "Supervisor launch failed", message: "No live supervisor took ownership within the launch grace period" };
      }
    } else if (supervisorAlive === "dead") {
      failure = { code: "SUPERVISOR_DIED", summary: "Supervisor died", message: "The recorded supervisor process is no longer alive" };
    }
    if (!failure) return { status, supervisorAlive, repairedResult, promoted: false };

    finalizeTerminalRun(store, {
      runId,
      parentRunId: status.parentRunId,
      agentName: status.agent.name,
      state: "failed",
      writerRole: "parent-runtime",
      summary: failure.summary,
      body: failure.message,
      error: { code: failure.code, message: failure.message },
    });
    status = store.readStatus(runId);
    return { status, supervisorAlive: "dead" as const, repairedResult, promoted: true };
  });
  return reconciled.value;
}
