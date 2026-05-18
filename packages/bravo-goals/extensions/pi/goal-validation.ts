import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { loadGoalState, validateGoalState } from "../../src/state.js";
import type { CheckIssue } from "../../src/types.js";
import { readActiveGoalsIndex } from "../../src/runtime.js";
import { discoverWorkspaceRoot } from "../../src/workspace.js";
import {
	chromeRenderable,
	renderFailureCard,
	renderValidateGoalStateCall,
	renderValidateGoalStateResult,
	type TextRenderable,
} from "./renderers.js";

const ValidateGoalStateParams = Type.Object({
	goal_id: Type.Optional(Type.String({ description: "Bravo goal id or goal directory path. Omit to validate the goal attached to the current Pi session." })),
});

interface ToolContextLike {
	cwd?: string;
	sessionManager?: {
		getSessionId?: () => string;
	};
}

interface ValidateGoalStateResult {
	ok: boolean;
	goal_id: string;
	state_path: string;
	issue_count: number;
	issues: CheckIssue[];
}

export function registerGoalValidationTools(pi: ExtensionAPI): void {
	if (typeof pi.registerTool !== "function") return;

	pi.registerTool({
		name: "validate_goal_state",
		label: "Validate goal state",
		description: "Validate a Bravo goal state.yaml file before advancing a prep or worker flow. Use this after editing state.yaml; avoid it for worker completion, where task_receipt_ready owns the state transition.",
		parameters: ValidateGoalStateParams,
		renderShell: "self",
		async execute(_toolCallId, params, _span, _toolCall, ctx?: ToolContextLike) {
			const result = await validateGoalStateForPi(params, ctx);
			return {
				content: [{ type: "text", text: renderValidateGoalStateText(result) }],
				details: result,
			};
		},
		renderCall(args: unknown): TextRenderable {
			const params = isRecord(args) ? args : {};
			const goalId = typeof params.goal_id === "string" ? params.goal_id : "attached-goal";
			return chromeRenderable((width) => renderValidateGoalStateCall({ goal_id: goalId }, width));
		},
		renderResult(result: unknown, _options, _theme, context): TextRenderable {
			return renderValidateGoalStateToolResult(result, context?.args);
		},
	});
}

async function validateGoalStateForPi(params: { goal_id?: string }, ctx?: ToolContextLike): Promise<ValidateGoalStateResult> {
	const workspaceRoot = await discoverWorkspaceRoot(ctx?.cwd ?? process.cwd());
	if (!workspaceRoot) {
		throw new Error("ContextError: No Bravo workspace found for validate_goal_state. Run /goal init first or call it from inside a Bravo workspace.");
	}
	const goalPath = await resolveGoalPath(workspaceRoot, params.goal_id, ctx?.sessionManager?.getSessionId?.() ?? null);
	const statePath = join(goalPath, "state.yaml");
	let issues: CheckIssue[] = [];
	let goalId = params.goal_id ?? relative(join(workspaceRoot, ".bravo", "goals"), goalPath);
	try {
		const state = await loadGoalState(statePath);
		goalId = state.goal.id || goalId;
		issues = validateGoalState(state);
	} catch (error) {
		issues = [{
			severity: "error",
			code: "STATE_LOAD_FAILED",
			message: error instanceof Error ? error.message : String(error),
			path: "state.yaml",
		}];
		const raw = await readFile(statePath, "utf8").catch(() => "");
		if (raw.length === 0) {
			issues.push({ severity: "error", code: "STATE_FILE_EMPTY_OR_MISSING", message: "state.yaml is empty or missing.", path: "state.yaml" });
		}
	}
	return {
		ok: !issues.some((issue) => issue.severity === "error"),
		goal_id: goalId,
		state_path: relative(workspaceRoot, statePath),
		issue_count: issues.length,
		issues,
	};
}

async function resolveGoalPath(workspaceRoot: string, goalIdOrPath: string | undefined, sessionId: string | null): Promise<string> {
	if (goalIdOrPath) {
		return goalIdOrPath.includes("/") || goalIdOrPath.startsWith(".")
			? resolve(workspaceRoot, goalIdOrPath)
			: join(workspaceRoot, ".bravo", "goals", goalIdOrPath);
	}
	if (!sessionId) {
		throw new Error("ContextError: validate_goal_state needs a goal_id when no Pi session id is available.");
	}
	const active = await readActiveGoalsIndex(workspaceRoot);
	const entry = active.active_goals.find((candidate) => candidate.pi_session_id === sessionId);
	if (!entry) {
		throw new Error(`ContextError: No Bravo goal is attached to current Pi session ${sessionId}. Pass goal_id or run /goal start first.`);
	}
	return isAbsolute(entry.path) ? entry.path : join(workspaceRoot, entry.path);
}

function renderValidateGoalStateText(result: ValidateGoalStateResult): string {
	if (result.ok) {
		return `Goal state valid: ${result.goal_id} (${result.state_path}).`;
	}
	const shown = result.issues.slice(0, 8).map((issue) => {
		const path = issue.path ? `${issue.path}: ` : "";
		return `${issue.severity}\t${issue.code}\t${path}${issue.message}`;
	});
	const suffix = result.issues.length > shown.length ? `\n... ${result.issues.length - shown.length} more issue(s)` : "";
	const taskHelp = result.issues.some((issue) =>
		issue.path === "tasks"
		|| issue.path?.startsWith("tasks[")
		|| (issue.path === "state.yaml" && issue.code === "STATE_LOAD_FAILED")
	)
		? `\n\nValid task shape:\ntasks:\n  - id: "<short-task-slug>"\n    title: "<human-readable task title>"\n    kind: work\n    status: active\n    boundary_after_pass: inherit\n    context_switch_severity: medium\n    receipt: null\n    judge_receipt: null\n    verify:\n      - "<command or evidence the Judge should check>"\n    expected_output:\n      - "<observable result of this task>"`
		: "";
	return `Goal state invalid: ${result.goal_id} (${result.state_path}).\n${shown.join("\n")}${suffix}${taskHelp}`;
}

function renderValidateGoalStateToolResult(rawResult: unknown, args?: unknown): TextRenderable {
	const result = isRecord(rawResult) ? rawResult : {};
	const details = isRecord(result.details) ? result.details : {};
	const argRec = isRecord(args) ? args : {};
	const goalId = extractString(details.goal_id) ?? extractString(argRec.goal_id) ?? "attached-goal";
	if (result.isError) {
		const errorText = Array.isArray(result.content) && isRecord(result.content[0]) && typeof result.content[0].text === "string"
			? result.content[0].text
			: "Tool error";
		return chromeRenderable((width) => renderFailureCard({
			goal_id: goalId,
			tool: "validate_goal_state",
			error: errorText,
		}, width));
	}
	return chromeRenderable((width) => renderValidateGoalStateResult({
		goal_id: goalId,
		state_path: extractString(details.state_path) ?? "state.yaml",
		ok: details.ok === true,
		issue_count: typeof details.issue_count === "number" ? details.issue_count : 0,
		issues: Array.isArray(details.issues) ? details.issues.filter(isCheckIssue) : [],
	}, width));
}

function isCheckIssue(value: unknown): value is CheckIssue {
	return isRecord(value)
		&& (value.severity === "error" || value.severity === "warning")
		&& typeof value.code === "string"
		&& typeof value.message === "string"
		&& (value.path === undefined || typeof value.path === "string");
}

function extractString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

export const testables = {
	validateGoalStateForPi,
	renderValidateGoalStateToolResult,
};
