import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackgroundTaskRecord } from "./task-types.js";

export type BackgroundBashWakeDetails = {
  taskId: string;
  status: "exited" | "failed" | "timed_out" | "killed";
  outputPath: string;
  outputBytes: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  stopReason?: BackgroundTaskRecord["stopReason"];
};

export type BackgroundBashWakeMessage = {
  customType: "background-bash-notification";
  content: string;
  display: true;
  details: BackgroundBashWakeDetails;
  options: { triggerTurn: true; deliverAs: "followUp" };
};

export type BackgroundWakeNotifier = {
  ownerSessionId?: string;
  ownerRuntimeId?: string;
  ownerSessionFile?: string;
  currentSessionId(): string | undefined;
  currentSessionFile(): string | undefined;
  send(message: BackgroundBashWakeMessage): void;
};

export type WakeRoutingResult = { ok: true } | { ok: false; code: string; message: string };

export class InvalidWakeRouteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InvalidWakeRouteError";
    this.code = code;
  }
}

export function completionMessage(task: BackgroundTaskRecord): string {
  return canonicalTerminal(task) ? buildWakeMessage(task).content : `[BACKGROUND BASH COMPLETE — NOT USER INPUT]\nTask: ${task.taskId}\nStatus: ${task.status}\nOutput: ${task.outputPath}`;
}

export function isWakeEligible(task: BackgroundTaskRecord): boolean {
  return task.schemaVersion === 1 && task.wakeOnCompletion === true && task.wakePolicyVersion === 1 && task.wakePolicySource === "tool_arg_v1";
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

export function validateWakeRouting(task: Pick<BackgroundTaskRecord, "ownerSessionId" | "ownerSessionFile" | "ownerRuntimeId">, notifier?: BackgroundWakeNotifier): WakeRoutingResult {
  if (!notifier) return { ok: false, code: "NO_NOTIFIER", message: "No session-bound wake notifier is available for this task." };
  if (typeof notifier.send !== "function") return { ok: false, code: "SEND_NOT_CALLABLE", message: "The host wake API is not callable." };
  const owner = task.ownerSessionId;
  const notifierOwner = notifier.ownerSessionId;
  const taskRuntime = task.ownerRuntimeId;
  const notifierRuntime = notifier.ownerRuntimeId;
  if (!nonempty(owner)) return { ok: false, code: "MISSING_OWNER_SESSION", message: "Wake-enabled task has no owner session id." };
  if (!nonempty(notifierOwner)) return { ok: false, code: "MISSING_NOTIFIER_SESSION", message: "Wake notifier has no owner session id." };
  if (owner !== notifierOwner) return { ok: false, code: "OWNER_SESSION_MISMATCH", message: `expected notifier for ${owner}, got ${notifierOwner}` };
  if (!nonempty(taskRuntime)) return { ok: false, code: "MISSING_TASK_RUNTIME", message: "Wake-enabled task has no owner runtime id." };
  if (!nonempty(notifierRuntime)) return { ok: false, code: "MISSING_NOTIFIER_RUNTIME", message: "Wake notifier has no owner runtime id." };
  if (taskRuntime !== notifierRuntime) return { ok: false, code: "RUNTIME_MISMATCH", message: `expected runtime ${taskRuntime}, got ${notifierRuntime}` };

  let current: string | undefined;
  let currentFile: string | undefined;
  try {
    current = notifier.currentSessionId();
    currentFile = notifier.currentSessionFile();
  } catch (error) {
    return { ok: false, code: "ROUTE_READ_FAILED", message: error instanceof Error ? error.message : String(error) };
  }
  if (!nonempty(current)) return { ok: false, code: "MISSING_CURRENT_SESSION", message: "Current Pi session id is unavailable." };
  if (current !== owner) return { ok: false, code: "SESSION_MISMATCH", message: `expected current session ${owner}, got ${current}` };

  const files = [task.ownerSessionFile, notifier.ownerSessionFile, currentFile];
  const allAbsent = files.every(value => value === undefined);
  if (!allAbsent && !files.every(nonempty)) return { ok: false, code: "SESSION_FILE_PRESENCE_MISMATCH", message: "Session files must be absent everywhere or present on task, notifier, and current session." };
  if (!allAbsent && new Set(files).size !== 1) return { ok: false, code: "SESSION_FILE_MISMATCH", message: "Task, notifier, and current session files do not match." };
  return { ok: true };
}

export function requireValidWakeRouting(task: Pick<BackgroundTaskRecord, "ownerSessionId" | "ownerSessionFile" | "ownerRuntimeId">, notifier?: BackgroundWakeNotifier): void {
  const route = validateWakeRouting(task, notifier);
  if (!route.ok) throw new InvalidWakeRouteError(route.code, route.message);
}

export function buildWakeMessage(task: BackgroundTaskRecord): BackgroundBashWakeMessage {
  const canonical = task.modelWakeCanonicalTerminal ?? canonicalTerminal(task);
  if (!canonical) throw new Error("Wake payload requires terminal task metadata.");
  const details: BackgroundBashWakeDetails = {
    taskId: task.taskId,
    status: canonical.status,
    outputPath: task.outputPath,
    outputBytes: task.outputBytes,
  };
  if (canonical.exitCode !== undefined && canonical.exitCode !== null) details.exitCode = canonical.exitCode;
  if (canonical.signal !== undefined && canonical.signal !== null) details.signal = canonical.signal;
  if (canonical.stopReason !== undefined) details.stopReason = canonical.stopReason;
  const tag = (name: string, value: unknown) => `  <${name}>${xmlEscape(String(value ?? "null"))}</${name}>`;
  const content = [
    `<background_bash_notification not_user_input="true">`,
    tag("task_id", details.taskId),
    tag("status", details.status),
    tag("output_path", details.outputPath),
    tag("output_bytes", details.outputBytes),
    ...(Object.hasOwn(details, "exitCode") ? [tag("exit_code", details.exitCode)] : []),
    ...(Object.hasOwn(details, "signal") ? [tag("signal", details.signal)] : []),
    ...(Object.hasOwn(details, "stopReason") ? [tag("stop_reason", details.stopReason)] : []),
    `</background_bash_notification>`,
  ].join("\n");
  return { customType: "background-bash-notification", content, display: true, details, options: { triggerTurn: true, deliverAs: "followUp" } };
}

export function canonicalTerminal(task: BackgroundTaskRecord): BackgroundTaskRecord["modelWakeCanonicalTerminal"] | undefined {
  if (!["exited", "failed", "timed_out", "killed"].includes(task.status)) return undefined;
  if (!task.endedAt) return undefined;
  return { status: task.status as "exited" | "failed" | "timed_out" | "killed", exitCode: task.exitCode ?? null, signal: task.signal ?? null, stopReason: task.stopReason, endedAt: task.endedAt };
}

function nonempty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}
