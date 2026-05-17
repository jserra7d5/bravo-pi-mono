import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { atomicWriteFile, nowIso } from "./fs.js";
import type { BoundaryMode, CheckIssue, GoalState, GoalTask, JudgeVerdict, TaskStatus } from "./types.js";

const GOAL_STATUSES = new Set(["draft", "active", "judging", "paused", "blocked", "final_audit", "done", "archived"]);
const TASK_STATUSES = new Set(["queued", "active", "awaiting_judge", "judging", "blocked", "done", "failed"]);
const BOUNDARY_MODES = new Set(["inherit", "carry", "compact", "fresh_session"]);
const CONCRETE_BOUNDARY_MODES = new Set(["carry", "compact", "fresh_session"]);
const CONTEXT_SWITCH_SEVERITIES = new Set(["low", "medium", "high"]);
const JUDGE_VERDICTS = new Set(["pass", "fail", "needs_more_evidence", "blocked", "none"]);

export interface CreateGoalStateOptions {
	id: string;
	title: string;
	status?: GoalState["goal"]["status"];
	repos?: GoalState["repos"];
	tasks?: Array<Partial<GoalTask> & Pick<GoalTask, "id" | "title">>;
	now?: string;
}

export interface StateTransitionResult {
	state: GoalState;
	changed: boolean;
}

export function createGoalState(options: CreateGoalStateOptions): GoalState {
	const now = options.now ?? nowIso();
	const tasks = (options.tasks ?? []).map((task, index): GoalTask => ({
		id: task.id,
		title: task.title,
		kind: "work",
		status: task.status ?? (index === 0 ? "active" : "queued"),
		boundary_after_pass: task.boundary_after_pass ?? "inherit",
		context_switch_severity: task.context_switch_severity ?? "medium",
		receipt: task.receipt ?? null,
		judge_receipt: task.judge_receipt ?? null,
		verify: task.verify ?? [],
		expected_output: task.expected_output ?? [],
	}));
	const activeTask = tasks.find((task) => task.status === "active")?.id ?? null;
	const state: GoalState = {
		schema_version: 1,
		goal: {
			id: options.id,
			title: options.title,
			status: options.status ?? "draft",
			created_at: now,
			updated_at: now,
		},
		repos: options.repos ?? [],
		session: {
			attached_pi_session_id: null,
			current_worker_turn_id: null,
			current_judge_run_id: null,
		},
		active_task: activeTask,
		tasks,
		judge: {
			last_verdict: "none",
			last_receipt: null,
			active: false,
		},
		progress: computeProgress(tasks),
		pause: {
			paused_at: null,
			pause_reason: null,
			resume_context: "resume.md",
		},
		phase_boundary: {
			default_after_judge_pass: "carry",
			after_judge_fail: "carry",
			before_final_audit: "fresh_session",
			experimental_flags: {
				allow_per_task_boundary: true,
				allow_runtime_override: true,
				auto_select_from_context_switch_severity: false,
			},
			compact_custom_instructions: null,
			last_boundary_at: null,
			last_boundary_mode: null,
			last_boundary_reason: null,
		},
		final_audit: {
			status: "pending",
			receipt: null,
			judge_run_id: null,
		},
		user_verification: {
			status: "pending",
			verified_at: null,
			verified_by: null,
			note: null,
		},
		archive: {
			archived_at: null,
			archived_path: null,
			forced: false,
			reason: null,
		},
	};
	return state;
}

export async function loadGoalState(path: string): Promise<GoalState> {
	const data = await readFile(path, "utf8");
	const parsed = YAML.parse(data);
	if (!isRecord(parsed)) {
		throw new Error("Invalid goal state: state.yaml must contain a YAML mapping.");
	}
	if (parsed.schema_version !== 1) {
		throw new Error("Invalid goal state: state.yaml schema_version must be 1.");
	}
	return parsed as unknown as GoalState;
}

export async function saveGoalState(path: string, state: GoalState): Promise<void> {
	const nextState = refreshProgress({ ...state, goal: { ...state.goal, updated_at: nowIso() } });
	const data = YAML.stringify(nextState, { lineWidth: 0 });
	await atomicWriteFile(path, data);
}

export function computeProgress(tasks: GoalTask[]): GoalState["progress"] {
	return {
		completed_tasks: tasks.filter((task) => task.status === "done").length,
		total_tasks: tasks.length,
	};
}

export function refreshProgress(state: GoalState): GoalState {
	return {
		...state,
		progress: computeProgress(state.tasks),
	};
}

export function canActiveTaskBeNull(state: GoalState): boolean {
	if (state.goal.status === "draft" && state.tasks.length === 0) {
		return true;
	}
	return state.tasks.every((task) => task.status === "done") && ["final_audit", "done", "archived"].includes(state.goal.status);
}

export function getActiveTask(state: GoalState): GoalTask | null {
	if (state.active_task === null) {
		return null;
	}
	return state.tasks.find((task) => task.id === state.active_task) ?? null;
}

export function validateGoalState(value: unknown): CheckIssue[] {
	const issues: CheckIssue[] = [];
	if (!isRecord(value)) {
		return [{ severity: "error", code: "STATE_NOT_OBJECT", message: "state.yaml must contain a YAML mapping." }];
	}

	const required = [
		"schema_version",
		"goal",
		"repos",
		"session",
		"active_task",
		"tasks",
		"judge",
		"progress",
		"pause",
		"phase_boundary",
		"final_audit",
		"user_verification",
		"archive",
	];
	for (const key of required) {
		if (!(key in value)) {
			issues.push({ severity: "error", code: "STATE_MISSING_KEY", message: `state.yaml is missing required key: ${key}`, path: key });
		}
	}
	if (value.schema_version !== 1) {
		issues.push({ severity: "error", code: "STATE_SCHEMA_VERSION", message: "state.yaml schema_version must be 1.", path: "schema_version" });
	}

	const goal = value.goal;
	if (!isRecord(goal)) {
		issues.push({ severity: "error", code: "STATE_GOAL_INVALID", message: "goal must be a mapping.", path: "goal" });
	} else {
		requireString(goal.id, "goal.id", issues);
		requireString(goal.title, "goal.title", issues);
		if (!GOAL_STATUSES.has(String(goal.status))) {
			issues.push({ severity: "error", code: "GOAL_STATUS_INVALID", message: `Invalid goal status: ${String(goal.status)}`, path: "goal.status" });
		}
		requireString(goal.created_at, "goal.created_at", issues);
		requireString(goal.updated_at, "goal.updated_at", issues);
	}

	if (!Array.isArray(value.repos)) {
		issues.push({ severity: "error", code: "REPOS_INVALID", message: "repos must be a list.", path: "repos" });
	}

	const tasks = value.tasks;
	if (!Array.isArray(tasks)) {
		issues.push({ severity: "error", code: "TASKS_INVALID", message: "tasks must be a list.", path: "tasks" });
	} else {
		const taskIds = new Set<string>();
		for (const [index, task] of tasks.entries()) {
			validateTask(task, index, taskIds, issues);
		}
		validateActiveTask(value, taskIds, issues);
		validateProgress(value, tasks as GoalTask[], issues);
	}

	validateJudge(value.judge, issues);
	validatePhaseBoundary(value.phase_boundary, issues);
	validateFinalAudit(value.final_audit, issues);
	validateUserVerification(value.user_verification, issues);
	return issues;
}

export function markWorkerReceiptReady(state: GoalState, taskId: string, receiptPath: string): StateTransitionResult {
	return updateTask(state, taskId, (task) => {
		if (task.status !== "active") {
			throw new Error(`Task ${taskId} must be active before worker receipt transition.`);
		}
		return { ...task, receipt: receiptPath, status: "awaiting_judge" };
	});
}

export function markJudgeStarted(state: GoalState, taskId: string, runId: string): StateTransitionResult {
	const result = updateTask(state, taskId, (task) => {
		if (task.status !== "awaiting_judge") {
			throw new Error(`Task ${taskId} must be awaiting_judge before Judge starts.`);
		}
		return { ...task, status: "judging" };
	});
	return {
		changed: true,
		state: {
			...result.state,
			goal: { ...result.state.goal, status: "judging" },
			session: { ...result.state.session, current_judge_run_id: runId },
			judge: { ...result.state.judge, active: true },
		},
	};
}

export function applyJudgeVerdict(state: GoalState, taskId: string, verdict: Exclude<JudgeVerdict, "none">, judgeReceiptPath: string): StateTransitionResult {
	const result = updateTask(state, taskId, (task) => {
		if (task.status !== "judging" && task.status !== "awaiting_judge") {
			throw new Error(`Task ${taskId} must be awaiting_judge or judging before Judge verdict transition.`);
		}
		if (verdict === "pass") {
			return { ...task, status: "done", judge_receipt: judgeReceiptPath };
		}
		if (verdict === "blocked") {
			return { ...task, status: "blocked", judge_receipt: judgeReceiptPath };
		}
		return { ...task, status: "active", judge_receipt: judgeReceiptPath };
	});
	const next = selectNextTask(result.state, verdict);
	return {
		changed: true,
		state: {
			...next,
			judge: { ...next.judge, active: false, last_verdict: verdict, last_receipt: judgeReceiptPath },
			session: { ...next.session, current_judge_run_id: null },
		},
	};
}

function updateTask(state: GoalState, taskId: string, update: (task: GoalTask) => GoalTask): StateTransitionResult {
	let changed = false;
	const tasks = state.tasks.map((task) => {
		if (task.id !== taskId) {
			return task;
		}
		changed = true;
		return update(task);
	});
	if (!changed) {
		throw new Error(`Unknown task: ${taskId}`);
	}
	return { changed, state: refreshProgress({ ...state, tasks }) };
}

function selectNextTask(state: GoalState, verdict: Exclude<JudgeVerdict, "none">): GoalState {
	if (verdict === "blocked") {
		return { ...state, goal: { ...state.goal, status: "blocked" } };
	}
	if (verdict !== "pass") {
		const active = state.tasks.find((task) => task.status === "active");
		return { ...state, active_task: active?.id ?? state.active_task, goal: { ...state.goal, status: "active" } };
	}
	const queuedIndex = state.tasks.findIndex((task) => task.status === "queued");
	if (queuedIndex >= 0) {
		const tasks = state.tasks.map((task, index) => index === queuedIndex ? { ...task, status: "active" as TaskStatus } : task);
		return refreshProgress({ ...state, tasks, active_task: tasks[queuedIndex]?.id ?? null, goal: { ...state.goal, status: "active" } });
	}
	return refreshProgress({ ...state, active_task: null, goal: { ...state.goal, status: "final_audit" } });
}

function validateTask(task: unknown, index: number, taskIds: Set<string>, issues: CheckIssue[]): void {
	const base = `tasks[${index}]`;
	if (!isRecord(task)) {
		issues.push({ severity: "error", code: "TASK_INVALID", message: "Task must be a mapping.", path: base });
		return;
	}
	if (typeof task.id !== "string" || task.id.length === 0) {
		issues.push({ severity: "error", code: "TASK_ID_INVALID", message: "Task id must be a non-empty string.", path: `${base}.id` });
	} else if (taskIds.has(task.id)) {
		issues.push({ severity: "error", code: "TASK_ID_DUPLICATE", message: `Duplicate task id: ${task.id}`, path: `${base}.id` });
	} else {
		taskIds.add(task.id);
	}
	requireString(task.title, `${base}.title`, issues);
	if (task.kind !== "work") {
		issues.push({ severity: "error", code: "TASK_KIND_INVALID", message: "Task kind must be work.", path: `${base}.kind` });
	}
	if (!TASK_STATUSES.has(String(task.status))) {
		issues.push({ severity: "error", code: "TASK_STATUS_INVALID", message: `Invalid task status: ${String(task.status)}`, path: `${base}.status` });
	}
	if (!BOUNDARY_MODES.has(String(task.boundary_after_pass))) {
		issues.push({ severity: "error", code: "TASK_BOUNDARY_INVALID", message: "Task boundary_after_pass is invalid.", path: `${base}.boundary_after_pass` });
	}
	if (!CONTEXT_SWITCH_SEVERITIES.has(String(task.context_switch_severity))) {
		issues.push({ severity: "error", code: "TASK_CONTEXT_SWITCH_INVALID", message: "Task context_switch_severity is invalid.", path: `${base}.context_switch_severity` });
	}
	if (!Array.isArray(task.verify)) {
		issues.push({ severity: "error", code: "TASK_VERIFY_INVALID", message: "Task verify must be a list.", path: `${base}.verify` });
	}
	if (!Array.isArray(task.expected_output)) {
		issues.push({ severity: "error", code: "TASK_EXPECTED_OUTPUT_INVALID", message: "Task expected_output must be a list.", path: `${base}.expected_output` });
	}
}

function validateActiveTask(value: Record<string, unknown>, taskIds: Set<string>, issues: CheckIssue[]): void {
	if (value.active_task !== null && typeof value.active_task !== "string") {
		issues.push({ severity: "error", code: "ACTIVE_TASK_INVALID", message: "active_task must be a task id or null.", path: "active_task" });
		return;
	}
	if (typeof value.active_task === "string" && !taskIds.has(value.active_task)) {
		issues.push({ severity: "error", code: "ACTIVE_TASK_UNKNOWN", message: `active_task does not reference a known task: ${value.active_task}`, path: "active_task" });
	}
	if (typeof value.active_task === "string" && Array.isArray(value.tasks)) {
		const task = value.tasks.find((candidate) => isRecord(candidate) && candidate.id === value.active_task) as Record<string, unknown> | undefined;
		if (task && ["done", "failed"].includes(String(task.status))) {
			issues.push({ severity: "error", code: "ACTIVE_TASK_TERMINAL", message: "active_task must not reference a done or failed task.", path: "active_task" });
		}
	}
	if (Array.isArray(value.tasks)) {
		const activeTasks = value.tasks.filter((task) => isRecord(task) && task.status === "active");
		if (activeTasks.length > 1) {
			issues.push({ severity: "error", code: "MULTIPLE_ACTIVE_TASKS", message: "Only one task may have status active.", path: "tasks" });
		}
		if (activeTasks.length === 1 && typeof value.active_task === "string" && isRecord(activeTasks[0]) && activeTasks[0].id !== value.active_task) {
			issues.push({ severity: "error", code: "ACTIVE_TASK_STATUS_MISMATCH", message: "The active task id must match the task with status active.", path: "active_task" });
		}
	}
	if (value.active_task === null) {
		const state = value as unknown as GoalState;
		if (!canActiveTaskBeNull(state)) {
			issues.push({
				severity: "error",
				code: "ACTIVE_TASK_NULL_INVALID",
				message: "active_task may be null only when every task is done and the goal is in final_audit, done, or archived.",
				path: "active_task",
			});
		}
	}
}

function validateProgress(value: Record<string, unknown>, tasks: GoalTask[], issues: CheckIssue[]): void {
	if (!isRecord(value.progress)) {
		issues.push({ severity: "error", code: "PROGRESS_INVALID", message: "progress must be a mapping.", path: "progress" });
		return;
	}
	const expected = computeProgress(tasks);
	if (value.progress.completed_tasks !== expected.completed_tasks) {
		issues.push({ severity: "error", code: "PROGRESS_COMPLETED_MISMATCH", message: `progress.completed_tasks must be ${expected.completed_tasks}.`, path: "progress.completed_tasks" });
	}
	if (value.progress.total_tasks !== expected.total_tasks) {
		issues.push({ severity: "error", code: "PROGRESS_TOTAL_MISMATCH", message: `progress.total_tasks must be ${expected.total_tasks}.`, path: "progress.total_tasks" });
	}
}

function validateJudge(value: unknown, issues: CheckIssue[]): void {
	if (!isRecord(value)) {
		issues.push({ severity: "error", code: "JUDGE_INVALID", message: "judge must be a mapping.", path: "judge" });
		return;
	}
	if (!JUDGE_VERDICTS.has(String(value.last_verdict))) {
		issues.push({ severity: "error", code: "JUDGE_VERDICT_INVALID", message: "judge.last_verdict is invalid.", path: "judge.last_verdict" });
	}
	if (typeof value.active !== "boolean") {
		issues.push({ severity: "error", code: "JUDGE_ACTIVE_INVALID", message: "judge.active must be a boolean.", path: "judge.active" });
	}
}

function validatePhaseBoundary(value: unknown, issues: CheckIssue[]): void {
	if (!isRecord(value)) {
		issues.push({ severity: "error", code: "PHASE_BOUNDARY_INVALID", message: "phase_boundary must be a mapping.", path: "phase_boundary" });
		return;
	}
	for (const key of ["default_after_judge_pass", "after_judge_fail", "before_final_audit"]) {
		if (!CONCRETE_BOUNDARY_MODES.has(String(value[key]))) {
			issues.push({ severity: "error", code: "PHASE_BOUNDARY_MODE_INVALID", message: `${key} must be carry, compact, or fresh_session.`, path: `phase_boundary.${key}` });
		}
	}
}

function validateFinalAudit(value: unknown, issues: CheckIssue[]): void {
	if (!isRecord(value)) {
		issues.push({ severity: "error", code: "FINAL_AUDIT_INVALID", message: "final_audit must be a mapping.", path: "final_audit" });
		return;
	}
	if (!["pending", "passed", "failed"].includes(String(value.status))) {
		issues.push({ severity: "error", code: "FINAL_AUDIT_STATUS_INVALID", message: "final_audit.status is invalid.", path: "final_audit.status" });
	}
}

function validateUserVerification(value: unknown, issues: CheckIssue[]): void {
	if (!isRecord(value)) {
		issues.push({ severity: "error", code: "USER_VERIFICATION_INVALID", message: "user_verification must be a mapping.", path: "user_verification" });
		return;
	}
	if (!["pending", "verified"].includes(String(value.status))) {
		issues.push({ severity: "error", code: "USER_VERIFICATION_STATUS_INVALID", message: "user_verification.status is invalid.", path: "user_verification.status" });
	}
}

function requireString(value: unknown, path: string, issues: CheckIssue[]): void {
	if (typeof value !== "string" || value.length === 0) {
		issues.push({ severity: "error", code: "STRING_REQUIRED", message: `${path} must be a non-empty string.`, path });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
