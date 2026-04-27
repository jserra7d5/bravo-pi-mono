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

export interface ResultValidation {
  ok: boolean;
  issue?: string;
  warning?: string;
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
  if (meta.resultSummaryOnlyAt) return "Agent explicitly completed as summary-only; no deliverable result.md was intended for this run.";
  if (!finalized) {
    if (hasResultFile) return "Result deliverable exists but has not been finalized by Tango; inspect carefully and ask the agent to finish with --result-file if needed.";
    if (isTerminalStatus(meta.status)) return meta.summary ? "No finalized deliverable result.md found; only metadata.summary is available." : "No finalized deliverable result.md found.";
    return "Agent is not terminal; result is not ready.";
  }
  if (!hasResultFile) return "Result was finalized but result.md is missing.";
  if (!result.trim()) return "Result deliverable is empty.";
  const validation = validateResultContent(meta, result, { enforceRequired: true });
  if (!validation.ok) return validation.issue;
  return undefined;
}

function resultWarning(meta: AgentMetadata, result: string): string | undefined {
  return validateResultContent(meta, result, { enforceRequired: false }).warning;
}

export function validateResultContent(meta: Pick<AgentMetadata, "task" | "resultRequired">, result: string, options: { enforceRequired?: boolean; enforceReportLike?: boolean } = {}): ResultValidation {
  const trimmed = result.trim();
  if (!trimmed) return { ok: false, issue: "Result deliverable is empty." };
  if (looksPlaceholderResult(trimmed)) return { ok: false, issue: "Result deliverable appears to be a placeholder instead of the requested deliverable." };
  const shortReport = looksReportLike(meta.task) && trimmed.length < 240;
  if (shortReport) {
    const message = "Result deliverable is suspiciously short for a report/audit/planning task.";
    if ((options.enforceRequired && meta.resultRequired) || options.enforceReportLike) return { ok: false, issue: message };
    return { ok: true, warning: message };
  }
  return { ok: true };
}

export function looksPlaceholderResult(result: string): boolean {
  const normalized = result.toLowerCase().replace(/\s+/g, " ").trim();
  const placeholderPatterns = [
    /deliverable (?:is )?provided in (?:the )?final (?:response|answer|message)/,
    /(?:see|refer to) (?:the )?final (?:response|answer|message)/,
    /final (?:response|answer|message) contains/,
    /(?:full|actual|complete) (?:report|deliverable|findings|matrix|analysis).{0,80}(?:final response|final answer|below|above)/,
    /(?:completed|complete) (?:read-only )?(?:investigation|retrospective|review|audit|analysis|research|task)[.;]?$/,
    /(?:findings|report|matrix|analysis) (?:ready|complete)[.;]?$/,
  ];
  return placeholderPatterns.some((pattern) => pattern.test(normalized));
}

export function looksReportLike(task: string): boolean {
  return /\b(report|audit|findings|investigat(?:e|ion)|research|plan|planning|review|analysis|analy[sz]e|root[- ]cause|matrix|retrospective|deliver(?:able|y)?)\b/i.test(task);
}
