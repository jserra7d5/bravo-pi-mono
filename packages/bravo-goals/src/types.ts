export type GoalStatus = "draft" | "active" | "judging" | "paused" | "blocked" | "final_audit" | "done" | "archived";
export type TaskStatus = "queued" | "active" | "awaiting_judge" | "judging" | "blocked" | "done" | "failed";
export type BoundaryMode = "inherit" | "carry" | "compact" | "fresh_session";
export type JudgeVerdict = "pass" | "fail" | "needs_more_evidence" | "blocked" | "none";

export interface GoalTask {
	id: string;
	title: string;
	kind: "work";
	status: TaskStatus;
	boundary_after_pass: BoundaryMode;
	context_switch_severity: "low" | "medium" | "high";
	receipt: string | null;
	judge_receipt: string | null;
	verify: string[];
	expected_output: string[];
}

export interface GoalState {
	schema_version: 1;
	goal: {
		id: string;
		title: string;
		status: GoalStatus;
		created_at: string;
		updated_at: string;
	};
	repos: Array<{ path: string; role: string }>;
	session: {
		attached_pi_session_id: string | null;
		current_worker_turn_id: string | null;
		current_judge_run_id: string | null;
	};
	active_task: string | null;
	tasks: GoalTask[];
	judge: {
		last_verdict: JudgeVerdict;
		last_receipt: string | null;
		active: boolean;
		unsafe_raw_bash?: boolean;
	};
	progress: {
		completed_tasks: number;
		total_tasks: number;
	};
	pause: {
		paused_at: string | null;
		pause_reason: string | null;
		resume_context: string;
	};
	phase_boundary: {
		default_after_judge_pass: Exclude<BoundaryMode, "inherit">;
		after_judge_fail: Exclude<BoundaryMode, "inherit">;
		before_final_audit: Exclude<BoundaryMode, "inherit">;
		experimental_flags: {
			allow_per_task_boundary: boolean;
			allow_runtime_override: boolean;
			auto_select_from_context_switch_severity: boolean;
		};
		compact_custom_instructions: string | null;
		last_boundary_at: string | null;
		last_boundary_mode: Exclude<BoundaryMode, "inherit"> | null;
		last_boundary_reason: string | null;
	};
	final_audit: {
		status: "pending" | "passed" | "failed";
		receipt: string | null;
		judge_run_id: string | null;
	};
	user_verification: {
		status: "pending" | "verified";
		verified_at: string | null;
		verified_by: string | null;
		note: string | null;
	};
	archive: {
		archived_at: string | null;
		archived_path: string | null;
		forced: boolean;
		reason: string | null;
	};
}

export interface WorkspacePaths {
	root: string;
	bravo: string;
	goals: string;
	archivedGoals: string;
	runtime: string;
	runs: string;
	logs: string;
}

export interface CheckIssue {
	severity: "error" | "warning";
	code: string;
	message: string;
	path?: string;
}

export interface CheckResult {
	ok: boolean;
	issues: CheckIssue[];
}
