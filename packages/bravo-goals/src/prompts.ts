import { join, relative } from "node:path";

export interface PromptTask {
	id: string;
	title: string;
	status?: string;
	receipt?: string | null;
}

export interface PromptGoalState {
	goal: {
		id: string;
		title: string;
		status: string;
	};
	active_task: string | null;
	tasks: PromptTask[];
}

export interface WorkerPromptOptions {
	goalDir: string;
	state: PromptGoalState;
	cwd?: string;
	intro?: string;
}

export interface HandoffPromptOptions extends WorkerPromptOptions {
	mode: "carry" | "compact" | "fresh_session" | "durable_current_session";
	boundaryReason?: string | null;
}

export interface IdleRecoveryPromptOptions extends WorkerPromptOptions {
	nudgeCount?: number;
}

function fromCwd(cwd: string | undefined, path: string): string {
	if (!cwd) return path;
	return relative(cwd, path) || ".";
}

export function workerReceiptTemplate(taskId: string): string {
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

export function activePromptTask(state: PromptGoalState): PromptTask | null {
	return state.tasks.find((task) => task.id === state.active_task) ?? null;
}

export function expectedWorkerReceiptPath(task: PromptTask | null): string | null {
	if (!task) return null;
	return task.receipt ?? `receipts/${task.id}-worker.md`;
}

export function renderReadList(goalDir: string, cwd?: string): string {
	return [
		`1. ${fromCwd(cwd, join(goalDir, "goal.md"))}`,
		`2. ${fromCwd(cwd, join(goalDir, "context.md"))}`,
		`3. ${fromCwd(cwd, join(goalDir, "state.yaml"))}`,
		`4. ${fromCwd(cwd, join(goalDir, "resume.md"))} if it exists; it is created only by checkpoint or pause.`,
	].join("\n");
}

function taskLine(task: PromptTask | null): string {
	return task ? `${task.id}: ${task.title}` : "no active task";
}

function receiptBlock(goalId: string, goalDir: string, task: PromptTask | null, cwd?: string): string {
	const receiptPath = expectedWorkerReceiptPath(task);
	const receiptFullPath = receiptPath ? join(goalDir, receiptPath) : null;
	if (!task || !receiptPath || !receiptFullPath) {
		return "No active task receipt path is available. Continue only if state.yaml identifies a valid active task.";
	}
	return [
		`Expected worker receipt path for task_receipt_ready: ${receiptPath}`,
		`Write the receipt file at: ${receiptFullPath}`,
		"",
		`When the active task is complete, write the worker receipt file at the full path above using this exact YAML-frontmatter shape, then Markdown details after the closing ---:`,
		"",
		workerReceiptTemplate(task.id),
		"",
		`Then call task_receipt_ready with goal_id: ${goalId} and receipt_path: ${receiptPath}. Do not create receipts under the repo directory. Do not edit state.yaml manually for the receipt-ready transition.`,
		`Use ${fromCwd(cwd, join(goalDir, "state.yaml"))} only as durable task state; task_receipt_ready owns the receipt-ready state transition.`,
	].join("\n");
}

export function renderWorkerStartPrompt(options: WorkerPromptOptions): string {
	const task = activePromptTask(options.state);
	return [
		`You are working on Bravo goal "${options.state.goal.title}" (${options.state.goal.id}).`,
		"",
		options.intro ?? "This is a fresh worker-start prompt. Orient from the durable goal files before acting.",
		"",
		"Read these files before acting:",
		renderReadList(options.goalDir, options.cwd),
		"",
		`Active task: ${taskLine(task)}`,
		receiptBlock(options.state.goal.id, options.goalDir, task, options.cwd),
	].join("\n");
}

export function renderWorkerResumePrompt(options: WorkerPromptOptions): string {
	const task = activePromptTask(options.state);
	return [
		`You are resuming Bravo goal "${options.state.goal.title}" (${options.state.goal.id}) in a fresh Pi session.`,
		"",
		"Orient from durable files before acting. If resume.md exists, treat it as a checkpoint summary; state.yaml and receipts remain authoritative.",
		"",
		"Read these files before acting:",
		renderReadList(options.goalDir, options.cwd),
		"",
		`Active task: ${taskLine(task)}`,
		receiptBlock(options.state.goal.id, options.goalDir, task, options.cwd),
		"",
		"Do not redo completed tasks unless state.yaml or a Judge receipt says evidence is weak.",
	].join("\n");
}

export function renderCarryContinuationPrompt(options: HandoffPromptOptions): string {
	const task = activePromptTask(options.state);
	const intro = options.mode === "carry"
		? "No handoff or compaction occurred. Keep using the context already in this session; consult durable files only if current context conflicts with the task boundary or you need exact evidence."
		: "Continue using the current conversation context and the task capsule below.";
	return [
		`Continue Bravo goal "${options.state.goal.title}" (${options.state.goal.id}).`,
		"",
		options.intro ?? intro,
		options.boundaryReason ? `Boundary reason: ${options.boundaryReason}` : null,
		"",
		`Active task: ${taskLine(task)}`,
		receiptBlock(options.state.goal.id, options.goalDir, task, options.cwd),
	].filter((line): line is string => line !== null).join("\n");
}

export function renderHandoffContinuationPrompt(options: HandoffPromptOptions): string {
	const task = activePromptTask(options.state);
	const modeLine = options.mode === "fresh_session"
		? "Fresh-session handoff is in effect. This prompt belongs in the replacement session; orient from durable files rather than relying on prior conversation context."
		: options.mode === "durable_current_session"
			? "Fresh-session handoff was selected, but this tool path cannot create the replacement session. Treat this as a durable current-session continuation: orient from durable files, and use /goal next --fresh later if a separate Pi session is still required."
			: "Compaction handoff completed. Use the compacted summary plus durable files as the source of truth.";
	return [
		`Continue Bravo goal "${options.state.goal.title}" (${options.state.goal.id}).`,
		"",
		modeLine,
		options.boundaryReason ? `Boundary reason: ${options.boundaryReason}` : null,
		"",
		"Read these files before acting:",
		renderReadList(options.goalDir, options.cwd),
		"",
		`Active task: ${taskLine(task)}`,
		receiptBlock(options.state.goal.id, options.goalDir, task, options.cwd),
	].filter((line): line is string => line !== null).join("\n");
}

export function renderIdleRecoveryPrompt(options: IdleRecoveryPromptOptions): string {
	const task = activePromptTask(options.state);
	const nudgeLine = options.nudgeCount ? `Watchdog recovery attempt: ${options.nudgeCount}.` : null;
	return [
		`Recover Bravo goal "${options.state.goal.title}" (${options.state.goal.id}) from an idle worker turn.`,
		"",
		nudgeLine,
		"The prior assistant turn ended while the goal still has an active worker task. This is not a fresh task start; first diagnose why the prior turn stopped, then continue only if the blocker is resolved or no real blocker exists.",
		"",
		"Recovery procedure:",
		"1. Review the latest assistant message and tool results in this conversation to identify whether the agent was waiting for user input, blocked by policy/tooling, or simply stopped early.",
		"2. If the prior turn asked a genuine unresolved user question, do not bulldoze it; restate the question and wait.",
		"3. If the prior blocker has been resolved by newer context, continue from the current conversation and durable state.",
		"4. If the task is already complete, write the worker receipt and call task_receipt_ready.",
		"5. If the task cannot proceed safely, say exactly what remains blocked and why; do not re-inject the cold-start task brief as if nothing happened.",
		"",
		"Durable orientation files, if you need to verify state:",
		renderReadList(options.goalDir, options.cwd),
		"",
		`Active task: ${taskLine(task)}`,
		receiptBlock(options.state.goal.id, options.goalDir, task, options.cwd),
	].filter((line): line is string => line !== null).join("\n");
}

export function renderCheckpointPrompt(options: WorkerPromptOptions): string {
	return [
		`Checkpoint Bravo goal "${options.state.goal.title}" (${options.state.goal.id}).`,
		"",
		"Read durable state before writing the checkpoint:",
		renderReadList(options.goalDir, options.cwd),
		"",
		`Refresh ${fromCwd(options.cwd, join(options.goalDir, "resume.md"))} with the current durable resume context for the active task.`,
		"Combine current conversation context, recent tool results, known blockers, and durable files; checkpointing exists to preserve useful in-session state that may not be represented in state.yaml yet.",
		"Include current task status, completed evidence, known blockers, receipt/Judge status, relevant files changed, and the next concrete action.",
		"Do not mark the goal or task complete unless state.yaml and receipts already prove completion.",
	].join("\n");
}
