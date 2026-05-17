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
      events.push(...interesting);
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
    next: ready.length ? ready.map((runId) => ({ tool: "subagent_result", args: { runId } })) : [{ tool: "subagent_wait", args: { runIds, since: cursors } }],
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
  const accumulatedReady = new Set<string>(latest.readyRunIds);
  const accumulatedEvents = [...latest.events];
  const accumulatedResults = new Map(latest.results.map((result) => [result.runId, result]));

  function accumulate(next: SubagentWaitResult): SubagentWaitResult {
    if (mode !== "all") return next;
    for (const runId of next.readyRunIds) accumulatedReady.add(runId);
    accumulatedEvents.push(...next.events);
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

  return latest;
}
