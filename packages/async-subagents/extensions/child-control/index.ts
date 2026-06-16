import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderClock } from "@bravo/render-clock";
import { Type } from "typebox";
import { appendJsonl, atomicWriteJson, readJsonl } from "../../src/jsonl.js";
import { RunStore } from "../../src/runStore.js";
import { SCHEMA_VERSION, type EventType, type InboxMessage, type RunEvent, type RunStatus } from "../../src/types.js";

type ChildControlState = {
  runId: string;
  runDir: string;
  parentRunId: string;
  rootSessionId?: string;
  cursor: number;
};

const CHILD_EVENT_TYPES = ["progress", "status", "question", "blocked", "artifact"] as const;
const WAKE_TYPES = new Set<EventType>(["question", "blocked", "artifact"]);

type SubscribeOnlyClock = Pick<typeof renderClock, "subscribe">;

function env(name: string): string | undefined {
  return process.env[name] || process.env[name.replace("ASYNC_SUBAGENTS_", "ASYNC_SUBAGENT_")];
}

function childStateFromEnv(): ChildControlState | undefined {
  const runId = env("ASYNC_SUBAGENTS_RUN_ID");
  const runDir = env("ASYNC_SUBAGENTS_RUN_DIR");
  const parentRunId = env("ASYNC_SUBAGENTS_PARENT_RUN_ID");
  if (!runId || !runDir || !parentRunId) return undefined;
  return { runId, runDir, parentRunId, rootSessionId: env("ASYNC_SUBAGENTS_ROOT_SESSION_ID"), cursor: 0 };
}

function eventId(): string {
  return `evt_${Date.now().toString(36)}_${randomBytes(5).toString("base64url")}`;
}

function appendEvent(state: ChildControlState, input: { type: EventType; summary?: string; body?: string; wake?: boolean; data?: Record<string, unknown> }): RunEvent {
  const event: RunEvent = {
    schemaVersion: SCHEMA_VERSION,
    eventId: eventId(),
    runId: state.runId,
    parentRunId: state.parentRunId,
    type: input.type,
    level: "info",
    createdAt: new Date().toISOString(),
    summary: input.summary,
    body: input.body,
    wake: input.wake ?? WAKE_TYPES.has(input.type),
    data: input.data ?? {},
  };
  appendJsonl(join(state.runDir, "events.jsonl"), event);
  updateStatusFromEvent(state, event);
  return event;
}

function updateStatusFromEvent(state: ChildControlState, event: RunEvent): void {
  const statusPath = join(state.runDir, "status.json");
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as RunStatus;
    const nextState =
      event.type === "question" ? "waiting_for_input" :
      event.type === "blocked" ? "blocked" :
      status.state;
    atomicWriteJson(statusPath, {
      ...status,
      state: nextState,
      writerRole: "child-runtime",
      updatedAt: event.createdAt,
      lastActivityAt: event.createdAt,
      lastEventId: event.eventId,
      summary: event.summary ?? status.summary,
      needs: event.type === "question" || event.type === "blocked" ? event.summary ?? event.body ?? null : status.needs,
    });
  } catch {
    // Status is best-effort here. The durable event is the communication contract.
  }
}

function parentMessageText(message: InboxMessage): string {
  const prefix =
    message.type === "answer" ? "Parent answered" :
    message.type === "cancel" ? "Parent requested cancellation" :
    message.type === "pause" ? "Parent paused this run" :
    message.type === "resume" ? "Parent resumed this run" :
    "Parent message";
  return `${prefix} (${message.messageId}, ${message.type}):\n\n${message.body}`;
}

function deliverInbox(pi: ExtensionAPI, state: ChildControlState): void {
  for (;;) {
    const read = readJsonl<InboxMessage>(join(state.runDir, "inbox.jsonl"), { offset: state.cursor, maxRecords: 1 });
    const message = read.records[0];
    if (!message) break;
    if (message.thinkingLevel) pi.setThinkingLevel(message.thinkingLevel);
    pi.sendUserMessage(parentMessageText(message), { deliverAs: message.type === "cancel" ? "followUp" : "steer" });
    state.cursor = read.nextOffset;
    try {
      appendEvent(state, {
        type: "message.received",
        summary: `Received ${message.type} from parent`,
        body: message.body,
        wake: false,
        data: { messageId: message.messageId, messageType: message.type, requiresAck: message.requiresAck, thinkingLevel: message.thinkingLevel },
      });
    } catch (error) {
      console.error("[async-subagents child-control] failed to record received inbox message", error);
    }
  }
}

function subscribeChildInboxPoll(clock: SubscribeOnlyClock, body: () => void): () => void {
  return clock.subscribe({ id: "async-child-inbox-poll", intervalMs: 1_000, reconcile: body });
}

export function __subscribeChildInboxPollForTest(clock: SubscribeOnlyClock, body: () => void): () => void {
  return subscribeChildInboxPoll(clock, body);
}

export default function childControlExtension(pi: ExtensionAPI, options?: { clock?: SubscribeOnlyClock }) {
  const clock = options?.clock ?? renderClock;
  let state: ChildControlState | undefined;
  let inboxPollUnsubscribe: (() => void) | undefined;

  pi.registerTool({
    name: "subagent_event",
    label: "Subagent Event",
    description: "Emit a structured child-to-parent subagent event.",
    promptSnippet: "Emit a progress, question, blocked, status, or artifact event to the parent subagent runtime. If you receive a time-budget warning, checkpoint your current findings; if you cannot finish before the deadline, emit a blocked event with the checkpoint and what parent input or continuation you need.",
    parameters: Type.Object({
      type: StringEnum(CHILD_EVENT_TYPES),
      summary: Type.String(),
      body: Type.Optional(Type.String()),
      wake: Type.Optional(Type.Boolean()),
      data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_toolCallId, params) {
      if (!state) throw new Error("subagent_event is only available inside an async-subagents child run");
      const event = appendEvent(state, {
        type: params.type as EventType,
        summary: params.summary,
        body: params.body,
        wake: typeof params.wake === "boolean" ? params.wake : undefined,
        data: params.data as Record<string, unknown> | undefined,
      });
      return {
        content: [{ type: "text" as const, text: `Event ${event.eventId} emitted` }],
        details: { event },
      };
    },
  });

  pi.on("session_start", async () => {
    const next = childStateFromEnv();
    if (!next) return;
    if (!state || state.runId !== next.runId || state.runDir !== next.runDir) state = next;
    inboxPollUnsubscribe?.();
    inboxPollUnsubscribe = undefined;
    inboxPollUnsubscribe = subscribeChildInboxPoll(clock, () => {
      if (state) deliverInbox(pi, state);
    });
    try {
      deliverInbox(pi, state);
    } catch (error) {
      console.error("[async-subagents child-control] initial inbox delivery failed", error);
    }
  });

  pi.on("session_shutdown", async () => {
    inboxPollUnsubscribe?.();
    inboxPollUnsubscribe = undefined;
    state = undefined;
  });
}
