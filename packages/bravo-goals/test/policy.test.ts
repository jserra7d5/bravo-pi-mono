import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultGoalPolicy, decideBash, decidePath, readGoalPolicy, type GoalPolicy } from "../src/policy.js";

test("goal policy is controller-owned and blocks protected Bravo mutation paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-policy-"));
	await mkdir(join(root, ".bravo", "goals", "policy-goal", "receipts"), { recursive: true });
	const policy = await createDefaultGoalPolicy({
		workspaceRoot: root,
		goalId: "policy-goal",
		activeTaskId: "task-one",
	});

	const loaded = await readGoalPolicy(policy.policy_path);
	assert.equal(loaded.goal_id, "policy-goal");

	assert.deepEqual(await decidePath(loaded, "mutate", join(root, ".bravo", "goals", "policy-goal", "state.yaml")), {
		allowed: false,
		reason: `mutate blocked by Bravo policy: ${join(root, ".bravo", "goals", "policy-goal", "state.yaml")}`,
	});
	assert.equal((await decidePath(loaded, "mutate", join(root, ".bravo", "goals", "policy-goal", "receipts", "task-one-worker.md"))).allowed, true);
	assert.equal((await decidePath(loaded, "mutate", join(root, "src", "app.ts"))).allowed, true);
});

test("goal policy blocks outside-workspace writes and destructive bash", async () => {
	const root = await mkdtemp(join(tmpdir(), "bravo-policy-"));
	await mkdir(join(root, ".bravo", "goals", "policy-goal"), { recursive: true });
	const policy = await createDefaultGoalPolicy({ workspaceRoot: root, goalId: "policy-goal" });
	const outside = join(await mkdtemp(join(tmpdir(), "bravo-outside-")), "file.txt");
	await writeFile(outside, "x");

	assert.equal((await decidePath(policy, "mutate", outside)).allowed, false);
	assert.equal(decideBash(policy, "git status --short").allowed, true);
	assert.equal(decideBash(policy, "cd ROGER-main && git status --short --branch && git worktree list --porcelain").allowed, true);
	assert.equal(decideBash(policy, "git -C ROGER-main status --short --branch").allowed, true);
	assert.equal(decideBash(policy, "git worktree list --porcelain").allowed, true);
	assert.equal(decideBash(policy, "git worktree add -b bravo/task ../ROGER-main-bravo roger-production-enhancements").allowed, true);
	assert.equal(decideBash(policy, "cd ROGER-main && git add api/main.py && git commit -m baseline").allowed, true);
	assert.equal(decideBash(policy, "npm test --workspace @bravo/goals").allowed, true);
	assert.equal(decideBash(policy, "rm -rf .bravo").allowed, false);
	assert.equal(decideBash(policy, "git reset --hard").allowed, false);
	assert.equal(decideBash(policy, "git -C ROGER-main reset --hard").allowed, false);
	assert.equal(decideBash(policy, "cd ROGER-main && git reset --hard").allowed, false);
	assert.equal(decideBash(policy, "git worktree remove ../ROGER-main-bravo").allowed, false);
	assert.equal(decideBash(policy, "git status --short && python script.py").allowed, false);
	assert.equal(decideBash(policy, "git status --short&&python script.py").allowed, false);
	assert.equal(decideBash(policy, "git status --short &&python script.py").allowed, false);
	assert.equal(decideBash(policy, "git status --short&& python script.py").allowed, false);
	assert.equal(decideBash(policy, "git statusx --short").allowed, false);
	assertBashBlockedByDenyPattern(policy, "git status --short\npython script.py");
	assertBashBlockedByDenyPattern(policy, "git status --short\rpython script.py");
	assertBashBlockedByDenyPattern(policy, "git status --short; python script.py");
	assertBashBlockedByDenyPattern(policy, "git commit -m ok; python script.py");
	assertBashBlockedByDenyPattern(policy, "git worktree list --porcelain | python script.py");
	assertBashBlockedByDenyPattern(policy, "git status --short || python script.py");
	assertBashBlockedByDenyPattern(policy, "git status --short & python script.py");
	assertBashBlockedByDenyPattern(policy, "git status --short `python script.py`");
	assertBashBlockedByDenyPattern(policy, "git status --short $(python script.py)");
	assertBashBlockedByDenyPattern(policy, "echo hi > file.txt");
	assertBashBlockedByDenyPattern(policy, "cat > package.json <<'EOF'\n{\"type\":\"module\"}\nEOF");
	assertBashBlockedByDenyPattern(policy, "mkdir -p test && cat > package.json <<'EOF'\n{}\nEOF");
	assertBashBlockedByDenyPattern(policy, "printf hi | tee file.txt");
	assertBashBlockedByDenyPattern(policy, "tee file.txt");
});

function assertBashBlockedByDenyPattern(policy: GoalPolicy, command: string): void {
	const decision = decideBash(policy, command);
	assert.equal(decision.allowed, false);
	assert.match(decision.reason, /blocked by Bravo policy/);
}
