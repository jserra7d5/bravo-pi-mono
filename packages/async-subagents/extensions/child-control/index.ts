import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendJsonl, atomicWriteJson, readJsonl } from "../../src/jsonl.js";
import { RunStore } from "../../src/runStore.js";
import { TaskStore } from "../../src/taskStore.js";
import { SCHEMA_VERSION, type EventType, type InboxMessage, type RunEvent, type RunStatus } from "../../src/types.js";

type ChildControlState = {
  runId: string;
  runDir: string;
  parentRunId: string;
  rootSessionId?: string;
  taskId?: string;
  taskToken?: string;
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
  return { runId, runDir, parentRunId, rootSessionId: env("ASYNC_SUBAGENTS_ROOT_SESSION_ID"), taskId: env("ASYNC_SUBAGENTS_TASK_ID"), taskToken: env("ASYNC_SUBAGENTS_TASK_TOKEN"), cursor: 0 };
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
  const read = readJsonl<InboxMessage>(join(state.runDir, "inbox.jsonl"), { offset: state.cursor });
  state.cursor = read.nextOffset;
  for (const message of read.records) {
    appendEvent(state, {
      type: "message.received",
      summary: `Received ${message.type} from parent`,
      body: message.body,
      wake: false,
      data: { messageId: message.messageId, messageType: message.type, requiresAck: message.requiresAck, thinkingLevel: message.thinkingLevel },
    });
    if (message.thinkingLevel) pi.setThinkingLevel(message.thinkingLevel);
    pi.sendUserMessage(parentMessageText(message), { deliverAs: message.type === "cancel" ? "followUp" : "steer" });
  }
}

export default function childControlExtension(pi: ExtensionAPI) {
  let state: ChildControlState | undefined;

  const taskIdentity = () => {
    if (!state?.rootSessionId || !state.taskId || !state.taskToken) throw new Error("task tools are only available inside a task-owned async-subagents child run");
    return { rootSessionId: state.rootSessionId, taskId: state.taskId, runId: state.runId, runRoot: dirname(state.runDir), taskToken: state.taskToken };
  };

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

  if (env("ASYNC_SUBAGENTS_TASK_ID") && env("ASYNC_SUBAGENTS_TASK_TOKEN")) {
  pi.registerTool({
    name: "task_submit_result",
    label: "Task Submit Result",
    description: "Submit the durable result receipt for the task assigned to this child run. Only works with the harness-injected task identity. Requires a receipt or substantive payload: artifactPaths, evidence, commandsRun, or notes.",
    promptSnippet: "For task-owned runs, finish by calling task_submit_result with a concise summary plus a durable receipt or substantive payload (receipt, artifactPaths, evidence, commandsRun, or notes). Do not submit summary-only results. Do not mark the task accepted; the parent accepts results.",
    parameters: Type.Object({ summary: Type.String(), receipt: Type.Optional(Type.Any()), artifactPaths: Type.Optional(Type.Array(Type.String())), evidence: Type.Optional(Type.Array(Type.String())), commandsRun: Type.Optional(Type.Array(Type.String())), notes: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const id = taskIdentity();
      const store = new TaskStore({ cwd: process.cwd(), runRoot: id.runRoot });
      const task = store.submitResult(id.rootSessionId, id.taskId, { runId: id.runId, taskToken: id.taskToken, summary: String(params.summary), receipt: params.receipt as Record<string, unknown> | undefined, artifactPaths: params.artifactPaths as string[] | undefined, evidence: params.evidence as string[] | undefined, commandsRun: params.commandsRun as string[] | undefined, notes: params.notes as string | undefined });
      return { content: [{ type: "text" as const, text: `Submitted result for ${task.id}` }], details: { taskId: task.id, status: task.status, result: task.result } };
    },
  });

  pi.registerTool({
    name: "task_update_progress",
    label: "Task Update Progress",
    description: "Append non-terminal progress for the task assigned to this child run.",
    parameters: Type.Object({ summary: Type.Optional(Type.String()), activeForm: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const id = taskIdentity();
      const task = new TaskStore({ cwd: process.cwd(), runRoot: id.runRoot }).updateProgress(id.rootSessionId, id.taskId, { runId: id.runId, taskToken: id.taskToken, summary: params.summary as string | undefined, activeForm: params.activeForm as string | undefined });
      return { content: [{ type: "text" as const, text: `Updated progress for ${task.id}` }], details: { taskId: task.id, status: task.status } };
    },
  });

  pi.registerTool({
    name: "task_report_blocked",
    label: "Task Report Blocked",
    description: "Report a blocker or need for parent input for the task assigned to this child run.",
    parameters: Type.Object({ summary: Type.String(), notes: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const id = taskIdentity();
      const task = new TaskStore({ cwd: process.cwd(), runRoot: id.runRoot }).reportBlocked(id.rootSessionId, id.taskId, { runId: id.runId, taskToken: id.taskToken, summary: String(params.summary), notes: params.notes as string | undefined });
      return { content: [{ type: "text" as const, text: `Reported blocker for ${task.id}` }], details: { taskId: task.id, status: task.status } };
    },
  });

  }

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
