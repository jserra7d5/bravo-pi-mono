import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderHud, renderStatusLine, snapshotForSession, type HudSnapshot } from "../extensions/pi/hud.js";
import { testables } from "../extensions/pi/commands.js";
import { registerJudgeControlTools } from "../extensions/pi/judge-control.js";
import { scaffoldGoalWorkspace } from "../src/workspace.js";
import { readGoalState, upsertActiveGoal, writeGoalState } from "../src/runtime.js";

const snapshot: HudSnapshot = {
	goalPath: "/workspace/.bravo/goals/durable-resume-loop",
	state: {
		goal: {
			id: "durable-resume-loop",
			title: "Durable resume loop",
			status: "active",
		},
		active_task: "checkpoint-writer",
		tasks: [
			{ id: "checkpoint-writer", title: "Implement resume checkpoint writer", status: "active" },
			{ id: "hud", title: "Render HUD", status: "done" },
		],
		judge: {
			last_verdict: "pass",
			active: false,
		},
		progress: {
			completed_tasks: 1,
			total_tasks: 2,
		},
	},
};

test("renders Bravo Goals footer status", () => {
	assert.equal(renderStatusLine(snapshot), "Goal: Durable resume loop 1/2 Judge: pass");
});

test("renders below-editor HUD lines from state", () => {
	assert.deepEqual(renderHud(snapshot), [
		"GOAL  Durable resume loop",
		"STATE active",
		"TASK  Implement resume checkpoint writer",
		"DONE  1/2 [########--------] 50%",
		"JUDGE pass",
	]);
});

test("parses quoted command flags", () => {
	const parsed = testables.parseArgs('verify durable-resume-loop --note "looks good" --force');
	assert.deepEqual(parsed.positional, ["verify", "durable-resume-loop"]);
	assert.equal(parsed.flags.get("note"), "looks good");
	assert.equal(parsed.flags.get("force"), true);
});

test("chooses explicit phase boundary flag", () => {
	const parsed = testables.parseArgs("next durable-resume-loop --fresh");
	assert.equal(testables.boundaryFromFlags(parsed.flags), "fresh_session");
});

test("worker prompt names receipt path and judge_event call", () => {
	const prompt = testables.activeTaskPrompt({
		id: "prompt-goal",
		path: "/workspace/.bravo/goals/prompt-goal",
		state: {
			goal: { id: "prompt-goal", title: "Prompt Goal", status: "active" },
			active_task: "task-one",
			tasks: [{ id: "task-one", title: "Task One", status: "active", receipt: "receipts/custom-worker.md" }],
			progress: { completed_tasks: 0, total_tasks: 1 },
		},
	});
	assert.match(prompt, /Expected worker receipt: receipts\/custom-worker\.md/);
	assert.match(prompt, /judge_event with event: task\.receipt_ready and receipt_path: receipts\/custom-worker\.md/);
	assert.match(prompt, /Do not edit state\.yaml manually/);
});

test("judge_event task.receipt_ready persists active task awaiting Judge", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "receipt-goal", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_receipt";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "receipt-goal",
		path: ".bravo/goals/receipt-goal",
		pi_session_id: "pi_receipt",
		status: "active",
		active_task: "task-one",
	});
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredJudgeEventTool();
	const result = await tool.execute("call_1", {
		goal_id: "receipt-goal",
		event: "task.receipt_ready",
		receipt_path: "receipts/task-one-worker.md",
	}, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_receipt" } });

	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "awaiting_judge");
	assert.equal(next.tasks[0]?.receipt, "receipts/task-one-worker.md");
	assert.equal(next.goal.status, "active");
	assert.match(result.content[0].text, /awaiting Judge/);
});

test("judge_event task.receipt_ready rejects absolute receipt paths outside workspace without mutation or event", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-absolute-"));
	const runDir = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-run-"));
	const outsideReceipt = join(await mkdtemp(join(tmpdir(), "bravo-goals-outside-receipt-")), "worker.md");
	await writeFile(outsideReceipt, workerReceipt("task-one"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "absolute-receipt", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_absolute";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "absolute-receipt",
		path: ".bravo/goals/absolute-receipt",
		pi_session_id: "pi_absolute",
		status: "active",
		active_task: "task-one",
	});

	const tool = registeredJudgeEventTool();
	const previousRunDir = process.env.BRAVO_JUDGE_RUN_DIR;
	process.env.BRAVO_JUDGE_RUN_DIR = runDir;
	try {
		await assert.rejects(
			() => tool.execute("call_1", { goal_id: "absolute-receipt", event: "task.receipt_ready", receipt_path: outsideReceipt }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_absolute" } }),
			/relative to the goal receipts directory/,
		);
		await assert.rejects(() => readFile(join(runDir, "events.jsonl"), "utf8"), /ENOENT/);
	} finally {
		if (previousRunDir === undefined) delete process.env.BRAVO_JUDGE_RUN_DIR;
		else process.env.BRAVO_JUDGE_RUN_DIR = previousRunDir;
	}
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
	assert.equal(next.tasks[0]?.receipt, null);
});

test("judge_event task.receipt_ready rejects traversal outside goal receipts", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-traversal-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "traversal-receipt", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_traversal";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "traversal-receipt",
		path: ".bravo/goals/traversal-receipt",
		pi_session_id: "pi_traversal",
		status: "active",
		active_task: "task-one",
	});
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredJudgeEventTool();
	await assert.rejects(
		() => tool.execute("call_1", { goal_id: "traversal-receipt", event: "task.receipt_ready", receipt_path: "receipts/../../escape.md" }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_traversal" } }),
		/escapes goal directory/,
	);
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
});

test("judge_event task.receipt_ready rejects malformed active goal paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-bad-entry-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "bad-entry", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_bad_entry";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "bad-entry",
		path: "../escape",
		pi_session_id: "pi_bad_entry",
		status: "active",
		active_task: "task-one",
	});
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredJudgeEventTool();
	await assert.rejects(
		() => tool.execute("call_1", { goal_id: "bad-entry", event: "task.receipt_ready", receipt_path: "receipts/task-one-worker.md" }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_bad_entry" } }),
		/Active goal path must be \.bravo\/goals\/bad-entry/,
	);
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
});

test("judge_event task.receipt_ready does not mutate on session mismatch", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-session-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "session-mismatch", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_expected";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "session-mismatch",
		path: ".bravo/goals/session-mismatch",
		pi_session_id: "pi_expected",
		status: "active",
		active_task: "task-one",
	});
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredJudgeEventTool();
	await assert.rejects(
		() => tool.execute("call_1", { goal_id: "session-mismatch", event: "task.receipt_ready", receipt_path: "receipts/task-one-worker.md" }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_other" } }),
		/No attached active Bravo goal/,
	);
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
	assert.equal(next.tasks[0]?.receipt, null);
});

test("judge_event task.receipt_ready rejects authoritative state session mismatch without mutation or event", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-state-session-"));
	const runDir = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-run-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "state-session-mismatch", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_authoritative";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "state-session-mismatch",
		path: ".bravo/goals/state-session-mismatch",
		pi_session_id: "pi_current",
		status: "active",
		active_task: "task-one",
	});
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredJudgeEventTool();
	const previousRunDir = process.env.BRAVO_JUDGE_RUN_DIR;
	process.env.BRAVO_JUDGE_RUN_DIR = runDir;
	try {
		await assert.rejects(
			() => tool.execute("call_1", { goal_id: "state-session-mismatch", event: "task.receipt_ready", receipt_path: "receipts/task-one-worker.md" }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_current" } }),
			/not attached to current Pi session/,
		);
		await assert.rejects(() => readFile(join(runDir, "events.jsonl"), "utf8"), /ENOENT/);
	} finally {
		if (previousRunDir === undefined) delete process.env.BRAVO_JUDGE_RUN_DIR;
		else process.env.BRAVO_JUDGE_RUN_DIR = previousRunDir;
	}
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
	assert.equal(next.tasks[0]?.receipt, null);
});

test("judge_event task.receipt_ready requires current session id and fails closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-no-session-"));
	const runDir = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-run-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "no-current-session", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_attached";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "no-current-session",
		path: ".bravo/goals/no-current-session",
		pi_session_id: "pi_attached",
		status: "active",
		active_task: "task-one",
	});
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredJudgeEventTool();
	const previousRunDir = process.env.BRAVO_JUDGE_RUN_DIR;
	process.env.BRAVO_JUDGE_RUN_DIR = runDir;
	try {
		await assert.rejects(
			() => tool.execute("call_1", { goal_id: "no-current-session", event: "task.receipt_ready", receipt_path: "receipts/task-one-worker.md" }, undefined, undefined, { cwd: root }),
			/requires a current Pi session id/,
		);
		await assert.rejects(() => readFile(join(runDir, "events.jsonl"), "utf8"), /ENOENT/);
	} finally {
		if (previousRunDir === undefined) delete process.env.BRAVO_JUDGE_RUN_DIR;
		else process.env.BRAVO_JUDGE_RUN_DIR = previousRunDir;
	}
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
	assert.equal(next.tasks[0]?.receipt, null);
});

test("judge_event task.receipt_ready fails without receipt evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-missing-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "missing-receipt", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_missing";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "missing-receipt",
		path: ".bravo/goals/missing-receipt",
		pi_session_id: "pi_missing",
		status: "active",
		active_task: "task-one",
	});

	const tool = registeredJudgeEventTool();
	await assert.rejects(
		() => tool.execute("call_1", { goal_id: "missing-receipt", event: "task.receipt_ready", receipt_path: "receipts/missing.md" }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_missing" } }),
		/Worker receipt not found/,
	);
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
});

test("judge_event task.receipt_ready fails without an active task", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-no-task-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "no-task", tasks: [] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_no_task";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "no-task",
		path: ".bravo/goals/no-task",
		pi_session_id: "pi_no_task",
		status: "active",
		active_task: null,
	});

	const tool = registeredJudgeEventTool();
	await assert.rejects(
		() => tool.execute("call_1", { goal_id: "no-task", event: "task.receipt_ready", receipt_path: "receipts/worker.md" }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_no_task" } }),
		/no active task/,
	);
});

test("HUD reports awaiting Judge for awaiting_judge active task", () => {
	const awaiting: HudSnapshot = {
		...snapshot,
		state: {
			...snapshot.state,
			tasks: [{ id: "checkpoint-writer", title: "Implement resume checkpoint writer", status: "awaiting_judge" }],
			judge: { last_verdict: "none", active: false },
		},
	};
	assert.equal(renderStatusLine(awaiting), "Goal: Durable resume loop 1/2 Judge: awaiting");
	assert.equal(renderHud(awaiting)[4], "JUDGE awaiting");
});

test("HUD discovers ancestor workspace and does not fall back to unrelated active goal", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-hud-"));
	const nested = join(root, "repo", "src");
	await mkdir(nested, { recursive: true });
	const goalDir = (await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "hud-goal" })).goalPath;
	const state = await readGoalState(goalDir);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_match";
	await writeGoalState(goalDir, state);
	await upsertActiveGoal(root, {
		goal_id: "hud-goal",
		path: ".bravo/goals/hud-goal",
		pi_session_id: "pi_match",
		status: "active",
		active_task: state.active_task,
	});

	const matched = await snapshotForSession({
		cwd: nested,
		sessionManager: { getSessionId: () => "pi_match" },
	});
	assert.equal(matched?.state.goal.id, "hud-goal");

	const unmatched = await snapshotForSession({
		cwd: nested,
		sessionManager: { getSessionId: () => "pi_other" },
	});
	assert.equal(unmatched, undefined);
});

function registeredJudgeEventTool(): { execute: (...args: any[]) => Promise<any> } {
	let judgeEvent: { name: string; execute: (...args: any[]) => Promise<any> } | undefined;
	registerJudgeControlTools({
		registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
			if (tool.name === "judge_event") judgeEvent = tool;
		},
	} as any);
	assert.ok(judgeEvent);
	return judgeEvent;
}

function workerReceipt(taskId: string): string {
	return `---
schema_version: 1
type: worker
task_id: ${taskId}
status: complete
created_at: "2026-05-17T12:00:00.000Z"
files_changed: []
commands: []
claims:
  - claim: Work completed
    evidence:
      - packages/bravo-goals/test/extension.test.ts
remaining_risk: []
---

# Worker Receipt

Done.
`;
}
