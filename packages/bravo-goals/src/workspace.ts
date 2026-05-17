import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { atomicWriteFile, ensureDir } from "./fs.js";
import { createGoalState, saveGoalState } from "./state.js";
import type { GoalState, GoalTask, WorkspacePaths } from "./types.js";

export interface InitWorkspaceOptions {
	root: string;
	force?: boolean;
}

export interface GoalScaffoldOptions {
	workspaceRoot: string;
	goalId: string;
	title?: string;
	repos?: GoalState["repos"];
	tasks?: Array<Partial<GoalTask> & Pick<GoalTask, "id" | "title">>;
	overwrite?: boolean;
	now?: string;
}

export interface ScaffoldGoalOptions extends GoalScaffoldOptions {}

export interface ScaffoldedGoal {
	workspace: WorkspacePaths;
	goalPath: string;
	state: GoalState;
}

const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/templates");
const SOURCE_TEMPLATE_DIR = resolve(process.cwd(), "packages/bravo-goals/docs/templates");
const DEFAULT_TEMPLATES: Record<string, string> = {
	"goal.md": "# Goal: {{title}}\n\n## Problem\n\nTBD.\n\n## Desired Outcome\n\nTBD.\n\n## Success Criteria\n\n- TBD.\n\n## Non-goals\n\n- TBD.\n\n## Verification Plan\n\n- TBD.\n\n## Final Acceptance\n\nTBD.\n\n## Risks and Constraints\n\n- TBD.\n",
	"context.md": "# Context\n\n## Workspace\n\nGoal id: `{{goal_id}}`\n\n## Repositories\n\n- TBD.\n\n## Read First\n\n- `goal.md`\n- `state.yaml`\n- `resume.md`\n\n## Commands\n\n- TBD.\n\n## Background\n\nTBD.\n\n## Known Constraints\n\n- TBD.\n\n## Gotchas\n\n- TBD.\n",
	"resume.md": "# Resume: {{title}}\n\nNo checkpoint yet.\n\n## Read First\n\n1. `goal.md`\n2. `context.md`\n3. `state.yaml`\n4. `resume.md`\n\n## Next Action\n\nContinue from `active_task` in `state.yaml`.\n",
};

export function bravoWorkspacePaths(root: string): WorkspacePaths {
	const resolvedRoot = resolve(root);
	const bravo = join(resolvedRoot, ".bravo");
	return {
		root: resolvedRoot,
		bravo,
		goals: join(bravo, "goals"),
		archivedGoals: join(bravo, "archived", "goals"),
		runtime: join(bravo, "runtime"),
		runs: join(bravo, "runs"),
		logs: join(bravo, "logs"),
	};
}

export function workspacePaths(root: string): WorkspacePaths {
	return bravoWorkspacePaths(root);
}

export async function discoverWorkspaceRoot(start = process.cwd()): Promise<string | null> {
	let current = resolve(start);
	for (;;) {
		if (await exists(join(current, ".bravo", "config.yaml"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

export async function findWorkspaceRoot(start = process.cwd()): Promise<string | null> {
	return discoverWorkspaceRoot(start);
}

export async function initBravoWorkspace(options: InitWorkspaceOptions): Promise<WorkspacePaths> {
	const paths = bravoWorkspacePaths(options.root);
	if (!options.force && await exists(join(paths.bravo, "config.yaml"))) {
		return paths;
	}
	await Promise.all([
		ensureDir(paths.goals),
		ensureDir(paths.archivedGoals),
		ensureDir(paths.runtime),
		ensureDir(paths.runs),
		ensureDir(paths.logs),
	]);
	const config = {
		schema_version: 1,
		workspace_root: paths.root,
	};
	await atomicWriteFile(join(paths.bravo, "config.yaml"), YAML.stringify(config, { lineWidth: 0 }));
	return paths;
}

export async function initWorkspace(options: string | InitWorkspaceOptions): Promise<WorkspacePaths> {
	return typeof options === "string" ? initBravoWorkspace({ root: options }) : initBravoWorkspace(options);
}

export async function requireDiscoveredWorkspaceRoot(start = process.cwd()): Promise<string> {
	const root = await discoverWorkspaceRoot(start);
	if (root === null) {
		throw new Error("No Bravo workspace found. Initialize explicitly with a workspace root before creating goals.");
	}
	return root;
}

export async function requireWorkspaceRoot(explicitRoot?: string): Promise<string> {
	if (explicitRoot) {
		const root = resolve(explicitRoot);
		if (!await exists(join(root, ".bravo", "config.yaml"))) {
			throw new Error(`workspace not initialized at ${root}`);
		}
		return root;
	}
	return requireDiscoveredWorkspaceRoot();
}

export function resolveGoalWorkspacePath(workspaceRoot: string, goalIdOrPath: string): string {
	if (isAbsolute(goalIdOrPath) || goalIdOrPath.includes("/") || goalIdOrPath.includes("\\")) {
		return resolve(workspaceRoot, goalIdOrPath);
	}
	return join(bravoWorkspacePaths(workspaceRoot).goals, goalIdOrPath);
}

export function resolveGoalPath(workspaceRoot: string, goalIdOrPath: string): string {
	return resolveGoalWorkspacePath(workspaceRoot, goalIdOrPath);
}

export async function scaffoldGoalWorkspace(options: GoalScaffoldOptions): Promise<ScaffoldedGoal> {
	const workspace = await initBravoWorkspace({ root: options.workspaceRoot });
	const goalId = validateGoalId(options.goalId);
	const title = options.title ?? titleFromId(goalId);
	const goalPath = join(workspace.goals, goalId);
	if (!options.overwrite && await exists(goalPath)) {
		throw new Error(`Goal already exists: ${goalId}`);
	}
	await Promise.all([
		ensureDir(goalPath),
		ensureDir(join(goalPath, "receipts")),
		ensureDir(join(goalPath, "artifacts")),
	]);
	const state = createGoalState({
		id: goalId,
		title,
		repos: options.repos,
		tasks: options.tasks,
		now: options.now,
	});
	await Promise.all([
		writeTemplate(join(goalPath, "goal.md"), "goal.md", { goalId, title }, options.overwrite),
		writeTemplate(join(goalPath, "context.md"), "context.md", { goalId, title }, options.overwrite),
		writeTemplate(join(goalPath, "resume.md"), "resume.md", { goalId, title }, options.overwrite),
	]);
	await saveGoalState(join(goalPath, "state.yaml"), state);
	return { workspace, goalPath, state };
}

export async function scaffoldGoal(options: ScaffoldGoalOptions): Promise<ScaffoldedGoal> {
	return scaffoldGoalWorkspace(options);
}

export async function readWorkspaceConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
	const data = await readFile(join(bravoWorkspacePaths(workspaceRoot).bravo, "config.yaml"), "utf8");
	const parsed = YAML.parse(data);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Bravo workspace config must be a YAML mapping.");
	}
	return parsed as Record<string, unknown>;
}

function validateGoalId(goalId: string): string {
	if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(goalId)) {
		throw new Error(`Invalid goal id: ${goalId}`);
	}
	return goalId;
}

function titleFromId(goalId: string): string {
	return goalId.split("-").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

async function writeTemplate(path: string, templateName: string, values: Record<string, string>, overwrite = false): Promise<void> {
	if (!overwrite && await exists(path)) {
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	const template = await readTemplate(templateName);
	await writeFile(path, renderTemplate(template, values));
}

async function readTemplate(templateName: string): Promise<string> {
	for (const dir of [TEMPLATE_DIR, SOURCE_TEMPLATE_DIR]) {
		try {
			return await readFile(join(dir, templateName), "utf8");
		} catch {
			// Try the next known location; dist builds do not copy docs/templates.
		}
	}
	const fallback = DEFAULT_TEMPLATES[templateName];
	if (fallback === undefined) {
		throw new Error(`Unknown template: ${templateName}`);
	}
	return fallback;
}

function renderTemplate(template: string, values: Record<string, string>): string {
	return template.replaceAll("{{goal_id}}", values.goalId).replaceAll("{{title}}", values.title);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function goalIdFromPath(path: string): string {
	return basename(resolve(path));
}
