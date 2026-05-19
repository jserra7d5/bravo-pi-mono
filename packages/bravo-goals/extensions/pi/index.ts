import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { registerGoalCommands } from "./commands.js";
import { registerGoalValidationTools } from "./goal-validation.js";
import { clearHud, updateHud } from "./hud.js";
import { registerJudgeControlTools } from "./judge-control.js";
import { registerGoalPolicyHooks } from "./policy-hook.js";
import { renderIdleRecoveryPrompt, wrapBravoSystemMessage } from "../../src/prompts.js";
import { readActiveGoalsIndex, readGoalState } from "../../src/runtime.js";
import { discoverWorkspaceRoot } from "../../src/workspace.js";
import {
	BRAVO_GOAL_CONTROL_MESSAGE_TYPE,
	BRAVO_GOAL_FEDERAL_JUDGE_READY_MESSAGE_TYPE,
	BRAVO_GOAL_WATCHDOG_MESSAGE_TYPE,
} from "./messages.js";

let currentCtx: ExtensionContext | undefined;
let hudTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight = false;
let consecutiveFailures = 0;
const watchdogNudges = new Map<string, number>();

interface IdleRecoveryCandidate {
	workspaceRoot: string;
	goalPath: string;
	sessionId: string;
	goalId: string;
	taskId: string;
	stateKey: string;
	cwd: string;
}

async function refresh(ctx: ExtensionContext): Promise<void> {
	if (refreshInFlight) return;
	refreshInFlight = true;
	try {
		await updateHud(ctx);
		consecutiveFailures = 0;
	} catch {
		consecutiveFailures += 1;
		if (consecutiveFailures >= 3) {
			ctx.ui?.setStatus?.("bravo-goals", "Goal: HUD unavailable");
		}
	} finally {
		refreshInFlight = false;
	}
}

function startHud(ctx: ExtensionContext): void {
	stopHud();
	currentCtx = ctx;
	void refresh(ctx);
	hudTimer = setInterval(() => {
		if (currentCtx) void refresh(currentCtx);
	}, 1_500);
	hudTimer.unref?.();
}

function stopHud(): void {
	if (hudTimer) clearInterval(hudTimer);
	hudTimer = undefined;
	if (currentCtx) clearHud(currentCtx);
	currentCtx = undefined;
	refreshInFlight = false;
	consecutiveFailures = 0;
}

function renderBravoMessage(message: unknown): Component {
	const content = (message as { content?: unknown } | undefined)?.content;
	return new Text(typeof content === "string" ? content : "", 0, 0);
}

function idleRecoveryKey(state: Awaited<ReturnType<typeof readGoalState>>, task: Awaited<ReturnType<typeof readGoalState>>["tasks"][number]): string {
	return `${state.goal.id}:${task.id}:${task.receipt ?? ""}:${task.judge_receipt ?? ""}`;
}

async function collectIdleRecoveryCandidate(ctx: ExtensionContext): Promise<IdleRecoveryCandidate | null> {
	if (ctx.hasPendingMessages()) return null;
	const workspaceRoot = await discoverWorkspaceRoot(ctx.cwd);
	if (!workspaceRoot) return null;
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return null;
	const index = await readActiveGoalsIndex(workspaceRoot);
	const active = index.active_goals.find((entry) => entry.pi_session_id === sessionId);
	if (!active) return null;
	const goalPath = join(workspaceRoot, active.path);
	const state = await readGoalState(goalPath);
	if (state.goal.status !== "active" || state.judge.active || !state.active_task) return null;
	const task = state.tasks.find((candidate) => candidate.id === state.active_task);
	if (!task || task.status !== "active") return null;
	return {
		workspaceRoot,
		goalPath,
		sessionId,
		goalId: state.goal.id,
		taskId: task.id,
		stateKey: idleRecoveryKey(state, task),
		cwd: ctx.cwd,
	};
}

async function sendIdleRecoveryIfStillCurrent(pi: ExtensionAPI, ctx: ExtensionContext, expected: IdleRecoveryCandidate): Promise<void> {
	if (ctx.hasPendingMessages()) return;
	const index = await readActiveGoalsIndex(expected.workspaceRoot);
	const active = index.active_goals.find((entry) => entry.pi_session_id === expected.sessionId && entry.goal_id === expected.goalId);
	if (!active) return;
	const goalPath = join(expected.workspaceRoot, active.path);
	if (goalPath !== expected.goalPath) return;
	const state = await readGoalState(goalPath);
	if (state.goal.status !== "active" || state.judge.active || !state.active_task) return;
	const task = state.tasks.find((candidate) => candidate.id === state.active_task);
	if (!task || task.status !== "active") return;
	const key = idleRecoveryKey(state, task);
	if (key !== expected.stateKey || task.id !== expected.taskId) return;
	const count = watchdogNudges.get(key) ?? 0;
	if (count >= 3) {
		ctx.ui?.notify?.(`Bravo goal ${state.goal.id} is still active on ${task.id}; watchdog reached retry limit and is waiting for human input.`, "warning");
		return;
	}
	watchdogNudges.set(key, count + 1);
	pi.sendMessage({
		customType: BRAVO_GOAL_WATCHDOG_MESSAGE_TYPE,
		display: true,
		content: wrapBravoSystemMessage(renderIdleRecoveryPrompt({
			state,
			goalDir: goalPath,
			cwd: expected.cwd,
			nudgeCount: count + 1,
		})),
		details: {
			goal_id: state.goal.id,
			goal_title: state.goal.title,
			kind: "idle_recovery",
			nudge_count: count + 1,
		},
	}, { deliverAs: "followUp", triggerTurn: true });
}

function idleRecoveryDeferMs(): number {
	const parsed = Number(process.env.BRAVO_GOALS_IDLE_RECOVERY_DEFER_MS ?? "0");
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function scheduleIdleRecovery(pi: ExtensionAPI, ctx: ExtensionContext, expected: IdleRecoveryCandidate): void {
	const timer = setTimeout(() => {
		void sendIdleRecoveryIfStillCurrent(pi, ctx, expected).catch((error) => {
			ctx.ui?.notify?.(`Bravo idle recovery skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
	}, idleRecoveryDeferMs());
	timer.unref?.();
}

export const testables = {
	collectIdleRecoveryCandidate,
	idleRecoveryKey,
	sendIdleRecoveryIfStillCurrent,
};

export default function bravoGoalsPiExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(BRAVO_GOAL_CONTROL_MESSAGE_TYPE, renderBravoMessage);
	pi.registerMessageRenderer(BRAVO_GOAL_WATCHDOG_MESSAGE_TYPE, renderBravoMessage);
	pi.registerMessageRenderer(BRAVO_GOAL_FEDERAL_JUDGE_READY_MESSAGE_TYPE, renderBravoMessage);

	registerGoalCommands(pi, {
		refresh: async (ctx) => {
			currentCtx = ctx;
			await refresh(ctx);
		},
	});
	registerGoalValidationTools(pi);
	registerJudgeControlTools(pi);
	registerGoalPolicyHooks(pi);

	pi.on("session_start", async (_event, ctx) => {
		startHud(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopHud();
	});

	pi.on("session_compact", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refresh(ctx);
		const candidate = await collectIdleRecoveryCandidate(ctx);
		if (!candidate) return;
		// By agent_end, pi-agent-core has already checked the follow-up queue for
		// this run. Rendering and queuing immediately here can leave a task-specific
		// recovery prompt parked in the follow-up queue until after state.yaml has advanced.
		// Defer one tick, then re-read durable state and send only if the same task
		// is still current.
		scheduleIdleRecovery(pi, ctx, candidate);
	});
}
