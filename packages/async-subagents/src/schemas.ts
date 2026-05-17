import type { ContextPolicy, EventType, InboxMessageType, RunState, SessionPolicy, TerminalRunState, ThinkingLevel } from "./types.js";

export const RUN_STATES: RunState[] = [
  "created",
  "queued",
  "running",
  "idle",
  "waiting_for_input",
  "paused",
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
export const PARENT_MESSAGE_TYPES = ["instruction", "answer", "context"] as const;
export const CONTEXT_POLICIES: ContextPolicy[] = ["fresh", "fork"];
export const SESSION_POLICIES: SessionPolicy[] = ["record", "none"];
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return TERMINAL_RUN_STATES.includes(state as TerminalRunState);
}

export function isInterestingEvent(type: EventType, wake?: boolean, requested: EventType[] = []): boolean {
  if (requested.includes(type)) return true;
  if (wake && type === "status") return true;
  return ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"].includes(type);
}
