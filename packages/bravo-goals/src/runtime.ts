import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { GoalState, GoalStatus } from "./types.js";
import { atomicWriteFile, ensureDir, nowIso } from "./fs.js";
import { renderWorkerResumePrompt, renderWorkerStartPrompt } from "./prompts.js";
import { refreshProgress, saveGoalState } from "./state.js";
import { validateJudgeCompletion } from "./judge-runner.js";
import { bravoWorkspacePaths, resolveGoalWorkspacePath } from "./workspace.js";

export interface ActiveGoalEntry {
	goal_id: string;
	path: string;
	pi_session_id: string | null;
	status: GoalStatus;
	active_task: string | null;
}

export interface ActiveGoalsIndex {
	schema_version: 1;
	active_goals: ActiveGoalEntry[];
}

export interface GoalListEntry {
	goal_id: string;
	title: string;
	status: GoalStatus;
	active_task: string | null;
	progress: string;
	path: string;
	modified_at: string;
	modified_ms: number;
}

export async function readGoalState(goalDir: string): Promise<GoalState> {
	return YAML.parse(await readFile(join(goalDir, "state.yaml"), "utf8")) as GoalState;
}

export async function writeGoalState(goalDir: string, state: GoalState): Promise<void> {
	await saveGoalState(join(goalDir, "state.yaml"), state);
}

export async function resolveGoalDir(workspaceRoot: string, goalIdOrPath: string): Promise<string> {
	const direct = resolve(goalIdOrPath);
	if (await exists(join(direct, "state.yaml"))) return direct;

	const goalDir = resolveGoalWorkspacePath(workspaceRoot, goalIdOrPath);
	if (await exists(join(goalDir, "state.yaml"))) return goalDir;
	throw new Error(`goal not found: ${goalIdOrPath}`);
}

export function activeGoalsIndexPath(workspaceRoot: string): string {
	return join(bravoWorkspacePaths(workspaceRoot).runtime, "active-goals.yaml");
}

export async function readActiveGoalsIndex(workspaceRoot: string): Promise<ActiveGoalsIndex> {
	const path = activeGoalsIndexPath(workspaceRoot);
	if (!(await exists(path))) return { schema_version: 1, active_goals: [] };
	const parsed = YAML.parse(await readFile(path, "utf8")) as Partial<ActiveGoalsIndex> | null;
	return {
		schema_version: 1,
		active_goals: Array.isArray(parsed?.active_goals) ? parsed.active_goals : [],
	};
}

export async function writeActiveGoalsIndex(workspaceRoot: string, index: ActiveGoalsIndex): Promise<void> {
	await atomicWriteFile(activeGoalsIndexPath(workspaceRoot), YAML.stringify(index));
}

export async function upsertActiveGoal(workspaceRoot: string, entry: ActiveGoalEntry): Promise<void> {
	const index = await readActiveGoalsIndex(workspaceRoot);
	const without = index.active_goals.filter((existing) => existing.goal_id !== entry.goal_id);
	await writeActiveGoalsIndex(workspaceRoot, { schema_version: 1, active_goals: [...without, entry] });
}

export async function removeActiveGoal(workspaceRoot: string, goalId: string): Promise<void> {
	const index = await readActiveGoalsIndex(workspaceRoot);
	await writeActiveGoalsIndex(workspaceRoot, {
		schema_version: 1,
		active_goals: index.active_goals.filter((entry) => entry.goal_id !== goalId),
	});
}

export async function recoverActiveGoalsIndex(workspaceRoot: string): Promise<ActiveGoalsIndex> {
	const paths = bravoWorkspacePaths(workspaceRoot);
	await ensureDir(paths.runtime);
	const entries: ActiveGoalEntry[] = [];
	if (await exists(paths.goals)) {
		for (const dirent of await readdir(paths.goals, { withFileTypes: true })) {
			if (!dirent.isDirectory()) continue;
			const goalDir = join(paths.goals, dirent.name);
			if (!(await exists(join(goalDir, "state.yaml")))) continue;
			const state = await readGoalState(goalDir);
			if (state.goal.status === "archived") continue;
			if (state.session.attached_pi_session_id || state.goal.status === "active" || state.goal.status === "judging") {
				entries.push({
					goal_id: state.goal.id,
					path: relative(workspaceRoot, goalDir),
					pi_session_id: state.session.attached_pi_session_id,
					status: state.goal.status,
					active_task: state.active_task,
				});
			}
		}
	}
	const index = { schema_version: 1 as const, active_goals: entries };
	await writeActiveGoalsIndex(workspaceRoot, index);
	return index;
}

export async function listGoals(workspaceRoot: string): Promise<GoalListEntry[]> {
	const paths = bravoWorkspacePaths(workspaceRoot);
	if (!(await exists(paths.goals))) return [];
	const entries: GoalListEntry[] = [];
	for (const dirent of await readdir(paths.goals, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const goalDir = join(paths.goals, dirent.name);
		if (!(await exists(join(goalDir, "state.yaml")))) continue;
		const state = await readGoalState(goalDir);
		const modifiedMs = await newestMtimeMs(goalDir);
		entries.push({
			goal_id: state.goal.id || dirent.name,
			title: state.goal.title,
			status: state.goal.status,
			active_task: state.active_task,
			progress: `${state.progress?.completed_tasks ?? 0}/${state.progress?.total_tasks ?? state.tasks.length}`,
			path: relative(workspaceRoot, goalDir),
			modified_at: new Date(modifiedMs).toISOString(),
			modified_ms: modifiedMs,
		});
	}
	return entries.sort((left, right) => right.modified_ms - left.modified_ms || left.goal_id.localeCompare(right.goal_id));
}

export function renderWorkerPrompt(state: GoalState, goalDir: string): string {
	return renderWorkerStartPrompt({ state, goalDir });
}

export function renderRestartPrompt(state: GoalState, goalDir: string): string {
	return renderWorkerResumePrompt({ state, goalDir });
}

export function recomputeProgress(state: GoalState): GoalState {
	return refreshProgress(state);
}

export async function recordUserVerification(
	goalDir: string,
	options: { verifiedBy?: string; note?: string | null } = {},
): Promise<GoalState> {
	const state = await readGoalState(goalDir);
	if (state.final_audit.status !== "passed") {
		throw new Error("cannot verify goal before final audit passes");
	}
	if (!state.final_audit.receipt || !state.final_audit.judge_run_id) {
		throw new Error("cannot verify goal before final audit receipt and judge_run_id exist");
	}
	if (!state.tasks.every((task) => task.status === "done")) {
		throw new Error("cannot verify goal before every task is done");
	}
	const workspaceRoot = workspaceRootFromGoalDir(goalDir);
	if (!workspaceRoot) {
		throw new Error("cannot verify goal because workspace root could not be resolved");
	}
	const finalAuditRun = await validateJudgeCompletion(join(workspaceRoot, ".bravo", "runs", state.final_audit.judge_run_id));
	if (!finalAuditRun.ok || finalAuditRun.verdict?.verdict !== "pass" || finalAuditRun.verdict.final_audit !== true) {
		throw new Error("cannot verify goal before final audit Judge run is terminal, passing, and final_audit scoped");
	}
	if (finalAuditRun.verdict.receipt_path !== state.final_audit.receipt) {
		throw new Error("cannot verify goal because final audit receipt does not match the Judge run verdict");
	}
	const now = nowIso();
	const next: GoalState = {
		...state,
		goal: {
			...state.goal,
			updated_at: now,
		},
		user_verification: {
			status: "verified",
			verified_at: now,
			verified_by: options.verifiedBy ?? process.env.USER ?? null,
			note: options.note ?? null,
		},
	};
	await writeGoalState(goalDir, next);
	return next;
}

function workspaceRootFromGoalDir(goalDir: string): string | null {
	const normalized = resolve(goalDir).split(sep).join("/");
	const marker = "/.bravo/goals/";
	const index = normalized.indexOf(marker);
	return index >= 0 ? normalized.slice(0, index) : null;
}

export function normalizeGoalId(input: string): string {
	const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!normalized) throw new Error("goal id is required");
	return normalized;
}

export async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function newestMtimeMs(path: string): Promise<number> {
	const info = await stat(path);
	if (!info.isDirectory()) return info.mtimeMs;
	let newest = info.mtimeMs;
	for (const dirent of await readdir(path, { withFileTypes: true })) {
		const childPath = join(path, dirent.name);
		const childMtime = dirent.isDirectory() ? await newestMtimeMs(childPath) : (await stat(childPath)).mtimeMs;
		if (childMtime > newest) newest = childMtime;
	}
	return newest;
}
