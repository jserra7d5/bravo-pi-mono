import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { appendJsonl, atomicWriteJson, readJsonl } from "../../src/jsonl.js";
import { SCHEMA_VERSION, type EventType, type InboxMessage, type RunEvent, type RunStatus } from "../../src/types.js";

type ChildControlState = {
  runId: string;
  runDir: string;
  parentRunId: string;
  cursor: number;
  timer?: ReturnType<typeof setInterval>;
};

const CHILD_EVENT_TYPES = ["progress", "status", "question", "blocked", "artifact"] as const;
const WAKE_TYPES = new Set<EventType>(["question", "blocked", "artifact"]);

function env(name: string): string | undefined {
  return process.env[name] || process.env[name.replace("ASYNC_SUBAGENTS_", "ASYNC_SUBAGENT_")];
}

function childStateFromEnv(): ChildControlState | undefined {
  const runId = env("ASYNC_SUBAGENTS_RUN_ID");
  const runDir = env("ASYNC_SUBAGENTS_RUN_DIR");
  const parentRunId = env("ASYNC_SUBAGENTS_PARENT_RUN_ID");
  if (!runId || !runDir || !parentRunId) return undefined;
  return { runId, runDir, parentRunId, cursor: 0 };
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
  const prefix = message.type === "answer" ? "Parent answered" : message.type === "cancel" ? "Parent requested cancellation" : "Parent message";
  return `${prefix} (${message.messageId}, ${message.type}):\n\n${message.body}`;
}

function deliverInbox(pi: ExtensionAPI, state: ChildControlState): void {
  const read = readJsonl<InboxMessage>(join(state.runDir, "inbox.jsonl"), { offset: state.cursor });
  state.cursor = read.nextOffset;
  for (const message of read.records) {
    appendEvent(state, {
      type: "message.received",
      summary: `Received ${message.type} from parent`,
      body: message.body,
      wake: false,
      data: { messageId: message.messageId, messageType: message.type, requiresAck: message.requiresAck },
    });
    pi.sendUserMessage(parentMessageText(message), { deliverAs: message.type === "cancel" ? "followUp" : "steer" });
  }
}

export default function childControlExtension(pi: ExtensionAPI) {
  let state: ChildControlState | undefined;

  pi.registerTool({
    name: "subagent_event",
    label: "Subagent Event",
    description: "Emit a structured child-to-parent subagent event.",
    promptSnippet: "Emit a progress, question, blocked, status, or artifact event to the parent subagent runtime.",
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
    state = childStateFromEnv();
    if (!state) return;
    deliverInbox(pi, state);
    state.timer = setInterval(() => {
      if (state) deliverInbox(pi, state);
    }, 1_000);
    state.timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (state?.timer) clearInterval(state.timer);
    state = undefined;
  });
}
