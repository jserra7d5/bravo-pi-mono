import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderHud, renderStatusLine, snapshotForSession, type HudSnapshot } from "../extensions/pi/hud.js";
import { testables } from "../extensions/pi/commands.js";
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
