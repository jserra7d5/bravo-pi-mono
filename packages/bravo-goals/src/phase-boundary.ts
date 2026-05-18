import type { BoundaryMode, GoalState, GoalTask } from "./types.js";
import { nowIso } from "./fs.js";

export type BoundarySelectionReason =
	| "runtime_override"
	| "task_boundary"
	| "context_usage"
	| "context_switch_severity"
	| "goal_default"
	| "package_default";

export interface BoundarySelection {
	mode: Exclude<BoundaryMode, "inherit">;
	reason: BoundarySelectionReason;
	message: string;
}

export interface BoundarySelectionOptions {
	override?: Exclude<BoundaryMode, "inherit"> | null;
	contextUsagePercent?: number | null;
	contextUsageThresholdPercent?: number;
	packageDefault?: Exclude<BoundaryMode, "inherit">;
}

const DEFAULT_BOUNDARY: Exclude<BoundaryMode, "inherit"> = "carry";
const DEFAULT_CONTEXT_USAGE_THRESHOLD_PERCENT = 45;

export function normalizeBoundaryMode(value: string | null | undefined): Exclude<BoundaryMode, "inherit"> | null {
	if (value === "carry" || value === "compact" || value === "fresh_session") {
		return value;
	}
	if (value === "fresh") {
		return "fresh_session";
	}
	return null;
}

export function selectNextBoundary(
	state: GoalState,
	task: GoalTask | null | undefined,
	options: BoundarySelectionOptions = {},
): BoundarySelection {
	if (options.override) {
		return {
			mode: options.override,
			reason: "runtime_override",
			message: `selected ${options.override} from runtime override`,
		};
	}

	if (
		task &&
		state.phase_boundary.experimental_flags.allow_per_task_boundary &&
		task.boundary_after_pass !== "inherit"
	) {
		return {
			mode: task.boundary_after_pass,
			reason: "task_boundary",
			message: `selected ${task.boundary_after_pass} from task boundary`,
		};
	}

	if (typeof options.contextUsagePercent === "number" && Number.isFinite(options.contextUsagePercent)) {
		const threshold = options.contextUsageThresholdPercent ?? DEFAULT_CONTEXT_USAGE_THRESHOLD_PERCENT;
		const mode = options.contextUsagePercent >= threshold ? "compact" : "carry";
		return {
			mode,
			reason: "context_usage",
			message: `selected ${mode} from context usage ${Math.round(options.contextUsagePercent)}% with ${threshold}% threshold`,
		};
	}

	if (task && state.phase_boundary.experimental_flags.auto_select_from_context_switch_severity) {
		const mode = boundaryFromSeverity(task.context_switch_severity);
		return {
			mode,
			reason: "context_switch_severity",
			message: `selected ${mode} from ${task.context_switch_severity} context switch severity`,
		};
	}

	if (state.phase_boundary.default_after_judge_pass) {
		return {
			mode: state.phase_boundary.default_after_judge_pass,
			reason: "goal_default",
			message: `selected ${state.phase_boundary.default_after_judge_pass} from goal default`,
		};
	}

	const fallback = options.packageDefault ?? DEFAULT_BOUNDARY;
	return {
		mode: fallback,
		reason: "package_default",
		message: `selected ${fallback} from package default`,
	};
}

export function markBoundaryApplied(
	state: GoalState,
	selection: BoundarySelection,
	now = nowIso(),
): GoalState {
	return {
		...state,
		goal: {
			...state.goal,
			updated_at: now,
		},
		phase_boundary: {
			...state.phase_boundary,
			last_boundary_at: now,
			last_boundary_mode: selection.mode,
			last_boundary_reason: selection.message,
		},
	};
}

export function renderCompactInstructions(state: GoalState): string {
	if (state.phase_boundary.compact_custom_instructions) {
		return state.phase_boundary.compact_custom_instructions;
	}
	const nextTask = state.active_task ? state.tasks.find((task) => task.id === state.active_task) : null;
	return [
		`Preserve the Bravo goal context for ${state.goal.id}.`,
		"Focus on context that will help with the next worker task, not stale exploration.",
		nextTask ? `Preview the next task: ${nextTask.id} — ${nextTask.title}.` : "There is no active next task; preserve final-audit or verification context if relevant.",
		"Preserve completed task evidence, active task status, blockers, relevant files changed, commands run, and the next concrete action.",
		"Do not invent completion claims. Treat state.yaml and receipts as authoritative.",
	].join("\n");
}

function boundaryFromSeverity(severity: GoalTask["context_switch_severity"]): Exclude<BoundaryMode, "inherit"> {
	if (severity === "low") return "carry";
	if (severity === "medium") return "compact";
	return "fresh_session";
}
