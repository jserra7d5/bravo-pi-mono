import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { CheckIssue, GoalState } from "./types.js";
import { nowIso } from "./fs.js";
import { checkGoal } from "./checker.js";
import {
	exists,
	readGoalState,
	removeActiveGoal,
	recomputeProgress,
	writeGoalState,
} from "./runtime.js";
import { bravoWorkspacePaths } from "./workspace.js";

export interface ArchiveOptions {
	force?: boolean;
	reason?: string | null;
	now?: string;
}

export interface ArchiveResult {
	archivedPath: string;
	forced: boolean;
	issues: CheckIssue[];
}

export async function archiveGoal(
	workspaceRoot: string,
	goalDir: string,
	options: ArchiveOptions = {},
): Promise<ArchiveResult> {
	const force = options.force ?? false;
	const state = recomputeProgress(await readGoalState(goalDir));
	const issues = [
		...validateArchiveReady(state),
		...((await checkGoal({ goalPath: goalDir })).issues.filter((issue) => issue.severity === "error")),
	];
	if (issues.length > 0 && !force) {
		throw new Error(`archive refused: ${issues.map((issue) => issue.message).join("; ")}`);
	}
	if (force && !options.reason) {
		throw new Error("forced archive requires --reason");
	}

	const archivedAt = options.now ?? nowIso();
	const paths = bravoWorkspacePaths(workspaceRoot);
	await mkdir(paths.archivedGoals, { recursive: true });
	const archivedPath = await nextArchivePath(paths.archivedGoals, archivedAt.slice(0, 10), state.goal.id);
	const relativeArchivedPath = relative(workspaceRoot, archivedPath);
	const nextState: GoalState = {
		...state,
		goal: {
			...state.goal,
			status: "archived",
			updated_at: archivedAt,
		},
		session: {
			...state.session,
			attached_pi_session_id: null,
		},
		archive: {
			archived_at: archivedAt,
			archived_path: relativeArchivedPath,
			forced: force,
			reason: options.reason ?? null,
		},
	};
	await writeGoalState(goalDir, nextState);
	await writeFile(join(goalDir, "archive.md"), renderArchiveMarkdown(state, archivedAt, relative(workspaceRoot, goalDir), force));
	await rename(goalDir, archivedPath);
	await removeActiveGoal(workspaceRoot, state.goal.id);
	return { archivedPath, forced: force, issues };
}

export function validateArchiveReady(state: GoalState): CheckIssue[] {
	const issues: CheckIssue[] = [];
	if (state.goal.status !== "done") {
		issues.push({ severity: "error", code: "archive.goal_not_done", message: "goal status must be done" });
	}
	if (state.final_audit.status !== "passed") {
		issues.push({ severity: "error", code: "archive.final_audit_not_passed", message: "final audit must be passed" });
	}
	if (state.user_verification.status !== "verified") {
		issues.push({ severity: "error", code: "archive.user_not_verified", message: "user verification is required" });
	}
	if (state.session.attached_pi_session_id) {
		issues.push({ severity: "error", code: "archive.session_attached", message: "active Pi session must be detached" });
	}
	return issues;
}

function renderArchiveMarkdown(state: GoalState, archivedAt: string, originalPath: string, forced: boolean): string {
	return [
		`# Archived Goal: ${state.goal.title}`,
		"",
		`Archived: ${archivedAt}`,
		`Original path: ${originalPath}`,
		`Final status: ${state.goal.status}`,
		`Final audit: ${state.final_audit.receipt ?? "none"}`,
		`User verified: ${state.user_verification.status === "verified" ? "yes" : "no"}`,
		`Forced: ${forced ? "yes" : "no"}`,
		"",
		"## Outcome",
		"",
		"## Key Receipts",
		"",
	].join("\n");
}

async function nextArchivePath(root: string, date: string, goalId: string): Promise<string> {
	const base = `${date}-${basename(goalId)}`;
	let candidate = join(root, base);
	let suffix = 2;
	while (await exists(candidate)) {
		candidate = join(root, `${base}-${suffix}`);
		suffix += 1;
	}
	return candidate;
}
