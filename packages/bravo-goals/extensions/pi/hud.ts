import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { discoverWorkspaceRoot } from "../../src/workspace.js";

export const HUD_STATUS_KEY = "bravo-goals";
export const HUD_WIDGET_KEY = "bravo-goals-hud";

export interface GoalTaskView {
	id: string;
	title: string;
	status?: string;
	receipt?: string | null;
}

export interface GoalStateView {
	goal: {
		id: string;
		title: string;
		status: string;
	};
	active_task: string | null;
	tasks: GoalTaskView[];
	judge?: {
		last_verdict?: string;
		active?: boolean;
	};
	progress?: {
		completed_tasks?: number;
		total_tasks?: number;
	};
}

export interface ActiveGoalEntry {
	goal_id: string;
	path: string;
	pi_session_id?: string | null;
	status?: string;
	active_task?: string | null;
}

export interface HudSnapshot {
	goalPath: string;
	state: GoalStateView;
	indexEntry?: ActiveGoalEntry;
}

interface UiLike {
	setStatus?: (key: string, value: string | undefined) => void;
	setWidget?: (key: string, value: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }) => void;
}

interface ContextLike {
	cwd?: string;
	ui?: UiLike;
	sessionManager?: {
		getSessionId?: () => string;
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeTask(value: unknown): GoalTaskView | undefined {
	if (!isObject(value)) return undefined;
	const id = asString(value.id);
	if (!id) return undefined;
	return {
		id,
		title: asString(value.title, id),
		status: typeof value.status === "string" ? value.status : undefined,
		receipt: typeof value.receipt === "string" ? value.receipt : null,
	};
}

export function normalizeGoalState(value: unknown): GoalStateView | undefined {
	if (!isObject(value) || !isObject(value.goal)) return undefined;
	const id = asString(value.goal.id);
	const title = asString(value.goal.title, id);
	if (!id || !title) return undefined;
	const tasks = Array.isArray(value.tasks) ? value.tasks.map(normalizeTask).filter((task): task is GoalTaskView => Boolean(task)) : [];
	return {
		goal: {
			id,
			title,
			status: asString(value.goal.status, "unknown"),
		},
		active_task: typeof value.active_task === "string" ? value.active_task : null,
		tasks,
		judge: isObject(value.judge)
			? {
					last_verdict: typeof value.judge.last_verdict === "string" ? value.judge.last_verdict : undefined,
					active: typeof value.judge.active === "boolean" ? value.judge.active : undefined,
				}
			: undefined,
		progress: isObject(value.progress)
			? {
					completed_tasks: asNumber(value.progress.completed_tasks),
					total_tasks: asNumber(value.progress.total_tasks, tasks.length),
				}
			: { completed_tasks: tasks.filter((task) => task.status === "done").length, total_tasks: tasks.length },
	};
}

function normalizeActiveEntry(value: unknown): ActiveGoalEntry | undefined {
	if (!isObject(value)) return undefined;
	const goalId = asString(value.goal_id);
	const path = asString(value.path);
	if (!goalId || !path) return undefined;
	return {
		goal_id: goalId,
		path,
		pi_session_id: typeof value.pi_session_id === "string" ? value.pi_session_id : null,
		status: typeof value.status === "string" ? value.status : undefined,
		active_task: typeof value.active_task === "string" ? value.active_task : null,
	};
}

export function progressBar(done: number, total: number, width = 16): string {
	if (total <= 0) return "-".repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return "#".repeat(filled) + "-".repeat(width - filled);
}

export function renderStatusLine(snapshot?: HudSnapshot): string | undefined {
	if (!snapshot) return undefined;
	const { state } = snapshot;
	const done = state.progress?.completed_tasks ?? 0;
	const total = state.progress?.total_tasks ?? state.tasks.length;
	const judge = judgeStatus(state);
	return `Goal: ${state.goal.title} ${done}/${total} Judge: ${judge}`;
}

export function renderHud(snapshot?: HudSnapshot): string[] {
	if (!snapshot) return [];
	const { state } = snapshot;
	const done = state.progress?.completed_tasks ?? 0;
	const total = state.progress?.total_tasks ?? state.tasks.length;
	const percent = total > 0 ? Math.round((done / total) * 100) : 0;
	const active = state.tasks.find((task) => task.id === state.active_task);
	const taskTitle = active?.title ?? state.active_task ?? "none";
	const judge = judgeStatus(state);
	return [
		`GOAL  ${state.goal.title}`,
		`STATE ${state.goal.status}`,
		`TASK  ${taskTitle}`,
		`DONE  ${done}/${total} [${progressBar(done, total)}] ${percent}%`,
		`JUDGE ${judge}`,
	];
}

function judgeStatus(state: GoalStateView): string {
	const active = state.tasks.find((task) => task.id === state.active_task);
	if (active?.status === "awaiting_judge") return "awaiting";
	return state.judge?.active ? "active" : (state.judge?.last_verdict ?? "none");
}

export async function readGoalState(goalPath: string): Promise<GoalStateView | undefined> {
	const text = await readFile(join(goalPath, "state.yaml"), "utf8");
	return normalizeGoalState(YAML.parse(text));
}

export async function readActiveGoals(root: string): Promise<ActiveGoalEntry[]> {
	try {
		const text = await readFile(join(root, ".bravo", "runtime", "active-goals.yaml"), "utf8");
		const parsed = YAML.parse(text);
		if (!isObject(parsed) || !Array.isArray(parsed.active_goals)) return [];
		return parsed.active_goals.map(normalizeActiveEntry).filter((entry): entry is ActiveGoalEntry => Boolean(entry));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function snapshotForSession(ctx: ContextLike): Promise<HudSnapshot | undefined> {
	const cwd = await discoverWorkspaceRoot(ctx.cwd ?? process.cwd());
	if (!cwd) return undefined;
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const activeGoals = await readActiveGoals(cwd);
	const entry = sessionId ? activeGoals.find((goal) => goal.pi_session_id === sessionId) : undefined;
	if (!entry) return undefined;
	const goalPath = resolve(cwd, entry.path);
	const state = await readGoalState(goalPath);
	if (!state) return undefined;
	return { goalPath, state, indexEntry: entry };
}

export async function updateHud(ctx: ContextLike): Promise<void> {
	const ui = ctx.ui;
	if (!ui) return;
	const snapshot = await snapshotForSession(ctx);
	ui.setStatus?.(HUD_STATUS_KEY, renderStatusLine(snapshot));
	const lines = renderHud(snapshot);
	ui.setWidget?.(HUD_WIDGET_KEY, lines.length ? lines : undefined, { placement: "belowEditor" });
}

export function clearHud(ctx: ContextLike): void {
	ctx.ui?.setStatus?.(HUD_STATUS_KEY, undefined);
	ctx.ui?.setWidget?.(HUD_WIDGET_KEY, undefined, { placement: "belowEditor" });
}
