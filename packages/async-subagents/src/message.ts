import { newMessageId } from "./ids.js";
import { isTerminalRunState } from "./schemas.js";
import { nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import type { AttachmentRef, InboxMessage, InboxMessageType, SubagentMessageResult } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createInboxMessage(input: {
  toRunId: string;
  fromRunId: string;
  body: string;
  type?: InboxMessageType;
  attachments?: AttachmentRef[];
  requiresAck?: boolean;
}): InboxMessage {
  return {
    schemaVersion: SCHEMA_VERSION,
    messageId: newMessageId(),
    toRunId: input.toRunId,
    fromRunId: input.fromRunId,
    type: input.type ?? "instruction",
    createdAt: nowIso(),
    body: input.body,
    attachments: input.attachments ?? [],
    requiresAck: input.requiresAck ?? true,
  };
}

export interface SendSubagentMessageInput {
  runId: string;
  fromRunId: string;
  body: string;
  type?: InboxMessageType;
  attachments?: AttachmentRef[];
  requiresAck?: boolean;
  liveTransport?: "child-control";
}

export interface WaitForMessageAckInput {
  runId: string;
  messageId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findMessageAck(store: RunStore, input: Pick<WaitForMessageAckInput, "runId" | "messageId">): { eventId: string } | undefined {
  const events = store.readEvents(input.runId).records;
  const event = events.find((candidate) => candidate.type === "message.received" && candidate.data?.messageId === input.messageId);
  return event ? { eventId: event.eventId } : undefined;
}

export async function waitForMessageAck(store: RunStore, input: WaitForMessageAckInput): Promise<{ eventId: string } | undefined> {
  const timeoutMs = input.timeoutMs ?? 2_000;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  const startedAt = Date.now();
  let ack = findMessageAck(store, input);
  while (!ack && Date.now() - startedAt < timeoutMs) {
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    ack = findMessageAck(store, input);
  }
  return ack;
}

export function sendSubagentMessage(store: RunStore, input: SendSubagentMessageInput): SubagentMessageResult {
  const message = createInboxMessage({
    toRunId: input.runId,
    fromRunId: input.fromRunId,
    body: input.body,
    type: input.type,
    attachments: input.attachments,
    requiresAck: input.requiresAck,
  });
  store.appendInboxMessage(input.runId, message);

  const status = store.readStatus(input.runId);
  const live = !isTerminalRunState(status.state);
  const cancel = message.type === "cancel";
  const supportedLiveTransport = input.liveTransport === "child-control";
  if (live && !cancel) {
    return {
      messageId: message.messageId,
      runId: input.runId,
      appended: true,
      liveDelivered: false,
      unsupported: supportedLiveTransport
        ? undefined
        : {
            code: "LIVE_MESSAGE_UNSUPPORTED",
            message: "message was appended to inbox.jsonl, but live parent-to-child delivery is not enabled for this run",
          },
    };
  }

  return {
    messageId: message.messageId,
    runId: input.runId,
    appended: true,
    liveDelivered: false,
  };
}
