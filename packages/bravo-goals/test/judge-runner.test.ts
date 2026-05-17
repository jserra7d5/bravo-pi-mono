import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	createJudgeRun,
	updateJudgeRunStatus,
	validateJudgeCommandPolicy,
	validateJudgeCompletion,
	writeJudgeVerdict,
	type JudgeVerdictFile
} from "../src/judge-runner.js";

test("createJudgeRun writes canonical run files and goal-local pointers", async () => {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "bravo-goals-judge-"));
	try {
		const run = await createJudgeRun({
			workspaceRoot,
			goalId: "durable-resume-loop",
			taskId: "implement-resume-checkpoint",
			workerReceiptPath: ".bravo/goals/durable-resume-loop/receipts/001-worker.md",
			judgeReceiptPath: ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
			runId: "01HX",
			createdAt: "2026-05-17T12:20:00-07:00"
		});

		assert.equal(run.runId, "judge_01HX");
		const runJson = JSON.parse(await readFile(run.runPath, "utf8"));
		assert.equal(runJson.command_policy.mode, "judge_bash");
		assert.equal(runJson.command_policy.unsafe_raw_bash, false);
		assert.deepEqual(runJson.allowed_tools, ["read", "grep", "ls", "judge_bash", "judge_finish"]);
		assert.equal(runJson.timeout_ms, 900000);

		const statusJson = JSON.parse(await readFile(run.statusPath, "utf8"));
		assert.equal(statusJson.status, "created");
		assert.match(await readFile(run.eventsPath, "utf8"), /"judge.created"/);
		assert.match(await readFile(join(run.runDir, "prompt", "system.md"), "utf8"), /Raw bash is not allowed/);
		assert.equal((await stat(join(run.runDir, "home", ".pi", "agent"))).isDirectory(), true);
		assert.equal((await stat(join(run.runDir, "pi-session", "session.jsonl"))).isFile(), true);

		const current = JSON.parse(await readFile(run.goalJudgeCurrentPath, "utf8"));
		const pointer = JSON.parse(await readFile(run.goalJudgeRunPath, "utf8"));
		assert.equal(current.run_path, ".bravo/runs/judge_01HX/run.json");
		assert.equal(pointer.receipt_path, ".bravo/goals/durable-resume-loop/receipts/002-judge.md");
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("raw bash policy requires unsafe_raw_bash", () => {
	assert.throws(
		() => validateJudgeCommandPolicy({ mode: "raw_bash", unsafe_raw_bash: false }, ["read", "bash", "judge_finish"]),
		/unsafe_raw_bash/
	);
	assert.throws(
		() => validateJudgeCommandPolicy({ mode: "judge_bash", unsafe_raw_bash: false }, ["read", "bash", "judge_finish"]),
		/raw Pi bash/i
	);
	assert.doesNotThrow(() =>
		validateJudgeCommandPolicy({ mode: "raw_bash", unsafe_raw_bash: true }, ["read", "bash", "judge_finish"])
	);
});

test("validateJudgeCompletion accepts terminal status with matching verdict and receipt", async () => {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "bravo-goals-judge-"));
	try {
		const run = await createJudgeRun({
			workspaceRoot,
			goalId: "durable-resume-loop",
			taskId: "implement-resume-checkpoint",
			workerReceiptPath: ".bravo/goals/durable-resume-loop/receipts/001-worker.md",
			judgeReceiptPath: ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
			runId: "01HX",
			createdAt: "2026-05-17T12:20:00-07:00"
		});
		const verdict = makeVerdict("pass");
		await writeJudgeVerdict(run.runDir, verdict, makeReceipt("pass"));
		await updateJudgeRunStatus(run.runDir, "succeeded", { at: "2026-05-17T12:21:00-07:00" });

		const result = await validateJudgeCompletion(run.runDir);
		assert.equal(result.ok, true);
		assert.deepEqual(result.issues, []);
		assert.equal(result.verdict?.verdict, "pass");
		assert.equal(result.receiptFrontmatter?.verdict, "pass");
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("validateJudgeCompletion rejects non-terminal status and verdict receipt disagreement", async () => {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "bravo-goals-judge-"));
	try {
		const run = await createJudgeRun({
			workspaceRoot,
			goalId: "durable-resume-loop",
			taskId: "implement-resume-checkpoint",
			judgeReceiptPath: ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
			runId: "01HX"
		});
		await writeJudgeVerdict(run.runDir, makeVerdict("pass"), makeReceipt("fail"));

		const result = await validateJudgeCompletion(run.runDir);
		assert.equal(result.ok, false);
		assert.match(result.issues.join("\n"), /run status is not terminal: created/);
		assert.match(result.issues.join("\n"), /Judge receipt verdict does not match expected value/);
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("timeout and cancellation are terminal without a verdict", async () => {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "bravo-goals-judge-"));
	try {
		const run = await createJudgeRun({
			workspaceRoot,
			goalId: "durable-resume-loop",
			taskId: "implement-resume-checkpoint",
			judgeReceiptPath: ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
			runId: "01HX"
		});
		await updateJudgeRunStatus(run.runDir, "timed_out", { at: "2026-05-17T12:21:00-07:00" });

		const statusJson = JSON.parse(await readFile(run.statusPath, "utf8"));
		assert.equal(statusJson.status, "timed_out");
		assert.equal(statusJson.finished_at, "2026-05-17T12:21:00-07:00");
		const pointerJson = JSON.parse(await readFile(run.goalJudgeRunPath, "utf8"));
		assert.equal(pointerJson.status, "timed_out");
		assert.match(await readFile(run.eventsPath, "utf8"), /"judge.timed_out"/);
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

function makeVerdict(verdict: "pass" | "fail"): JudgeVerdictFile {
	return {
		schema_version: 1,
		run_id: "judge_01HX",
		goal_id: "durable-resume-loop",
		task_id: "implement-resume-checkpoint",
		final_audit: false,
		verdict,
		receipt_path: ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
		evidence_checked: ["packages/bravo-goals/src/judge-runner.ts"],
		commands_run: [],
		inspection_helpers: [],
		missing_or_weak_evidence: [],
		recommendation: verdict === "pass" ? "advance_task" : "return_to_worker",
		created_at: "2026-05-17T12:20:00-07:00"
	};
}

function makeReceipt(verdict: "pass" | "fail"): string {
	return `---
schema_version: 1
type: judge
run_id: judge_01HX
task_id: implement-resume-checkpoint
verdict: ${verdict}
created_at: "2026-05-17T12:20:00-07:00"
verdict_path: ".bravo/runs/judge_01HX/verdict.json"
receipt_path: ".bravo/goals/durable-resume-loop/receipts/002-judge.md"
commands: []
inspection_helpers: []
claims_checked:
  - claim: "Judge runner contract exists"
    result: ${verdict}
    evidence:
      - "packages/bravo-goals/src/judge-runner.ts"
---

# Judge Receipt
`;
}
