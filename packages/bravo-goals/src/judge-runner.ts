import { readFile, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile, ensureDir, nowIso } from "./fs.js";

export type JudgeRunStatus = "created" | "running" | "succeeded" | "failed" | "blocked" | "timed_out" | "cancelled";
export type TerminalJudgeRunStatus = Exclude<JudgeRunStatus, "created" | "running">;
export type JudgeContractVerdict = "pass" | "fail" | "needs_more_evidence" | "blocked";
export type JudgeCommandPolicyMode = "judge_bash" | "raw_bash";

export const terminalJudgeRunStatuses = new Set<JudgeRunStatus>([
	"succeeded",
	"failed",
	"blocked",
	"timed_out",
	"cancelled"
]);

export interface JudgeCommandPolicy {
	mode: JudgeCommandPolicyMode;
	unsafe_raw_bash: boolean;
}

export interface JudgeHelperPolicy {
	enabled: boolean;
	max_helpers: number;
}

export interface JudgeRunConfig {
	schema_version: 1;
	run_id: string;
	goal_id: string;
	goal_path: string;
	task_id: string;
	final_audit: boolean;
	worker_receipt_path: string | null;
	judge_receipt_path: string;
	workspace_root: string;
	cwd: string;
	allowed_scope: string[];
	allowed_tools: string[];
	verification_commands: string[];
	timeout_ms: number;
	helper_policy: JudgeHelperPolicy;
	command_policy: JudgeCommandPolicy;
	created_at: string;
}

export interface JudgeRunStatusFile {
	schema_version: 1;
	run_id: string;
	status: JudgeRunStatus;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	finished_at: string | null;
}

export interface JudgeVerdictFile {
	schema_version: 1;
	run_id: string;
	goal_id: string;
	task_id: string;
	final_audit: boolean;
	verdict: JudgeContractVerdict;
	receipt_path: string;
	evidence_checked: unknown[];
	commands_run: unknown[];
	inspection_helpers: unknown[];
	missing_or_weak_evidence: unknown[];
	recommendation: string;
	follow_up_tasks?: Array<{
		id?: string;
		title: string;
		verify?: string[];
		expected_output?: string[];
		context_switch_severity?: "low" | "medium" | "high";
	}>;
	created_at: string;
}

export interface CreateJudgeRunOptions {
	workspaceRoot: string;
	goalId: string;
	taskId: string;
	finalAudit?: boolean;
	workerReceiptPath?: string | null;
	judgeReceiptPath: string;
	cwd?: string;
	allowedScope?: string[];
	allowedTools?: string[];
	verificationCommands?: string[];
	timeoutMs?: number;
	helperPolicy?: JudgeHelperPolicy;
	commandPolicy?: Partial<JudgeCommandPolicy>;
	promptSystem?: string;
	promptTask?: string;
	runId?: string;
	createdAt?: string;
}

export interface JudgeRunHandle {
	runId: string;
	runDir: string;
	runPath: string;
	statusPath: string;
	eventsPath: string;
	verdictPath: string;
	receiptLinkPath: string;
	goalJudgeCurrentPath: string;
	goalJudgeRunPath: string;
	config: JudgeRunConfig;
	status: JudgeRunStatusFile;
}

export interface JudgeValidationResult {
	ok: boolean;
	issues: string[];
	run: JudgeRunConfig | null;
	status: JudgeRunStatusFile | null;
	verdict: JudgeVerdictFile | null;
	receiptFrontmatter: Record<string, unknown> | null;
}

export function normalizeJudgeRunId(runId: string): string {
	return runId.startsWith("judge_") ? runId : `judge_${runId}`;
}

export function defaultJudgeCommandPolicy(policy: Partial<JudgeCommandPolicy> = {}): JudgeCommandPolicy {
	return {
		mode: policy.mode ?? "judge_bash",
		unsafe_raw_bash: policy.unsafe_raw_bash ?? false
	};
}

export function defaultJudgeAllowedTools(commandPolicy: JudgeCommandPolicy): string[] {
	const tools = ["read", "grep", "ls", "judge_bash", "judge_finish"];
	if (commandPolicy.mode === "raw_bash") {
		tools.push("bash");
	}
	return tools;
}

export function validateJudgeCommandPolicy(commandPolicy: JudgeCommandPolicy, allowedTools: string[]): void {
	if (commandPolicy.mode === "raw_bash" && !commandPolicy.unsafe_raw_bash) {
		throw new Error("raw Judge bash requires command_policy.unsafe_raw_bash: true");
	}
	if (allowedTools.includes("bash") && !commandPolicy.unsafe_raw_bash) {
		throw new Error("raw Pi bash is only allowed when command_policy.unsafe_raw_bash is true");
	}
	if (commandPolicy.mode === "judge_bash" && !allowedTools.includes("judge_bash")) {
		throw new Error("judge_bash command policy requires allowed_tools to include judge_bash");
	}
}

export async function createJudgeRun(options: CreateJudgeRunOptions): Promise<JudgeRunHandle> {
	const createdAt = options.createdAt ?? nowIso();
	const runId = normalizeJudgeRunId(options.runId ?? `${Date.now().toString(36)}_${process.pid.toString(36)}`);
	const commandPolicy = defaultJudgeCommandPolicy(options.commandPolicy);
	const allowedTools = options.allowedTools ?? defaultJudgeAllowedTools(commandPolicy);
	validateJudgeCommandPolicy(commandPolicy, allowedTools);

	const bravoRoot = join(options.workspaceRoot, ".bravo");
	const runDir = join(bravoRoot, "runs", runId);
	const goalPath = `.bravo/goals/${options.goalId}`;
	const goalJudgeDir = join(bravoRoot, "goals", options.goalId, "judge");
	const config: JudgeRunConfig = {
		schema_version: 1,
		run_id: runId,
		goal_id: options.goalId,
		goal_path: goalPath,
		task_id: options.taskId,
		final_audit: options.finalAudit ?? false,
		worker_receipt_path: options.workerReceiptPath ?? null,
		judge_receipt_path: options.judgeReceiptPath,
		workspace_root: options.workspaceRoot,
		cwd: options.cwd ?? options.workspaceRoot,
		allowed_scope: options.allowedScope ?? [],
		allowed_tools: allowedTools,
		verification_commands: options.verificationCommands ?? [],
		timeout_ms: options.timeoutMs ?? 900000,
		helper_policy: options.helperPolicy ?? { enabled: false, max_helpers: 0 },
		command_policy: commandPolicy,
		created_at: createdAt
	};
	const status: JudgeRunStatusFile = {
		schema_version: 1,
		run_id: runId,
		status: "created",
		created_at: createdAt,
		updated_at: createdAt,
		started_at: null,
		finished_at: null
	};

	await Promise.all([
		ensureDir(join(runDir, "prompt")),
		ensureDir(join(runDir, "pi-session")),
		ensureDir(join(runDir, "home", ".pi", "agent")),
		ensureDir(join(runDir, "logs")),
		ensureDir(join(runDir, "artifacts")),
		ensureDir(join(goalJudgeDir, "runs"))
	]);

	const runPath = join(runDir, "run.json");
	const statusPath = join(runDir, "status.json");
	const eventsPath = join(runDir, "events.jsonl");
	await Promise.all([
		atomicWriteJson(runPath, config),
		atomicWriteJson(statusPath, status),
		atomicWriteFile(eventsPath, `${JSON.stringify({ type: "judge.created", run_id: runId, at: createdAt })}\n`),
		atomicWriteFile(join(runDir, "prompt", "system.md"), options.promptSystem ?? defaultJudgeSystemPrompt(config)),
		atomicWriteFile(join(runDir, "prompt", "task.md"), options.promptTask ?? defaultJudgeTaskPrompt(config)),
		atomicWriteFile(join(runDir, "pi-session", "session.jsonl"), ""),
		writeJudgePointers(config, status)
	]);

	return {
		runId,
		runDir,
		runPath,
		statusPath,
		eventsPath,
		verdictPath: join(runDir, "verdict.json"),
		receiptLinkPath: join(runDir, "receipt.md"),
		goalJudgeCurrentPath: join(goalJudgeDir, "current.json"),
		goalJudgeRunPath: join(goalJudgeDir, "runs", `${runId}.json`),
		config,
		status
	};
}

export async function updateJudgeRunStatus(
	runDir: string,
	status: JudgeRunStatus,
	options: { at?: string; eventType?: string } = {}
): Promise<JudgeRunStatusFile> {
	const at = options.at ?? nowIso();
	const statusPath = join(runDir, "status.json");
	const current = JSON.parse(await readFile(statusPath, "utf8")) as JudgeRunStatusFile;
	const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as JudgeRunConfig;
	const next: JudgeRunStatusFile = {
		...current,
		status,
		updated_at: at,
		started_at: status === "running" && current.started_at === null ? at : current.started_at,
		finished_at: terminalJudgeRunStatuses.has(status) ? at : current.finished_at
	};
	await atomicWriteJson(statusPath, next);
	await writeJudgePointers(run, next);
	await appendJudgeEvent(runDir, {
		type: options.eventType ?? `judge.${status}`,
		run_id: current.run_id,
		status,
		at
	});
	return next;
}

export async function writeJudgeVerdict(runDir: string, verdict: JudgeVerdictFile, receiptMarkdown: string): Promise<void> {
	validateJudgeVerdictShape(verdict);
	const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as JudgeRunConfig;
	if (verdict.run_id !== run.run_id || verdict.goal_id !== run.goal_id || verdict.task_id !== run.task_id) {
		throw new Error("verdict does not match run identity");
	}
	if (verdict.receipt_path !== run.judge_receipt_path) {
		throw new Error("verdict receipt_path must match run judge_receipt_path");
	}

	const receiptPath = resolveWorkspacePath(run.workspace_root, verdict.receipt_path);
	await atomicWriteJson(join(runDir, "verdict.json"), verdict);
	await atomicWriteFile(receiptPath, receiptMarkdown);
	await refreshReceiptLink(runDir, receiptPath);
	await appendJudgeEvent(runDir, {
		type: "judge.verdict_written",
		run_id: verdict.run_id,
		verdict: verdict.verdict,
		at: nowIso()
	});
}

export async function validateJudgeCompletion(runDir: string): Promise<JudgeValidationResult> {
	const issues: string[] = [];
	const run = await readJsonOrNull<JudgeRunConfig>(join(runDir, "run.json"));
	const status = await readJsonOrNull<JudgeRunStatusFile>(join(runDir, "status.json"));
	const verdict = await readJsonOrNull<JudgeVerdictFile>(join(runDir, "verdict.json"));
	let receiptFrontmatter: Record<string, unknown> | null = null;

	if (!run) issues.push("missing run.json");
	if (!status) issues.push("missing status.json");
	if (!verdict) issues.push("missing verdict.json");
	if (status && !terminalJudgeRunStatuses.has(status.status)) {
		issues.push(`run status is not terminal: ${status.status}`);
	}
	if (run && status && status.run_id !== run.run_id) {
		issues.push("status run_id does not match run.json");
	}
	if (run && verdict) {
		validateVerdictAgainstRun(run, verdict, issues);
		const receiptPath = resolveWorkspacePath(run.workspace_root, verdict.receipt_path);
		const receiptText = await readTextOrNull(receiptPath);
		if (receiptText === null) {
			issues.push(`missing Judge receipt: ${verdict.receipt_path}`);
		} else {
			receiptFrontmatter = parseReceiptFrontmatter(receiptText);
			validateReceiptAgainstVerdict(run, verdict, receiptFrontmatter, issues);
		}
	}

	return {
		ok: issues.length === 0,
		issues,
		run,
		status,
		verdict,
		receiptFrontmatter
	};
}

async function writeJudgePointers(config: JudgeRunConfig, status: JudgeRunStatusFile): Promise<void> {
	const goalJudgeDir = join(config.workspace_root, ".bravo", "goals", config.goal_id, "judge");
	await Promise.all([
		atomicWriteJson(join(goalJudgeDir, "current.json"), judgePointer(config, status)),
		atomicWriteJson(join(goalJudgeDir, "runs", `${config.run_id}.json`), judgePointer(config, status))
	]);
}

function defaultJudgeSystemPrompt(config: JudgeRunConfig): string {
	const unsafeLine = config.command_policy.unsafe_raw_bash
		? "WARNING: raw bash is enabled for this run. Every command must be recorded in verdict.json and the Judge receipt."
		: "Use judge_bash for command execution. Raw bash is not allowed.";
	const roleLine = config.final_audit
		? "You are the Bravo Goals Federal Judge. Review the whole goal like an integrated PR review before human verification."
		: "You are the Bravo Goals task Judge.";
	const followUpLine = config.final_audit
		? "If the integrated implementation does not accomplish the goal in spirit, include follow_up_tasks in verdict.json with actionable remediation tasks."
		: "If the task is incomplete, return it to the worker with concrete missing evidence.";
	return [
		roleLine,
		config.final_audit
			? "Verify all task receipts, Judge receipts, implementation changes, tests, and architectural fit against the goal and context."
			: "Verify the worker receipt against the task, goal criteria, and concrete evidence.",
		"Do not perform implementation work.",
		"External checks must fail fast: use explicit timeouts for tests, builds, git remotes, package installs, and network/API calls; disable interactive git/SSH prompts where practical, and treat unbounded checks as missing evidence rather than waiting indefinitely.",
		"Write a machine verdict and a Markdown Judge receipt that agree.",
		followUpLine,
		unsafeLine,
		"Final assistant prose is supplemental only; verdict.json is authoritative."
	].join("\n");
}

function defaultJudgeTaskPrompt(config: JudgeRunConfig): string {
	return [
		`Run ID: ${config.run_id}`,
		`Goal: ${config.goal_id}`,
		`Task: ${config.task_id}`,
		`Worker receipt: ${config.worker_receipt_path ?? "(final audit or none)"}`,
		`Judge receipt: ${config.judge_receipt_path}`,
		config.final_audit
			? "Federal Judge scope: holistic goal review across all task receipts, code changes, tests, integration behavior, and architectural smells."
			: "Task Judge scope: verify this task receipt only.",
		`Allowed tools: ${config.allowed_tools.join(", ")}`,
		`Command policy: ${config.command_policy.mode}, unsafe_raw_bash=${String(config.command_policy.unsafe_raw_bash)}`
	].join("\n");
}

function judgePointer(config: JudgeRunConfig, status: JudgeRunStatusFile): Record<string, unknown> {
	return {
		schema_version: 1,
		run_id: config.run_id,
		run_path: `.bravo/runs/${config.run_id}/run.json`,
		status_path: `.bravo/runs/${config.run_id}/status.json`,
		verdict_path: `.bravo/runs/${config.run_id}/verdict.json`,
		receipt_path: config.judge_receipt_path,
		status: status.status,
		created_at: config.created_at,
		updated_at: status.updated_at
	};
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJudgeEvent(runDir: string, event: Record<string, unknown>): Promise<void> {
	await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, { flag: "a" });
}

async function refreshReceiptLink(runDir: string, receiptPath: string): Promise<void> {
	const linkPath = join(runDir, "receipt.md");
	try {
		await symlink(relative(runDir, receiptPath), linkPath);
	} catch (error) {
		if (isErrno(error, "EEXIST")) return;
		throw error;
	}
}

function validateJudgeVerdictShape(verdict: JudgeVerdictFile): void {
	if (verdict.schema_version !== 1) throw new Error("verdict schema_version must be 1");
	if (!["pass", "fail", "needs_more_evidence", "blocked"].includes(verdict.verdict)) {
		throw new Error(`invalid Judge verdict: ${String(verdict.verdict)}`);
	}
}

function validateVerdictAgainstRun(run: JudgeRunConfig, verdict: JudgeVerdictFile, issues: string[]): void {
	if (verdict.schema_version !== 1) issues.push("verdict schema_version must be 1");
	if (verdict.run_id !== run.run_id) issues.push("verdict run_id does not match run.json");
	if (verdict.goal_id !== run.goal_id) issues.push("verdict goal_id does not match run.json");
	if (verdict.task_id !== run.task_id) issues.push("verdict task_id does not match run.json");
	if (verdict.final_audit !== run.final_audit) issues.push("verdict final_audit does not match run.json");
	if (verdict.receipt_path !== run.judge_receipt_path) issues.push("verdict receipt_path does not match run judge_receipt_path");
	if (!["pass", "fail", "needs_more_evidence", "blocked"].includes(verdict.verdict)) {
		issues.push(`invalid verdict: ${String(verdict.verdict)}`);
	}
}

function validateReceiptAgainstVerdict(
	run: JudgeRunConfig,
	verdict: JudgeVerdictFile,
	frontmatter: Record<string, unknown> | null,
	issues: string[]
): void {
	if (!frontmatter) {
		issues.push("Judge receipt is missing YAML frontmatter");
		return;
	}
	const expectedVerdictPath = `.bravo/runs/${run.run_id}/verdict.json`;
	const checks: Array<[string, unknown, unknown]> = [
		["schema_version", frontmatter.schema_version, 1],
		["type", frontmatter.type, "judge"],
		["run_id", frontmatter.run_id, verdict.run_id],
		["task_id", frontmatter.task_id, verdict.task_id],
		["verdict", frontmatter.verdict, verdict.verdict],
		["verdict_path", frontmatter.verdict_path, expectedVerdictPath],
		["receipt_path", frontmatter.receipt_path, verdict.receipt_path]
	];
	for (const [field, actual, expected] of checks) {
		if (actual !== expected) {
			issues.push(`Judge receipt ${field} does not match expected value`);
		}
	}
}

function parseReceiptFrontmatter(markdown: string): Record<string, unknown> | null {
	if (!markdown.startsWith("---\n")) return null;
	const end = markdown.indexOf("\n---", 4);
	if (end === -1) return null;
	const parsed = parseYaml(markdown.slice(4, end));
	return isRecord(parsed) ? parsed : null;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
	const text = await readTextOrNull(path);
	return text === null ? null : (JSON.parse(text) as T);
}

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return null;
		throw error;
	}
}

function resolveWorkspacePath(workspaceRoot: string, path: string): string {
	return isAbsolute(path) ? path : join(workspaceRoot, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}
