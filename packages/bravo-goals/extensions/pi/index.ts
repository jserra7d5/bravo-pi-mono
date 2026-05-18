import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalCommands } from "./commands.js";
import { registerGoalValidationTools } from "./goal-validation.js";
import { clearHud, updateHud } from "./hud.js";
import { registerJudgeControlTools } from "./judge-control.js";
import { registerGoalPolicyHooks } from "./policy-hook.js";
import { renderIdleRecoveryPrompt } from "../../src/prompts.js";
import { readActiveGoalsIndex, readGoalState } from "../../src/runtime.js";
import { discoverWorkspaceRoot } from "../../src/workspace.js";

let currentCtx: ExtensionContext | undefined;
let hudTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight = false;
let consecutiveFailures = 0;
const watchdogNudges = new Map<string, number>();

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

export default function bravoGoalsPiExtension(pi: ExtensionAPI): void {
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
		if (ctx.hasPendingMessages()) return;
		const workspaceRoot = await discoverWorkspaceRoot(ctx.cwd);
		if (!workspaceRoot) return;
		const sessionId = ctx.sessionManager.getSessionId?.();
		if (!sessionId) return;
		const index = await readActiveGoalsIndex(workspaceRoot);
		const active = index.active_goals.find((entry) => entry.pi_session_id === sessionId);
		if (!active) return;
		const state = await readGoalState(`${workspaceRoot}/${active.path}`);
		if (state.goal.status !== "active" || state.judge.active || !state.active_task) return;
		const task = state.tasks.find((candidate) => candidate.id === state.active_task);
		if (!task || task.status !== "active") return;
		const key = `${state.goal.id}:${task.id}:${task.receipt ?? ""}:${task.judge_receipt ?? ""}`;
		const count = watchdogNudges.get(key) ?? 0;
		if (count >= 3) {
			ctx.ui?.notify?.(`Bravo goal ${state.goal.id} is still active on ${task.id}; watchdog reached retry limit and is waiting for human input.`, "warning");
			return;
		}
		watchdogNudges.set(key, count + 1);
		pi.sendUserMessage(renderIdleRecoveryPrompt({
			state,
			goalDir: `${workspaceRoot}/${active.path}`,
			cwd: ctx.cwd,
			nudgeCount: count + 1,
		}), { deliverAs: "followUp" });
	});
}
