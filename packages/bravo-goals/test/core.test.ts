import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverWorkspaceRoot, scaffoldGoalWorkspace } from "../src/workspace.js";
import { applyJudgeVerdict, createGoalState, loadGoalState, markJudgeStarted, markWorkerReceiptReady, saveGoalState } from "../src/state.js";
import { checkGoal } from "../src/checker.js";
import { parseReceiptMarkdown, validateReceipt } from "../src/receipts.js";

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "bravo-goals-"));
}

test("workspace discovery is explicit and scaffold creates required goal entries", async () => {
	const root = await tempRoot();
	const nested = join(root, "repo", "src");
	await mkdir(nested, { recursive: true });
	assert.equal(await discoverWorkspaceRoot(nested), null);

	const scaffold = await scaffoldGoalWorkspace({
		workspaceRoot: root,
		goalId: "durable-resume-loop",
		title: "Durable Resume Loop",
		tasks: [{ id: "implement-checkpoint", title: "Implement checkpoint" }],
		now: "2026-05-17T10:00:00.000Z",
	});
	assert.equal(await discoverWorkspaceRoot(nested), root);
	assert.equal(scaffold.state.active_task, "implement-checkpoint");

	const state = await loadGoalState(join(scaffold.goalPath, "state.yaml"));
	assert.equal(state.goal.id, "durable-resume-loop");
	assert.equal(state.progress.total_tasks, 1);

	const result = await checkGoal({ goalPath: scaffold.goalPath });
	assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("state checker rejects bad progress and invalid null active_task", async () => {
	const root = await tempRoot();
	const scaffold = await scaffoldGoalWorkspace({
		workspaceRoot: root,
		goalId: "bad-state",
		tasks: [{ id: "task-one", title: "Task One" }],
		now: "2026-05-17T10:00:00.000Z",
	});
	const state = await loadGoalState(join(scaffold.goalPath, "state.yaml"));
	state.active_task = null;
	state.progress.completed_tasks = 5;
	await saveGoalState(join(scaffold.goalPath, "state.yaml"), state);

	const result = await checkGoal({ goalPath: scaffold.goalPath });
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.code === "ACTIVE_TASK_NULL_INVALID"));
});

test("receipt validation requires evidence for complete worker claims", () => {
	const receipt = parseReceiptMarkdown(`---
schema_version: 1
type: worker
task_id: task-one
status: complete
created_at: "2026-05-17T12:15:00-07:00"
files_changed: []
commands: []
claims:
  - claim: "Implemented the thing"
    evidence: []
remaining_risk: []
---

# Worker Receipt
`);
	const issues = validateReceipt(receipt, { expectedType: "worker", taskId: "task-one" });
	assert.ok(issues.some((issue) => issue.code === "RECEIPT_CLAIM_EVIDENCE_REQUIRED"));
});

test("done tasks require worker and judge receipts", async () => {
	const root = await tempRoot();
	const scaffold = await scaffoldGoalWorkspace({
		workspaceRoot: root,
		goalId: "receipt-gates",
		tasks: [{ id: "task-one", title: "Task One" }],
		now: "2026-05-17T10:00:00.000Z",
	});
	const state = await loadGoalState(join(scaffold.goalPath, "state.yaml"));
	state.tasks[0] = { ...state.tasks[0]!, status: "done", receipt: null, judge_receipt: null };
	state.active_task = null;
	state.goal.status = "done";
	state.final_audit.status = "passed";
	state.final_audit.receipt = "receipts/final-audit.md";
	state.final_audit.judge_run_id = "judge_final";
	await saveGoalState(join(scaffold.goalPath, "state.yaml"), state);

	const result = await checkGoal({ goalPath: scaffold.goalPath });
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.code === "WORKER_RECEIPT_MISSING"));
	assert.ok(result.issues.some((issue) => issue.code === "JUDGE_RECEIPT_MISSING"));
});

test("state machine transitions worker receipt through passing judge verdict", () => {
	let state = createGoalState({
		id: "machine",
		title: "Machine",
		tasks: [
			{ id: "one", title: "One" },
			{ id: "two", title: "Two" },
		],
		now: "2026-05-17T10:00:00.000Z",
	});
	state = markWorkerReceiptReady(state, "one", "receipts/001-worker.md").state;
	assert.equal(state.tasks[0]?.status, "awaiting_judge");
	state = markJudgeStarted(state, "one", "judge_1").state;
	assert.equal(state.goal.status, "judging");
	state = applyJudgeVerdict(state, "one", "pass", "receipts/002-judge.md").state;
	assert.equal(state.tasks[0]?.status, "done");
	assert.equal(state.tasks[1]?.status, "active");
	assert.equal(state.active_task, "two");
	assert.deepEqual(state.progress, { completed_tasks: 1, total_tasks: 2 });
});

test("archive gates require final audit, user verification, and detached session", async () => {
	const root = await tempRoot();
	const scaffold = await scaffoldGoalWorkspace({
		workspaceRoot: root,
		goalId: "archive-gates",
		tasks: [{ id: "task-one", title: "Task One" }],
		now: "2026-05-17T10:00:00.000Z",
	});
	const worker = `---
schema_version: 1
type: worker
task_id: task-one
status: complete
created_at: "2026-05-17T12:15:00-07:00"
files_changed: []
commands: []
claims:
  - claim: "Task one complete"
    evidence:
      - "goal.md"
remaining_risk: []
---
# Worker
`;
	const judge = `---
schema_version: 1
type: judge
run_id: judge_one
task_id: task-one
verdict: pass
created_at: "2026-05-17T12:20:00-07:00"
verdict_path: ".bravo/runs/judge_one/verdict.json"
receipt_path: "receipts/002-judge.md"
commands: []
inspection_helpers: []
claims_checked:
  - claim: "Task one complete"
    result: pass
    evidence:
      - "goal.md"
---
# Judge
`;
	const finalAudit = judge.replaceAll("task-one", "final").replaceAll("judge_one", "judge_final").replace("receipts/002-judge.md", "receipts/final-audit.md");
	await writeFile(join(scaffold.goalPath, "receipts", "001-worker.md"), worker);
	await writeFile(join(scaffold.goalPath, "receipts", "002-judge.md"), judge);
	await writeFile(join(scaffold.goalPath, "receipts", "final-audit.md"), finalAudit);
	const state = await loadGoalState(join(scaffold.goalPath, "state.yaml"));
	state.tasks[0] = { ...state.tasks[0]!, status: "done", receipt: "receipts/001-worker.md", judge_receipt: "receipts/002-judge.md" };
	state.active_task = null;
	state.goal.status = "archived";
	state.final_audit = { status: "passed", receipt: "receipts/final-audit.md", judge_run_id: "judge_final" };
	state.archive = { archived_at: "2026-05-17T13:00:00-07:00", archived_path: ".bravo/archived/goals/2026-05-17-archive-gates", forced: false, reason: null };
	await saveGoalState(join(scaffold.goalPath, "state.yaml"), state);

	const result = await checkGoal({ goalPath: scaffold.goalPath });
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.code === "ARCHIVE_USER_VERIFICATION_REQUIRED"));
});

test("goal check rejects forged Judge receipt without terminal run artifacts", async () => {
	const root = await tempRoot();
	const scaffold = await scaffoldGoalWorkspace({
		workspaceRoot: root,
		goalId: "forged-judge",
		tasks: [{ id: "task-one", title: "Task One" }],
		now: "2026-05-17T10:00:00.000Z",
	});
	await writeFile(join(scaffold.goalPath, "receipts", "001-worker.md"), `---
schema_version: 1
type: worker
task_id: task-one
status: complete
created_at: "2026-05-17T12:15:00-07:00"
files_changed: []
commands: []
claims:
  - claim: "Task one complete"
    evidence:
      - "goal.md"
remaining_risk: []
---
# Worker
`);
	await writeFile(join(scaffold.goalPath, "receipts", "002-judge.md"), `---
schema_version: 1
type: judge
run_id: judge_missing
task_id: task-one
verdict: pass
created_at: "2026-05-17T12:20:00-07:00"
verdict_path: ".bravo/runs/judge_missing/verdict.json"
receipt_path: ".bravo/goals/forged-judge/receipts/002-judge.md"
commands: []
inspection_helpers: []
claims_checked: []
---
# Judge
`);
	const state = await loadGoalState(join(scaffold.goalPath, "state.yaml"));
	state.tasks[0] = { ...state.tasks[0]!, status: "done", receipt: "receipts/001-worker.md", judge_receipt: "receipts/002-judge.md" };
	state.active_task = null;
	state.goal.status = "final_audit";
	await saveGoalState(join(scaffold.goalPath, "state.yaml"), state);

	const result = await checkGoal({ goalPath: scaffold.goalPath });
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.code === "JUDGE_RUN_INVALID"));
});
