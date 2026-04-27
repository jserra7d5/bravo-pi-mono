import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMetadata } from "./types.js";
import { isTerminalStatus } from "./lifecycle.js";

export interface ResultAssessment {
  resultFile: string;
  hasResultFile: boolean;
  result: string;
  finalized: boolean;
  resultReady: boolean;
  resultIssue?: string;
  resultWarning?: string;
}

export function assessResultDeliverable(meta: AgentMetadata): ResultAssessment {
  const resultFile = join(meta.runDir, "result.md");
  const hasResultFile = existsSync(resultFile);
  const result = hasResultFile ? readFileSync(resultFile, "utf8") : "";
  const finalized = !!meta.resultFinalizedAt;
  const hardIssue = resultIssue(meta, hasResultFile, finalized, result);
  const warning = !hardIssue ? resultWarning(meta, result) : undefined;
  return {
    resultFile,
    hasResultFile,
    result,
    finalized,
    resultReady: hasResultFile && finalized && !hardIssue,
    resultIssue: hardIssue,
    resultWarning: warning,
  };
}

export function resultIssue(meta: AgentMetadata, hasResultFile: boolean, finalized: boolean, result: string): string | undefined {
  if (meta.resultIssue) return meta.resultIssue;
  if (!finalized) {
    if (hasResultFile) return "Result deliverable exists but has not been finalized by Tango; inspect carefully and ask the agent to finish with --result-file if needed.";
    if (isTerminalStatus(meta.status)) return meta.summary ? "No finalized deliverable result.md found; only metadata.summary is available." : "No finalized deliverable result.md found.";
    return "Agent is not terminal; result is not ready.";
  }
  if (!hasResultFile) return "Result was finalized but result.md is missing.";
  if (!result.trim()) return "Result deliverable is empty.";
  return undefined;
}

function resultWarning(meta: AgentMetadata, result: string): string | undefined {
  if (looksReportLike(meta.task) && result.trim().length < 240) return "Result deliverable is suspiciously short for a report/audit/planning task.";
  return undefined;
}

function looksReportLike(task: string): boolean {
  return /\b(report|audit|findings|investigat(?:e|ion)|research|plan|planning|review|analysis|analy[sz]e|root[- ]cause)\b/i.test(task);
}
