import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJudgeCompletion, createJudgeRun, updateJudgeRunStatus, writeJudgeVerdict, type JudgeContractVerdict, type JudgeRunConfig, type JudgeVerdictFile } from "../../src/judge-runner.js";
import { readGoalState, writeGoalState } from "../../src/runtime.js";
import { applyJudgeVerdict, refreshProgress } from "../../src/state.js";
import type { GoalState, GoalTask } from "../../src/types.js";

export interface AutonomousJudgeOptions {
	workspaceRoot: string;
	goalDir: string;
	goalId: string;
	taskId: string;
	runDir: string;
	runId: string;
	judgeReceiptPath: string;
	model?: unknown;
	timeoutMs: number;
	maxAttempts: number;
}

export interface AutonomousJudgeOutcome {
	verdict: JudgeContractVerdict;
	taskStatus: string;
	attempts: number;
	runId: string;
	runDir: string;
	judgeReceiptPath: string;
	nextAction: "continue" | "return_to_worker" | "blocked" | "human_verification";
	finalAudit?: {
		verdict: JudgeContractVerdict;
		attempts: number;
		runId: string;
		judgeReceiptPath: string;
		followUpTasksAdded: number;
	};
}

interface AttemptHandle {
	runId: string;
	runDir: string;
	judgeReceiptPath: string;
}

export async function runAutonomousJudge(options: AutonomousJudgeOptions): Promise<AutonomousJudgeOutcome> {
	let attempt: AttemptHandle = {
		runId: options.runId,
		runDir: options.runDir,
		judgeReceiptPath: options.judgeReceiptPath,
	};
	let lastError = "Judge did not run.";

	for (let index = 1; index <= options.maxAttempts; index += 1) {
		try {
			await updateJudgeRunStatus(attempt.runDir, "running");
			await runJudgeAttempt(attempt.runDir, options);
			const completion = await validateJudgeCompletion(attempt.runDir);
			if (!completion.ok || !completion.verdict) {
				throw new Error(`Judge completion invalid: ${completion.issues.join("; ")}`);
			}
			const state = await readGoalState(options.goalDir);
			const next = applyJudgeVerdict(state, options.taskId, completion.verdict.verdict, completion.verdict.receipt_path).state;
			await writeGoalState(options.goalDir, next);
			const finalAudit = next.goal.status === "final_audit"
				? await runAutonomousFinalAudit({
					...options,
					baseRunId: attempt.runId,
				})
				: undefined;
			return {
				verdict: completion.verdict.verdict,
				taskStatus: next.tasks.find((task) => task.id === options.taskId)?.status ?? "unknown",
				attempts: index,
				runId: attempt.runId,
				runDir: attempt.runDir,
				judgeReceiptPath: completion.verdict.receipt_path,
				nextAction: finalAudit ? (finalAudit.verdict === "pass" ? "human_verification" : "continue") : nextActionForVerdict(completion.verdict.verdict),
				finalAudit,
			};
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await markAttemptFailed(attempt.runDir, lastError);
			if (index < options.maxAttempts) {
				attempt = await createRetryAttempt(options, attempt, index + 1);
			}
		}
	}

	const state = await readGoalState(options.goalDir);
	await writeGoalState(options.goalDir, {
		...state,
		goal: { ...state.goal, status: "blocked" },
		judge: { ...state.judge, active: false, last_verdict: "blocked" },
		session: { ...state.session, current_judge_run_id: null },
	});
	throw new Error(`Judge failed after ${options.maxAttempts} attempts: ${lastError}`);
}

async function runAutonomousFinalAudit(options: AutonomousJudgeOptions & { baseRunId: string }): Promise<NonNullable<AutonomousJudgeOutcome["finalAudit"]>> {
	const run = await createJudgeRun({
		workspaceRoot: options.workspaceRoot,
		goalId: options.goalId,
		taskId: "final",
		finalAudit: true,
		workerReceiptPath: null,
		judgeReceiptPath: `.bravo/goals/${options.goalId}/receipts/final-audit.md`,
		cwd: options.workspaceRoot,
		timeoutMs: options.timeoutMs,
		runId: `${options.baseRunId}_final`,
	});
	const initialState = await readGoalState(options.goalDir);
	await writeGoalState(options.goalDir, {
		...initialState,
		goal: { ...initialState.goal, status: "final_audit" },
		session: { ...initialState.session, current_judge_run_id: run.runId },
		judge: { ...initialState.judge, active: true },
	});

	let attempt: AttemptHandle = {
		runId: run.runId,
		runDir: run.runDir,
		judgeReceiptPath: run.config.judge_receipt_path,
	};
	let lastError = "Final audit Judge did not run.";
	for (let index = 1; index <= options.maxAttempts; index += 1) {
		try {
			await updateJudgeRunStatus(attempt.runDir, "running");
			await runJudgeAttempt(attempt.runDir, { ...options, runDir: attempt.runDir, runId: attempt.runId, judgeReceiptPath: attempt.judgeReceiptPath });
			const completion = await validateJudgeCompletion(attempt.runDir);
			if (!completion.ok || !completion.verdict) {
				throw new Error(`Final audit Judge completion invalid: ${completion.issues.join("; ")}`);
			}
			const state = await readGoalState(options.goalDir);
			const federalPassed = completion.verdict.verdict === "pass";
			const followUpTasks = federalPassed ? [] : buildFederalFollowUpTasks(state, completion.verdict);
			const nextState = federalPassed
				? {
					...state,
					goal: { ...state.goal, status: "done" as const },
					active_task: null,
					tasks: state.tasks,
				}
				: activateFederalFollowUpTasks(state, followUpTasks);
			await writeGoalState(options.goalDir, {
				...nextState,
				session: { ...state.session, current_judge_run_id: null },
				judge: {
					...state.judge,
					active: false,
					last_verdict: completion.verdict.verdict,
					last_receipt: completion.verdict.receipt_path,
				},
				final_audit: {
					status: federalPassed ? "passed" : "failed",
					receipt: completion.verdict.receipt_path,
					judge_run_id: attempt.runId,
				},
			});
			return {
				verdict: completion.verdict.verdict,
				attempts: index,
				runId: attempt.runId,
				judgeReceiptPath: completion.verdict.receipt_path,
				followUpTasksAdded: followUpTasks.length,
			};
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await markAttemptFailed(attempt.runDir, lastError);
			if (index < options.maxAttempts) {
				attempt = await createFinalAuditRetryAttempt(options, attempt, index + 1);
			}
		}
	}
	const state = await readGoalState(options.goalDir);
	await writeGoalState(options.goalDir, {
		...state,
		goal: { ...state.goal, status: "blocked" },
		session: { ...state.session, current_judge_run_id: null },
		judge: { ...state.judge, active: false, last_verdict: "blocked" },
		final_audit: { ...state.final_audit, status: "failed" },
	});
	return {
		verdict: "blocked",
			attempts: options.maxAttempts,
			runId: attempt.runId,
			judgeReceiptPath: attempt.judgeReceiptPath,
			followUpTasksAdded: 0,
		};
}

async function runJudgeAttempt(runDir: string, options: AutonomousJudgeOptions): Promise<void> {
	const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as JudgeRunConfig;
	const fakeVerdict = run.final_audit
		? (process.env.BRAVO_GOALS_FAKE_FEDERAL_JUDGE_VERDICT ?? process.env.BRAVO_GOALS_FAKE_JUDGE_VERDICT)
		: process.env.BRAVO_GOALS_FAKE_JUDGE_VERDICT;
	if (fakeVerdict === "pass" || fakeVerdict === "fail" || fakeVerdict === "needs_more_evidence" || fakeVerdict === "blocked") {
		await writeFakeJudgeVerdict(runDir, fakeVerdict);
		return;
	}

	const extensionPath = resolveJudgeExtensionPath();
	const modelArgs = modelCliArgs(options.model);
	const taskPrompt = await readFile(join(runDir, "prompt", "task.md"), "utf8");
	const systemPrompt = join(runDir, "prompt", "system.md");
	const child = spawn("pi", [
		"--print",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-extensions",
		"--extension",
		extensionPath,
		"--tools",
		run.allowed_tools.join(","),
		"--append-system-prompt",
		systemPrompt,
		"--session-dir",
		join(runDir, "pi-session"),
		...modelArgs,
		renderJudgeInstruction(taskPrompt),
	], {
		cwd: run.cwd || options.workspaceRoot,
		env: {
			...process.env,
			BRAVO_JUDGE_RUN_DIR: runDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	const result = await waitForProcess(child, options.timeoutMs);
	await Promise.all([
		writeFile(join(runDir, "logs", "pi-stdout.log"), result.stdout),
		writeFile(join(runDir, "logs", "pi-stderr.log"), result.stderr),
	]);
	if (result.timedOut) {
		await updateJudgeRunStatus(runDir, "timed_out");
		throw new Error("Judge timed out.");
	}
	if (result.code !== 0) {
		throw new Error(`Judge process exited ${result.code}: ${result.stderr.slice(0, 800)}`);
	}
}

export function resolveJudgeExtensionPath(extensionDir = dirname(fileURLToPath(import.meta.url))): string {
	const compiled = resolve(extensionDir, "index.js");
	if (existsSync(compiled)) return compiled;
	const source = resolve(extensionDir, "index.ts");
	if (existsSync(source)) return source;
	return compiled;
}

function renderJudgeInstruction(taskPrompt: string): string {
	return `${taskPrompt}

Read the relevant goal files, receipts, and implementation files. Verify the claims with concrete file/command evidence.
Use explicit fail-fast timeouts for tests, builds, git remote operations, package installs, and network/API calls; disable interactive git/SSH prompts where practical. If a check cannot be safely bounded, record it as missing or weak evidence instead of running it unbounded.
You must finish by calling judge_finish with the verdict and the exact Judge receipt path from the prompt.
Do not implement or fix code.`;
}

function modelCliArgs(model: unknown): string[] {
	if (!model || typeof model !== "object") return [];
	const rec = model as Record<string, unknown>;
	const provider = typeof rec.provider === "string" ? rec.provider : null;
	const id = typeof rec.id === "string" ? rec.id : null;
	return provider && id ? ["--model", `${provider}/${id}`] : [];
}

async function writeFakeJudgeVerdict(runDir: string, verdictKind: JudgeContractVerdict): Promise<void> {
	const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as JudgeRunConfig;
	const verdict: JudgeVerdictFile = {
		schema_version: 1,
		run_id: run.run_id,
		goal_id: run.goal_id,
		task_id: run.task_id,
		final_audit: run.final_audit,
		verdict: verdictKind,
		receipt_path: run.judge_receipt_path,
		evidence_checked: [],
		commands_run: [],
		inspection_helpers: [],
		missing_or_weak_evidence: [],
		recommendation: verdictKind === "pass" ? "advance_task" : "return_to_worker",
		follow_up_tasks: run.final_audit && verdictKind !== "pass" ? [{
			title: "Address Federal Judge findings",
			verify: ["Re-run the failing Federal Judge evidence checks."],
			expected_output: ["The integrated implementation satisfies the full Bravo goal without the Federal Judge finding."],
			context_switch_severity: "medium",
		}] : undefined,
		created_at: new Date().toISOString(),
	};
	await writeJudgeVerdict(runDir, verdict, `---
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

# ${run.final_audit ? "Federal Judge Receipt" : "Judge Receipt"}

Fake ${run.final_audit ? "Federal Judge" : "Judge"} verdict for deterministic tests.
`);
	await updateJudgeRunStatus(runDir, verdictKind === "blocked" ? "blocked" : verdictKind === "pass" ? "succeeded" : "failed");
}

async function createRetryAttempt(options: AutonomousJudgeOptions, previousAttempt: AttemptHandle, attemptNumber: number): Promise<AttemptHandle> {
	const previous = JSON.parse(await readFile(join(previousAttempt.runDir, "run.json"), "utf8")) as JudgeRunConfig;
	const retry = await createJudgeRun({
		workspaceRoot: options.workspaceRoot,
		goalId: options.goalId,
		taskId: options.taskId,
		finalAudit: previous.final_audit,
		workerReceiptPath: previous.worker_receipt_path,
		judgeReceiptPath: previous.judge_receipt_path.replace(/\.md$/, `-attempt-${attemptNumber}.md`),
		cwd: previous.cwd,
		verificationCommands: previous.verification_commands,
		timeoutMs: previous.timeout_ms,
		runId: `${previous.run_id}_retry_${attemptNumber}`,
	});
	const state = await readGoalState(options.goalDir);
	await writeGoalState(options.goalDir, {
		...state,
		session: { ...state.session, current_judge_run_id: retry.runId },
	});
	return {
		runId: retry.runId,
		runDir: retry.runDir,
		judgeReceiptPath: retry.config.judge_receipt_path,
	};
}

async function createFinalAuditRetryAttempt(options: AutonomousJudgeOptions, previous: AttemptHandle, attemptNumber: number): Promise<AttemptHandle> {
	const previousRun = JSON.parse(await readFile(join(previous.runDir, "run.json"), "utf8")) as JudgeRunConfig;
	const retry = await createJudgeRun({
		workspaceRoot: options.workspaceRoot,
		goalId: options.goalId,
		taskId: "final",
		finalAudit: true,
		workerReceiptPath: null,
		judgeReceiptPath: previousRun.judge_receipt_path.replace(/\.md$/, `-attempt-${attemptNumber}.md`),
		cwd: previousRun.cwd,
		verificationCommands: previousRun.verification_commands,
		timeoutMs: previousRun.timeout_ms,
		runId: `${previousRun.run_id}_retry_${attemptNumber}`,
	});
	const state = await readGoalState(options.goalDir);
	await writeGoalState(options.goalDir, {
		...state,
		session: { ...state.session, current_judge_run_id: retry.runId },
	});
	return {
		runId: retry.runId,
		runDir: retry.runDir,
		judgeReceiptPath: retry.config.judge_receipt_path,
	};
}

async function markAttemptFailed(runDir: string, error: string): Promise<void> {
	try {
		await writeFile(join(runDir, "logs", "controller-error.log"), `${error}\n`);
		const completion = await validateJudgeCompletion(runDir);
		if (!completion.status || completion.status.status === "created" || completion.status.status === "running") {
			await updateJudgeRunStatus(runDir, "failed");
		}
	} catch {
		// The original error is more useful than a secondary status-write failure.
	}
}

function nextActionForVerdict(verdict: JudgeContractVerdict): AutonomousJudgeOutcome["nextAction"] {
	if (verdict === "pass") return "continue";
	if (verdict === "blocked") return "blocked";
	return "return_to_worker";
}

function buildFederalFollowUpTasks(state: GoalState, verdict: JudgeVerdictFile): GoalTask[] {
	const rawTasks = Array.isArray(verdict.follow_up_tasks) ? verdict.follow_up_tasks : [];
	const candidates = rawTasks.length > 0 ? rawTasks : [{
		title: "Address Federal Judge findings",
		verify: verdict.missing_or_weak_evidence.map((item) => String(item)).filter(Boolean),
		expected_output: ["Federal Judge passes the integrated goal review."],
		context_switch_severity: "medium" as const,
	}];
	const existingIds = new Set(state.tasks.map((task) => task.id));
	return candidates.map((candidate, index): GoalTask => {
		const baseId = candidate.id ? slug(candidate.id) : `federal-remediation-${state.tasks.length + index + 1}`;
		const id = uniqueTaskId(existingIds, baseId || `federal-remediation-${index + 1}`);
		existingIds.add(id);
		return {
			id,
			title: candidate.title || "Address Federal Judge findings",
			kind: "work",
			status: "queued",
			boundary_after_pass: "inherit",
			context_switch_severity: candidate.context_switch_severity ?? "medium",
			receipt: null,
			judge_receipt: null,
			verify: candidate.verify ?? [],
			expected_output: candidate.expected_output ?? ["Federal Judge passes the integrated goal review."],
		};
	});
}

function activateFederalFollowUpTasks(state: GoalState, followUpTasks: GoalTask[]): GoalState {
	const tasks = [...state.tasks, ...followUpTasks];
	const firstFollowUpId = followUpTasks[0]?.id ?? null;
	const nextTasks = tasks.map((task) => task.id === firstFollowUpId ? { ...task, status: "active" as const } : task);
	return refreshProgress({
		...state,
		goal: { ...state.goal, status: firstFollowUpId ? "active" : "blocked" },
		active_task: firstFollowUpId,
		tasks: nextTasks,
	});
}

function uniqueTaskId(existing: Set<string>, preferred: string): string {
	let candidate = preferred;
	let suffix = 2;
	while (existing.has(candidate)) {
		candidate = `${preferred}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}

function slug(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function waitForProcess(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.stdout?.on("data", (data) => { stdout += data.toString(); });
		child.stderr?.on("data", (data) => { stderr += data.toString(); });
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, stdout, stderr, timedOut });
		});
	});
}

export function relativeRunPath(workspaceRoot: string, runDir: string): string {
	return relative(workspaceRoot, join(runDir, "run.json"));
}
