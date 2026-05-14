import type { EventType, InboxMessageType, RunState, TerminalRunState } from "./types.js";

export const RUN_STATES: RunState[] = [
  "created",
  "queued",
  "running",
  "waiting_for_input",
  "blocked",
  "stalled",
  "completed",
  "failed",
  "cancelled",
  "expired",
];

export const TERMINAL_RUN_STATES: TerminalRunState[] = ["completed", "failed", "cancelled", "expired"];

export const EVENT_TYPES: EventType[] = [
  "started",
  "progress",
  "status",
  "message.received",
  "question",
  "blocked",
  "artifact",
  "result",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "heartbeat",
];

export const INBOX_MESSAGE_TYPES: InboxMessageType[] = ["instruction", "answer", "cancel", "pause", "resume", "context"];

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return TERMINAL_RUN_STATES.includes(state as TerminalRunState);
}

export function isInterestingEvent(type: EventType, wake?: boolean, requested: EventType[] = []): boolean {
  if (requested.includes(type)) return true;
  if (wake && type === "status") return true;
  return ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"].includes(type);
}
