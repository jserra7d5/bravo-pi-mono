import { existsSync, openSync, readFileSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackgroundTaskRecord } from "./task-types.js";

export type BackgroundBashWakeMessage = {
  customType: "background-bash-notification";
  content: string;
  display: true;
  details: Record<string, unknown>;
  options: { triggerTurn: true; deliverAs: "followUp" };
};

export type BackgroundWakeSendResult = { acceptedAt: string; deliverySemantics: "accepted" | "delivered" };

export type BackgroundWakeNotifier = {
  ownerSessionId?: string;
  ownerRuntimeId: string;
  ownerSessionFile?: string;
  currentSessionId(): string | undefined;
  currentSessionFile(): string | undefined;
  send(message: BackgroundBashWakeMessage): Promise<BackgroundWakeSendResult>;
};

export function completionMessage(task: BackgroundTaskRecord): string {
  return canonicalTerminal(task) ? buildWakeMessage(task).content : `[BACKGROUND BASH COMPLETE — NOT USER INPUT]\nTask: ${task.taskId}\nStatus: ${task.status}\nOutput: ${task.outputPath}`;
}

export function isWakeEligible(task: BackgroundTaskRecord): boolean {
  return task.wakeOnCompletion === true && task.wakePolicyVersion === 1 && task.wakePolicySource === "tool_arg_v1";
}

export function claimPath(task: BackgroundTaskRecord): string {
  return join(dirname(task.metadataPath), "model-wake.claim");
}

export function acquireWakeClaim(task: BackgroundTaskRecord, now = new Date()): BackgroundTaskRecord | undefined {
  if (!isWakeEligible(task)) return undefined;
  if (task.modelWakeState && task.modelWakeState !== "not_requested") return undefined;
  const terminal = canonicalTerminal(task);
  if (!terminal) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(claimPath(task), "wx", 0o600);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const claimedAt = now.toISOString();
  return {
    ...task,
    modelWakeState: "claim_acquired",
    modelWakeNotificationId: `${task.taskId}:${terminal.endedAt}`,
    modelWakeClaimedAt: claimedAt,
    modelWakeCanonicalTerminal: terminal,
  };
}

export function routingFailure(task: BackgroundTaskRecord, code: string, message: string): BackgroundTaskRecord {
  return { ...task, modelWakeState: "routing_failed", modelWakeErrorCode: code, modelWakeError: message };
}

export function validateWakeRouting(task: BackgroundTaskRecord, notifier?: BackgroundWakeNotifier): { ok: true } | { ok: false; code: string; message: string } {
  if (!notifier) return { ok: false, code: "NO_NOTIFIER", message: "No session-bound wake notifier is available for this task." };
  if (!task.ownerSessionId) return { ok: false, code: "MISSING_OWNER_SESSION", message: "Wake-enabled task has no owner session id." };
  if (task.ownerSessionId !== notifier.ownerSessionId) return { ok: false, code: "OWNER_SESSION_MISMATCH", message: `expected notifier for ${task.ownerSessionId}, got ${notifier.ownerSessionId ?? "undefined"}` };
  if (task.ownerRuntimeId && task.ownerRuntimeId !== notifier.ownerRuntimeId) return { ok: false, code: "RUNTIME_MISMATCH", message: `expected runtime ${task.ownerRuntimeId}, got ${notifier.ownerRuntimeId}` };
  const current = notifier.currentSessionId();
  if (!current) return { ok: false, code: "STALE_SESSION_HANDLE", message: "Current Pi session id is unavailable." };
  if (current !== task.ownerSessionId) return { ok: false, code: "SESSION_MISMATCH", message: `expected current session ${task.ownerSessionId}, got ${current}` };
  const currentFile = notifier.currentSessionFile();
  if (task.ownerSessionFile && (!currentFile || currentFile !== task.ownerSessionFile)) return { ok: false, code: "SESSION_FILE_MISMATCH", message: `expected session file ${task.ownerSessionFile}, got ${currentFile ?? "undefined"}` };
  return { ok: true };
}

export function buildWakeMessage(task: BackgroundTaskRecord): BackgroundBashWakeMessage {
  const canonical = task.modelWakeCanonicalTerminal ?? canonicalTerminal(task)!;
  const tail = readBoundedTail(task.outputPath);
  const command = boundedText(task.command, 2048);
  const details = {
    taskId: task.taskId,
    status: canonical.status,
    exitCode: canonical.exitCode ?? null,
    signal: canonical.signal ?? null,
    stopReason: canonical.stopReason ?? null,
    command: command.text,
    commandTruncated: command.truncated,
    outputPath: task.outputPath,
    startedAt: task.startedAt ?? null,
    completedAt: canonical.endedAt,
    summary: summary(task, canonical),
    outputTail: tail.text,
    outputTailTruncated: tail.truncated,
    outputTailBytes: Buffer.byteLength(tail.text, "utf8"),
    outputTailLines: tail.lines,
    notificationId: task.modelWakeNotificationId,
  };
  const tag = (name: string, value: unknown, attrs = "") => `  <${name}${attrs}>${xmlEscape(String(value ?? "null"))}</${name}>`;
  const content = [
    `<background_bash_notification not_user_input="true">`,
    tag("task_id", task.taskId),
    tag("status", canonical.status),
    tag("exit_code", canonical.exitCode ?? null),
    tag("signal", canonical.signal ?? null),
    tag("stop_reason", canonical.stopReason ?? null),
    tag("command", command.text, ` truncated="${command.truncated}"`),
    tag("output_path", task.outputPath),
    tag("started_at", task.startedAt ?? null),
    tag("completed_at", canonical.endedAt),
    tag("summary", details.summary),
    tag("output_tail", tail.text, ` truncated="${tail.truncated}" bytes="${Buffer.byteLength(tail.text, "utf8")}" lines="${tail.lines}" encoding="xml-text-escaped"`),
    `</background_bash_notification>`,
  ].join("\n");
  return { customType: "background-bash-notification", content, display: true, details, options: { triggerTurn: true, deliverAs: "followUp" } };
}

export function canonicalTerminal(task: BackgroundTaskRecord): BackgroundTaskRecord["modelWakeCanonicalTerminal"] | undefined {
  if (!["exited", "failed", "timed_out", "killed"].includes(task.status)) return undefined;
  if (!task.endedAt) return undefined;
  return { status: task.status as "exited" | "failed" | "timed_out" | "killed", exitCode: task.exitCode ?? null, signal: task.signal ?? null, stopReason: task.stopReason, endedAt: task.endedAt };
}

function summary(task: BackgroundTaskRecord, c: NonNullable<BackgroundTaskRecord["modelWakeCanonicalTerminal"]>): string {
  if (c.status === "exited") return "Background command completed successfully.";
  if (c.status === "failed" && c.exitCode !== null && c.exitCode !== undefined) return `Background command failed with exit code ${c.exitCode}.`;
  if (c.status === "timed_out") return `Background command timed out after ${task.maxRuntimeMs ?? "configured runtime"}ms and was stopped.`;
  if (c.status === "killed" && c.stopReason === "user") return "Background command was stopped by request.";
  if (c.status === "killed" && c.stopReason === "output_cap") return "Background command was stopped after reaching the output cap.";
  return `Background command finished with status ${c.status}.`;
}

function readBoundedTail(path: string): { text: string; truncated: boolean; lines: number } {
  try {
    if (!existsSync(path)) return { text: "Output log is not available.", truncated: false, lines: 1 };
    const data = readFileSync(path);
    const max = 4096;
    const byteTruncated = data.length > max;
    const slice = data.subarray(Math.max(0, data.length - max));
    let text = slice.toString("utf8");
    if (byteTruncated) text = text.replace(/^\uFFFD/, "");
    text = normalizeText(text);
    const byteCapped = truncateUtf8Bytes(text, max);
    text = byteCapped.text;
    const split = text.split(/\r?\n/);
    const lineTruncated = split.length > 80;
    if (lineTruncated) text = split.slice(-80).join("\n");
    const finalCapped = truncateUtf8Bytes(text, max);
    text = finalCapped.text;
    return { text, truncated: byteTruncated || byteCapped.truncated || lineTruncated || finalCapped.truncated, lines: text ? text.split(/\r?\n/).length : 0 };
  } catch (err) {
    return { text: boundedText(`Could not read output log: ${err instanceof Error ? err.message : String(err)}`, 512).text, truncated: false, lines: 1 };
  }
}

function boundedText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  return truncateUtf8Bytes(normalizeText(text), maxBytes);
}

function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, ""), truncated: true };
}

function normalizeText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
