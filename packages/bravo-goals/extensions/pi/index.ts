import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalCommands } from "./commands.js";
import { clearHud, updateHud } from "./hud.js";
import { registerJudgeControlTools } from "./judge-control.js";

let currentCtx: ExtensionContext | undefined;
let hudTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight = false;
let consecutiveFailures = 0;

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
	registerJudgeControlTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		startHud(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopHud();
	});

	pi.on("session_compact", async (_event, ctx) => {
		await refresh(ctx);
	});
}
