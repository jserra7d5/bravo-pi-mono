import assert from "node:assert/strict";
import test from "node:test";
import {
	renderCarryContinuationPrompt,
	renderCheckpointPrompt,
	renderHandoffContinuationPrompt,
	renderIdleRecoveryPrompt,
	renderWorkerResumePrompt,
	renderWorkerStartPrompt,
	type PromptGoalState,
} from "../src/prompts.js";
import { renderRestartPrompt, renderWorkerPrompt } from "../src/runtime.js";
import type { GoalState } from "../src/types.js";

const promptState: PromptGoalState = {
	goal: { id: "prompt-goal", title: "Prompt Goal", status: "active" },
	active_task: "task-one",
	tasks: [{ id: "task-one", title: "Task One", status: "active", receipt: "receipts/task-one-worker.md" }],
};

function fullState(): GoalState {
	return {
		schema_version: 1,
		goal: {
			id: "prompt-goal",
			title: "Prompt Goal",
			status: "active",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		},
		repos: [],
		session: {
			attached_pi_session_id: "pi_prompt",
			current_worker_turn_id: null,
			current_judge_run_id: null,
		},
		active_task: "task-one",
		tasks: [{
			id: "task-one",
			title: "Task One",
			kind: "work",
			status: "active",
			boundary_after_pass: "inherit",
			context_switch_severity: "medium",
			receipt: "receipts/task-one-worker.md",
			judge_receipt: null,
			verify: ["verify it"],
			expected_output: ["it is verified"],
		}],
		judge: {
			last_verdict: "none",
			last_receipt: null,
			active: false,
		},
		progress: {
			completed_tasks: 0,
			total_tasks: 1,
		},
		pause: {
			paused_at: null,
			pause_reason: null,
			resume_context: "",
		},
		phase_boundary: {
			default_after_judge_pass: "carry",
			after_judge_fail: "carry",
			before_final_audit: "carry",
			experimental_flags: {
				allow_per_task_boundary: true,
				allow_runtime_override: true,
				auto_select_from_context_switch_severity: true,
			},
			compact_custom_instructions: null,
			last_boundary_at: null,
			last_boundary_mode: null,
			last_boundary_reason: null,
		},
		final_audit: {
			status: "pending",
			receipt: null,
			judge_run_id: null,
		},
		user_verification: {
			status: "pending",
			verified_at: null,
			verified_by: null,
			note: null,
		},
		archive: {
			archived_at: null,
			archived_path: null,
			forced: false,
			reason: null,
		},
	};
}

test("worker start and resume prompts expose distinct lifecycle semantics", () => {
	const start = renderWorkerStartPrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace" });
	assert.match(start, /fresh worker-start prompt/);
	assert.match(start, /Read these files before acting/);
	assert.match(start, /task_receipt_ready with goal_id: prompt-goal/);

	const resume = renderWorkerResumePrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace" });
	assert.match(resume, /fresh Pi session/);
	assert.match(resume, /resume\.md exists/);
	assert.match(resume, /Do not redo completed tasks/);
});

test("carry, compact, fresh, and durable handoff prompts are lifecycle-specific", () => {
	const carry = renderCarryContinuationPrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace", mode: "carry" });
	assert.match(carry, /No handoff or compaction occurred/);
	assert.doesNotMatch(carry, /Read these files before acting/);

	const compact = renderHandoffContinuationPrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace", mode: "compact", boundaryReason: "medium context switch" });
	assert.match(compact, /Compaction handoff completed/);
	assert.match(compact, /Boundary reason: medium context switch/);
	assert.match(compact, /Read these files before acting/);

	const fresh = renderHandoffContinuationPrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace", mode: "fresh_session" });
	assert.match(fresh, /Fresh-session handoff is in effect/);
	assert.match(fresh, /replacement session/);

	const durable = renderHandoffContinuationPrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace", mode: "durable_current_session" });
	assert.match(durable, /cannot create the replacement session/);
	assert.match(durable, /durable current-session continuation/);
});

test("idle recovery prompt diagnoses prior stop before continuing", () => {
	const prompt = renderIdleRecoveryPrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace", nudgeCount: 2 });
	assert.match(prompt, /Recover Bravo goal/);
	assert.match(prompt, /not a fresh task start/);
	assert.match(prompt, /first diagnose why the prior turn stopped/);
	assert.match(prompt, /genuine unresolved user question/);
});

test("checkpoint prompt preserves in-session context without inventing completion", () => {
	const prompt = renderCheckpointPrompt({ goalDir: "/workspace/.bravo/goals/prompt-goal", state: promptState, cwd: "/workspace" });
	assert.match(prompt, /Combine current conversation context, recent tool results, known blockers, and durable files/);
	assert.match(prompt, /may not be represented in state\.yaml yet/);
	assert.match(prompt, /Do not mark the goal or task complete unless state\.yaml and receipts already prove completion/);
});

test("runtime compatibility prompts keep absolute paths when cwd is omitted", () => {
	const state = fullState();
	const worker = renderWorkerPrompt(state, "/workspace/.bravo/goals/prompt-goal");
	assert.match(worker, /\/workspace\/\.bravo\/goals\/prompt-goal\/goal\.md/);
	assert.match(worker, /\/workspace\/\.bravo\/goals\/prompt-goal\/state\.yaml/);

	const restart = renderRestartPrompt(state, "/workspace/.bravo/goals/prompt-goal");
	assert.match(restart, /\/workspace\/\.bravo\/goals\/prompt-goal\/goal\.md/);
	assert.match(restart, /\/workspace\/\.bravo\/goals\/prompt-goal\/resume\.md/);
});
