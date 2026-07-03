import { execFile } from "node:child_process";
import { newMessageId } from "./ids.js";
import { isTerminalRunState } from "./schemas.js";
import { nowIso } from "./time.js";
import { RunStore } from "./runStore.js";
import type { AttachmentRef, InboxMessage, InboxMessageType, SubagentMessageResult, ThinkingLevel } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function createInboxMessage(input: {
  toRunId: string;
  fromRunId: string;
  body: string;
  type?: InboxMessageType;
  attachments?: AttachmentRef[];
  requiresAck?: boolean;
  thinkingLevel?: ThinkingLevel;
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
    thinkingLevel: input.thinkingLevel,
  };
}

export interface SendSubagentMessageInput {
  runId: string;
  fromRunId: string;
  body: string;
  type?: InboxMessageType;
  attachments?: AttachmentRef[];
  requiresAck?: boolean;
  thinkingLevel?: ThinkingLevel;
  liveTransport?: "child-control" | "tmux";
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

function tmuxBin(): string {
  return process.env.ASYNC_SUBAGENTS_TMUX_BIN || "tmux";
}

function execTmux(args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(tmuxBin(), args, { timeout: 2_000 }, (error) => error ? reject(error) : resolve());
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function sendTmuxNudge(status: { tmuxSocket: string; tmuxPane: string }, message: string): Promise<void> {
  const buffer = `async-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const base = ["-S", status.tmuxSocket];
  await execTmux([...base, "load-buffer", "-b", buffer, "-"], message);
  await execTmux([...base, "paste-buffer", "-d", "-b", buffer, "-t", status.tmuxPane]);
  await execTmux([...base, "send-keys", "-t", status.tmuxPane, "Enter"]);
}

export function findMessageAck(store: RunStore, input: Pick<WaitForMessageAckInput, "runId" | "messageId">): { eventId: string } | undefined {
  const events = store.readEvents(input.runId).records;
  const event = events.find((candidate) => candidate.type === "message.handled" && candidate.data?.messageId === input.messageId);
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
    thinkingLevel: input.thinkingLevel,
  });
  store.appendInboxMessage(input.runId, message);

  const status = store.readStatus(input.runId);
  const live = !isTerminalRunState(status.state);
  const cancel = message.type === "cancel";
  const tmuxAvailable = Boolean(status.harness === "claude" && status.claudeTransport === "mcp" && status.tmuxSocket && status.tmuxSession && status.tmuxPane && status.transcriptPath);
  const supportedLiveTransport = input.liveTransport === "child-control" || input.liveTransport === "tmux" || tmuxAvailable;
  if (live && !cancel) {
    let liveDelivered = false;
    if (tmuxAvailable) {
      void sendTmuxNudge({ tmuxSocket: status.tmuxSocket!, tmuxPane: status.tmuxPane! }, `Parent message ${message.messageId} is available in your durable MCP inbox. Directly invoke mcp__async_subagents__subagent_read_inbox now; do not ToolSearch. After handling it, directly invoke mcp__async_subagents__subagent_ack_inbox.\n`).catch(() => undefined);
      liveDelivered = true;
    }
    return {
      messageId: message.messageId,
      runId: input.runId,
      appended: true,
      liveDelivered,
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
