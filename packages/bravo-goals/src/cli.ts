#!/usr/bin/env node
import { join, relative, resolve } from "node:path";
import type { CheckIssue, CheckResult, GoalState } from "./types.js";
import { archiveGoal } from "./archive.js";
import { checkGoal as checkGoalWorkspace } from "./checker.js";
import { markBoundaryApplied, normalizeBoundaryMode, renderCompactInstructions, selectNextBoundary } from "./phase-boundary.js";
import {
	exists,
	listGoals,
	readGoalState,
	recordUserVerification,
	recoverActiveGoalsIndex,
	resolveGoalDir,
	writeGoalState,
} from "./runtime.js";
import {
	bravoWorkspacePaths,
	initBravoWorkspace,
	requireDiscoveredWorkspaceRoot,
	scaffoldGoalWorkspace,
} from "./workspace.js";

interface ParsedArgs {
	command: string | null;
	positionals: string[];
	flags: Map<string, string | boolean>;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const args = parseArgs(argv);
	try {
		switch (args.command) {
			case "init":
				return await cmdInit(args);
			case "prep":
				return await cmdPrep(args);
			case "status":
				return await cmdStatus(args);
			case "list":
				return await cmdList(args);
			case "check":
				return await cmdCheck(args);
			case "verify":
				return await cmdVerify(args);
			case "archive":
				return await cmdArchive(args);
			case "next":
				return await cmdNext(args);
			case null:
			case "help":
			case "--help":
			case "-h":
				printHelp();
				return 0;
			default:
				throw new Error(`unknown command: ${args.command}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function cmdInit(args: ParsedArgs): Promise<number> {
	const root = String(flag(args, "workspace-root") ?? process.cwd());
	const paths = await initBravoWorkspace({ root });
	console.log(`initialized ${paths.bravo}`);
	return 0;
}

async function cmdPrep(args: ParsedArgs): Promise<number> {
	const goalId = args.positionals[0];
	if (!goalId) throw new Error("usage: bravo-goals prep <goal-id> [--workspace-root <path>] [--title <title>]");
	const explicitRoot = stringFlag(args, "workspace-root");
	const root = explicitRoot ? resolve(explicitRoot) : await requireDiscoveredWorkspaceRoot();
	const result = await scaffoldGoalWorkspace({
		goalId,
		title: stringFlag(args, "title"),
		workspaceRoot: root,
	});
	console.log(`prepared ${relative(root, result.goalPath)}`);
	return 0;
}

async function cmdList(args: ParsedArgs): Promise<number> {
	const root = await workspaceRootFromArgs(args);
	const goals = await listGoals(root);
	if (goals.length === 0) {
		console.log("no goals");
		return 0;
	}
	for (const goal of goals) {
		console.log(`${goal.modified_at}\t${goal.goal_id}\t${goal.status}\t${goal.progress}\t${goal.active_task ?? "-"}\t${goal.path}\t${goal.title}`);
	}
	return 0;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
	const root = await workspaceRootFromArgs(args);
	const goalArg = args.positionals[0];
	if (!goalArg) {
		const index = await recoverActiveGoalsIndex(root);
		if (index.active_goals.length === 0) {
			console.log("no active goals");
			return 0;
		}
		for (const entry of index.active_goals) {
			console.log(`${entry.goal_id}\t${entry.status}\t${entry.active_task ?? "-"}\t${entry.path}`);
		}
		return 0;
	}
	const goalDir = await resolveGoalDir(root, goalArg);
	const state = await readGoalState(goalDir);
	printGoalStatus(state);
	return 0;
}

async function cmdCheck(args: ParsedArgs): Promise<number> {
	const root = await workspaceRootFromArgs(args);
	const goalArg = args.positionals[0];
	const result = goalArg ? await checkGoalWorkspace({ goalPath: await resolveGoalDir(root, goalArg) }) : await checkWorkspace(root);
	if (result.issues.length === 0) {
		console.log("ok");
		return 0;
	}
	for (const issue of result.issues) {
		console.log(`${issue.severity}\t${issue.code}\t${issue.path ?? "-"}\t${issue.message}`);
	}
	return result.ok ? 0 : 1;
}

async function cmdVerify(args: ParsedArgs): Promise<number> {
	const goalArg = args.positionals[0];
	if (!goalArg) throw new Error("usage: bravo-goals verify <goal-id> [--note <note>]");
	const root = await workspaceRootFromArgs(args);
	const goalDir = await resolveGoalDir(root, goalArg);
	const state = await recordUserVerification(goalDir, { note: stringFlag(args, "note") });
	console.log(`verified ${state.goal.id}`);
	return 0;
}

async function cmdArchive(args: ParsedArgs): Promise<number> {
	const goalArg = args.positionals[0];
	if (!goalArg) throw new Error("usage: bravo-goals archive <goal-id> [--force --reason <reason>]");
	const root = await workspaceRootFromArgs(args);
	const goalDir = await resolveGoalDir(root, goalArg);
	const result = await archiveGoal(root, goalDir, {
		force: Boolean(flag(args, "force")),
		reason: stringFlag(args, "reason"),
	});
	console.log(`archived ${relative(root, result.archivedPath)}`);
	if (result.forced && result.issues.length > 0) {
		console.log(`forced with ${result.issues.length} unmet archive requirement(s)`);
	}
	return 0;
}

async function cmdNext(args: ParsedArgs): Promise<number> {
	const goalArg = args.positionals[0];
	if (!goalArg) throw new Error("usage: bravo-goals next <goal-id> [--carry | --compact | --fresh]");
	const root = await workspaceRootFromArgs(args);
	const goalDir = await resolveGoalDir(root, goalArg);
	const state = await readGoalState(goalDir);
	const override = boundaryOverride(args);
	if (override && !state.phase_boundary.experimental_flags.allow_runtime_override) {
		throw new Error("runtime boundary override is disabled for this goal");
	}
	if (state.judge.last_verdict !== "pass") {
		throw new Error("next boundary requires the last Judge verdict to be pass");
	}
	const task = state.tasks.find((candidate) => candidate.judge_receipt && candidate.judge_receipt === state.judge.last_receipt) ?? null;
	if (!task) {
		throw new Error("next boundary requires judge.last_receipt to match a completed task Judge receipt");
	}
	const selection = selectNextBoundary(state, task, { override });
	const next = markBoundaryApplied(state, selection);
	await writeGoalState(goalDir, next);
	console.log(`${selection.mode}\t${selection.message}`);
	if (selection.mode === "compact") {
		console.log(renderCompactInstructions(next));
	}
	return 0;
}

export async function checkWorkspace(workspaceRoot: string): Promise<CheckResult> {
	const issues: CheckIssue[] = [];
	const paths = bravoWorkspacePaths(workspaceRoot);
	for (const required of [paths.bravo, paths.goals, paths.archivedGoals, paths.runtime, paths.runs, paths.logs]) {
		if (!(await exists(required))) {
			issues.push({ severity: "error", code: "workspace.missing_path", path: required, message: "required workspace path is missing" });
		}
	}
	return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

function parseArgs(argv: string[]): ParsedArgs {
	const [commandRaw, ...rest] = argv;
	const flags = new Map<string, string | boolean>();
	const positionals: string[] = [];
	for (let index = 0; index < rest.length; index += 1) {
		const item = rest[index];
		if (item?.startsWith("--")) {
			const eq = item.indexOf("=");
			if (eq >= 0) {
				flags.set(item.slice(2, eq), item.slice(eq + 1));
				continue;
			}
			const key = item.slice(2);
			const next = rest[index + 1];
			if (next && !next.startsWith("--")) {
				flags.set(key, next);
				index += 1;
			} else {
				flags.set(key, true);
			}
			continue;
		}
		positionals.push(item);
	}
	return { command: commandRaw ?? null, positionals, flags };
}

function flag(args: ParsedArgs, name: string): string | boolean | undefined {
	return args.flags.get(name);
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
	const value = flag(args, name);
	return typeof value === "string" ? value : undefined;
}

function boundaryOverride(args: ParsedArgs): "carry" | "compact" | "fresh_session" | null {
	if (flag(args, "carry")) return "carry";
	if (flag(args, "compact")) return "compact";
	if (flag(args, "fresh")) return "fresh_session";
	return normalizeBoundaryMode(stringFlag(args, "boundary"));
}

async function workspaceRootFromArgs(args: ParsedArgs): Promise<string> {
	const explicit = stringFlag(args, "workspace-root");
	if (explicit) {
		const root = resolve(explicit);
		if (!(await exists(join(root, ".bravo", "config.yaml")))) {
			throw new Error(`workspace not initialized at ${root}`);
		}
		return root;
	}
	return requireDiscoveredWorkspaceRoot();
}

function printGoalStatus(state: GoalState): void {
	const task = state.tasks.find((candidate) => candidate.id === state.active_task);
	console.log(`goal\t${state.goal.id}`);
	console.log(`status\t${state.goal.status}`);
	console.log(`task\t${task ? `${task.id} (${task.status})` : "-"}`);
	console.log(`progress\t${state.progress.completed_tasks}/${state.progress.total_tasks}`);
	console.log(`judge\t${state.judge.last_verdict}`);
	console.log(`final_audit\t${state.final_audit.status}`);
	console.log(`verified\t${state.user_verification.status}`);
}

function printHelp(): void {
	console.log([
		"usage: bravo-goals <command>",
		"",
		"commands:",
		"  init [--workspace-root <path>]",
		"  prep <goal-id> [--workspace-root <path>] [--title <title>]",
		"  list [--workspace-root <path>]",
		"  status [goal-id]",
		"  check [goal-id]",
		"  verify <goal-id> [--note <note>]",
		"  archive <goal-id> [--force --reason <reason>]",
		"  next <goal-id> [--carry | --compact | --fresh]",
	].join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = await main();
}
