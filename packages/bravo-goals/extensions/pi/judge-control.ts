import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import { createJudgeRun, updateJudgeRunStatus, writeJudgeVerdict, type JudgeRunConfig, type JudgeVerdictFile } from "../../src/judge-runner.js";
import { readActiveGoalsIndex, readGoalState, writeGoalState } from "../../src/runtime.js";
import { markWorkerReceiptReady } from "../../src/state.js";
import { discoverWorkspaceRoot } from "../../src/workspace.js";

const JudgeEventParams = Type.Object({
	goal_id: Type.String({ description: "Bravo goal id." }),
	event: Type.String({ description: "Judge event name such as task.receipt_ready or judge.completed." }),
	run_id: Type.Optional(Type.String({ description: "Judge run id, when known." })),
	receipt_path: Type.Optional(Type.String({ description: "Path to the relevant Judge or worker receipt." })),
	note: Type.Optional(Type.String({ description: "Short event note." })),
});

const JudgeFinishParams = Type.Object({
	goal_id: Type.String({ description: "Bravo goal id." }),
	run_id: Type.Optional(Type.String({ description: "Judge run id, when known." })),
	verdict: Type.Union([
		Type.Literal("pass"),
		Type.Literal("fail"),
		Type.Literal("needs_more_evidence"),
		Type.Literal("blocked"),
	]),
	receipt_path: Type.String({ description: "Path to the Judge receipt." }),
	summary: Type.Optional(Type.String({ description: "Short Judge result summary." })),
});

const TaskReceiptReadyParams = Type.Object({
	goal_id: Type.String({ description: "Bravo goal id." }),
	receipt_path: Type.Optional(Type.String({ description: "Worker receipt path under receipts/. Defaults to the active task receipt path." })),
	summary: Type.Optional(Type.String({ description: "Short worker completion summary." })),
	note: Type.Optional(Type.String({ description: "Short worker completion note." })),
});

interface ToolContextLike {
	cwd?: string;
	shutdown?: () => void;
	sessionManager?: {
		getSessionId?: () => string;
	};
}

export function registerJudgeControlTools(pi: ExtensionAPI): void {
	if (typeof pi.registerTool !== "function") return;

	pi.registerTool({
		name: "task_receipt_ready",
		label: "Task receipt ready",
		description: "Signal that the active Bravo task worker receipt exists and the task is ready for Judge review.",
		parameters: TaskReceiptReadyParams,
		async execute(_toolCallId, params, _span, _toolCall, ctx?: ToolContextLike) {
			const result = await persistWorkerReceiptReady(params, ctx);
			await appendJudgeControlEvent({
				type: "task.receipt_ready",
				goal_id: params.goal_id,
				run_id: result.judgeRunId,
				receipt_path: result.receiptPath,
				task_id: result.taskId,
				task_status: "awaiting_judge",
				note: params.note ?? params.summary,
				at: new Date().toISOString(),
			});
			return taskReceiptReadyResponse(params.goal_id, result);
		},
	});

	pi.registerTool({
		name: "judge_event",
		label: "Judge event",
		description: "Record a Bravo Judge lifecycle event and persist supported Bravo task transitions.",
		parameters: JudgeEventParams,
		async execute(_toolCallId, params, _span, _toolCall, ctx?: ToolContextLike) {
			if (params.event !== "task.receipt_ready") {
				await appendJudgeControlEvent({
					type: params.event,
					goal_id: params.goal_id,
					run_id: params.run_id,
					receipt_path: params.receipt_path,
					note: params.note,
					at: new Date().toISOString(),
				});
				return {
					content: [{ type: "text", text: `Judge event accepted: ${params.event} for ${params.goal_id}.` }],
					details: params,
				};
			}

			const result = await persistWorkerReceiptReady(params, ctx);
			await appendJudgeControlEvent({
				type: params.event,
				goal_id: params.goal_id,
				run_id: result.judgeRunId,
				receipt_path: result.receiptPath,
				task_id: result.taskId,
				task_status: "awaiting_judge",
				note: params.note,
				at: new Date().toISOString(),
			});
			return taskReceiptReadyResponse(params.goal_id, result);
		},
	});

	pi.registerTool({
		name: "judge_finish",
		label: "Judge finish",
		description: "Signal completion of a Bravo Judge run with a verdict and receipt path. This v1 Pi extension exposes the contract only.",
		parameters: JudgeFinishParams,
		async execute(_toolCallId, params, _span, _toolCall, ctx?: ToolContextLike) {
			const runDir = process.env.BRAVO_JUDGE_RUN_DIR;
			if (!runDir) throw new Error("judge_finish is only for isolated Bravo Judge sessions (BRAVO_JUDGE_RUN_DIR is not set). Normal worker agents should write the worker receipt, then call task_receipt_ready with goal_id and receipt_path instead.");
			const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as JudgeRunConfig;
			const verdict: JudgeVerdictFile = {
				schema_version: 1,
				run_id: params.run_id ?? run.run_id,
				goal_id: params.goal_id,
				task_id: run.task_id,
				final_audit: run.final_audit,
				verdict: params.verdict,
				receipt_path: params.receipt_path,
				evidence_checked: [],
				commands_run: [],
				inspection_helpers: [],
				missing_or_weak_evidence: [],
				recommendation: params.verdict === "pass" ? "advance_task" : "return_to_worker",
				created_at: new Date().toISOString(),
			};
			await writeJudgeVerdict(runDir, verdict, renderJudgeReceipt(verdict, params.summary));
			await updateJudgeRunStatus(runDir, params.verdict === "blocked" ? "blocked" : params.verdict === "pass" ? "succeeded" : "failed");
			ctx?.shutdown?.();
			return {
				content: [
					{
						type: "text",
						text: `Judge finished for ${params.goal_id}: ${params.verdict}. Receipt: ${params.receipt_path}`,
					},
				],
				details: params,
			};
		},
	});
}

interface ReceiptReadyResult {
	taskId: string;
	receiptPath: string;
	judgeRunId: string;
	judgeRunPath: string;
	judgeReceiptPath: string;
	nextAction: "judge_pending_launch";
}

async function persistWorkerReceiptReady(params: { goal_id: string; receipt_path?: string }, ctx?: ToolContextLike): Promise<ReceiptReadyResult> {
	const workspaceRoot = await discoverWorkspaceRoot(ctx?.cwd ?? process.cwd());
	if (!workspaceRoot) {
		throw new Error("ContextError: No Bravo workspace found for task_receipt_ready. Run it from inside the Bravo workspace attached to this Pi session.");
	}
	const index = await readActiveGoalsIndex(workspaceRoot);
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (!sessionId) {
		throw new Error("ContextError: task_receipt_ready requires a current Pi session id. Resume/start the goal in this Pi session, then retry.");
	}
	const entry = index.active_goals.find((candidate) => (
		candidate.goal_id === params.goal_id
		&& candidate.pi_session_id === sessionId
	));
	if (!entry) {
		throw new Error(`ContextError: No attached active Bravo goal found for ${params.goal_id} in current Pi session ${sessionId}. Use /goal start or /goal resume for this goal, then call task_receipt_ready.`);
	}
	const goalDir = resolveActiveGoalDir(workspaceRoot, entry.path, params.goal_id);
	const state = await readGoalState(goalDir);
	if (state.goal.id !== params.goal_id) {
		throw new Error(`Attached goal state mismatch: expected ${params.goal_id}, found ${state.goal.id}.`);
	}
	if (state.session.attached_pi_session_id !== sessionId) {
		throw new Error(`ContextError: Goal ${params.goal_id} is not attached to current Pi session ${sessionId}; state has ${state.session.attached_pi_session_id ?? "no attached session"}. Use /goal resume to attach the authoritative goal state, then retry task_receipt_ready.`);
	}
	const task = state.active_task ? state.tasks.find((candidate) => candidate.id === state.active_task) : null;
	if (!task) {
		throw new Error(`Goal ${params.goal_id} has no active task for task_receipt_ready.`);
	}
	if (task.status !== "active") {
		throw new Error(`Task ${task.id} must be active before task_receipt_ready; current status is ${task.status}.`);
	}
	const receiptPath = params.receipt_path ?? task.receipt ?? canonicalWorkerReceiptPath(task.id);
	const validatedReceiptPath = await validateWorkerReceipt(goalDir, receiptPath, task.id);
	const judgeReceiptPath = `.bravo/goals/${params.goal_id}/receipts/${task.id}-judge.md`;
	const judgeRun = await createJudgeRun({
		workspaceRoot,
		goalId: params.goal_id,
		taskId: task.id,
		workerReceiptPath: `.bravo/goals/${params.goal_id}/${validatedReceiptPath}`,
		judgeReceiptPath,
		cwd: ctx?.cwd ?? workspaceRoot,
	});
	const readyState = markWorkerReceiptReady(state, task.id, validatedReceiptPath).state;
	await writeGoalState(goalDir, {
		...readyState,
		session: { ...readyState.session, current_judge_run_id: judgeRun.runId },
	});
	return {
		taskId: task.id,
		receiptPath: validatedReceiptPath,
		judgeRunId: judgeRun.runId,
		judgeRunPath: relative(workspaceRoot, judgeRun.runPath),
		judgeReceiptPath,
		nextAction: "judge_pending_launch",
	};
}

function taskReceiptReadyResponse(goalId: string, result: ReceiptReadyResult): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
	return {
		content: [{
			type: "text",
			text: `Task receipt ready: ${goalId}/${result.taskId} is awaiting Judge. Receipt: ${result.receiptPath}. Judge run: ${result.judgeRunId}. Next action: ${result.nextAction}.`,
		}],
		details: {
			status: "awaiting_judge",
			goal_id: goalId,
			task_id: result.taskId,
			receipt_path: result.receiptPath,
			judge_run_id: result.judgeRunId,
			judge_run_path: result.judgeRunPath,
			judge_receipt_path: result.judgeReceiptPath,
			next_action: result.nextAction,
		},
	};
}

function canonicalWorkerReceiptPath(taskId: string): string {
	return `receipts/${taskId}-worker.md`;
}

function resolveActiveGoalDir(workspaceRoot: string, entryPath: string, goalId: string): string {
	if (isAbsolute(entryPath)) {
		throw new Error(`Active goal path must be workspace-relative for ${goalId}.`);
	}
	const normalizedEntryPath = normalize(entryPath);
	const expectedEntryPath = join(".bravo", "goals", goalId);
	if (normalizedEntryPath !== expectedEntryPath) {
		throw new Error(`Active goal path must be ${expectedEntryPath} for ${goalId}.`);
	}
	const goalDir = resolve(workspaceRoot, normalizedEntryPath);
	assertContained(resolve(workspaceRoot, ".bravo", "goals"), goalDir, `Active goal path escapes workspace goals for ${goalId}.`);
	return goalDir;
}

async function validateWorkerReceipt(goalDir: string, receiptPath: string, taskId: string): Promise<string> {
	const normalizedReceiptPath = normalizeReceiptPath(receiptPath);
	const resolved = resolve(goalDir, normalizedReceiptPath);
	assertContained(join(goalDir, "receipts"), resolved, `Worker receipt path escapes goal receipts: ${receiptPath}`);
	try {
		await access(resolved, constants.F_OK);
	} catch {
		throw new Error(`Worker receipt not found: ${receiptPath}`);
	}
	const receiptStat = await stat(resolved);
	if (!receiptStat.isFile()) {
		throw new Error(`Worker receipt must be a regular file: ${receiptPath}`);
	}
	const content = await readFile(resolved, "utf8");
	validateWorkerReceiptFrontmatter(content, taskId, receiptPath);
	return normalizedReceiptPath;
}

function validateWorkerReceiptFrontmatter(content: string, taskId: string, receiptPath: string): void {
	if (!content.trim()) {
		throw new Error(`Worker receipt is empty: ${receiptPath}`);
	}
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) {
		throw new Error(`Worker receipt must start with YAML frontmatter: ${receiptPath}`);
	}
	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(match[1] ?? "");
	} catch (error) {
		throw new Error(`Worker receipt frontmatter is malformed: ${receiptPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		throw new Error(`Worker receipt frontmatter is empty or malformed: ${receiptPath}`);
	}
	const data = frontmatter as Record<string, unknown>;
	if (data.type !== "worker") {
		throw new Error(`Worker receipt frontmatter type must be worker: ${receiptPath}`);
	}
	if (data.task_id !== taskId) {
		throw new Error(`Worker receipt frontmatter task_id must match active task ${taskId}: ${receiptPath}`);
	}
	if (data.status !== "complete" && data.status !== "ready") {
		throw new Error(`Worker receipt frontmatter status must be complete or ready: ${receiptPath}`);
	}
}

function normalizeReceiptPath(receiptPath: string): string {
	if (isAbsolute(receiptPath)) {
		throw new Error(`Worker receipt path must be relative to the goal receipts directory: ${receiptPath}`);
	}
	const normalizedReceiptPath = normalize(receiptPath);
	if (normalizedReceiptPath === ".." || normalizedReceiptPath.startsWith(`..${sep}`)) {
		throw new Error(`Worker receipt path escapes goal directory: ${receiptPath}`);
	}
	if (!normalizedReceiptPath.startsWith(`receipts${sep}`)) {
		throw new Error(`Worker receipt path must be under receipts/: ${receiptPath}`);
	}
	return normalizedReceiptPath;
}

function assertContained(root: string, candidate: string, message: string): void {
	const relativePath = relative(root, candidate);
	if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return;
	throw new Error(message);
}

async function appendJudgeControlEvent(event: Record<string, unknown>): Promise<void> {
	const runDir = process.env.BRAVO_JUDGE_RUN_DIR;
	if (!runDir) return;
	await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, { flag: "a" });
}

function renderJudgeReceipt(verdict: JudgeVerdictFile, summary?: string): string {
	return `---
schema_version: 1
type: judge
run_id: ${verdict.run_id}
task_id: ${verdict.task_id}
verdict: ${verdict.verdict}
created_at: "${verdict.created_at}"
verdict_path: ".bravo/runs/${verdict.run_id}/verdict.json"
receipt_path: "${verdict.receipt_path}"
commands: []
inspection_helpers: []
claims_checked: []
---

# Judge Receipt

${summary ?? "Judge finished through judge_finish."}
`;
}
