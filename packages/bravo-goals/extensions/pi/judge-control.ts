import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants, readFileSync, statSync } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import { runAutonomousJudge, type AutonomousJudgeOutcome } from "./judge-launcher.js";
import { createJudgeRun, updateJudgeRunStatus, writeJudgeVerdict, type JudgeRunConfig, type JudgeVerdictFile } from "../../src/judge-runner.js";
import { readActiveGoalsIndex, readGoalState, writeGoalState } from "../../src/runtime.js";
import { markJudgeStarted, markWorkerReceiptReady } from "../../src/state.js";
import { markBoundaryApplied, renderCompactInstructions, selectNextBoundary, type BoundarySelection } from "../../src/phase-boundary.js";
import {
	renderCarryContinuationPrompt as renderPromptCarryContinuation,
	renderHandoffContinuationPrompt as renderPromptHandoffContinuation,
} from "../../src/prompts.js";
import type { GoalState } from "../../src/types.js";
import { discoverWorkspaceRoot } from "../../src/workspace.js";
import {
	chromeRenderable,
	renderFailureCard,
	renderJudgeEventCall,
	renderJudgeEventResult,
	renderJudgeFinishCall,
	renderJudgeFinishResult,
	renderTaskReceiptReadyCall,
	renderTaskReceiptReadyResult,
	textBlock,
	type JudgeVerdictKind,
	type TextRenderable,
} from "./renderers.js";

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
	evidence_checked: Type.Optional(Type.Array(Type.String({ description: "Concrete evidence checked by the Judge." }))),
	commands_run: Type.Optional(Type.Array(Type.String({ description: "Commands run through judge_bash or intentionally empty." }))),
	inspection_helpers: Type.Optional(Type.Array(Type.String({ description: "Helper review lanes or inspection methods used." }))),
	missing_or_weak_evidence: Type.Optional(Type.Array(Type.String({ description: "Missing or weak evidence found by the Judge." }))),
	recommendation: Type.Optional(Type.String({ description: "Recommended next lifecycle action." })),
	follow_up_tasks: Type.Optional(Type.Array(Type.Object({
		id: Type.Optional(Type.String({ description: "Optional stable task id." })),
		title: Type.String({ description: "Follow-up remediation task title." }),
		verify: Type.Optional(Type.Array(Type.String({ description: "Verification step for the follow-up task." }))),
		expected_output: Type.Optional(Type.Array(Type.String({ description: "Expected output for the follow-up task." }))),
		context_switch_severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
	}, { description: "Federal Judge follow-up remediation task." }))),
});

const JudgeBashParams = Type.Object({
	command: Type.String({ description: "Shell command for a Bravo Judge verification step. Must be evidence-gathering only; do not edit files." }),
	cwd: Type.Optional(Type.String({ description: "Optional workspace-relative working directory. Defaults to the Judge run cwd." })),
	timeout_ms: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds. Defaults to 120000." })),
});

const TaskReceiptReadyParams = Type.Object({
	goal_id: Type.String({ description: "Bravo goal id." }),
	receipt_path: Type.Optional(Type.String({ description: "Worker receipt path under receipts/. Defaults to the active task receipt path." })),
	summary: Type.Optional(Type.String({ description: "Short worker completion summary." })),
	note: Type.Optional(Type.String({ description: "Short worker completion note." })),
});

interface ToolContextLike {
	cwd?: string;
	compact?: (options?: { customInstructions?: string; onComplete?: () => void }) => void;
	shutdown?: () => void;
	model?: unknown;
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
		renderShell: "self",
		async execute(_toolCallId, params, _span, _toolCall, ctx?: ToolContextLike) {
			const result = await persistWorkerReceiptReady(params, ctx);
			const judgeOutcome = await runAutonomousJudge({
				workspaceRoot: result.workspaceRoot,
				goalDir: result.goalDir,
				goalId: params.goal_id,
				taskId: result.taskId,
				runDir: result.judgeRunDir,
				runId: result.judgeRunId,
				judgeReceiptPath: result.judgeReceiptPath,
				model: ctx?.model,
				timeoutMs: 900000,
				maxAttempts: 3,
			});
			await appendJudgeControlEvent({
				type: "task.receipt_ready",
				goal_id: params.goal_id,
				run_id: result.judgeRunId,
				receipt_path: result.receiptPath,
				task_id: result.taskId,
				task_status: judgeOutcome.taskStatus,
				note: params.note ?? params.summary,
				at: new Date().toISOString(),
			});
			await queueAfterJudge(pi, result, judgeOutcome, ctx);
			return taskReceiptReadyResponse(params.goal_id, result, result.title, judgeOutcome);
		},
		renderCall(args: unknown): TextRenderable {
			const params = isRecord(args) ? args : {};
			const goalId = extractStringOrUndefined(params.goal_id) ?? "unknown";
			const title = resolveGoalTitleSync(goalId);
			return chromeRenderable((width) => renderTaskReceiptReadyCall({
				goal_id: goalId,
				goal_title: title,
				receipt_path: extractStringOrUndefined(params.receipt_path),
				summary: extractStringOrUndefined(params.summary),
			}, width));
		},
		renderResult(result: unknown, _options, _theme, context): TextRenderable {
			return renderToolResultComponent(result, "task_receipt_ready", context?.args);
		},
	});

	pi.registerTool({
		name: "judge_event",
		label: "Judge event",
		description: "Record a Bravo Judge lifecycle event and persist supported Bravo task transitions.",
		parameters: JudgeEventParams,
		renderShell: "self",
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
				const title = resolveGoalTitleSyncFromCtx(params.goal_id, ctx);
				return {
					content: [{ type: "text", text: `Judge event accepted: ${params.event} for ${params.goal_id}.` }],
					details: { ...params, title },
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
			return taskReceiptReadyResponse(params.goal_id, result, result.title);
		},
		renderCall(args: unknown): TextRenderable {
			const params = isRecord(args) ? args : {};
			const goalId = extractStringOrUndefined(params.goal_id) ?? "unknown";
			const title = resolveGoalTitleSync(goalId);
			return chromeRenderable((width) => renderJudgeEventCall({
				goal_id: goalId,
				goal_title: title,
				event: extractStringOrUndefined(params.event) ?? "unknown",
				note: extractStringOrUndefined(params.note),
			}, width));
		},
		renderResult(result: unknown, _options, _theme, context): TextRenderable {
			return renderToolResultComponent(result, "judge_event", context?.args);
		},
	});

	pi.registerTool({
		name: "judge_finish",
		label: "Judge finish",
		description: "Signal completion of a Bravo Judge run with a verdict and receipt path. This v1 Pi extension exposes the contract only.",
		parameters: JudgeFinishParams,
		renderShell: "self",
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
				evidence_checked: params.evidence_checked ?? [],
				commands_run: params.commands_run ?? [],
				inspection_helpers: params.inspection_helpers ?? [],
				missing_or_weak_evidence: params.missing_or_weak_evidence ?? [],
				recommendation: params.recommendation ?? (params.verdict === "pass" ? "advance_task" : "return_to_worker"),
				follow_up_tasks: params.follow_up_tasks,
				created_at: new Date().toISOString(),
			};
			await writeJudgeVerdict(runDir, verdict, renderJudgeReceipt(verdict, params.summary));
			await updateJudgeRunStatus(runDir, params.verdict === "blocked" ? "blocked" : params.verdict === "pass" ? "succeeded" : "failed");
			ctx?.shutdown?.();
			// Try to read a human title — Judge sessions run in an isolated
			// BRAVO_JUDGE_RUN_DIR so cwd lookup may miss the workspace; fall
			// back to undefined and the renderer will show the slug.
			const title = resolveGoalTitleSyncFromCtx(params.goal_id, ctx);
			return {
				content: [
					{
						type: "text",
						text: `Judge finished for ${params.goal_id}: ${params.verdict}. Receipt: ${params.receipt_path}`,
					},
				],
				details: { ...params, title, next_action: verdict.recommendation },
			};
		},
		renderCall(args: unknown): TextRenderable {
			const params = isRecord(args) ? args : {};
			const goalId = extractStringOrUndefined(params.goal_id) ?? "unknown";
			const title = resolveGoalTitleSync(goalId);
			const verdict = isJudgeVerdictKind(params.verdict) ? params.verdict : undefined;
			return chromeRenderable((width) => renderJudgeFinishCall({
				goal_id: goalId,
				goal_title: title,
				run_id: extractStringOrUndefined(params.run_id),
				verdict,
			}, width));
		},
		renderResult(result: unknown, _options, _theme, context): TextRenderable {
			return renderToolResultComponent(result, "judge_finish", context?.args);
		},
	});

	pi.registerTool({
		name: "judge_bash",
		label: "Judge bash",
		description: "Run evidence-gathering shell commands inside an isolated Bravo Judge session. Use only for verification; implementation and file mutation are blocked by policy.",
		parameters: JudgeBashParams,
		async execute(_toolCallId, params) {
			const runDir = process.env.BRAVO_JUDGE_RUN_DIR;
			if (!runDir) throw new Error("judge_bash is only available inside isolated Bravo Judge sessions.");
			const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as JudgeRunConfig;
			if (looksMutatingCommand(params.command)) {
				throw new Error(`judge_bash blocked mutating command: ${params.command}`);
			}
			const cwd = params.cwd ? resolve(run.workspace_root, params.cwd) : run.cwd;
			const output = await runJudgeBash(params.command, cwd, params.timeout_ms ?? 120000);
			await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "judge.command",
				run_id: run.run_id,
				command: params.command,
				code: output.code,
				at: new Date().toISOString(),
			})}\n`, { flag: "a" });
			return {
				content: [{ type: "text", text: [
					`exit_code: ${output.code}`,
					"stdout:",
					output.stdout,
					"stderr:",
					output.stderr,
				].join("\n") }],
				details: output,
			};
		},
	});
}

// ─── render adapters ──────────────────────────────────────────────────────

interface ToolExecResult {
	content?: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function extractStringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isJudgeVerdictKind(value: unknown): value is JudgeVerdictKind {
	return value === "pass" || value === "fail" || value === "needs_more_evidence" || value === "blocked";
}

// Map an execute() return into the right card based on the tool name. The
// tool always knows its own name — no schema sniffing required. `args` is the
// original tool-call params (when pi supplies them via render context); used
// as a fallback for error cards where `details` is missing.
export function renderToolResultComponent(rawResult: unknown, toolName: string, args?: unknown): TextRenderable {
	const result = (isRecord(rawResult) ? rawResult : {}) as ToolExecResult;
	const details = isRecord(result.details) ? result.details : {};
	const argRec = isRecord(args) ? args : {};
	// Fall back to the params goal_id when execute() threw — pi error results
	// have no details, so the failure card would otherwise lose its identity.
	const goalId = extractStringOrUndefined(details.goal_id)
		?? extractStringOrUndefined(argRec.goal_id)
		?? "";
	const title = extractStringOrUndefined(details.title)
		?? (goalId ? resolveGoalTitleSync(goalId) : undefined);

	// Error path: pi surfaces thrown errors through isError + text content.
	if (result.isError) {
		const errorText = result.content?.[0]?.text ?? "Tool error";
		return chromeRenderable((width) => renderFailureCard({
			goal_id: goalId || "unknown",
			goal_title: title,
			tool: toolName,
			error: errorText,
		}, width));
	}

	if (toolName === "task_receipt_ready") {
		const taskId = extractStringOrUndefined(details.task_id);
		const receiptPath = extractStringOrUndefined(details.receipt_path);
		const judgeRunId = extractStringOrUndefined(details.judge_run_id);
		if (!taskId || !receiptPath || !judgeRunId) {
			const fallbackText = result.content?.[0]?.text ?? "task_receipt_ready did not return success details.";
			const looksLikeError = /error|ContextError|failed/i.test(fallbackText);
			if (looksLikeError) {
				return chromeRenderable((width) => renderFailureCard({
					goal_id: goalId || "unknown",
					goal_title: title,
					tool: toolName,
					error: fallbackText,
				}, width));
			}
			return textBlock([fallbackText]);
		}
		return chromeRenderable((width) => renderTaskReceiptReadyResult({
			goal_id: goalId,
			goal_title: title,
			task_id: taskId,
			receipt_path: receiptPath,
			judge_run_id: judgeRunId,
			judge_run_path: extractStringOrUndefined(details.judge_run_path),
			judge_receipt_path: extractStringOrUndefined(details.judge_receipt_path),
			next_action: extractStringOrUndefined(details.next_action),
		}, width));
	}

	if (toolName === "judge_event") {
		// judge_event for task.receipt_ready returns the same details shape
		// as task_receipt_ready — render the receipt-ready card so the user
		// sees the actual transition that happened.
		if (extractStringOrUndefined(details.status) === "awaiting_judge") {
			return chromeRenderable((width) => renderTaskReceiptReadyResult({
				goal_id: goalId,
				goal_title: title,
				task_id: extractStringOrUndefined(details.task_id) ?? "",
				receipt_path: extractStringOrUndefined(details.receipt_path) ?? "",
				judge_run_id: extractStringOrUndefined(details.judge_run_id) ?? "",
				judge_run_path: extractStringOrUndefined(details.judge_run_path),
				judge_receipt_path: extractStringOrUndefined(details.judge_receipt_path),
				next_action: extractStringOrUndefined(details.next_action),
			}, width));
		}
		return chromeRenderable((width) => renderJudgeEventResult({
			goal_id: goalId,
			goal_title: title,
			event: extractStringOrUndefined(details.event) ?? "",
			run_id: extractStringOrUndefined(details.run_id),
			receipt_path: extractStringOrUndefined(details.receipt_path),
		}, width));
	}

	if (toolName === "judge_finish") {
		const verdict = extractStringOrUndefined(details.verdict) as JudgeVerdictKind | undefined;
		if (verdict) {
			return chromeRenderable((width) => renderJudgeFinishResult({
				goal_id: goalId,
				goal_title: title,
				run_id: extractStringOrUndefined(details.run_id),
				verdict,
				receipt_path: extractStringOrUndefined(details.receipt_path) ?? "",
				summary: extractStringOrUndefined(details.summary),
				next_action: extractStringOrUndefined(details.next_action),
			}, width));
		}
	}

	// Safety fallback: render the result text on its own (no chrome).
	const fallbackText = result.content?.[0]?.text ?? "";
	return chromeRenderable(() => [fallbackText]);
}

// Walk up from `start` until a `.bravo/config.yaml` is found, mirroring the
// async `discoverWorkspaceRoot` but in sync mode. Used only by renderCall, which
// can't await.
export function discoverWorkspaceRootSync(start: string): string | null {
	let current = resolve(start);
	for (;;) {
		try {
			const candidate = join(current, ".bravo", "config.yaml");
			if (statSync(candidate).isFile()) return current;
		} catch {
			// Continue walking up — config might be in a parent.
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

// Best-effort sync title resolution for renderCall. Reads the active-goals
// index to find the goal directory, then loads state.yaml. Returns undefined
// on any failure so the renderer falls back to the slug.
export function resolveGoalTitleSync(goalId: string, fromCwd?: string): string | undefined {
	try {
		const workspaceRoot = discoverWorkspaceRootSync(fromCwd ?? process.cwd());
		if (!workspaceRoot) return undefined;
		const indexPath = join(workspaceRoot, ".bravo", "runtime", "active-goals.yaml");
		let goalDir: string | undefined;
		try {
			const indexRaw = readFileSync(indexPath, "utf8");
			const indexParsed = parseYaml(indexRaw) as { active_goals?: Array<{ goal_id: string; path: string }> } | null;
			const entry = indexParsed?.active_goals?.find((candidate) => candidate.goal_id === goalId);
			if (entry) goalDir = resolve(workspaceRoot, entry.path);
		} catch {
			// Index miss is fine — fall back to the conventional path below.
		}
		if (!goalDir) goalDir = join(workspaceRoot, ".bravo", "goals", goalId);
		const stateRaw = readFileSync(join(goalDir, "state.yaml"), "utf8");
		const parsed = parseYaml(stateRaw) as { goal?: { title?: string } } | null;
		const title = parsed?.goal?.title;
		return typeof title === "string" && title.length > 0 ? title : undefined;
	} catch {
		return undefined;
	}
}

function resolveGoalTitleSyncFromCtx(goalId: string, ctx?: ToolContextLike): string | undefined {
	return resolveGoalTitleSync(goalId, ctx?.cwd);
}

interface ReceiptReadyResult {
	taskId: string;
	receiptPath: string;
	judgeRunId: string;
	judgeRunDir: string;
	judgeRunPath: string;
	judgeReceiptPath: string;
	workspaceRoot: string;
	goalDir: string;
	nextAction: "judge_running";
	title: string;
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
	const readyState = markJudgeStarted(markWorkerReceiptReady(state, task.id, validatedReceiptPath).state, task.id, judgeRun.runId).state;
	await writeGoalState(goalDir, {
		...readyState,
		session: { ...readyState.session, current_judge_run_id: judgeRun.runId },
	});
	return {
		taskId: task.id,
		receiptPath: validatedReceiptPath,
		judgeRunId: judgeRun.runId,
		judgeRunDir: judgeRun.runDir,
		judgeRunPath: relative(workspaceRoot, judgeRun.runPath),
		judgeReceiptPath,
		workspaceRoot,
		goalDir,
		nextAction: "judge_running",
		title: state.goal.title,
	};
}

function taskReceiptReadyResponse(goalId: string, result: ReceiptReadyResult, title: string | undefined, judgeOutcome?: AutonomousJudgeOutcome): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
	const finalAuditText = judgeOutcome?.finalAudit
		? ` Federal Judge: ${judgeOutcome.finalAudit.verdict} (${judgeOutcome.finalAudit.runId}). Follow-up tasks: ${judgeOutcome.finalAudit.followUpTasksAdded}.`
		: "";
	const verdictText = judgeOutcome ? ` Judge verdict: ${judgeOutcome.verdict}. Attempts: ${judgeOutcome.attempts}.${finalAuditText} Next action: ${judgeOutcome.nextAction}.` : "";
	return {
		content: [{
			type: "text",
			text: `Task receipt ready: ${goalId}/${result.taskId} entered Judge review. Receipt: ${result.receiptPath}. Judge run: ${result.judgeRunId}.${verdictText}`,
		}],
		details: {
			status: judgeOutcome?.taskStatus ?? "judging",
			goal_id: goalId,
			task_id: result.taskId,
			receipt_path: result.receiptPath,
			judge_run_id: result.judgeRunId,
			judge_run_path: result.judgeRunPath,
			judge_receipt_path: result.judgeReceiptPath,
			judge_verdict: judgeOutcome?.verdict,
			judge_attempts: judgeOutcome?.attempts,
			final_audit_verdict: judgeOutcome?.finalAudit?.verdict,
			final_audit_attempts: judgeOutcome?.finalAudit?.attempts,
			final_audit_run_id: judgeOutcome?.finalAudit?.runId,
			final_audit_receipt_path: judgeOutcome?.finalAudit?.judgeReceiptPath,
			final_audit_follow_up_tasks_added: judgeOutcome?.finalAudit?.followUpTasksAdded,
			next_action: judgeOutcome?.nextAction ?? result.nextAction,
			title: title ?? result.title,
		},
	};
}

async function queueAfterJudge(pi: ExtensionAPI, result: ReceiptReadyResult, outcome: AutonomousJudgeOutcome, ctx?: ToolContextLike): Promise<void> {
	if (outcome.nextAction === "blocked") return;
	const state = await readGoalState(result.goalDir);
	if (outcome.nextAction === "human_verification") {
		pi.sendMessage?.({
			customType: "bravo-goal-federal-judge-ready",
			display: true,
			content: `Bravo goal "${state.goal.title}" (${state.goal.id}) completed all worker tasks and passed Federal Judge review.\n\nFederal Judge receipt: ${state.final_audit.receipt ?? outcome.finalAudit?.judgeReceiptPath ?? "the goal receipts directory"}\n\nHuman verification is now available with /goal verify ${state.goal.id}.`,
			details: {
				goal_id: state.goal.id,
				goal_title: state.goal.title,
				federal_judge_receipt: state.final_audit.receipt ?? outcome.finalAudit?.judgeReceiptPath,
				next_action: "human_verification",
			},
		});
		return;
	}
	if (typeof pi.sendUserMessage !== "function") return;
	const active = state.active_task ? state.tasks.find((task) => task.id === state.active_task) : null;
	if (!active) {
		pi.sendUserMessage(`Bravo goal ${state.goal.id} has no active worker task after Judge verdict ${outcome.verdict}. Check final audit status and continue only if the durable state requires more work.`, { deliverAs: "followUp" });
		return;
	}
	const completedTask = state.tasks.find((task) => task.id === result.taskId) ?? null;
	const selection = selectNextBoundary(state, completedTask);
	const stateWithBoundary = markBoundaryApplied(state, selection);
	await writeGoalState(result.goalDir, stateWithBoundary);
	if (selection.mode === "compact" && typeof ctx?.compact === "function") {
		ctx.compact({
			customInstructions: renderCompactInstructions(stateWithBoundary),
			onComplete: () => {
				pi.sendUserMessage(renderPromptHandoffContinuation({
					goalDir: result.goalDir,
					state: stateWithBoundary,
					mode: "compact",
					boundaryReason: selection.reason,
				}), { deliverAs: "followUp" });
			},
		});
		return;
	}
	const prompt = selection.mode === "carry"
		? renderPromptCarryContinuation({
			goalDir: result.goalDir,
			state: stateWithBoundary,
			mode: "carry",
			boundaryReason: selection.reason,
		})
		: renderPromptHandoffContinuation({
			goalDir: result.goalDir,
			state: stateWithBoundary,
			mode: selection.mode === "fresh_session" ? "durable_current_session" : selection.mode,
			boundaryReason: selection.reason,
		});
	pi.sendUserMessage(prompt, { deliverAs: "followUp" });
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

function looksMutatingCommand(command: string): boolean {
	return /(^|\s)(rm|mv|cp|chmod|chown|truncate|tee|sed\s+-i|perl\s+-pi)\b/.test(command)
		|| /\bgit\s+(add|commit|checkout|reset|clean|rm|mv|merge|rebase)\b/.test(command)
		|| />/.test(command);
}

function runJudgeBash(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolvePromise) => {
		const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.stdout?.on("data", (data) => { stdout += data.toString(); });
		child.stderr?.on("data", (data) => { stderr += data.toString(); });
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr, code });
		});
	});
}

async function appendJudgeControlEvent(event: Record<string, unknown>): Promise<void> {
	const runDir = process.env.BRAVO_JUDGE_RUN_DIR;
	if (!runDir) return;
	await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, { flag: "a" });
}

function renderJudgeReceipt(verdict: JudgeVerdictFile, summary?: string): string {
	const title = verdict.final_audit ? "Federal Judge Receipt" : "Judge Receipt";
	const commands = renderYamlList(verdict.commands_run);
	const helpers = renderYamlList(verdict.inspection_helpers);
	const claims = renderYamlList(verdict.evidence_checked);
	const missing = renderYamlList(verdict.missing_or_weak_evidence);
	const followUps = renderFollowUpTasks(verdict.follow_up_tasks);
	return `---
schema_version: 1
type: judge
run_id: ${verdict.run_id}
task_id: ${verdict.task_id}
verdict: ${verdict.verdict}
created_at: "${verdict.created_at}"
verdict_path: ".bravo/runs/${verdict.run_id}/verdict.json"
receipt_path: "${verdict.receipt_path}"
commands:${commands}
inspection_helpers:${helpers}
claims_checked:${claims}
missing_or_weak_evidence:${missing}
---

# ${title}

${summary ?? "Judge finished through judge_finish."}
${followUps}
`;
}

function renderYamlList(values: unknown[]): string {
	if (!values.length) return " []";
	return `\n${values.map((value) => `  - ${JSON.stringify(String(value))}`).join("\n")}`;
}

function renderFollowUpTasks(tasks: JudgeVerdictFile["follow_up_tasks"]): string {
	if (!tasks?.length) return "";
	return `\n\n## Federal Judge Follow-up Tasks\n\n${tasks.map((task, index) => `${index + 1}. ${task.title}`).join("\n")}\n`;
}
