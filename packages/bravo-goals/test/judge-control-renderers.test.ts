import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverWorkspaceRootSync,
	renderToolResultComponent,
	resolveGoalTitleSync,
} from "../extensions/pi/judge-control.js";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── resolveGoalTitleSync · failure-mode coverage ─────────────────────────
// Each test confirms a specific failure mode returns undefined cleanly (no
// throw) so the renderer falls back to the slug.

test("resolveGoalTitleSync returns undefined when no workspace exists above cwd", async () => {
	// Use the OS tmp dir directly — there's no .bravo/config.yaml anywhere
	// above it, so workspace discovery walks to root and returns null.
	const dir = await mkdtemp(join(tmpdir(), "bravo-no-workspace-"));
	const title = resolveGoalTitleSync("some-goal", dir);
	assert.equal(title, undefined);
});

test("resolveGoalTitleSync returns undefined when active-goals.yaml is missing and conventional path has no state", async () => {
	// Workspace exists (.bravo/config.yaml) but no active-goals index, and no
	// .bravo/goals/<goal_id>/state.yaml either.
	const workspace = await mkdtemp(join(tmpdir(), "bravo-empty-workspace-"));
	await mkdir(join(workspace, ".bravo"), { recursive: true });
	await writeFile(join(workspace, ".bravo", "config.yaml"), "schema_version: 1\n");
	const title = resolveGoalTitleSync("absent-goal", workspace);
	assert.equal(title, undefined);
});

test("resolveGoalTitleSync returns undefined when state.yaml is malformed YAML", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "bravo-malformed-state-"));
	await mkdir(join(workspace, ".bravo", "goals", "broken-goal"), { recursive: true });
	await writeFile(join(workspace, ".bravo", "config.yaml"), "schema_version: 1\n");
	// Deliberately bad YAML
	await writeFile(
		join(workspace, ".bravo", "goals", "broken-goal", "state.yaml"),
		":\n  - not\n :::: valid: yaml:\n",
	);
	const title = resolveGoalTitleSync("broken-goal", workspace);
	assert.equal(title, undefined);
});

test("resolveGoalTitleSync returns undefined when active-goals.yaml is malformed YAML", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "bravo-malformed-index-"));
	await mkdir(join(workspace, ".bravo", "runtime"), { recursive: true });
	await writeFile(join(workspace, ".bravo", "config.yaml"), "schema_version: 1\n");
	await writeFile(
		join(workspace, ".bravo", "runtime", "active-goals.yaml"),
		":\n :::: not yaml :::\n",
	);
	// Index parse fails, falls through to conventional path which also doesn't exist.
	const title = resolveGoalTitleSync("some-goal", workspace);
	assert.equal(title, undefined);
});

test("resolveGoalTitleSync returns undefined when goal_id is not in the index and no conventional state exists", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "bravo-missing-goal-"));
	await mkdir(join(workspace, ".bravo", "runtime"), { recursive: true });
	await writeFile(join(workspace, ".bravo", "config.yaml"), "schema_version: 1\n");
	await writeFile(
		join(workspace, ".bravo", "runtime", "active-goals.yaml"),
		"schema_version: 1\nactive_goals:\n  - goal_id: other-goal\n    path: .bravo/goals/other-goal\n",
	);
	const title = resolveGoalTitleSync("not-in-index", workspace);
	assert.equal(title, undefined);
});

test("resolveGoalTitleSync returns the title when index + state.yaml are well-formed", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "bravo-happy-path-"));
	await mkdir(join(workspace, ".bravo", "runtime"), { recursive: true });
	await mkdir(join(workspace, ".bravo", "goals", "happy-goal"), { recursive: true });
	await writeFile(join(workspace, ".bravo", "config.yaml"), "schema_version: 1\n");
	await writeFile(
		join(workspace, ".bravo", "runtime", "active-goals.yaml"),
		"schema_version: 1\nactive_goals:\n  - goal_id: happy-goal\n    path: .bravo/goals/happy-goal\n",
	);
	await writeFile(
		join(workspace, ".bravo", "goals", "happy-goal", "state.yaml"),
		"goal:\n  id: happy-goal\n  title: A perfectly happy goal\n  status: active\n",
	);
	const title = resolveGoalTitleSync("happy-goal", workspace);
	assert.equal(title, "A perfectly happy goal");
});

test("resolveGoalTitleSync returns the title when index is missing but conventional state.yaml exists", async () => {
	// The fallback path: no index entry, but the conventional
	// .bravo/goals/<id>/state.yaml is present.
	const workspace = await mkdtemp(join(tmpdir(), "bravo-conventional-"));
	await mkdir(join(workspace, ".bravo", "goals", "convo-goal"), { recursive: true });
	await writeFile(join(workspace, ".bravo", "config.yaml"), "schema_version: 1\n");
	await writeFile(
		join(workspace, ".bravo", "goals", "convo-goal", "state.yaml"),
		"goal:\n  id: convo-goal\n  title: From convention\n  status: active\n",
	);
	const title = resolveGoalTitleSync("convo-goal", workspace);
	assert.equal(title, "From convention");
});

test("discoverWorkspaceRootSync walks up from a nested subdirectory", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "bravo-discover-"));
	const nested = join(workspace, "deep", "nested", "dir");
	await mkdir(nested, { recursive: true });
	await mkdir(join(workspace, ".bravo"), { recursive: true });
	await writeFile(join(workspace, ".bravo", "config.yaml"), "schema_version: 1\n");
	const found = discoverWorkspaceRootSync(nested);
	assert.equal(found, workspace);
});

test("discoverWorkspaceRootSync returns null when no workspace exists in any ancestor", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bravo-no-ancestor-"));
	const found = discoverWorkspaceRootSync(dir);
	assert.equal(found, null);
});

// ─── renderToolResultComponent · success and failure path dispatch ────────

test("renderToolResultComponent dispatches task_receipt_ready details to the receipt-ready card", () => {
	const renderable = renderToolResultComponent({
		content: [{ type: "text", text: "ok" }],
		details: {
			status: "awaiting_judge",
			goal_id: "g-rrc-1",
			task_id: "task_001",
			receipt_path: "receipts/task_001-worker.md",
			judge_run_id: "jr_test",
			next_action: "judge_pending_launch",
			title: "Receipt-ready goal",
		},
	}, "task_receipt_ready");
	const lines = renderable.render(96);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /task_receipt_ready/);
	assert.match(plain, /accepted/, "shows accepted badge");
	assert.match(plain, /task_001/);
	assert.match(plain, /jr_test/);
});

test("renderToolResultComponent renders failure card when task_receipt_ready returns isError", () => {
	// Args fallback supplies the goal_id even though details is absent.
	const renderable = renderToolResultComponent(
		{
			isError: true,
			content: [{ type: "text", text: "ContextError: goal not attached" }],
		},
		"task_receipt_ready",
		{ goal_id: "g-failpath-1", receipt_path: "receipts/x.md" },
	);
	const lines = renderable.render(96);
	const titleRow = stripAnsi(lines[0]!);
	assert.match(titleRow, /task_receipt_ready/);
	assert.match(titleRow, /error/);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /ContextError/);
	// Slug footer should carry the args goal_id, not "unknown".
	assert.match(plain, /g-failpath-1/);
	assert.ok(!plain.includes("unknown"), "goal_id falls back to args, not the literal 'unknown'");
});

test("renderToolResultComponent renders failure card with 'unknown' when args are absent", () => {
	const renderable = renderToolResultComponent(
		{
			isError: true,
			content: [{ type: "text", text: "boom" }],
		},
		"task_receipt_ready",
	);
	const lines = renderable.render(72);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /unknown/, "no args → falls back to literal 'unknown'");
});

test("renderToolResultComponent for judge_event with awaiting_judge dispatches to receipt-ready card", () => {
	const renderable = renderToolResultComponent({
		content: [{ type: "text", text: "ok" }],
		details: {
			status: "awaiting_judge",
			goal_id: "g-je-1",
			task_id: "task_007",
			receipt_path: "receipts/task_007-worker.md",
			judge_run_id: "jr_je",
			next_action: "judge_pending_launch",
			title: "Judge-event-as-receipt-ready",
		},
	}, "judge_event");
	const lines = renderable.render(96);
	const plain = lines.map(stripAnsi).join("\n");
	// Receipt-ready card uses the `task_receipt_ready` tool name in the title row.
	assert.match(plain, /task_receipt_ready/);
	assert.match(plain, /task_007/);
	assert.match(plain, /accepted/);
});

test("renderToolResultComponent for judge_event with plain event renders the event card", () => {
	const renderable = renderToolResultComponent({
		content: [{ type: "text", text: "ok" }],
		details: {
			event: "judge.started",
			goal_id: "g-je-2",
			run_id: "jr_started",
			title: "Started event",
		},
	}, "judge_event");
	const lines = renderable.render(96);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /judge_event/);
	assert.match(plain, /recorded/);
	assert.match(plain, /judge\.started/);
	assert.match(plain, /jr_started/);
});

test("renderToolResultComponent for judge_event isError renders a failure card (not the receipt-ready card)", () => {
	// The critical path: judge_event with event=task.receipt_ready dispatches
	// persistWorkerReceiptReady which can throw. When pi marks isError, the
	// failure must win over the receipt-ready dispatch.
	const renderable = renderToolResultComponent(
		{
			isError: true,
			content: [{ type: "text", text: "ContextError: session mismatch" }],
		},
		"judge_event",
		{ goal_id: "g-je-fail", event: "task.receipt_ready" },
	);
	const lines = renderable.render(96);
	const titleRow = stripAnsi(lines[0]!);
	assert.match(titleRow, /judge_event/, "tool name stays judge_event on failure");
	assert.match(titleRow, /error/);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /ContextError/);
	assert.ok(!plain.includes("accepted"), "receipt-ready accepted badge does NOT appear on failure");
});

test("renderToolResultComponent for judge_finish maps verdict details to the verdict card", () => {
	const renderable = renderToolResultComponent({
		content: [{ type: "text", text: "ok" }],
		details: {
			goal_id: "g-jf-1",
			run_id: "jr_jf",
			verdict: "pass",
			receipt_path: "receipts/task_004-judge.md",
			summary: "All good.",
			next_action: "advance_task",
			title: "Passing goal",
		},
	}, "judge_finish");
	const lines = renderable.render(96);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /verdict pass/);
	assert.match(plain, /Passing goal/);
});

test("renderToolResultComponent for judge_finish isError renders a failure card with args fallback", () => {
	const renderable = renderToolResultComponent(
		{
			isError: true,
			content: [{ type: "text", text: "judge_finish is only for isolated Bravo Judge sessions" }],
		},
		"judge_finish",
		{ goal_id: "g-jf-fail", verdict: "pass" },
	);
	const lines = renderable.render(72);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /judge_finish/);
	assert.match(plain, /error/);
	assert.match(plain, /g-jf-fail/);
	assert.ok(!plain.includes("verdict pass"), "no verdict-pass badge on a failure");
});

test("renderToolResultComponent fallback path renders just the text content when no card matches", () => {
	// judge_finish without a verdict in details takes the safety fallback.
	const renderable = renderToolResultComponent({
		content: [{ type: "text", text: "Some plain text" }],
		details: { goal_id: "g-fallback" },
	}, "judge_finish");
	const lines = renderable.render(72);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /Some plain text/);
});
