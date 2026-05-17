import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { CheckIssue } from "./types.js";

export type ReceiptType = "worker" | "judge";
export type WorkerReceiptStatus = "complete" | "partial" | "blocked";
export type JudgeReceiptVerdict = "pass" | "fail" | "needs_more_evidence" | "blocked";

export interface ParsedReceipt {
	frontmatter: Record<string, unknown>;
	body: string;
}

export interface ReceiptValidationOptions {
	expectedType?: ReceiptType;
	taskId?: string;
	runId?: string;
	verdict?: JudgeReceiptVerdict;
	receiptPath?: string;
	verdictPath?: string;
}

const WORKER_STATUSES = new Set(["complete", "partial", "blocked"]);
const JUDGE_VERDICTS = new Set(["pass", "fail", "needs_more_evidence", "blocked"]);

export async function loadReceipt(path: string): Promise<ParsedReceipt> {
	return parseReceiptMarkdown(await readFile(path, "utf8"));
}

export function parseReceiptMarkdown(markdown: string): ParsedReceipt {
	if (!markdown.startsWith("---\n")) {
		throw new Error("Receipt is missing YAML frontmatter.");
	}
	const end = markdown.indexOf("\n---", 4);
	if (end < 0) {
		throw new Error("Receipt frontmatter is not closed.");
	}
	const frontmatterText = markdown.slice(4, end);
	const body = markdown.slice(end + 4).replace(/^\r?\n/, "");
	const frontmatter = YAML.parse(frontmatterText);
	if (!isRecord(frontmatter)) {
		throw new Error("Receipt frontmatter must be a YAML mapping.");
	}
	return { frontmatter, body };
}

export function validateReceipt(receipt: ParsedReceipt, options: ReceiptValidationOptions = {}): CheckIssue[] {
	const issues: CheckIssue[] = [];
	const fm = receipt.frontmatter;
	if (fm.schema_version !== 1) {
		issues.push({ severity: "error", code: "RECEIPT_SCHEMA_VERSION", message: "Receipt schema_version must be 1.", path: "schema_version" });
	}
	if (fm.type !== "worker" && fm.type !== "judge") {
		issues.push({ severity: "error", code: "RECEIPT_TYPE_INVALID", message: "Receipt type must be worker or judge.", path: "type" });
	}
	if (options.expectedType && fm.type !== options.expectedType) {
		issues.push({ severity: "error", code: "RECEIPT_TYPE_MISMATCH", message: `Expected ${options.expectedType} receipt.`, path: "type" });
	}
	requireString(fm.task_id, "task_id", issues);
	requireString(fm.created_at, "created_at", issues);
	if (options.taskId && fm.task_id !== options.taskId) {
		issues.push({ severity: "error", code: "RECEIPT_TASK_MISMATCH", message: `Receipt task_id must be ${options.taskId}.`, path: "task_id" });
	}
	if (fm.type === "worker") {
		validateWorkerReceipt(fm, issues);
	} else if (fm.type === "judge") {
		validateJudgeReceipt(fm, options, issues);
	}
	if (receipt.body.trim().length === 0) {
		issues.push({ severity: "warning", code: "RECEIPT_BODY_EMPTY", message: "Receipt body is empty." });
	}
	return issues;
}

export async function validateReceiptFile(path: string, options: ReceiptValidationOptions = {}): Promise<CheckIssue[]> {
	try {
		return validateReceipt(await loadReceipt(path), options);
	} catch (error) {
		return [{ severity: "error", code: "RECEIPT_PARSE_FAILED", message: error instanceof Error ? error.message : String(error), path }];
	}
}

function validateWorkerReceipt(fm: Record<string, unknown>, issues: CheckIssue[]): void {
	if (!WORKER_STATUSES.has(String(fm.status))) {
		issues.push({ severity: "error", code: "WORKER_RECEIPT_STATUS_INVALID", message: "Worker receipt status must be complete, partial, or blocked.", path: "status" });
	}
	if (!Array.isArray(fm.files_changed)) {
		issues.push({ severity: "error", code: "WORKER_RECEIPT_FILES_INVALID", message: "Worker receipt files_changed must be a list.", path: "files_changed" });
	}
	validateCommands(fm.commands, issues);
	if (fm.status === "complete") {
		validateClaims(fm.claims, issues);
	}
	if (!Array.isArray(fm.remaining_risk)) {
		issues.push({ severity: "error", code: "WORKER_RECEIPT_RISK_INVALID", message: "Worker receipt remaining_risk must be a list.", path: "remaining_risk" });
	}
}

function validateJudgeReceipt(fm: Record<string, unknown>, options: ReceiptValidationOptions, issues: CheckIssue[]): void {
	requireString(fm.run_id, "run_id", issues);
	requireString(fm.verdict_path, "verdict_path", issues);
	requireString(fm.receipt_path, "receipt_path", issues);
	if (!JUDGE_VERDICTS.has(String(fm.verdict))) {
		issues.push({ severity: "error", code: "JUDGE_RECEIPT_VERDICT_INVALID", message: "Judge verdict is invalid.", path: "verdict" });
	}
	if (options.runId && fm.run_id !== options.runId) {
		issues.push({ severity: "error", code: "JUDGE_RECEIPT_RUN_MISMATCH", message: `Judge receipt run_id must be ${options.runId}.`, path: "run_id" });
	}
	if (options.verdict && fm.verdict !== options.verdict) {
		issues.push({ severity: "error", code: "JUDGE_RECEIPT_VERDICT_MISMATCH", message: `Judge receipt verdict must be ${options.verdict}.`, path: "verdict" });
	}
	if (options.receiptPath && fm.receipt_path !== options.receiptPath) {
		issues.push({ severity: "error", code: "JUDGE_RECEIPT_PATH_MISMATCH", message: `Judge receipt receipt_path must be ${options.receiptPath}.`, path: "receipt_path" });
	}
	if (options.verdictPath && fm.verdict_path !== options.verdictPath) {
		issues.push({ severity: "error", code: "JUDGE_RECEIPT_VERDICT_PATH_MISMATCH", message: `Judge receipt verdict_path must be ${options.verdictPath}.`, path: "verdict_path" });
	}
	validateCommands(fm.commands, issues);
	if (!Array.isArray(fm.inspection_helpers)) {
		issues.push({ severity: "error", code: "JUDGE_RECEIPT_HELPERS_INVALID", message: "Judge receipt inspection_helpers must be a list.", path: "inspection_helpers" });
	}
	validateClaimsChecked(fm.claims_checked, issues);
}

function validateCommands(value: unknown, issues: CheckIssue[]): void {
	if (!Array.isArray(value)) {
		issues.push({ severity: "error", code: "RECEIPT_COMMANDS_INVALID", message: "Receipt commands must be a list.", path: "commands" });
		return;
	}
	for (const [index, command] of value.entries()) {
		if (typeof command === "string") {
			continue;
		}
		if (!isRecord(command)) {
			issues.push({ severity: "error", code: "RECEIPT_COMMAND_INVALID", message: "Command must be a string or mapping.", path: `commands[${index}]` });
			continue;
		}
		requireString(command.command, `commands[${index}].command`, issues);
		if (typeof command.exit_code !== "number") {
			issues.push({ severity: "error", code: "RECEIPT_COMMAND_EXIT_CODE_INVALID", message: "Command exit_code must be a number.", path: `commands[${index}].exit_code` });
		}
		requireString(command.output_path, `commands[${index}].output_path`, issues);
	}
}

function validateClaims(value: unknown, issues: CheckIssue[]): void {
	if (!Array.isArray(value) || value.length === 0) {
		issues.push({ severity: "error", code: "RECEIPT_CLAIMS_REQUIRED", message: "Complete worker receipts must include claims.", path: "claims" });
		return;
	}
	for (const [index, claim] of value.entries()) {
		if (!isRecord(claim)) {
			issues.push({ severity: "error", code: "RECEIPT_CLAIM_INVALID", message: "Claim must be a mapping.", path: `claims[${index}]` });
			continue;
		}
		requireString(claim.claim, `claims[${index}].claim`, issues);
		if (!Array.isArray(claim.evidence) || claim.evidence.length === 0 || !claim.evidence.every((item) => typeof item === "string" && item.length > 0)) {
			issues.push({ severity: "error", code: "RECEIPT_CLAIM_EVIDENCE_REQUIRED", message: "Each completion claim must cite at least one evidence path.", path: `claims[${index}].evidence` });
		}
	}
}

function validateClaimsChecked(value: unknown, issues: CheckIssue[]): void {
	if (!Array.isArray(value)) {
		issues.push({ severity: "error", code: "JUDGE_CLAIMS_CHECKED_INVALID", message: "Judge receipt claims_checked must be a list.", path: "claims_checked" });
		return;
	}
	for (const [index, claim] of value.entries()) {
		if (!isRecord(claim)) {
			issues.push({ severity: "error", code: "JUDGE_CLAIM_CHECKED_INVALID", message: "claims_checked entries must be mappings.", path: `claims_checked[${index}]` });
			continue;
		}
		requireString(claim.claim, `claims_checked[${index}].claim`, issues);
		if (!["pass", "fail", "needs_more_evidence", "blocked"].includes(String(claim.result))) {
			issues.push({ severity: "error", code: "JUDGE_CLAIM_RESULT_INVALID", message: "claims_checked result is invalid.", path: `claims_checked[${index}].result` });
		}
		if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
			issues.push({ severity: "error", code: "JUDGE_CLAIM_EVIDENCE_REQUIRED", message: "Each checked claim must cite evidence.", path: `claims_checked[${index}].evidence` });
		}
	}
}

function requireString(value: unknown, path: string, issues: CheckIssue[]): void {
	if (typeof value !== "string" || value.length === 0) {
		issues.push({ severity: "error", code: "RECEIPT_STRING_REQUIRED", message: `${path} must be a non-empty string.`, path });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
