import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderClock } from "@bravo/render-clock";
import { Type } from "typebox";
import { readJsonl } from "../../src/jsonl.js";
import { mutateNonterminalRun, mutateNonterminalStatus } from "../../src/lifecycle.js";
import { RunStore } from "../../src/runStore.js";
import type { EventType, InboxMessage, RunEvent } from "../../src/types.js";

type ChildControlState = {
  runId: string;
  runDir: string;
  parentRunId: string;
  rootSessionId?: string;
  store: RunStore;
  cursor: number;
};

const CHILD_EVENT_TYPES = ["progress", "status", "question", "blocked", "artifact"] as const;
const WAKE_TYPES = new Set<EventType>(["question", "blocked", "artifact"]);

type SubscribeOnlyClock = Pick<typeof renderClock, "subscribe">;
type InboxPollBody = () => void | Promise<void>;

function env(name: string): string | undefined {
  return process.env[name] || process.env[name.replace("ASYNC_SUBAGENTS_", "ASYNC_SUBAGENT_")];
}

function childStateFromEnv(): ChildControlState | undefined {
  const runId = env("ASYNC_SUBAGENTS_RUN_ID");
  const runDir = env("ASYNC_SUBAGENTS_RUN_DIR");
  const parentRunId = env("ASYNC_SUBAGENTS_PARENT_RUN_ID");
  if (!runId || !runDir || !parentRunId) return undefined;
  return {
    runId,
    runDir,
    parentRunId,
    rootSessionId: env("ASYNC_SUBAGENTS_ROOT_SESSION_ID"),
    store: new RunStore({ cwd: process.cwd(), runRoot: dirname(runDir) }),
    cursor: 0,
  };
}

async function appendEvent(
  state: ChildControlState,
  input: { type: EventType; summary?: string; body?: string; wake?: boolean; data?: Record<string, unknown> },
  options: { terminalBehavior?: "noop" | "reject"; receipt?: InboxMessage } = {},
): Promise<RunEvent | undefined> {
  const result = await mutateNonterminalRun(state.store, {
    runId: state.runId,
    type: input.type,
    summary: input.summary,
    body: input.body,
    wake: input.wake ?? WAKE_TYPES.has(input.type),
    data: input.data ?? {},
    writerRole: "child-runtime",
    terminalBehavior: options.terminalBehavior,
    statusPatch: options.receipt
      ? (status) => {
          const resumes =
            (options.receipt?.type === "answer" || options.receipt?.type === "instruction") &&
            (status.state === "blocked" || status.state === "waiting_for_input");
          return resumes
            ? { state: "running", needs: null }
            : { state: status.state, needs: status.needs };
        }
      : undefined,
  });
  return result.applied ? result.event : undefined;
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

async function restoreDeliveredReceiptProjection(state: ChildControlState, message: InboxMessage, summary: string): Promise<void> {
  if (message.type !== "answer" && message.type !== "instruction") return;
  await mutateNonterminalStatus(state.store, {
    runId: state.runId,
    writerRole: "child-runtime",
    terminalBehavior: "noop",
    statusPatch: (status) =>
      status.state === "blocked" || status.state === "waiting_for_input"
        ? { state: "running", needs: null, summary }
        : {},
  });
}

async function deliverInbox(pi: ExtensionAPI, state: ChildControlState): Promise<void> {
  for (;;) {
    const read = readJsonl<InboxMessage>(join(state.runDir, "inbox.jsonl"), { offset: state.cursor, maxRecords: 1 });
    const message = read.records[0];
    if (!message) break;
    if (message.thinkingLevel) pi.setThinkingLevel(message.thinkingLevel);
    pi.sendUserMessage(parentMessageText(message), { deliverAs: message.type === "cancel" ? "followUp" : "steer" });
    // Delivery succeeded, so never replay this message even if lifecycle bookkeeping fails.
    state.cursor = read.nextOffset;
    const receiptSummary = `Received ${message.type} from parent`;
    try {
      await appendEvent(state, {
        type: "message.received",
        summary: receiptSummary,
        body: message.body,
        wake: false,
        data: { messageId: message.messageId, messageType: message.type, requiresAck: message.requiresAck, thinkingLevel: message.thinkingLevel },
      }, { terminalBehavior: "noop", receipt: message });
    } catch (error) {
      if (message.type !== "answer" && message.type !== "instruction") {
        console.error("[async-subagents child-control] failed to record received inbox message", error);
        continue;
      }
      try {
        await restoreDeliveredReceiptProjection(state, message, receiptSummary);
      } catch (projectionError) {
        console.error("[async-subagents child-control] failed to record or project received inbox message", error, projectionError);
        continue;
      }
      console.error("[async-subagents child-control] failed to record received inbox message; restored status projection", error);
    }
  }
}

function subscribeChildInboxPoll(clock: SubscribeOnlyClock, body: InboxPollBody): () => void {
  return clock.subscribe({ id: "async-child-inbox-poll", intervalMs: 1_000, reconcile: body });
}

export function __subscribeChildInboxPollForTest(clock: SubscribeOnlyClock, body: InboxPollBody): () => void {
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
      const event = await appendEvent(state, {
        type: params.type as EventType,
        summary: params.summary,
        body: params.body,
        wake: typeof params.wake === "boolean" ? params.wake : undefined,
        data: params.data as Record<string, unknown> | undefined,
      });
      if (!event) throw new Error("run is terminal");
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
    inboxPollUnsubscribe = subscribeChildInboxPoll(clock, async () => {
      if (state) await deliverInbox(pi, state);
    });
    try {
      await deliverInbox(pi, state);
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
