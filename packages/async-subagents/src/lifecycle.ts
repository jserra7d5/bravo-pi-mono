import { hostname } from "node:os";
import { extractCostFromSessionLogSync } from "./cost.js";
import { createResultEvent, createRunEvent, createTerminalEvent } from "./events.js";
import { createRunResult } from "./result.js";
import { probeProcessIdentity, withRunMutationLock, type ProcessIdentitySnapshot } from "./runLock.js";
import { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import { updateRunStatus } from "./status.js";
import type { EventType, RunEvent, RunMetrics, RunResult, RunStatus, TerminalRunState, WriterRole } from "./types.js";

export const SUPERVISOR_LAUNCH_GRACE_MS = 5 * 60 * 1000;
// The supervisor's configured Claude MCP drain is capped at five seconds. A
// presentation-triggered orphan repair must not outrun that canonical drain.
export const TERMINAL_DRAIN_GRACE_MS = 5_000;

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
  mutationLockTimeoutMs?: number;
}

export type ProcessHealth = "alive" | "dead" | "unknown";

export interface DeadProcessReconcileOptions {
  nowMs?: number;
  cancellationGraceMs?: number;
  terminalDrainGraceMs?: number;
  localHost?: string;
  probe?: (pid: number) => ProcessHealth;
  supervisorProbe?: (pid: number) => ProcessIdentitySnapshot;
  mutationLockTimeoutMs?: number;
}

export interface DeadProcessReconcileResult {
  status: RunStatus;
  processHealth: ProcessHealth;
  promoted: boolean;
}

// Kept broad for existing event-forwarding callers; terminal/result values are
// rejected at the lifecycle boundary before any mutation is written.
export type NonterminalEventType = EventType;

export interface NonterminalEventMutationInput {
  runId: string;
  type: NonterminalEventType;
  summary?: string;
  body?: string;
  wake?: boolean;
  data?: Record<string, unknown>;
  writerRole: WriterRole;
  /** Additional lifecycle transition applied atomically with the event (for example state/needs). */
  statusPatch?: Partial<RunStatus> | ((status: RunStatus, event: RunEvent) => Partial<RunStatus>);
  terminalBehavior?: "noop" | "reject";
  mutationLockTimeoutMs?: number;
}

export type NonterminalEventMutationResult =
  | { applied: true; event: RunEvent; status: RunStatus }
  | { applied: false; status: RunStatus };

export type NonterminalStatusPatch = Partial<Pick<RunStatus, "state" | "needs" | "summary">>;

export interface NonterminalStatusMutationInput {
  runId: string;
  writerRole: WriterRole;
  statusPatch: NonterminalStatusPatch | ((status: Readonly<RunStatus>) => NonterminalStatusPatch);
  terminalBehavior?: "noop" | "reject";
  mutationLockTimeoutMs?: number;
}

export type NonterminalStatusMutationResult =
  | { applied: true; status: RunStatus }
  | { applied: false; status: RunStatus };

/**
 * Status-only degradation fallback for an already-delivered parent answer or
 * instruction whose receipt event could not be persisted. Normal lifecycle
 * changes must use mutateNonterminalRun so event and status remain atomic.
 */
export async function mutateNonterminalStatus(store: RunStore, input: NonterminalStatusMutationInput): Promise<NonterminalStatusMutationResult> {
  const runDir = store.pathsFor({ runId: input.runId }).runDir;
  const mutation = await withRunMutationLock(runDir, () => {
    const current = store.readStatus(input.runId);
    if (isTerminalRunState(current.state)) {
      if (input.terminalBehavior === "noop") return { applied: false as const, status: current };
      throw new Error(`run is terminal: ${input.runId}`);
    }
    const patch = typeof input.statusPatch === "function" ? input.statusPatch(current) : input.statusPatch;
    if (patch.state && isTerminalRunState(patch.state)) throw new Error(`status mutation is terminal: ${patch.state}`);
    const status = updateRunStatus(current, { ...patch, writerRole: input.writerRole });
    store.writeStatus(status);
    return { applied: true as const, status };
  }, { timeoutMs: input.mutationLockTimeoutMs });
  return mutation.value;
}

function transitionForNonterminalEvent(status: RunStatus, event: RunEvent): Partial<RunStatus> {
  if (event.type === "question") return { state: "waiting_for_input", needs: event.summary };
  if (event.type === "blocked") return { state: "blocked", needs: event.summary };
  if (event.type === "message.received" && (event.data?.messageType === "answer" || event.data?.messageType === "instruction")) {
    return { state: "running", needs: null };
  }
  if (["progress", "status", "artifact", "liveness"].includes(event.type) && (status.state === "created" || status.state === "queued")) {
    return { state: "running" };
  }
  return {};
}

/**
 * Serializes a nonterminal event and its canonical status transition against all
 * other run lifecycle mutations. Terminal state is re-read under the lock so a
 * late child update cannot resurrect a completed run.
 */
export async function mutateNonterminalRun(store: RunStore, input: NonterminalEventMutationInput): Promise<NonterminalEventMutationResult> {
  const runDir = store.pathsFor({ runId: input.runId }).runDir;
  const mutation = await withRunMutationLock(runDir, () => {
    if (input.type === "result" || input.type === "completed" || input.type === "failed" || input.type === "cancelled" || input.type === "expired") {
      throw new Error(`event is terminal: ${input.type}`);
    }
    const current = store.readStatus(input.runId);
    if (isTerminalRunState(current.state)) {
      if (input.terminalBehavior === "noop") return { applied: false as const, status: current };
      throw new Error(`run is terminal: ${input.runId}`);
    }
    const event = createRunEvent({
      sequence: nextEventSequence(store, input.runId),
      runId: input.runId,
      parentRunId: current.parentRunId,
      type: input.type,
      summary: input.summary,
      body: input.body,
      wake: input.wake,
      data: input.data,
    });
    const customTransition = typeof input.statusPatch === "function" ? input.statusPatch(current, event) : (input.statusPatch ?? {});
    const transition = { ...transitionForNonterminalEvent(current, event), ...customTransition };
    store.appendEvent(input.runId, event);
    const status = updateRunStatus(current, {
      ...transition,
      writerRole: input.writerRole,
      lastActivityAt: event.createdAt,
      lastEventId: event.eventId,
      summary: input.summary ?? transition.summary ?? current.summary,
    });
    store.writeStatus(status);
    return { applied: true as const, event, status };
  }, { timeoutMs: input.mutationLockTimeoutMs });
  return mutation.value;
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
  processHealth?: ProcessHealth;
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
    if (!isTerminalRunState(status.state) || status.state !== existingResult.state) {
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
      ...(input.processHealth ? { processHealth: input.processHealth } : {}),
    }),
  );
  return result;
}

const PROCESS_OWNED_ACTIVE_STATES = new Set(["running", "idle", "stalled"]);

function defaultProcessHealthProbe(pid: number): ProcessHealth {
  const snapshot = probeProcessIdentity(pid);
  return snapshot.alive === true ? "alive" : snapshot.alive === false ? "dead" : "unknown";
}

/**
 * Canonical repair for the legacy child-pid dead-process signal used by the pi
 * presentation. Every durable precondition is re-read under the lifecycle lock;
 * presentation only requests this operation and never invents terminal state.
 */
export async function reconcileDeadProcessUnderLock(
  store: RunStore,
  runId: string,
  options: DeadProcessReconcileOptions = {},
): Promise<DeadProcessReconcileResult> {
  const runDir = store.pathsFor({ runId }).runDir;
  const reconciled = await withRunMutationLock(runDir, () => {
    let status = store.readStatus(runId);
    const existingResult = store.readResult(runId);
    if (existingResult) {
      if (!isTerminalRunState(status.state) || status.state !== existingResult.state) {
        finalizeTerminalRun(store, {
          runId,
          parentRunId: existingResult.parentRunId,
          agentName: existingResult.agentName,
          state: existingResult.state,
          writerRole: "parent-runtime",
          summary: existingResult.summary,
          body: existingResult.body,
          effectiveMaxRunMs: existingResult.effectiveMaxRunMs,
          timeout: existingResult.timeout,
          error: existingResult.error ?? null,
        });
        status = store.readStatus(runId);
      }
      return { status, processHealth: "unknown" as const, promoted: false };
    }
    if (isTerminalRunState(status.state)) return { status, processHealth: "unknown" as const, promoted: false };

    const pid = status.pid;
    if (!pid || !Number.isFinite(pid) || pid <= 0) return { status, processHealth: "unknown" as const, promoted: false };
    let processHealth: ProcessHealth;
    try {
      processHealth = (options.probe ?? defaultProcessHealthProbe)(pid);
    } catch {
      processHealth = "unknown";
    }
    if (processHealth !== "dead") return { status, processHealth, promoted: false };

    // A recorded supervisor owns terminal publication. Only repair after that
    // ownership is definitively dead; unknown identity/permissions remain
    // conservative so presentation cannot race an in-flight MCP completion.
    const hasSupervisorOwnership = Boolean(status.supervisorPid || status.supervisorHost || status.supervisorStartedAtToken);
    if (hasSupervisorOwnership) {
      const supervisorAlive = supervisorLiveness(
        status,
        options.localHost ?? hostname(),
        options.supervisorProbe ?? probeProcessIdentity,
      );
      if (supervisorAlive !== "dead") return { status, processHealth, promoted: false };
    }

    // Claude MCP completion can arrive shortly after its pane exits. The
    // supervisor uses this interval to drain a terminal result, so orphan repair
    // waits out the same maximum window even when supervisor ownership has just
    // disappeared.
    if (status.harness === "claude" && status.claudeTransport === "mcp") {
      const activityTimes = [status.updatedAt, status.lastTerminalOutputAt, status.lastMcpCallAt]
        .map((value) => value ? Date.parse(value) : Number.NaN)
        .filter(Number.isFinite);
      const drainStartedAt = activityTimes.length ? Math.max(...activityTimes) : Number.NaN;
      const drainGraceMs = options.terminalDrainGraceMs ?? TERMINAL_DRAIN_GRACE_MS;
      if (!Number.isFinite(drainStartedAt) || (options.nowMs ?? Date.now()) - drainStartedAt <= drainGraceMs) {
        return { status, processHealth, promoted: false };
      }
    }

    // Re-read the durable summary projection while holding the lock. In
    // particular, cancellation may have been recorded as an event after status.
    const summaryRow = store.readRunSummary(runId);
    const cancelRequested = summaryRow?.summary?.startsWith("Cancel requested:") === true;
    if (cancelRequested) {
      const requestedAt = Date.parse(summaryRow.updatedAt);
      const graceMs = options.cancellationGraceMs ?? 60_000;
      if (!Number.isFinite(requestedAt) || (options.nowMs ?? Date.now()) - requestedAt <= graceMs) {
        return { status, processHealth, promoted: false };
      }
    } else if (!PROCESS_OWNED_ACTIVE_STATES.has(status.state)) {
      return { status, processHealth, promoted: false };
    }

    const state = cancelRequested ? "cancelled" : "failed";
    const summary = cancelRequested
      ? "Cancelled after recorded child process exited before supervisor finalization"
      : "Failed after recorded child process exited before supervisor finalization";
    const error = {
      code: cancelRequested ? "PARENT_CANCELLED_PROCESS_EXITED" : "PARENT_PROCESS_EXITED_WITHOUT_TERMINAL_STATUS",
      message: summary,
      details: { pid, processHealth: "dead" },
    };
    finalizeTerminalRun(store, {
      runId,
      parentRunId: status.parentRunId,
      agentName: status.agent.name,
      state,
      writerRole: "parent-runtime",
      summary,
      body: summary,
      error,
      processHealth: "dead",
    });
    status = store.readStatus(runId);
    return { status, processHealth, promoted: true };
  }, { timeoutMs: options.mutationLockTimeoutMs });
  return reconciled.value;
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
    if (result && (!isTerminalRunState(status.state) || status.state !== result.state)) {
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
  }, { timeoutMs: options.mutationLockTimeoutMs });
  return reconciled.value;
}
