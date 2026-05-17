import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadReceipt, validateReceiptFile } from "./receipts.js";
import { loadGoalState, validateGoalState } from "./state.js";
import { validateJudgeCompletion } from "./judge-runner.js";
import type { CheckIssue, CheckResult, GoalState, GoalTask } from "./types.js";

export interface CheckGoalOptions {
	goalPath: string;
}

const REQUIRED_FILES = ["goal.md", "context.md", "state.yaml", "resume.md"];
const REQUIRED_DIRS = ["receipts", "artifacts"];

export async function checkGoal(options: CheckGoalOptions): Promise<CheckResult> {
	const issues: CheckIssue[] = [];
	for (const file of REQUIRED_FILES) {
		await requireFile(options.goalPath, file, issues);
	}
	for (const dir of REQUIRED_DIRS) {
		await requireDir(options.goalPath, dir, issues);
	}
	let state: GoalState | null = null;
	try {
		state = await loadGoalState(join(options.goalPath, "state.yaml"));
	} catch (error) {
		issues.push({ severity: "error", code: "STATE_LOAD_FAILED", message: error instanceof Error ? error.message : String(error), path: "state.yaml" });
	}
	if (state) {
		issues.push(...validateGoalState(state));
		issues.push(...await checkTaskReceipts(options.goalPath, state));
		issues.push(...await checkFinalAudit(options.goalPath, state));
		issues.push(...checkArchiveGates(state));
	}
	return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

export function checkState(state: GoalState): CheckResult {
	const issues = [
		...validateGoalState(state),
		...checkFinalAuditState(state),
		...checkArchiveGates(state),
	];
	return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

async function checkTaskReceipts(goalPath: string, state: GoalState): Promise<CheckIssue[]> {
	const issues: CheckIssue[] = [];
	for (const task of state.tasks) {
		if (["awaiting_judge", "judging", "done"].includes(task.status)) {
			if (!task.receipt) {
				issues.push({ severity: "error", code: "WORKER_RECEIPT_MISSING", message: `Task ${task.id} requires a worker receipt.`, path: taskPath(task, "receipt") });
			} else {
				issues.push(...await validateReceiptFile(resolveGoalLocal(goalPath, task.receipt), { expectedType: "worker", taskId: task.id }));
			}
		}
		if (task.status === "done") {
			if (!task.judge_receipt) {
				issues.push({ severity: "error", code: "JUDGE_RECEIPT_MISSING", message: `Done task ${task.id} requires a Judge receipt.`, path: taskPath(task, "judge_receipt") });
			} else {
				issues.push(...await validateJudgeReceiptAndRun(goalPath, state, task.judge_receipt, {
					taskId: task.id,
					finalAudit: false,
					runId: undefined,
					verdict: "pass",
				}));
			}
		}
	}
	return issues;
}

async function checkFinalAudit(goalPath: string, state: GoalState): Promise<CheckIssue[]> {
	const issues = checkFinalAuditState(state);
	if (state.final_audit.status === "passed" && state.final_audit.receipt) {
		issues.push(...await validateJudgeReceiptAndRun(goalPath, state, state.final_audit.receipt, {
			taskId: undefined,
			finalAudit: true,
			runId: state.final_audit.judge_run_id ?? undefined,
			verdict: "pass",
		}));
	}
	return issues;
}

function checkFinalAuditState(state: GoalState): CheckIssue[] {
	const issues: CheckIssue[] = [];
	if (state.final_audit.status === "passed") {
		if (!state.tasks.every((task) => task.status === "done")) {
			issues.push({ severity: "error", code: "FINAL_AUDIT_BEFORE_TASKS_DONE", message: "Final audit cannot pass before every task is done.", path: "final_audit.status" });
		}
		if (!state.final_audit.receipt) {
			issues.push({ severity: "error", code: "FINAL_AUDIT_RECEIPT_MISSING", message: "Passed final audit requires a Judge receipt.", path: "final_audit.receipt" });
		}
		if (!state.final_audit.judge_run_id) {
			issues.push({ severity: "error", code: "FINAL_AUDIT_RUN_MISSING", message: "Passed final audit requires judge_run_id.", path: "final_audit.judge_run_id" });
		}
	}
	if (state.goal.status === "done" && state.final_audit.status !== "passed") {
		issues.push({ severity: "error", code: "DONE_REQUIRES_FINAL_AUDIT", message: "Goal status done requires final_audit.status passed.", path: "goal.status" });
	}
	return issues;
}

function checkArchiveGates(state: GoalState): CheckIssue[] {
	const issues: CheckIssue[] = [];
	if (state.goal.status !== "archived" && !state.archive.archived_at && !state.archive.archived_path) {
		return issues;
	}
	if (state.archive.forced) {
		if (!state.archive.reason) {
			issues.push({ severity: "error", code: "ARCHIVE_FORCE_REASON_MISSING", message: "Forced archive requires a reason.", path: "archive.reason" });
		}
		return issues;
	}
	if (state.goal.status !== "archived") {
		issues.push({ severity: "error", code: "ARCHIVE_STATUS_INVALID", message: "Archived state requires goal.status archived.", path: "goal.status" });
	}
	if (state.final_audit.status !== "passed") {
		issues.push({ severity: "error", code: "ARCHIVE_FINAL_AUDIT_REQUIRED", message: "Archive requires passed final audit.", path: "final_audit.status" });
	}
	if (state.user_verification.status !== "verified") {
		issues.push({ severity: "error", code: "ARCHIVE_USER_VERIFICATION_REQUIRED", message: "Archive requires user verification.", path: "user_verification.status" });
	}
	if (state.session.attached_pi_session_id !== null) {
		issues.push({ severity: "error", code: "ARCHIVE_SESSION_ATTACHED", message: "Archive requires no active attached Pi session.", path: "session.attached_pi_session_id" });
	}
	if (!state.archive.archived_at || !state.archive.archived_path) {
		issues.push({ severity: "error", code: "ARCHIVE_METADATA_MISSING", message: "Archive requires archived_at and archived_path.", path: "archive" });
	}
	return issues;
}

async function requireFile(goalPath: string, relativePath: string, issues: CheckIssue[]): Promise<void> {
	const path = join(goalPath, relativePath);
	try {
		const info = await stat(path);
		if (!info.isFile()) {
			issues.push({ severity: "error", code: "REQUIRED_FILE_NOT_FILE", message: `${relativePath} must be a file.`, path: relativePath });
		}
	} catch {
		issues.push({ severity: "error", code: "REQUIRED_FILE_MISSING", message: `${relativePath} is required.`, path: relativePath });
	}
}

async function requireDir(goalPath: string, relativePath: string, issues: CheckIssue[]): Promise<void> {
	const path = join(goalPath, relativePath);
	try {
		const info = await stat(path);
		if (!info.isDirectory()) {
			issues.push({ severity: "error", code: "REQUIRED_DIR_NOT_DIR", message: `${relativePath} must be a directory.`, path: relativePath });
		}
	} catch {
		issues.push({ severity: "error", code: "REQUIRED_DIR_MISSING", message: `${relativePath} is required.`, path: relativePath });
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveGoalLocal(goalPath: string, path: string): string {
	if (isAbsolute(path)) {
		return path;
	}
	if (path.startsWith(".bravo/")) {
		const marker = `${goalPath.includes("\\") ? "\\": "/"}.bravo${goalPath.includes("\\") ? "\\": "/"}`;
		const index = goalPath.indexOf(marker);
		if (index >= 0) {
			return join(goalPath.slice(0, index), path);
		}
		return path;
	}
	return join(goalPath, path);
}

interface JudgeRunExpectation {
	taskId?: string;
	finalAudit: boolean;
	runId?: string;
	verdict: "pass";
}

async function validateJudgeReceiptAndRun(goalPath: string, state: GoalState, receiptPath: string, expectation: JudgeRunExpectation): Promise<CheckIssue[]> {
	const absoluteReceiptPath = resolveGoalLocal(goalPath, receiptPath);
	const issues = await validateReceiptFile(absoluteReceiptPath, { expectedType: "judge", taskId: expectation.taskId, runId: expectation.runId, verdict: expectation.verdict });
	let receipt;
	try {
		receipt = await loadReceipt(absoluteReceiptPath);
	} catch {
		return issues;
	}
	const runId = receipt.frontmatter.run_id;
	if (typeof runId !== "string" || runId.length === 0) {
		return issues;
	}
	const workspaceRoot = workspaceRootFromGoalPath(goalPath);
	if (!workspaceRoot) {
		issues.push({ severity: "error", code: "WORKSPACE_ROOT_UNRESOLVED", message: "Could not resolve workspace root for Judge run validation.", path: receiptPath });
		return issues;
	}
	const runDir = join(workspaceRoot, ".bravo", "runs", runId);
	const result = await validateJudgeCompletion(runDir);
	for (const issue of result.issues) {
		issues.push({ severity: "error", code: "JUDGE_RUN_INVALID", message: issue, path: relative(workspaceRoot, runDir) });
	}
	if (result.verdict && result.verdict.goal_id !== state.goal.id) {
		issues.push({ severity: "error", code: "JUDGE_RUN_GOAL_MISMATCH", message: "Judge verdict goal_id does not match state goal id.", path: receiptPath });
	}
	if (result.verdict && result.verdict.verdict !== expectation.verdict) {
		issues.push({ severity: "error", code: "JUDGE_RUN_VERDICT_NOT_PASS", message: "Completed work and passed final audits require a passing Judge verdict.", path: receiptPath });
	}
	if (result.verdict && result.verdict.final_audit !== expectation.finalAudit) {
		issues.push({ severity: "error", code: "JUDGE_RUN_FINAL_AUDIT_MISMATCH", message: "Judge run final_audit flag does not match the state field being validated.", path: receiptPath });
	}
	if (expectation.runId && result.verdict && result.verdict.run_id !== expectation.runId) {
		issues.push({ severity: "error", code: "JUDGE_RUN_ID_MISMATCH", message: "Judge run id does not match state final_audit.judge_run_id.", path: receiptPath });
	}
	return issues;
}

function workspaceRootFromGoalPath(goalPath: string): string | null {
	const normalized = goalPath.split(sep).join("/");
	const marker = "/.bravo/goals/";
	const index = normalized.indexOf(marker);
	if (index < 0) return null;
	return normalized.slice(0, index);
}

function taskPath(task: GoalTask, key: keyof GoalTask): string {
	return `tasks.${task.id}.${String(key)}`;
}
