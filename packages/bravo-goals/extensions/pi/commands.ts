import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import { archiveGoal } from "../../src/archive.js";
import { checkGoal } from "../../src/checker.js";
import { createDefaultGoalPolicy } from "../../src/policy.js";
import {
	renderCarryContinuationPrompt,
	renderCheckpointPrompt,
	renderHandoffContinuationPrompt,
	renderWorkerResumePrompt,
	renderWorkerStartPrompt,
	wrapBravoSystemMessage,
} from "../../src/prompts.js";
import { exists as pathExists, listGoals, recordUserVerification } from "../../src/runtime.js";
import { bravoWorkspacePaths, discoverWorkspaceRoot, initBravoWorkspace, scaffoldGoalWorkspace } from "../../src/workspace.js";
import { markBoundaryApplied, normalizeBoundaryMode, renderCompactInstructions, selectNextBoundary } from "../../src/phase-boundary.js";
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

interface GoalCommandHelp {
	name: string;
	usage: string;
	when: string;
	args?: string[];
	flags?: string[];
}

interface ReplacementSession {
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
	sessionManager?: {
		getSessionId?: () => string;
	};
}

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	cyan: "\x1b[38;2;126;212;201m",
	gold: "\x1b[38;2;229;181;72m",
	sky: "\x1b[38;2;174;215;255m",
	amber: "\x1b[38;2;229;181;72m",
	text: "\x1b[38;2;220;220;221m",
	muted: "\x1b[38;2;120;120;128m",
	ok: "\x1b[38;2;126;201;145m",
	bad: "\x1b[38;2;232;111;111m",
};

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

const GOAL_COMMAND_HELP: GoalCommandHelp[] = [
	{
		name: "help",
		usage: "/goal help [subcommand]",
		when: "Show Bravo Goals slash-command help. Use a subcommand for details.",
		args: ["subcommand: optional command name, like init, start, next, or archive."],
	},
	{
		name: "init",
		usage: "/goal init [--workspace-root <path>]",
		when: "Create the .bravo workspace directories and config before any goals exist.",
		flags: ["--workspace-root <path>: workspace root to initialize. Defaults to the current Pi cwd."],
	},
	{
		name: "prep",
		usage: "/goal prep <goal-id> [--title <title>]",
		when: "Create a draft goal workspace and start an interactive prep conversation to define context and tasks.",
		args: ["goal-id: required slug for the new goal under .bravo/goals/."],
		flags: ["--title <title>: human-readable working title. The prep agent may refine it with you."],
	},
	{
		name: "start",
		usage: "/goal start <goal-id-or-path>",
		when: "Attach this Pi session to an existing goal and queue the active worker prompt.",
		args: ["goal-id-or-path: goal id under .bravo/goals/ or a path to a goal directory."],
	},
	{
		name: "list",
		usage: "/goal list",
		when: "List goals sorted by most recently modified first.",
	},
	{
		name: "status",
		usage: "/goal status [goal-id]",
		when: "Show the attached goal status, or an explicit goal status.",
		args: ["goal-id: optional goal id. Omit it to use the goal attached to this session."],
	},
	{
		name: "pause",
		usage: "/goal pause [goal-id] [--reason <text>]",
		when: "Write a controller resume snapshot, detach this session, and mark the goal paused.",
		args: ["goal-id: optional goal id. Omit it to use the attached goal."],
		flags: ["--reason <text>: stored as the pause reason in state.yaml and resume.md."],
	},
	{
		name: "resume",
		usage: "/goal resume <goal-id-or-path>",
		when: "Reattach this Pi session to a paused or active goal and queue the restart prompt.",
		args: ["goal-id-or-path: goal id under .bravo/goals/ or a path to a goal directory."],
	},
	{
		name: "checkpoint",
		usage: "/goal checkpoint [goal-id]",
		when: "Ask the worker to refresh resume.md with current durable context.",
		args: ["goal-id: optional goal id. Omit it to use the attached goal."],
	},
	{
		name: "check",
		usage: "/goal check [goal-id]",
		when: "Validate the attached goal, an explicit goal, or the workspace structure when no goal is attached.",
		args: ["goal-id: optional goal id. Omit it to check the attached goal or workspace."],
	},
	{
		name: "next",
		usage: "/goal next [goal-id] [--carry | --compact | --fresh]",
		when: "Continue after a passing Judge verdict using the selected phase boundary.",
		args: ["goal-id: optional goal id. Omit it to use the attached goal."],
		flags: [
			"--carry: continue in the same session.",
			"--compact: compact first, then queue continuation.",
			"--fresh: start a replacement Pi session.",
		],
	},
	{
		name: "compact",
		usage: "/goal compact [goal-id]",
		when: "Compact this session with Bravo goal context, without changing task state.",
		args: ["goal-id: optional goal id. Omit it to use the attached goal."],
	},
	{
		name: "verify",
		usage: "/goal verify <goal-id> [--note <text>]",
		when: "Record user verification after the final audit has passed.",
		args: ["goal-id: required goal id."],
		flags: ["--note <text>: optional verification note."],
	},
	{
		name: "archive",
		usage: "/goal archive <goal-id> [--force --reason <text>]",
		when: "Move a done, final-audited, user-verified goal to .bravo/archived/goals/.",
		args: ["goal-id: required goal id."],
		flags: [
			"--force: archive even when gates are not met; records forced archive state.",
			"--reason <text>: required in practice when forcing, and useful for audit context.",
		],
	},
];

const GOAL_COMMAND_NAMES = new Set(GOAL_COMMAND_HELP.map((command) => command.name));

function renderGoalHelp(commandName?: string): string {
	if (commandName) {
		const command = GOAL_COMMAND_HELP.find((candidate) => candidate.name === commandName);
		if (!command) {
			return `Unknown /goal command: ${commandName}\n\n${renderGoalHelp()}`;
		}
		return [
			renderUsage(command.usage),
			"",
			`${C.text}${command.when}${C.reset}`,
			command.args?.length ? ["", sectionTitle("Arguments"), ...command.args.map((arg) => `  ${renderHelpDetail(arg)}`)].join("\n") : null,
			command.flags?.length ? ["", sectionTitle("Flags"), ...command.flags.map((flag) => `  ${renderHelpDetail(flag)}`)].join("\n") : null,
		].filter((line): line is string => line !== null).join("\n");
	}
	return [
		`${C.bold}${C.gold}Bravo Goals commands${C.reset}`,
		"",
		...GOAL_COMMAND_HELP.map((command) => `  ${renderUsage(command.usage)}\n    ${C.text}${command.when}${C.reset}`),
		"",
		`${C.muted}Use ${renderUsage("/goal help <subcommand>")} ${C.muted}for arguments and flags.${C.reset}`,
	].join("\n");
}

function sectionTitle(label: string): string {
	return `${C.bold}${C.gold}${label}${C.reset}`;
}

function renderUsage(usage: string): string {
	const [base, subcommand, ...rest] = usage.split(" ");
	return [
		base === "/goal" ? `${C.bold}${C.cyan}${base}${C.reset}` : base,
		subcommand ? `${C.bold}${C.gold}${subcommand}${C.reset}` : null,
		...rest.map((part) => renderUsageToken(part)),
	].filter((part): part is string => part !== null).join(" ");
}

function renderUsageToken(part: string): string {
	if (part === "|") return `${C.muted}|${C.reset}`;
	const open = part.startsWith("[") ? `${C.muted}[${C.reset}` : "";
	const close = part.endsWith("]") ? `${C.muted}]${C.reset}` : "";
	const core = part.replace(/^\[/, "").replace(/\]$/, "");
	return `${open}${renderCoreToken(core)}${close}`;
}

function renderCoreToken(token: string): string {
	if (token.startsWith("--")) return `${C.amber}${token}${C.reset}`;
	if (token.startsWith("<") && token.endsWith(">")) return `${C.sky}${token}${C.reset}`;
	if (token.length > 0) return `${C.sky}${token}${C.reset}`;
	return "";
}

function renderHelpDetail(detail: string): string {
	return detail
		.replace(/^([^:]+):/, (_match, label: string) => `${renderUsageToken(label)}${C.muted}:${C.reset}`)
		.replace(/--[a-z-]+/g, (flag) => `${C.amber}${flag}${C.reset}`)
		.replace(/<[^>]+>/g, (arg) => `${C.sky}${arg}${C.reset}`);
}

function renderNotice(label: string, detail?: string): string {
	return `${C.bold}${C.gold}${label}${C.reset}${detail ? ` ${C.text}${detail}${C.reset}` : ""}`;
}

function renderSuccess(label: string, detail?: string): string {
	return `${C.bold}${C.ok}${label}${C.reset}${detail ? ` ${C.text}${detail}${C.reset}` : ""}`;
}

function renderGoalList(goals: Awaited<ReturnType<typeof listGoals>>): string {
	if (goals.length === 0) return renderNotice("No Bravo goals found.");
	return [
		`${C.bold}${C.gold}Bravo goals${C.reset}`,
		"",
		...goals.map((goal) => [
			`${C.muted}${goal.modified_at}${C.reset}`,
			`${C.bold}${C.sky}${goal.goal_id}${C.reset}`,
			`${C.text}${goal.status}${C.reset}`,
			`${C.gold}${goal.progress}${C.reset}`,
			`${C.muted}${goal.active_task ?? "-"}${C.reset}`,
			`${C.text}${goal.title}${C.reset}`,
		].join("\t")),
	].join("\n");
}

async function checkWorkspace(root: string): Promise<string[]> {
	const paths = bravoWorkspacePaths(root);
	const missing: string[] = [];
	for (const required of [paths.bravo, paths.goals, paths.archivedGoals, paths.runtime, paths.runs, paths.logs]) {
		if (!(await pathExists(required))) {
			missing.push(required);
		}
	}
	return missing;
}

async function notifyGoalCheck(ctx: ExtensionCommandContext, root: string, goal: GoalRecord): Promise<void> {
	const result = await checkGoal({ goalPath: goal.path });
	if (result.issues.length === 0) {
		ctx.ui.notify(renderSuccess("Bravo goal check passed", goal.id), "info");
		return;
	}
	const lines = [
		result.ok ? renderNotice("Bravo goal check passed with warnings", goal.id) : `${C.bold}${C.bad}Bravo goal check failed${C.reset} ${C.text}${goal.id}${C.reset}`,
		"",
		...result.issues.map((issue) => `${issue.severity === "error" ? C.bad : C.amber}${issue.severity}${C.reset}\t${C.gold}${issue.code}${C.reset}\t${C.sky}${issue.path ?? relPath(root, goal.path)}${C.reset}\t${C.text}${issue.message}${C.reset}`),
	];
	ctx.ui.notify(lines.join("\n"), result.ok ? "warning" : "error");
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

function activeTaskPrompt(goal: GoalRecord): string {
	return renderWorkerStartPrompt({ goalDir: goal.path, state: goal.state, cwd: process.cwd() });
}

function carryTaskPrompt(goal: GoalRecord, intro = "Continue in this same Pi session."): string {
	return renderCarryContinuationPrompt({ goalDir: goal.path, state: goal.state, cwd: process.cwd(), mode: "carry", intro });
}

function compactTaskPrompt(goal: GoalRecord, boundaryReason?: string | null): string {
	return renderHandoffContinuationPrompt({ goalDir: goal.path, state: goal.state, cwd: process.cwd(), mode: "compact", boundaryReason });
}

function freshHandoffPrompt(goal: GoalRecord, boundaryReason?: string | null): string {
	return renderHandoffContinuationPrompt({ goalDir: goal.path, state: goal.state, cwd: process.cwd(), mode: "fresh_session", boundaryReason });
}

function restartPrompt(goal: GoalRecord): string {
	return renderWorkerResumePrompt({ goalDir: goal.path, state: goal.state, cwd: process.cwd() });
}

function checkpointPrompt(goal: GoalRecord): string {
	return renderCheckpointPrompt({ goalDir: goal.path, state: goal.state, cwd: process.cwd() });
}

function prepPrompt(goal: { id: string; path: string; title: string }): string {
	const hasWorkingTitle = goal.title !== "TBD";
	const workingTitle = hasWorkingTitle ? `\nWorking title provided by the user: "${goal.title}". Treat it as a conversation hint, not as enough information to draft the goal.` : "\nNo working title was provided. The title must be derived during prep after talking with the user.";
	return `Prepare Bravo goal ${goal.id}.${workingTitle}

This is an interactive goal-definition flow, not active implementation.

The goal id is only a stable filesystem and tooling identifier. Do not infer the title, scope, success criteria, task queue, implementation plan, or affected systems from the id or working title alone.

First read these placeholder files:
1. ${relPath(process.cwd(), join(goal.path, "goal.md"))}
2. ${relPath(process.cwd(), join(goal.path, "context.md"))}
3. ${relPath(process.cwd(), join(goal.path, "state.yaml"))}

After reading them, stop and talk with the user right away. Ask what this goal is meant to accomplish, what context matters, and what done should look like. Do not write goal content or tasks until the user has supplied enough intent.

When enough user-provided intent exists, work with the user to clarify:
1. The problem and desired outcome.
2. Concrete success criteria and non-goals.
3. Relevant repos/files/commands/background context.
4. A small initial task queue with verifiable expected outputs.
5. The verification plan for each task and the final acceptance bar.

The interview is not complete until the user explicitly confirms that they are happy with the current goal definition and that you may write the durable goal files. Before writing any durable file, summarize the proposed goal definition, task queue, and verification plan, then ask for that confirmation. Do not treat inferred agreement, silence, or a partial answer as approval to write files.

Durable files to update:
1. ${relPath(process.cwd(), join(goal.path, "goal.md"))}
2. ${relPath(process.cwd(), join(goal.path, "context.md"))}
3. ${relPath(process.cwd(), join(goal.path, "state.yaml"))}

Do not edit goal.md, context.md, or state.yaml beyond reading placeholders until the explicit confirmation gate above is satisfied.

Do not create resume.md during prep. resume.md is created only by checkpoint or pause, when there is an actual stopping point to preserve.

Keep goal.status as draft while preparing. When the goal definition is ready, update state.yaml with the final title and worker tasks. Use status active for the first task, queued for later tasks, active_task set to the first task id, and progress.total_tasks matching the task count.

Use this exact task shape when editing state.yaml:

tasks:
  - id: "<short-task-slug>"
    title: "<human-readable task title>"
    kind: work
    status: active
    boundary_after_pass: inherit
    context_switch_severity: medium
    receipt: null
    judge_receipt: null
    verify:
      - "<command or evidence the Judge should check>"
    expected_output:
      - "<observable result of this task>"

After editing state.yaml, call validate_goal_state with goal_id: ${goal.id}. Fix any reported issues before you tell the user the goal is ready.

Do not start implementation. Do not write worker receipts. Do not call task_receipt_ready. When prep is complete, tell the user to run /goal start ${goal.id}.`;
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
	return [
		renderCompactInstructions(goal.state as unknown as GoalState),
		`Durable source of truth: ${relPath(process.cwd(), goal.path)}.`,
	].join("\n");
}

function boundaryFromFlags(flags: Map<string, string | boolean>): Exclude<BoundaryMode, "checkpoint_only"> {
	if (flags.has("fresh")) return "fresh_session";
	if (flags.has("compact")) return "compact";
	if (flags.has("carry")) return "carry";
	return normalizeBoundaryMode(typeof flags.get("boundary") === "string" ? flags.get("boundary") as string : null) ?? "carry";
}

async function queuePrompt(pi: ExtensionAPI, prompt: string): Promise<void> {
	pi.sendUserMessage(wrapBravoSystemMessage(prompt), { deliverAs: "followUp" });
}

async function freshSession(root: string, ctx: ExtensionCommandContext, goal: GoalRecord, boundaryReason?: string | null): Promise<void> {
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
			await replacement.sendUserMessage(wrapBravoSystemMessage(freshHandoffPrompt(goal, boundaryReason)), { deliverAs: "followUp" });
		},
	});
}

async function runBoundary(root: string, pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: GoalRecord, mode: BoundaryMode, boundaryReason?: string | null): Promise<"continued" | "replaced" | "none"> {
	if (mode === "checkpoint_only") return "none";
	if (mode === "fresh_session") {
		await freshSession(root, ctx, goal, boundaryReason);
		return "replaced";
	}
	if (mode === "compact") {
		ctx.compact({
			customInstructions: compactInstructions(goal),
			onComplete: () => queuePrompt(pi, compactTaskPrompt(goal, boundaryReason)),
		});
		return "continued";
	}
	await queuePrompt(pi, carryTaskPrompt(goal));
	return "continued";
}

async function handleGoal(pi: ExtensionAPI, runtime: CommandRuntime, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseArgs(args);
	const [subcommand = "status", goalArg] = parsed.positional;

	if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		ctx.ui.notify(renderGoalHelp(goalArg), "info");
		return;
	}

	if (!GOAL_COMMAND_NAMES.has(subcommand)) {
		ctx.ui.notify(renderGoalHelp(subcommand), "error");
		return;
	}

	if (subcommand === "init") {
		const explicitRoot = typeof parsed.flags.get("workspace-root") === "string" ? parsed.flags.get("workspace-root") as string : null;
		const paths = await initBravoWorkspace({ root: explicitRoot ?? ctx.cwd });
		ctx.ui.notify(renderSuccess("Initialized Bravo workspace", paths.bravo), "info");
		await runtime.refresh(ctx);
		return;
	}

	const root = await discoverWorkspaceRoot(ctx.cwd);
	if (!root) throw new Error("No Bravo workspace found. Run /goal init at the workspace root first.");
	const sessionId = sessionIdOf(ctx);

	if (subcommand === "list") {
		ctx.ui.notify(renderGoalList(await listGoals(root)), "info");
		await runtime.refresh(ctx);
		return;
	}

	if (subcommand === "prep") {
		if (!goalArg) throw new Error("usage: /goal prep <goal-id> [--title <title>]");
		const result = await scaffoldGoalWorkspace({
			workspaceRoot: root,
			goalId: goalArg,
			title: typeof parsed.flags.get("title") === "string" ? parsed.flags.get("title") as string : undefined,
		});
		ctx.ui.notify(renderSuccess("Prepared Bravo goal", relPath(root, result.goalPath)), "info");
		await runtime.refresh(ctx);
		await queuePrompt(pi, prepPrompt({
			id: result.state.goal.id,
			title: result.state.goal.title,
			path: result.goalPath,
		}));
		return;
	}

	if (subcommand === "status") {
		const goal = await resolveGoal(root, goalArg, sessionId);
		if (!goal) {
			ctx.ui.notify(renderNotice("No Bravo goal is attached to this session."), "info");
			clearHud(ctx);
			return;
		}
		ctx.ui.notify(renderNotice(goal.state.goal.title, goal.state.goal.status), "info");
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
		await createDefaultGoalPolicy({
			workspaceRoot: root,
			goalId: goal.id,
			activeTaskId: goal.state.active_task,
			mode: "worker",
		});
		await runtime.refresh(ctx);
		await queuePrompt(pi, subcommand === "resume" ? restartPrompt(goal) : activeTaskPrompt(goal));
		return;
	}

	if (subcommand === "check") {
		const goal = await resolveGoal(root, goalArg, sessionId);
		if (goal) {
			await notifyGoalCheck(ctx, root, goal);
			await runtime.refresh(ctx);
			return;
		}
		const missing = await checkWorkspace(root);
		if (missing.length === 0) {
			ctx.ui.notify(renderSuccess("Bravo workspace check passed", root), "info");
			return;
		}
		ctx.ui.notify([
			`${C.bold}${C.bad}Bravo workspace check failed${C.reset} ${C.text}${root}${C.reset}`,
			"",
			...missing.map((path) => `${C.bad}error${C.reset}\t${C.gold}workspace.missing_path${C.reset}\t${C.sky}${path}${C.reset}\t${C.text}required workspace path is missing${C.reset}`),
		].join("\n"), "error");
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
		const contextUsagePercent = override ? null : (ctx.getContextUsage()?.percent ?? null);
		const selection = selectNextBoundary(fullState, completedTask, { override, contextUsagePercent });
		const updated = markBoundaryApplied(fullState, selection);
		await writeYaml(join(goal.path, "state.yaml"), updated);
		const boundaryGoal = { ...goal, state: updated as unknown as GoalStateView };
		const outcome = await runBoundary(root, pi, ctx, boundaryGoal, selection.mode, selection.reason);
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
		ctx.ui.notify(renderSuccess("Verified Bravo goal", goal.id), "info");
		return;
	}

	if (subcommand === "archive") {
		const archiveState = await readYaml(join(goal.path, "state.yaml")) as GoalState;
		const attachedSessionId = archiveState.session?.attached_pi_session_id ?? null;
		if (attachedSessionId && sessionId && attachedSessionId === sessionId) {
			await updateGoalState(goal.path, (state) => {
				const sessionState = state.session as Record<string, unknown> | undefined;
				if (sessionState) sessionState.attached_pi_session_id = null;
			});
			await detachActiveGoal(root, goal.id, sessionId);
		}
		const result = await archiveGoal(root, goal.path, {
			force: parsed.flags.has("force"),
			reason: typeof parsed.flags.get("reason") === "string" ? parsed.flags.get("reason") as string : null,
		});
		clearHud(ctx);
		ctx.ui.notify(renderSuccess("Archived Bravo goal", `${goal.id} -> ${relPath(root, result.archivedPath)}`), "info");
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
	renderGoalHelp,
	handleGoal,
	activeTaskPrompt,
	restartPrompt,
	checkpointPrompt,
};
