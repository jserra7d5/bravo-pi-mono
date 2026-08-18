import { reconcileUnderLock } from "./lifecycle.js";
import { isInterestingEvent, isTerminalRunState } from "./schemas.js";
import { RunStore } from "./runStore.js";
import type { EventType, RunEvent, RunResult, RunState, SubagentWaitResult, WaitCursorMap } from "./types.js";

export interface WaitInput {
  runIds?: string[];
  parentRunId?: string;
  since?: WaitCursorMap;
  mode?: "race" | "all" | "each";
  eventTypes?: EventType[];
  includeStatus?: boolean;
  includeResult?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  until?: "interesting" | "terminal" | "result" | "event";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRunIds(store: RunStore, input: WaitInput): string[] {
  if (input.runIds?.length) return input.runIds;
  if (input.parentRunId) return store.listDirectChildren(input.parentRunId).map((record) => record.runId);
  return [];
}

function coalesceTerminalEvents(events: RunEvent[], result: RunResult | undefined, includeResult: boolean): RunEvent[] {
  if (!result || !includeResult) return events;
  return events.filter((event) => !["result", "completed", "failed", "cancelled", "expired"].includes(event.type));
}

function eventMatches(input: WaitInput, event: RunEvent): boolean {
  const until = input.until ?? "interesting";
  if (until === "result") return false;
  if (until === "terminal") return isTerminalRunState(event.type as RunState);
  if (until === "event") return input.eventTypes?.length ? input.eventTypes.includes(event.type) : true;
  return isInterestingEvent(event.type, event.wake, input.eventTypes);
}

function resultMatches(input: WaitInput, result: RunResult | undefined): result is RunResult {
  if (!result || input.includeResult === false) return false;
  const until = input.until ?? "interesting";
  return until === "interesting" || until === "terminal" || until === "result";
}

const TERMINAL_EVENT_TYPES = new Set<EventType>(["result", "completed", "failed", "cancelled", "expired"]);

function withoutUnstableTerminalClaims(latest: SubagentWaitResult, unstableRunIds: Set<string>, runIds: string[]): SubagentWaitResult {
  const events = latest.events.filter((event) => !unstableRunIds.has(event.runId) || !TERMINAL_EVENT_TYPES.has(event.type));
  const results = latest.results.filter((result) => !unstableRunIds.has(result.runId));
  const readySet = new Set([...events.map((event) => event.runId), ...results.map((result) => result.runId)]);
  const readyRunIds = runIds.filter((runId) => readySet.has(runId));
  const mode = latest.mode;
  const ready = mode === "all" ? runIds.length > 0 && readyRunIds.length === runIds.length : readyRunIds.length > 0;
  return {
    ...latest,
    state: ready ? "ready" : "timeout",
    readyRunIds,
    events,
    results,
    remainingRunIds: runIds.filter((runId) => !readySet.has(runId)),
    timedOut: !ready,
    next: readyRunIds.length ? readyRunIds.map((runId) => ({ tool: "subagent_result", args: { runId } })) : [{ tool: "subagent_status", args: { runIds } }],
  };
}

function isMutationLockTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out waiting for run mutation lock/.test(error.message);
}

function terminalClaimState(event: RunEvent): RunState | undefined {
  if (isTerminalRunState(event.type as RunState)) return event.type as RunState;
  if (event.type === "result" && isTerminalRunState(event.data?.state as RunState)) return event.data!.state as RunState;
  return undefined;
}

export function waitOnce(store: RunStore, input: WaitInput): SubagentWaitResult {
  const mode = input.mode ?? "race";
  const runIds = resolveRunIds(store, input);
  const cursors: WaitCursorMap = {};
  const events: RunEvent[] = [];
  const results: RunResult[] = [];
  const statuses: Array<{ runId: string; state: RunState; summary?: string; displayName?: string; namePack?: string }> = [];
  const readyRunIds = new Set<string>();
  const includeResult = input.includeResult !== false;

  for (const runId of runIds) {
    const read = store.readEvents(runId, input.since?.[runId]);
    cursors[runId] = read.cursor;
    const result = includeResult ? store.readResult(runId) : undefined;
    const interesting = coalesceTerminalEvents(
      read.records.filter((event) => eventMatches(input, event)),
      result,
      includeResult,
    );
    if (interesting.length) {
      for (const event of interesting) events.push(event);
      readyRunIds.add(runId);
    }
    if (resultMatches(input, result)) {
      results.push(result);
      readyRunIds.add(runId);
    }
    if (input.includeStatus !== false) {
      const status = store.readStatus(runId);
      statuses.push({ runId: status.runId, state: status.state, summary: status.summary, displayName: status.displayName, namePack: status.namePack });
    }
    if (mode === "race" && readyRunIds.size > 0) break;
  }

  const ready = [...readyRunIds];
  const state = mode === "all" ? (runIds.length > 0 && ready.length === runIds.length ? "ready" : "timeout") : ready.length ? "ready" : "timeout";
  return {
    state,
    mode,
    readyRunIds: ready,
    events,
    results,
    statuses,
    cursors,
    remainingRunIds: runIds.filter((runId) => !readyRunIds.has(runId)),
    timedOut: state === "timeout",
    next: ready.length ? ready.map((runId) => ({ tool: "subagent_result", args: { runId } })) : [{ tool: "subagent_status", args: { runIds } }],
  };
}

export async function waitSubagents(store: RunStore, input: WaitInput): Promise<SubagentWaitResult> {
  const timeoutMs = input.timeoutMs ?? 0;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  const startedAt = Date.now();
  let since = input.since;
  let latest = waitOnce(store, { ...input, since });
  const mode = input.mode ?? "race";
  const runIds = resolveRunIds(store, input);
  const accumulatedReady = new Set<string>();
  const accumulatedEvents: RunEvent[] = [];
  const accumulatedResults = new Map<string, RunResult>();

  function accumulate(next: SubagentWaitResult): SubagentWaitResult {
    if (mode !== "all") return next;
    for (const runId of next.readyRunIds) accumulatedReady.add(runId);
    for (const event of next.events) accumulatedEvents.push(event);
    for (const result of next.results) accumulatedResults.set(result.runId, result);
    const readyRunIds = [...accumulatedReady];
    const ready = runIds.length > 0 && readyRunIds.length === runIds.length;
    return {
      ...next,
      state: ready ? "ready" : "timeout",
      readyRunIds,
      events: accumulatedEvents,
      results: [...accumulatedResults.values()],
      remainingRunIds: runIds.filter((runId) => !accumulatedReady.has(runId)),
      timedOut: !ready,
      next: readyRunIds.length ? readyRunIds.map((runId) => ({ tool: "subagent_result", args: { runId } })) : next.next,
    };
  }

  latest = accumulate(latest);

  while (latest.state !== "ready" && (timeoutMs < 0 || Date.now() - startedAt < timeoutMs)) {
    since = latest.cursors;
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs < 0 ? pollIntervalMs : timeoutMs - (Date.now() - startedAt))));
    latest = accumulate(waitOnce(store, { ...input, since }));
  }

  // Terminal files/events are published before status while holding the run
  // mutation lock. A lock-free poll can therefore observe either a result or a
  // terminal event during that brief publication window. Stabilization shares the
  // caller's deadline: a held lock must produce normal timeout semantics, never an
  // unrelated five-second lock rejection or a terminal claim paired with stale
  // status. This applies even when the caller excluded result bodies entirely.
  const terminalClaims = new Map<string, Set<RunState>>();
  for (const result of latest.results) terminalClaims.set(result.runId, new Set([result.state]));
  for (const event of latest.events) {
    const state = terminalClaimState(event);
    if (state) {
      const states = terminalClaims.get(event.runId) ?? new Set<RunState>();
      states.add(state);
      terminalClaims.set(event.runId, states);
    }
  }
  if (terminalClaims.size) {
    const reconciled = new Map<string, Awaited<ReturnType<typeof reconcileUnderLock>>["status"]>();
    const unstable = new Set<string>();
    await Promise.all([...terminalClaims].map(async ([runId, claimedStates]) => {
      const claimMatches = (state: RunState): boolean => isTerminalRunState(state) && claimedStates.size === 1 && claimedStates.has(state);
      const visibleStatus = store.readStatus(runId);
      if (claimMatches(visibleStatus.state)) {
        reconciled.set(runId, visibleStatus);
        return;
      }
      while (true) {
        const remainingMs = timeoutMs < 0 ? 5_000 : Math.max(0, timeoutMs - (Date.now() - startedAt));
        if (remainingMs === 0) {
          unstable.add(runId);
          return;
        }
        try {
          const outcome = await reconcileUnderLock(store, runId, { mutationLockTimeoutMs: remainingMs });
          if (claimMatches(outcome.status.state)) reconciled.set(runId, outcome.status);
          else unstable.add(runId);
          return;
        } catch (error) {
          if (!isMutationLockTimeout(error)) throw error;
          if (timeoutMs >= 0) {
            unstable.add(runId);
            return;
          }
        }
      }
    }));
    latest = withoutUnstableTerminalClaims(latest, unstable, runIds);
    if (reconciled.size && latest.statuses.length) {
      latest = {
        ...latest,
        statuses: latest.statuses.map((status) => {
          const terminal = reconciled.get(status.runId);
          return terminal ? { runId: terminal.runId, state: terminal.state, summary: terminal.summary, displayName: terminal.displayName, namePack: terminal.namePack } : status;
        }),
      };
    }
  }

  return latest;
}
