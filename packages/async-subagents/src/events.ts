import { eventIdForSequence } from "./ids.js";
import { nowIso } from "./time.js";
import type { EventType, RunEvent, RunResult, TerminalRunState } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createRunEvent(input: {
  sequence: number;
  runId: string;
  parentRunId: string;
  type: EventType;
  summary?: string;
  body?: string;
  wake?: boolean;
  data?: Record<string, unknown>;
}): RunEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: eventIdForSequence(input.sequence),
    runId: input.runId,
    parentRunId: input.parentRunId,
    type: input.type,
    level: "info",
    createdAt: nowIso(),
    summary: input.summary,
    body: input.body,
    wake: input.wake,
    data: input.data ?? {},
  };
}

export function createStartedEvent(input: {
  sequence: number;
  runId: string;
  parentRunId: string;
  pid?: number;
  command?: string;
}): RunEvent {
  return createRunEvent({
    sequence: input.sequence,
    runId: input.runId,
    parentRunId: input.parentRunId,
    type: "started",
    summary: input.pid ? `Started child process ${input.pid}` : "Started child process",
    data: { pid: input.pid, command: input.command },
  });
}

export function createProgressEvent(input: {
  sequence: number;
  runId: string;
  parentRunId: string;
  summary: string;
  body?: string;
  wake?: boolean;
  data?: Record<string, unknown>;
}): RunEvent {
  return createRunEvent({ ...input, type: "progress" });
}

export function createResultEvent(input: { sequence: number; result: RunResult }): RunEvent {
  return createRunEvent({
    sequence: input.sequence,
    runId: input.result.runId,
    parentRunId: input.result.parentRunId,
    type: "result",
    summary: input.result.summary,
    body: input.result.body,
    wake: true,
    data: { state: input.result.state, success: input.result.success },
  });
}

export function createTerminalEvent(input: {
  sequence: number;
  runId: string;
  parentRunId: string;
  state: TerminalRunState;
  summary?: string;
  error?: unknown;
}): RunEvent {
  return createRunEvent({
    sequence: input.sequence,
    runId: input.runId,
    parentRunId: input.parentRunId,
    type: input.state,
    summary: input.summary ?? `Run ${input.state}`,
    wake: true,
    data: { state: input.state, error: input.error },
  });
}
