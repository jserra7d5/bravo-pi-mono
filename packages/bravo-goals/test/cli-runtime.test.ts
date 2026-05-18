import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { checkGoal } from "../src/checker.js";
import { archiveGoal } from "../src/archive.js";
import { readGoalState, recoverActiveGoalsIndex, upsertActiveGoal, writeGoalState } from "../src/runtime.js";
import { scaffoldGoalWorkspace } from "../src/workspace.js";
import { createJudgeRun, updateJudgeRunStatus, writeJudgeVerdict, type JudgeVerdictFile } from "../src/judge-runner.js";

test("init and prep scaffold durable goal workspace", async () => {
	const root = await tempRoot();
	assert.equal(await main(["init", "--workspace-root", root]), 0);
	assert.equal(await main(["prep", "durable-resume-loop", "--workspace-root", root]), 0);

	for (const required of ["goal.md", "context.md", "state.yaml", "receipts", "artifacts"]) {
		assert.ok(await exists(join(root, ".bravo", "goals", "durable-resume-loop", required)), required);
	}
	assert.equal(await exists(join(root, ".bravo", "goals", "durable-resume-loop", "resume.md")), false);
	const state = await readGoalState(join(root, ".bravo", "goals", "durable-resume-loop"));
	assert.equal(state.goal.status, "draft");
	assert.equal(state.goal.title, "TBD");
	assert.equal(state.phase_boundary.default_after_judge_pass, "carry");
});

test("prep stores provided title without deriving title from goal id", async () => {
	const root = await tempRoot();
	assert.equal(await main(["init", "--workspace-root", root]), 0);
	assert.equal(await main(["prep", "structured-log-roger-prod-refactor", "--workspace-root", root, "--title", "Roger logging cleanup"]), 0);

	const state = await readGoalState(join(root, ".bravo", "goals", "structured-log-roger-prod-refactor"));
	assert.equal(state.goal.title, "Roger logging cleanup");
});

test("check rejects done tasks with missing receipts", async () => {
	const root = await tempRoot();
	const goalDir = (await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "receipt-gap" })).goalPath;
	const state = await readGoalState(goalDir);
	state.goal.status = "done";
	state.active_task = null;
	state.tasks.push({
		id: "task-one",
		title: "Task one",
		kind: "work",
		status: "done",
		boundary_after_pass: "inherit",
		context_switch_severity: "low",
		receipt: "receipts/worker.md",
		judge_receipt: null,
		verify: [],
		expected_output: [],
	});
	state.progress = { completed_tasks: 1, total_tasks: 1 };
	await writeGoalState(goalDir, state);

	const result = await checkGoal({ goalPath: goalDir });
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.code === "RECEIPT_PARSE_FAILED"));
	assert.ok(result.issues.some((issue) => issue.code === "JUDGE_RECEIPT_MISSING"));
});

test("runtime index can recover from goal state", async () => {
	const root = await tempRoot();
	const goalDir = (await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "active-index" })).goalPath;
	const state = await readGoalState(goalDir);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_123";
	state.active_task = "task-one";
	await writeGoalState(goalDir, state);

	const index = await recoverActiveGoalsIndex(root);
	assert.equal(index.active_goals.length, 1);
	assert.equal(index.active_goals[0]?.goal_id, "active-index");
	assert.equal(index.active_goals[0]?.pi_session_id, "pi_123");
});

test("next records boundary selection with runtime override", async () => {
	const root = await tempRoot();
	const goalDir = (await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "boundary" })).goalPath;
	const state = await readGoalState(goalDir);
	state.active_task = "task-one";
	state.tasks.push({
		id: "task-one",
		title: "Task one",
		kind: "work",
		status: "done",
		boundary_after_pass: "fresh_session",
		context_switch_severity: "high",
		receipt: null,
		judge_receipt: "receipts/002-judge.md",
		verify: [],
		expected_output: [],
	});
	state.judge.last_verdict = "pass";
	state.judge.last_receipt = "receipts/002-judge.md";
	await writeGoalState(goalDir, state);

	assert.equal(await main(["next", "boundary", "--workspace-root", root, "--compact"]), 0);
	const next = await readGoalState(goalDir);
	assert.equal(next.phase_boundary.last_boundary_mode, "compact");
	assert.match(next.phase_boundary.last_boundary_reason ?? "", /runtime override/);
});

test("archive enforces gates and forced archive records reason", async () => {
	const root = await tempRoot();
	const goalDir = (await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "archive-me" })).goalPath;
	await assert.rejects(() => archiveGoal(root, goalDir), /goal status must be done/);

	const state = await readGoalState(goalDir);
	state.goal.status = "done";
	state.final_audit.status = "passed";
	state.final_audit.receipt = ".bravo/goals/archive-me/receipts/final-audit.md";
	state.final_audit.judge_run_id = "judge_final";
	state.user_verification.status = "verified";
	state.user_verification.verified_at = "2026-05-17T00:00:00.000Z";
	await writeGoalState(goalDir, state);
	await writeFinalJudgeRun(root, "archive-me");
	await upsertActiveGoal(root, {
		goal_id: state.goal.id,
		path: ".bravo/goals/archive-me",
		pi_session_id: null,
		status: "done",
		active_task: null,
	});

	const first = await archiveGoal(root, goalDir, { now: "2026-05-17T12:00:00.000Z" });
	assert.match(first.archivedPath, /2026-05-17-archive-me$/);
	const archivedState = await readGoalState(first.archivedPath);
	assert.equal(archivedState.goal.status, "archived");
	assert.equal(archivedState.archive.forced, false);
	assert.ok(await exists(join(first.archivedPath, "archive.md")));

	const forcedDir = (await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "archive-me" })).goalPath;
	const forced = await archiveGoal(root, forcedDir, {
		force: true,
		reason: "manual cleanup",
		now: "2026-05-17T13:00:00.000Z",
	});
	assert.match(forced.archivedPath, /2026-05-17-archive-me-2$/);
	const forcedState = await readGoalState(forced.archivedPath);
	assert.equal(forcedState.archive.forced, true);
	assert.equal(forcedState.archive.reason, "manual cleanup");
});

test("verify records user verification after final audit", async () => {
	const root = await tempRoot();
	const goalDir = (await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "verify-me" })).goalPath;
	const state = await readGoalState(goalDir);
	state.final_audit.status = "passed";
	state.final_audit.receipt = ".bravo/goals/verify-me/receipts/final-audit.md";
	state.final_audit.judge_run_id = "judge_final";
	await writeGoalState(goalDir, state);
	await writeFinalJudgeRun(root, "verify-me");

	assert.equal(await main(["verify", "verify-me", "--workspace-root", root, "--note", "looks good"]), 0);
	const verified = await readGoalState(goalDir);
	assert.equal(verified.user_verification.status, "verified");
	assert.equal(verified.user_verification.note, "looks good");
});

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "bravo-goals-"));
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function writeFinalJudgeRun(root: string, goalId: string): Promise<void> {
	const run = await createJudgeRun({
		workspaceRoot: root,
		goalId,
		taskId: "final",
		finalAudit: true,
		judgeReceiptPath: `.bravo/goals/${goalId}/receipts/final-audit.md`,
		runId: "final",
	});
	const verdict: JudgeVerdictFile = {
		schema_version: 1,
		run_id: "judge_final",
		goal_id: goalId,
		task_id: "final",
		final_audit: true,
		verdict: "pass",
		receipt_path: `.bravo/goals/${goalId}/receipts/final-audit.md`,
		evidence_checked: [],
		commands_run: [],
		inspection_helpers: [],
		missing_or_weak_evidence: [],
		recommendation: "advance_task",
		created_at: "2026-05-17T12:00:00.000Z",
	};
	await writeJudgeVerdict(run.runDir, verdict, `---
schema_version: 1
type: judge
run_id: judge_final
task_id: final
verdict: pass
created_at: "2026-05-17T12:00:00.000Z"
verdict_path: ".bravo/runs/judge_final/verdict.json"
receipt_path: ".bravo/goals/${goalId}/receipts/final-audit.md"
commands: []
inspection_helpers: []
claims_checked: []
---

# Final Audit
`);
	await updateJudgeRunStatus(run.runDir, "succeeded", { at: "2026-05-17T12:01:00.000Z" });
}
