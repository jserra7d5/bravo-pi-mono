import { isTerminalRunState } from "../../src/schemas.js";
import { RunStore } from "../../src/runStore.js";
import { readWatcherSnapshot, type RunSummaryRow } from "../../src/watcher.js";
import { isWakeupKeyHandled, resultDeliveryKey } from "./wakeups.js";

export const ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE = "async-subagent-compaction-status";

export interface CompactionReminderInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
  maxRows?: number;
}

export interface CompactionReminderDetails {
  parentRunId?: string;
  rootSessionId?: string;
  active: number;
  waiting: number;
  resultReady: number;
  omitted: number;
  rows: Array<{
    runId: string;
    displayName?: string;
    agentName: string;
    state: string;
    summary?: string;
    resultReady: boolean;
  }>;
}

export interface CompactionReminderMessage {
  customType: typeof ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE;
  content: string;
  display: boolean;
  details: CompactionReminderDetails;
}

function unreadResult(input: CompactionReminderInput, row: RunSummaryRow): boolean {
  if (!row.result) return row.resultReady;
  const parentRunId = input.parentRunId ?? row.result.parentRunId;
  if (isWakeupKeyHandled(input.store, parentRunId, resultDeliveryKey(row.runId, row.result))) return false;
  return row.resultReady || Boolean(row.result);
}

function needsReminder(input: CompactionReminderInput, row: RunSummaryRow): boolean {
  return !isTerminalRunState(row.state) || unreadResult(input, row);
}

function shortText(value: string | undefined, max = 120): string | undefined {
  const single = value?.replace(/\s+/g, " ").trim();
  if (!single) return undefined;
  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 1))}…`;
}

function rowLabel(row: RunSummaryRow): string {
  const display = row.displayName ? `@${row.displayName}` : row.agentName;
  return row.displayName ? `${display} (${row.agentName})` : display;
}

function nextAction(row: RunSummaryRow): string {
  if (row.state === "waiting_for_input" || row.state === "blocked") return "respond with subagent_message; inspect once with subagent_status only if needed";
  if (row.resultReady || row.result || isTerminalRunState(row.state)) return "read with subagent_result";
  return "active; no per-row action needed until an async wakeup";
}

function rowLine(row: RunSummaryRow): string {
  const summary = shortText(row.needs ?? row.summary ?? row.event?.summary ?? row.result?.summary);
  const base = `- ${rowLabel(row)} ${row.runId}: ${row.state}`;
  return `${base}${summary ? ` — ${summary}` : ""}; ${nextAction(row)}.`;
}

export function buildCompactionReminder(input: CompactionReminderInput): CompactionReminderMessage | undefined {
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
  });
  const rows = snapshot.rows.filter((row) => needsReminder(input, row));
  if (!rows.length) return undefined;

  const maxRows = input.maxRows ?? 6;
  const shown = rows.slice(0, maxRows);
  const omitted = Math.max(0, rows.length - shown.length);
  const active = rows.filter((row) => !isTerminalRunState(row.state) && row.state !== "blocked" && row.state !== "waiting_for_input").length;
  const waiting = rows.filter((row) => row.state === "blocked" || row.state === "waiting_for_input").length;
  const resultReady = rows.filter((row) => unreadResult(input, row)).length;

  const counts = [
    active ? `${active} active` : "",
    waiting ? `${waiting} waiting/blocked` : "",
    resultReady ? `${resultReady} result-ready` : "",
  ].filter(Boolean).join(", ");

  const content = [
    `Async subagent status preserved after compaction${counts ? ` (${counts})` : ""}:`,
    ...shown.map(rowLine),
    omitted ? `- ${omitted} more subagent run${omitted === 1 ? "" : "s"} not shown.` : "",
    "After compaction, one subagent_status call is appropriate if you need to re-orient; do not loop on status for active runs. Before finalizing or changing direction, account for these in-flight or unread subagent results.",
  ].filter(Boolean).join("\n");

  return {
    customType: ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE,
    content,
    display: true,
    details: {
      parentRunId: input.parentRunId,
      rootSessionId: input.rootSessionId,
      active,
      waiting,
      resultReady,
      omitted,
      rows: shown.map((row) => ({
        runId: row.runId,
        displayName: row.displayName,
        agentName: row.agentName,
        state: row.state,
        summary: shortText(row.needs ?? row.summary ?? row.event?.summary ?? row.result?.summary),
        resultReady: unreadResult(input, row),
      })),
    },
  };
}
