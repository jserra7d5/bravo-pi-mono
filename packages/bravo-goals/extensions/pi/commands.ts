import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import { archiveGoal } from "../../src/archive.js";
import { recordUserVerification } from "../../src/runtime.js";
import { discoverWorkspaceRoot } from "../../src/workspace.js";
import { markBoundaryApplied, normalizeBoundaryMode, selectNextBoundary } from "../../src/phase-boundary.js";
import type { GoalState } from "../../src/types.js";
import { clearHud, readActiveGoals, readGoalState, updateHud, type ActiveGoalEntry, type GoalStateView } from "./hud.js";

type BoundaryMode = "carry" | "compact" | "fresh_session" | "checkpoint_only";

interface CommandRuntime {
	refresh(ctx: ExtensionCommandContext): Promise<void>;
}

interface ParsedArgs {
	positional: string[];
	flags: Map<string, string | boolean>;
}

interface GoalRecord {
	id: string;
	path: string;
	state: GoalStateView;
}

interface ReplacementSession {
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
	sessionManager?: {
		getSessionId?: () => string;
	};
}

function parseArgs(args: string): ParsedArgs {
	const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => {
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1);
		}
		return token;
	}) ?? [];
	const positional: string[] = [];
	const flags = new Map<string, string | boolean>();
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const [rawName, inlineValue] = token.slice(2).split("=", 2);
		if (inlineValue !== undefined) {
			flags.set(rawName, inlineValue);
		} else if (tokens[i + 1] && !tokens[i + 1]!.startsWith("--")) {
			flags.set(rawName, tokens[i + 1]!);
			i += 1;
		} else {
			flags.set(rawName, true);
		}
	}
	return { positional, flags };
}

function sessionIdOf(ctx: ExtensionCommandContext): string | null {
	return ctx.sessionManager.getSessionId?.() ?? null;
}

function relPath(root: string, path: string): string {
	const rel = relative(root, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

async function writeYaml(path: string, value: unknown): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true });
	await writeFile(path, YAML.stringify(value), "utf8");
}

async function readYaml(path: string): Promise<unknown> {
	return YAML.parse(await readFile(path, "utf8"));
}

async function resolveGoal(root: string, goalIdOrPath?: string, sessionId?: string | null): Promise<GoalRecord | undefined> {
	let goalPath: string | undefined;
	if (goalIdOrPath) {
		goalPath = goalIdOrPath.includes("/") || goalIdOrPath.startsWith(".")
			? resolve(root, goalIdOrPath)
			: join(root, ".bravo", "goals", goalIdOrPath);
	} else {
		if (!sessionId) return undefined;
		const active = await readActiveGoals(root);
		const entry = active.find((candidate) => candidate.pi_session_id === sessionId);
		if (entry) goalPath = resolve(root, entry.path);
	}
	if (!goalPath) return undefined;
	const state = await readGoalState(goalPath);
	if (!state) return undefined;
	return { id: state.goal.id || basename(goalPath), path: goalPath, state };
}

async function updateGoalState(goalPath: string, updater: (state: Record<string, unknown>) => void): Promise<void> {
	const statePath = join(goalPath, "state.yaml");
	const state = await readYaml(statePath);
	if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error(`Invalid goal state: ${statePath}`);
	updater(state as Record<string, unknown>);
	await writeYaml(statePath, state);
}

async function writeActiveGoal(root: string, entry: ActiveGoalEntry): Promise<void> {
	const runtimeDir = join(root, ".bravo", "runtime");
	await mkdir(runtimeDir, { recursive: true });
	const existing = await readActiveGoals(root);
	const filtered = existing.filter((candidate) => candidate.goal_id !== entry.goal_id && candidate.pi_session_id !== entry.pi_session_id);
	await writeYaml(join(runtimeDir, "active-goals.yaml"), {
		schema_version: 1,
		active_goals: [...filtered, entry],
	});
}

async function detachActiveGoal(root: string, goalId: string, sessionId?: string | null): Promise<void> {
	const runtimeDir = join(root, ".bravo", "runtime");
	const existing = await readActiveGoals(root);
	const filtered = existing.filter((entry) => entry.goal_id !== goalId && (!sessionId || entry.pi_session_id !== sessionId));
	await writeYaml(join(runtimeDir, "active-goals.yaml"), {
		schema_version: 1,
		active_goals: filtered,
	});
}

function expectedWorkerReceiptPath(goal: GoalRecord): string | null {
	const active = goal.state.tasks.find((task) => task.id === goal.state.active_task);
	if (!active) return null;
	return active.receipt ?? `receipts/${active.id}-worker.md`;
}

function activeTaskPrompt(goal: GoalRecord): string {
	const active = goal.state.tasks.find((task) => task.id === goal.state.active_task);
	const task = active ? `${active.id}: ${active.title}` : "no active task";
	const receiptPath = expectedWorkerReceiptPath(goal);
	const receiptFullPath = receiptPath ? join(goal.path, receiptPath) : null;
	return `You are working on Bravo goal "${goal.state.goal.title}" (${goal.id}).

Read these files before acting:
1. ${relPath(process.cwd(), join(goal.path, "goal.md"))}
2. ${relPath(process.cwd(), join(goal.path, "context.md"))}
3. ${relPath(process.cwd(), join(goal.path, "state.yaml"))}
4. ${relPath(process.cwd(), join(goal.path, "resume.md"))}

Active task: ${task}
${receiptPath && receiptFullPath ? `Expected worker receipt path for task_receipt_ready: ${receiptPath}\nWrite the receipt file at: ${receiptFullPath}` : "No active task receipt path is available."}

${receiptPath && receiptFullPath ? `Continue the active task from state.yaml. When complete, write the worker receipt file at the full path above using this exact YAML-frontmatter shape, then Markdown details after the closing ---:\n\n${workerReceiptTemplate(active?.id ?? "<task-id>")}\n\nThen call task_receipt_ready with goal_id: ${goal.id} and receipt_path: ${receiptPath}. Do not create receipts under the repo directory. Do not edit state.yaml manually for the receipt-ready transition.` : "Continue from state.yaml. There is no active task receipt path available."}`;
}

function workerReceiptTemplate(taskId: string): string {
	return `---
schema_version: 1
type: worker
task_id: ${taskId}
status: complete
created_at: "<ISO-8601 timestamp>"
files_changed: []
commands: []
claims:
  - claim: "<what was completed>"
    evidence:
      - "<file or command evidence>"
remaining_risk: []
---`;
}

function restartPrompt(goal: GoalRecord): string {
	const active = goal.state.tasks.find((task) => task.id === goal.state.active_task);
	const receiptPath = expectedWorkerReceiptPath(goal);
	const receiptFullPath = receiptPath ? join(goal.path, receiptPath) : null;
	return `You are resuming a Bravo goal in a fresh Pi session.

Read these files before acting:
1. ${relPath(process.cwd(), join(goal.path, "goal.md"))}
2. ${relPath(process.cwd(), join(goal.path, "context.md"))}
3. ${relPath(process.cwd(), join(goal.path, "state.yaml"))}
4. ${relPath(process.cwd(), join(goal.path, "resume.md"))}

Then continue the active task from state.yaml.${receiptPath && receiptFullPath ? ` When complete, write the worker receipt file at ${receiptFullPath} using this frontmatter shape:\n\n${workerReceiptTemplate(active?.id ?? "<task-id>")}\n\nThen call task_receipt_ready with goal_id: ${goal.id} and receipt_path: ${receiptPath}. Do not create receipts under the repo directory.` : " There is no active task receipt path available."}`;
}

function checkpointPrompt(goal: GoalRecord): string {
	return `Checkpoint Bravo goal "${goal.state.goal.title}".

Refresh ${relPath(process.cwd(), join(goal.path, "resume.md"))} with the current durable resume context for the active task. Do not mark the goal complete unless state.yaml and receipts already prove completion.`;
}

function controllerResumeSnapshot(goal: GoalRecord, reason: string | null): string {
	const active = goal.state.tasks.find((task) => task.id === goal.state.active_task);
	// Intentional: resume.md records the pre-pause snapshot. When pausing an active
	// goal this says "Goal status: active" so the next worker can see what was
	// interrupted, while state.yaml remains the authoritative current status.
	return [
		`# Resume: ${goal.state.goal.title}`,
		"",
		`Checkpointed: ${new Date().toISOString()}`,
		reason ? `Reason: ${reason}` : null,
		"",
		"## Current State",
		"",
		`Goal status: ${goal.state.goal.status}`,
		`Active task: ${active ? `${active.id} - ${active.title}` : "none"}`,
		`Progress: ${goal.state.progress?.completed_tasks ?? 0}/${goal.state.progress?.total_tasks ?? goal.state.tasks.length}`,
		`Judge: ${goal.state.judge?.active ? "active" : (goal.state.judge?.last_verdict ?? "none")}`,
		"",
		"## Read First",
		"",
		"1. `goal.md`",
		"2. `context.md`",
		"3. `state.yaml`",
		"4. `resume.md`",
		"",
		"## Next Action",
		"",
		"Continue from `state.yaml`. Do not trust partial work without receipts.",
		"",
	].filter((line): line is string => line !== null).join("\n");
}

function compactInstructions(goal: GoalRecord): string {
	return `Preserve the Bravo goal context for ${goal.id}. Include the active task, current blockers, receipt status, relevant files changed, and next action. The durable source of truth remains ${relPath(process.cwd(), goal.path)}.`;
}

function boundaryFromFlags(flags: Map<string, string | boolean>): Exclude<BoundaryMode, "checkpoint_only"> {
	if (flags.has("fresh")) return "fresh_session";
	if (flags.has("compact")) return "compact";
	if (flags.has("carry")) return "carry";
	return normalizeBoundaryMode(typeof flags.get("boundary") === "string" ? flags.get("boundary") as string : null) ?? "carry";
}

async function queuePrompt(pi: ExtensionAPI, prompt: string): Promise<void> {
	pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

async function freshSession(root: string, ctx: ExtensionCommandContext, goal: GoalRecord): Promise<void> {
	await ctx.waitForIdle();
	await ctx.newSession({
		parentSession: ctx.sessionManager.getSessionFile?.(),
		withSession: async (replacement: ReplacementSession) => {
			const replacementSessionId = replacement.sessionManager?.getSessionId?.() ?? null;
			await updateGoalState(goal.path, (state) => {
				const session = state.session as Record<string, unknown> | undefined;
				if (session) session.attached_pi_session_id = replacementSessionId;
			});
			await writeActiveGoal(root, {
				goal_id: goal.id,
				path: relPath(root, goal.path),
				pi_session_id: replacementSessionId,
				status: goal.state.goal.status,
				active_task: goal.state.active_task,
			});
			await replacement.sendUserMessage(restartPrompt(goal), { deliverAs: "followUp" });
		},
	});
}

async function runBoundary(root: string, pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: GoalRecord, mode: BoundaryMode): Promise<"continued" | "replaced" | "none"> {
	if (mode === "checkpoint_only") return "none";
	if (mode === "fresh_session") {
		await freshSession(root, ctx, goal);
		return "replaced";
	}
	if (mode === "compact") {
		ctx.compact({
			customInstructions: compactInstructions(goal),
			onComplete: () => queuePrompt(pi, activeTaskPrompt(goal)),
		});
		return "continued";
	}
	await queuePrompt(pi, activeTaskPrompt(goal));
	return "continued";
}

async function handleGoal(pi: ExtensionAPI, runtime: CommandRuntime, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const root = await discoverWorkspaceRoot(ctx.cwd);
	if (!root) throw new Error("No Bravo workspace found. Run bravo-goals init at the workspace root first.");
	const parsed = parseArgs(args);
	const [subcommand = "status", goalArg] = parsed.positional;
	const sessionId = sessionIdOf(ctx);

	if (subcommand === "status") {
		const goal = await resolveGoal(root, goalArg, sessionId);
		if (!goal) {
			ctx.ui.notify("No Bravo goal is attached to this session.", "info");
			clearHud(ctx);
			return;
		}
		ctx.ui.notify(`${goal.state.goal.title}: ${goal.state.goal.status}`, "info");
		await runtime.refresh(ctx);
		return;
	}

	if (subcommand === "start" || subcommand === "resume") {
		const goal = await resolveGoal(root, goalArg, sessionId);
		if (!goal) throw new Error(`Goal not found: ${goalArg ?? ""}`);
		await updateGoalState(goal.path, (state) => {
			const goalState = state.goal as Record<string, unknown> | undefined;
			const sessionState = state.session as Record<string, unknown> | undefined;
			if (goalState) goalState.status = "active";
			if (sessionState) sessionState.attached_pi_session_id = sessionId;
			// Intentional: keep pause.paused_at/pause_reason as last-pause audit metadata
			// after resume; current lifecycle is represented by goal.status/session/index.
		});
		await writeActiveGoal(root, {
			goal_id: goal.id,
			path: relPath(root, goal.path),
			pi_session_id: sessionId,
			status: "active",
			active_task: goal.state.active_task,
		});
		await runtime.refresh(ctx);
		await queuePrompt(pi, subcommand === "resume" ? restartPrompt(goal) : activeTaskPrompt(goal));
		return;
	}

	const goal = await resolveGoal(root, goalArg, sessionId);
	if (!goal) throw new Error(`No Bravo goal found for /goal ${subcommand}.`);

	if (subcommand === "pause") {
		const reason = typeof parsed.flags.get("reason") === "string" ? parsed.flags.get("reason") as string : null;
		await writeFile(join(goal.path, "resume.md"), controllerResumeSnapshot(goal, reason), "utf8");
		await updateGoalState(goal.path, (state) => {
			const goalState = state.goal as Record<string, unknown> | undefined;
			const sessionState = state.session as Record<string, unknown> | undefined;
			const pause = state.pause as Record<string, unknown> | undefined;
			if (goalState) goalState.status = "paused";
			if (sessionState) sessionState.attached_pi_session_id = null;
			if (pause) {
				pause.paused_at = new Date().toISOString();
				pause.pause_reason = reason;
			}
		});
		await detachActiveGoal(root, goal.id, sessionId);
		clearHud(ctx);
		return;
	}

	if (subcommand === "checkpoint") {
		await queuePrompt(pi, checkpointPrompt(goal));
		await runtime.refresh(ctx);
		return;
	}

	if (subcommand === "next") {
		if (goal.state.judge?.last_verdict !== "pass") {
			throw new Error("next boundary requires the last Judge verdict to be pass");
		}
		const fullState = await readYaml(join(goal.path, "state.yaml")) as GoalState;
		const override = parsed.flags.size > 0 ? boundaryFromFlags(parsed.flags) : null;
		if (override && !fullState.phase_boundary.experimental_flags.allow_runtime_override) {
			throw new Error("runtime boundary override is disabled for this goal");
		}
		const completedTask = fullState.tasks.find((task) => task.judge_receipt && task.judge_receipt === fullState.judge.last_receipt) ?? null;
		if (!completedTask) {
			throw new Error("next boundary requires judge.last_receipt to match a completed task Judge receipt");
		}
		const selection = selectNextBoundary(fullState, completedTask, { override });
		const updated = markBoundaryApplied(fullState, selection);
		await writeYaml(join(goal.path, "state.yaml"), updated);
		const outcome = await runBoundary(root, pi, ctx, goal, selection.mode);
		if (outcome !== "replaced") await runtime.refresh(ctx);
		return;
	}

	if (subcommand === "compact") {
		await runBoundary(root, pi, ctx, goal, "compact");
		return;
	}

	if (subcommand === "verify") {
		await recordUserVerification(goal.path, {
			verifiedBy: "user",
			note: typeof parsed.flags.get("note") === "string" ? parsed.flags.get("note") as string : null,
		});
		await runtime.refresh(ctx);
		ctx.ui.notify(`Verified Bravo goal: ${goal.id}`, "info");
		return;
	}

	if (subcommand === "archive") {
		const result = await archiveGoal(root, goal.path, {
			force: parsed.flags.has("force"),
			reason: typeof parsed.flags.get("reason") === "string" ? parsed.flags.get("reason") as string : null,
		});
		clearHud(ctx);
		ctx.ui.notify(`Archived Bravo goal: ${goal.id} -> ${relPath(root, result.archivedPath)}`, "info");
		return;
	}

	throw new Error(`Unknown /goal command: ${subcommand}`);
}

export function registerGoalCommands(pi: ExtensionAPI, runtime: CommandRuntime): void {
	pi.registerCommand("goal", {
		description: "Manage Bravo goal status, lifecycle, phase boundaries, and archive.",
		handler: async (args, ctx) => handleGoal(pi, runtime, args, ctx),
	});
}

export const testables = {
	parseArgs,
	boundaryFromFlags,
	activeTaskPrompt,
	restartPrompt,
	checkpointPrompt,
};
