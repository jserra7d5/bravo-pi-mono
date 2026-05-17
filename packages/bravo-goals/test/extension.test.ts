import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderHud, renderStatusLine, snapshotForSession, type HudSnapshot } from "../extensions/pi/hud.js";
import { testables } from "../extensions/pi/commands.js";
import { registerGoalValidationTools } from "../extensions/pi/goal-validation.js";
import { registerJudgeControlTools } from "../extensions/pi/judge-control.js";
import { scaffoldGoalWorkspace } from "../src/workspace.js";
import { readActiveGoalsIndex, readGoalState, upsertActiveGoal, writeGoalState } from "../src/runtime.js";

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
		final_audit: { status: "pending" },
		user_verification: { status: "pending" },
	},
};

test("renders Bravo Goals footer status (v2 format)", () => {
	const line = renderStatusLine(snapshot);
	assert.ok(line, "status line should be defined");
	// v2: <gold bold title>  ●◉○  <caption>
	assert.match(line, /Durable resume loop/);
	// Tasks are active (1/2 done, not all done), audit/verify pending → gate dots
	assert.match(line, /1\/2 tasks/);
});

test("renders below-editor HUD lines from state (v2 three-gate layout)", () => {
	const lines = renderHud(snapshot);
	assert.ok(lines.length > 0, "should return at least one line");
	const joined = lines.join("\n");
	// Must include goal title
	assert.match(joined, /Durable resume loop/);
	// Must include task info for the active task (tasks gate is active)
	assert.match(joined, /checkpoint-writer/);
	// Must include gates row
	assert.match(joined, /gates/);
	// Must include task count
	assert.match(joined, /1\/2/);
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

test("/goal help renders command usage without a Bravo workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-help-"));
	const notifications: string[] = [];
	await testables.handleGoal({} as any, { refresh: async () => {} }, "help next", {
		cwd: root,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getSessionId: () => "pi_help" },
	} as any);

	assert.equal(notifications.length, 1);
	const plain = stripAnsi(notifications[0]!);
	assert.match(plain, /\/goal next \[goal-id\] \[--carry \| --compact \| --fresh\]/);
	assert.match(plain, /--fresh: start a replacement Pi session/);
	assert.match(notifications[0]!, /\x1b\[/);
});

test("/goal init creates Bravo workspace from Pi command context", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-init-"));
	const notifications: string[] = [];
	let refreshes = 0;
	await testables.handleGoal({} as any, { refresh: async () => { refreshes += 1; } }, "init", {
		cwd: root,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getSessionId: () => "pi_init" },
	} as any);

	await access(join(root, ".bravo", "config.yaml"));
	await access(join(root, ".bravo", "goals"));
	await access(join(root, ".bravo", "runtime"));
	assert.equal(refreshes, 1);
	assert.match(stripAnsi(notifications[0] ?? ""), /Initialized Bravo workspace .*\.bravo/);
});

test("/goal prep creates a draft goal workspace from Pi command context", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-prep-"));
	await testables.handleGoal({} as any, { refresh: async () => {} }, "init", {
		cwd: root,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "pi_prep" },
	} as any);

	const notifications: string[] = [];
	const queuedPrompts: string[] = [];
	let refreshes = 0;
	await testables.handleGoal({ sendUserMessage: (prompt: string) => queuedPrompts.push(prompt) } as any, { refresh: async () => { refreshes += 1; } }, 'prep pi-smoke --title "Pi Smoke Goal"', {
		cwd: root,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getSessionId: () => "pi_prep" },
	} as any);

	const goalDir = join(root, ".bravo", "goals", "pi-smoke");
	await access(join(goalDir, "goal.md"));
	await access(join(goalDir, "context.md"));
	await access(join(goalDir, "state.yaml"));
	await access(join(goalDir, "resume.md"));
	await access(join(goalDir, "receipts"));
	await access(join(goalDir, "artifacts"));
	const state = await readGoalState(goalDir);
	assert.equal(state.goal.title, "Pi Smoke Goal");
	assert.equal(state.goal.status, "draft");
	assert.equal(state.active_task, null);
	assert.deepEqual(state.tasks, []);
	assert.equal(refreshes, 1);
	assert.match(stripAnsi(notifications[0] ?? ""), /Prepared Bravo goal \.bravo\/goals\/pi-smoke/);
	assert.equal(queuedPrompts.length, 1);
	assert.match(queuedPrompts[0]!, /interactive goal-definition flow/);
	assert.match(queuedPrompts[0]!, /validate_goal_state/);
	assert.match(queuedPrompts[0]!, /Do not start implementation/);
	assert.match(queuedPrompts[0]!, /\/goal start pi-smoke/);
});

test("/goal check validates explicit goals from Pi command context", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-check-"));
	await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "check-me" });
	const notifications: string[] = [];
	let refreshes = 0;

	await testables.handleGoal({} as any, { refresh: async () => { refreshes += 1; } }, "check check-me", {
		cwd: root,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getSessionId: () => "pi_check" },
	} as any);

	assert.equal(refreshes, 1);
	assert.match(stripAnsi(notifications[0] ?? ""), /Bravo goal check passed check-me/);
});

test("/goal next supports carry, compact, and fresh handoff modes from Pi slash commands", async () => {
	const carry = await createPassedBoundaryGoal("handoff-carry", "carry");
	const carryPrompts: string[] = [];
	let carryRefreshes = 0;
	await testables.handleGoal({ sendUserMessage: (prompt: string) => carryPrompts.push(prompt) } as any, { refresh: async () => { carryRefreshes += 1; } }, "next handoff-carry --carry", {
		cwd: carry.root,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "pi_handoff" },
	} as any);
	const carryState = await readGoalState(carry.goalPath);
	assert.equal(carryState.phase_boundary.last_boundary_mode, "carry");
	assert.equal(carryPrompts.length, 1);
	assert.match(carryPrompts[0]!, /Active task: task-two/);
	assert.equal(carryRefreshes, 1);

	const compact = await createPassedBoundaryGoal("handoff-compact", "compact");
	const compactPrompts: string[] = [];
	let compactRefreshes = 0;
	let compactInstructions = "";
	await testables.handleGoal({ sendUserMessage: (prompt: string) => compactPrompts.push(prompt) } as any, { refresh: async () => { compactRefreshes += 1; } }, "next handoff-compact --compact", {
		cwd: compact.root,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "pi_handoff" },
		compact(options: { customInstructions: string; onComplete: () => void }) {
			compactInstructions = options.customInstructions;
			options.onComplete();
		},
	} as any);
	const compactState = await readGoalState(compact.goalPath);
	assert.equal(compactState.phase_boundary.last_boundary_mode, "compact");
	assert.match(compactInstructions, /Preserve the Bravo goal context/);
	assert.equal(compactPrompts.length, 1);
	assert.match(compactPrompts[0]!, /Active task: task-two/);
	assert.equal(compactRefreshes, 1);

	const fresh = await createPassedBoundaryGoal("handoff-fresh", "fresh_session");
	const replacementPrompts: string[] = [];
	let freshRefreshes = 0;
	let waited = false;
	let newSessionCalled = false;
	await testables.handleGoal({ sendUserMessage: () => { throw new Error("fresh should use replacement session"); } } as any, { refresh: async () => { freshRefreshes += 1; } }, "next handoff-fresh --fresh", {
		cwd: fresh.root,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "pi_handoff", getSessionFile: () => "/tmp/pi_handoff.json" },
		waitForIdle: async () => { waited = true; },
		newSession: async (options: { parentSession?: string; withSession: (replacement: any) => Promise<void> }) => {
			newSessionCalled = true;
			assert.equal(options.parentSession, "/tmp/pi_handoff.json");
			await options.withSession({
				sessionManager: { getSessionId: () => "pi_replacement" },
				sendUserMessage: async (prompt: string) => { replacementPrompts.push(prompt); },
			});
		},
	} as any);
	const freshState = await readGoalState(fresh.goalPath);
	const freshIndex = await readActiveGoalsIndex(fresh.root);
	assert.equal(freshState.phase_boundary.last_boundary_mode, "fresh_session");
	assert.equal(freshState.session.attached_pi_session_id, "pi_replacement");
	assert.equal(freshIndex.active_goals.find((entry) => entry.goal_id === "handoff-fresh")?.pi_session_id, "pi_replacement");
	assert.equal(waited, true);
	assert.equal(newSessionCalled, true);
	assert.equal(replacementPrompts.length, 1);
	assert.match(replacementPrompts[0]!, /fresh Pi session/);
	assert.equal(freshRefreshes, 0);
});

test("worker prompt names receipt path, schema, and task_receipt_ready call", () => {
	const prompt = testables.activeTaskPrompt({
		id: "prompt-goal",
		path: "/workspace/.bravo/goals/prompt-goal",
		state: {
			goal: { id: "prompt-goal", title: "Prompt Goal", status: "active" },
			active_task: "task-one",
			tasks: [{ id: "task-one", title: "Task One", status: "active", receipt: "receipts/custom-worker.md" }],
			progress: { completed_tasks: 0, total_tasks: 1 },
			final_audit: { status: "pending" },
			user_verification: { status: "pending" },
		},
	});
	assert.match(prompt, /Expected worker receipt path for task_receipt_ready: receipts\/custom-worker\.md/);
	assert.match(prompt, /Write the receipt file at: \/workspace\/\.bravo\/goals\/prompt-goal\/receipts\/custom-worker\.md/);
	assert.match(prompt, /Do not create receipts under the repo directory/);
	assert.match(prompt, /type: worker/);
	assert.match(prompt, /task_id: task-one/);
	assert.match(prompt, /task_receipt_ready with goal_id: prompt-goal and receipt_path: receipts\/custom-worker\.md/);
	assert.doesNotMatch(prompt, /judge_finish|judge_event/);
	assert.match(prompt, /Do not edit state\.yaml manually/);
});

test("no-task prompt does not mention task_receipt_ready", () => {
	const prompt = testables.activeTaskPrompt({
		id: "prompt-no-task",
		path: "/workspace/.bravo/goals/prompt-no-task",
		state: {
			goal: { id: "prompt-no-task", title: "Prompt No Task", status: "active" },
			active_task: null,
			tasks: [],
			progress: { completed_tasks: 0, total_tasks: 0 },
			final_audit: { status: "pending" },
			user_verification: { status: "pending" },
		},
	});
	assert.doesNotMatch(prompt, /task_receipt_ready/);
});

test("task_receipt_ready persists active task awaiting Judge and creates Judge run", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-task-receipt-ready-"));
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

	const tool = registeredTaskReceiptReadyTool();
	const result = await tool.execute("call_1", {
		goal_id: "receipt-goal",
		receipt_path: "receipts/task-one-worker.md",
	}, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_receipt" } });

	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "awaiting_judge");
	assert.equal(next.tasks[0]?.receipt, "receipts/task-one-worker.md");
	assert.equal(next.session.current_judge_run_id, result.details.judge_run_id);
	assert.equal(next.goal.status, "active");
	assert.equal(result.details.status, "awaiting_judge");
	assert.equal(result.details.goal_id, "receipt-goal");
	assert.equal(result.details.task_id, "task-one");
	assert.equal(result.details.receipt_path, "receipts/task-one-worker.md");
	assert.match(result.details.judge_run_id, /^judge_/);
	assert.equal(result.details.judge_receipt_path, ".bravo/goals/receipt-goal/receipts/task-one-judge.md");
	assert.equal(result.details.next_action, "judge_pending_launch");
	assert.match(await readFile(join(root, result.details.judge_run_path), "utf8"), /"worker_receipt_path"/);
	assert.match(result.content[0].text, /Task receipt ready/);
});

test("judge-control tool call renderers tolerate missing Pi args", () => {
	for (const tool of [registeredTaskReceiptReadyTool(), registeredJudgeEventTool(), registeredJudgeFinishTool()]) {
		const rendered = tool.renderCall?.(undefined).render(96).join("\n") ?? "";
		assert.match(stripAnsi(rendered), /unknown/);
	}
});

test("task_receipt_ready uses default active task receipt path", async () => {
	const { root, goalPath } = await createActiveReceiptGoal("default-receipt", "pi_default");
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredTaskReceiptReadyTool();
	const result = await tool.execute("call_1", {
		goal_id: "default-receipt",
	}, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_default" } });

	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "awaiting_judge");
	assert.equal(next.tasks[0]?.receipt, "receipts/task-one-worker.md");
	assert.equal(result.details.receipt_path, "receipts/task-one-worker.md");
	assert.match(result.details.judge_run_id, /^judge_/);
});

test("task_receipt_ready rejects malformed, empty, and directory worker receipts without mutation", async () => {
	const cases: { name: string; write: (goalPath: string) => Promise<string>; message: RegExp }[] = [
		{
			name: "empty",
			write: async (goalPath) => {
				await writeFile(join(goalPath, "receipts", "empty-worker.md"), "");
				return "receipts/empty-worker.md";
			},
			message: /empty/,
		},
		{
			name: "malformed",
			write: async (goalPath) => {
				await writeFile(join(goalPath, "receipts", "malformed-worker.md"), "# no frontmatter\n");
				return "receipts/malformed-worker.md";
			},
			message: /YAML frontmatter/,
		},
		{
			name: "wrong-task",
			write: async (goalPath) => {
				await writeFile(join(goalPath, "receipts", "wrong-worker.md"), workerReceipt("other-task"));
				return "receipts/wrong-worker.md";
			},
			message: /task_id must match active task/,
		},
		{
			name: "directory",
			write: async (goalPath) => {
				await mkdir(join(goalPath, "receipts", "dir-worker.md"));
				return "receipts/dir-worker.md";
			},
			message: /regular file/,
		},
	];

	for (const receiptCase of cases) {
		const goalId = `bad-${receiptCase.name}`;
		const sessionId = `pi_${receiptCase.name}`;
		const { root, goalPath } = await createActiveReceiptGoal(goalId, sessionId);
		const receiptPath = await receiptCase.write(goalPath);
		const tool = registeredTaskReceiptReadyTool();
		await assert.rejects(
			() => tool.execute("call_1", { goal_id: goalId, receipt_path: receiptPath }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => sessionId } }),
			receiptCase.message,
		);
		const next = await readGoalState(goalPath);
		assert.equal(next.tasks[0]?.status, "active");
		assert.equal(next.session.current_judge_run_id, null);
	}
});

test("task_receipt_ready does not mutate state when Judge run creation fails", async () => {
	const { root, goalPath } = await createActiveReceiptGoal("judge-create-fails", "pi_create_fail");
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));
	await writeFile(join(goalPath, "judge"), "not a directory");

	const tool = registeredTaskReceiptReadyTool();
	await assert.rejects(
		() => tool.execute("call_1", { goal_id: "judge-create-fails", receipt_path: "receipts/task-one-worker.md" }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_create_fail" } }),
		/ENOTDIR|EEXIST/,
	);
	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "active");
	assert.equal(next.tasks[0]?.receipt, null);
	assert.equal(next.session.current_judge_run_id, null);
});

test("judge_event task.receipt_ready remains compatible", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-judge-event-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "compat-receipt-goal", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_receipt";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: "compat-receipt-goal",
		path: ".bravo/goals/compat-receipt-goal",
		pi_session_id: "pi_receipt",
		status: "active",
		active_task: "task-one",
	});
	await writeFile(join(goalPath, "receipts", "task-one-worker.md"), workerReceipt("task-one"));

	const tool = registeredJudgeEventTool();
	const result = await tool.execute("call_1", {
		goal_id: "compat-receipt-goal",
		event: "task.receipt_ready",
		receipt_path: "receipts/task-one-worker.md",
	}, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => "pi_receipt" } });

	const next = await readGoalState(goalPath);
	assert.equal(next.tasks[0]?.status, "awaiting_judge");
	assert.equal(result.details.next_action, "judge_pending_launch");
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

test("HUD shows judging chip for awaiting_judge active task", () => {
	const awaiting: HudSnapshot = {
		...snapshot,
		state: {
			...snapshot.state,
			tasks: [{ id: "checkpoint-writer", title: "Implement resume checkpoint writer", status: "awaiting_judge" }],
			judge: { last_verdict: "none", active: false },
		},
	};
	const statusLine = renderStatusLine(awaiting);
	assert.ok(statusLine, "status line should be defined");
	assert.match(statusLine, /Durable resume loop/);
	const lines = renderHud(awaiting);
	const joined = lines.join("\n");
	// The task row should include the judging chip since status is awaiting_judge
	assert.match(joined, /◐ judging/);
});

test("judge_finish outside Judge run teaches workers to use task_receipt_ready", async () => {
	const tool = registeredJudgeFinishTool();
	const previousRunDir = process.env.BRAVO_JUDGE_RUN_DIR;
	delete process.env.BRAVO_JUDGE_RUN_DIR;
	try {
		await assert.rejects(
			() => tool.execute("call_1", { goal_id: "worker-goal", verdict: "pass", receipt_path: "receipts/task-one-judge.md" }, undefined, undefined, {}),
			/task_receipt_ready/,
		);
	} finally {
		if (previousRunDir !== undefined) process.env.BRAVO_JUDGE_RUN_DIR = previousRunDir;
	}
});

test("validate_goal_state reports valid state for an explicit goal", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-validate-state-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "state-ok", tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "draft";
	await writeGoalState(goalPath, state);

	const tool = registeredValidateGoalStateTool();
	const result = await tool.execute("call_1", { goal_id: "state-ok" }, undefined, undefined, { cwd: root });

	assert.equal(result.details.ok, true);
	assert.equal(result.details.goal_id, "state-ok");
	assert.equal(result.details.state_path, ".bravo/goals/state-ok/state.yaml");
	assert.deepEqual(result.details.issues, []);
	assert.match(result.content[0].text, /Goal state valid/);
});

test("validate_goal_state returns actionable issues without mutating invalid state", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-goals-validate-state-bad-"));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId: "state-bad" });
	await writeFile(join(goalPath, "state.yaml"), "schema_version: 1\ngoal:\n  id: state-bad\n");

	const tool = registeredValidateGoalStateTool();
	const result = await tool.execute("call_1", { goal_id: "state-bad" }, undefined, undefined, { cwd: root });

	assert.equal(result.details.ok, false);
	assert.equal(result.details.goal_id, "state-bad");
	assert.ok(result.details.issue_count > 0);
	assert.match(result.content[0].text, /Goal state invalid/);
	assert.match(result.content[0].text, /STATE_MISSING_KEY|STRING_REQUIRED/);
	assert.match(await readFile(join(goalPath, "state.yaml"), "utf8"), /schema_version: 1/);
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

async function createActiveReceiptGoal(goalId: string, sessionId: string): Promise<{ root: string; goalPath: string }> {
	const root = await mkdtemp(join(tmpdir(), `bravo-goals-${goalId}-`));
	const { goalPath } = await scaffoldGoalWorkspace({ workspaceRoot: root, goalId, tasks: [{ id: "task-one", title: "Task One" }] });
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = sessionId;
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: goalId,
		path: `.bravo/goals/${goalId}`,
		pi_session_id: sessionId,
		status: "active",
		active_task: "task-one",
	});
	return { root, goalPath };
}

async function createPassedBoundaryGoal(goalId: string, mode: "carry" | "compact" | "fresh_session"): Promise<{ root: string; goalPath: string }> {
	const root = await mkdtemp(join(tmpdir(), `bravo-goals-${goalId}-`));
	const { goalPath } = await scaffoldGoalWorkspace({
		workspaceRoot: root,
		goalId,
		tasks: [
			{ id: "task-one", title: "Complete first task", boundary_after_pass: mode },
			{ id: "task-two", title: "Continue second task" },
		],
	});
	const state = await readGoalState(goalPath);
	state.goal.status = "active";
	state.session.attached_pi_session_id = "pi_handoff";
	state.tasks[0] = {
		...state.tasks[0]!,
		status: "done",
		receipt: "receipts/task-one-worker.md",
		judge_receipt: "receipts/task-one-judge.md",
	};
	state.tasks[1] = { ...state.tasks[1]!, status: "active" };
	state.active_task = "task-two";
	state.progress = { completed_tasks: 1, total_tasks: 2 };
	state.judge.last_verdict = "pass";
	state.judge.last_receipt = "receipts/task-one-judge.md";
	await writeGoalState(goalPath, state);
	await upsertActiveGoal(root, {
		goal_id: goalId,
		path: `.bravo/goals/${goalId}`,
		pi_session_id: "pi_handoff",
		status: "active",
		active_task: "task-two",
	});
	return { root, goalPath };
}

function registeredTaskReceiptReadyTool(): RegisteredTestTool {
	return registeredTool("task_receipt_ready");
}

function registeredJudgeEventTool(): RegisteredTestTool {
	return registeredTool("judge_event");
}

function registeredJudgeFinishTool(): RegisteredTestTool {
	return registeredTool("judge_finish");
}

interface RegisteredTestTool {
	name?: string;
	execute: (...args: any[]) => Promise<any>;
	renderCall?: (args: unknown) => { render(width: number): string[] };
}

function registeredValidateGoalStateTool(): RegisteredTestTool {
	let matched: RegisteredTestTool | undefined;
	registerGoalValidationTools({
		registerTool(tool: RegisteredTestTool & { name: string }) {
			if (tool.name === "validate_goal_state") matched = tool;
		},
	} as any);
	assert.ok(matched);
	return matched;
}

function registeredTool(name: string): RegisteredTestTool {
	let matched: RegisteredTestTool | undefined;
	registerJudgeControlTools({
		registerTool(tool: RegisteredTestTool & { name: string }) {
			if (tool.name === name) matched = tool;
		},
	} as any);
	assert.ok(matched);
	return matched;
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

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}
