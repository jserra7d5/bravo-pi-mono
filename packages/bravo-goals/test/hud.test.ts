import assert from "node:assert/strict";
import test from "node:test";
import {
	visWidth,
	truncAnsi,
	normalizeGoalState,
	pickLayout,
	renderHud,
	renderStatusLine,
	judgeGlyphForFrame,
	type GoalStateView,
	type HudSnapshot,
} from "../extensions/pi/hud.js";

// ---- visWidth ---------------------------------------------------------------

test("visWidth: plain ASCII counts 1 cell per character", () => {
	assert.equal(visWidth("hello"), 5);
	assert.equal(visWidth(""), 0);
});

test("visWidth: ANSI escape sequences contribute 0 cells", () => {
	const colored = "\x1b[38;2;229;181;72mhello\x1b[0m";
	assert.equal(visWidth(colored), 5);
});

test("visWidth: emoji counts 2 cells", () => {
	assert.equal(visWidth("🚀"), 2);
	assert.equal(visWidth("🛰️"), 2); // satellite + variation selector — VS contributes 0
});

test("visWidth: variation selector (U+FE0F) does not add cells", () => {
	// U+2714 (check mark) + U+FE0F (variation selector-16) = 2 chars, but 1 cell
	const withVS = "✔️";
	assert.equal(visWidth(withVS), 1);
});

test("visWidth: ZWJ sequences do not over-count", () => {
	// Family emoji: 👨‍👩‍👧 = 5 code points (3 emoji + 2 ZWJ)
	// Should count as 2 cells (a single emoji glyph slot), not 10
	const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
	const w = visWidth(family);
	// Family emoji renders as 2 cells wide in most terminals
	assert.ok(w <= 6, `expected <= 6 cells, got ${w}`);
	// ZWJs should not add cells
	assert.equal(visWidth("‍"), 0);
});

test("visWidth: CJK ideographs count 2 cells", () => {
	assert.equal(visWidth("汉"), 2);
	assert.equal(visWidth("語"), 2);
});

test("visWidth: mixed ANSI + emoji + ASCII", () => {
	// "\x1b[0m" is 0 cells, "🚀" is 2, " hello" is 6
	const s = "\x1b[0m🚀 hello";
	assert.equal(visWidth(s), 8);
});

// ---- truncAnsi --------------------------------------------------------------

test("truncAnsi: string already within limit is returned unchanged", () => {
	const s = "hello";
	assert.equal(truncAnsi(s, 10), "hello");
});

test("truncAnsi: string exactly at limit is returned unchanged", () => {
	const s = "hello";
	assert.equal(truncAnsi(s, 5), "hello");
});

test("truncAnsi: plain string is truncated with ellipsis", () => {
	const result = truncAnsi("hello world", 7);
	// Should be "hello w" → reserved 1 for "…" → "hello " + "…"
	assert.equal(visWidth(result), 7);
	assert.ok(result.endsWith("…\x1b[0m") || result.endsWith("…"), "should end with ellipsis");
});

test("truncAnsi: ANSI escape at truncation boundary is handled correctly", () => {
	const s = "\x1b[32mhello world\x1b[0m";
	const result = truncAnsi(s, 7);
	assert.equal(visWidth(result), 7);
	assert.ok(result.includes("…"), "should contain ellipsis");
});

test("truncAnsi: ANSI codes in the middle are preserved", () => {
	const s = "ab\x1b[32mcd\x1b[0mef";
	// total visible: 6 chars
	const result = truncAnsi(s, 4);
	// "ab" + "\x1b[32m" + "c" → 3 visible + reset, then "…"
	assert.equal(visWidth(result), 4);
});

test("truncAnsi: maxCells=1 returns just ellipsis with reset", () => {
	const result = truncAnsi("hello", 1);
	assert.equal(result, "…\x1b[0m");
});

test("truncAnsi: emoji-bearing string truncated at correct cell boundary", () => {
	// "🚀 launch" = 2+1+6 = 9 cells; truncate to 5 → "🚀 la" = 2+1+2 = 5 cells? No:
	// limit = 5-1 = 4 cells available before ellipsis
	// "🚀" = 2 cells → remaining 2 → " l" = 2 → total 4, then "…"
	const result = truncAnsi("🚀 launch", 5);
	assert.equal(visWidth(result), 5);
});

// ---- Active-gate derivation (5 lifecycle states) ----------------------------

function makeState(overrides: Partial<GoalStateView> = {}): GoalStateView {
	return {
		goal: { id: "test-goal", title: "Test Goal", status: "active" },
		active_task: "task-1",
		tasks: [
			{ id: "task-1", title: "Task One", status: "active" },
			{ id: "task-2", title: "Task Two", status: "queued" },
		],
		judge: { last_verdict: "none", active: false },
		progress: { completed_tasks: 0, total_tasks: 2 },
		final_audit: { status: "pending" },
		user_verification: { status: "pending" },
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<GoalStateView> = {}): HudSnapshot {
	return {
		goalPath: "/workspace/.bravo/goals/test-goal",
		state: makeState(overrides),
	};
}

// State 1: tasks active, judge running
test("layout state 1: tasks in progress with judge running shows judging chip", () => {
	const snap = makeSnapshot({
		tasks: [
			{ id: "task-3", title: "Implement resume checkpoint", status: "judging" },
			{ id: "task-4", title: "Wire phase boundary", status: "queued" },
		],
		active_task: "task-3",
		judge: { last_verdict: "none", active: true },
		progress: { completed_tasks: 3, total_tasks: 9 },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /Test Goal/);
	assert.match(joined, /[◐◓◑◒] judging/);
	assert.match(joined, /3\/9/);
	// Tasks gate should be active (◉), audit and verify pending (○)
	assert.match(joined, /tasks/);
	assert.match(joined, /audit/);
	assert.match(joined, /verify/);
	// Progress bar should be present
	assert.match(joined, /▰/);
});

// State 2: all tasks done, awaiting final audit
test("layout state 2: all tasks done awaiting final audit shows audit gate active", () => {
	const snap = makeSnapshot({
		goal: { id: "test-goal", title: "Test Goal", status: "final_audit" },
		active_task: null,
		tasks: [{ id: "task-1", title: "Task One", status: "done" }],
		judge: { last_verdict: "pass", active: false },
		progress: { completed_tasks: 1, total_tasks: 1 },
		final_audit: { status: "pending" },
		user_verification: { status: "pending" },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /awaiting final audit/);
	// Should NOT show progress bar (tasks gate done)
	assert.doesNotMatch(joined, /▰/);
	// Status line should also reflect awaiting final audit
	const statusLine = renderStatusLine(snap);
	assert.ok(statusLine);
	assert.match(statusLine, /awaiting final audit/);
});

test("judge glyph cycles deterministically by frame", () => {
	assert.equal(judgeGlyphForFrame(0), "◐");
	assert.equal(judgeGlyphForFrame(1), "◓");
	assert.equal(judgeGlyphForFrame(2), "◑");
	assert.equal(judgeGlyphForFrame(3), "◒");
	assert.equal(judgeGlyphForFrame(4), "◐");
});

// State 3: final audit passed, awaiting /goal verify
test("layout state 3: final audit passed shows verify gate active", () => {
	const snap = makeSnapshot({
		goal: { id: "test-goal", title: "Test Goal", status: "active" },
		active_task: null,
		tasks: [{ id: "task-1", title: "Task One", status: "done" }],
		judge: { last_verdict: "pass", active: false },
		progress: { completed_tasks: 1, total_tasks: 1 },
		final_audit: { status: "passed" },
		user_verification: { status: "pending" },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /ready for \/goal verify/);
	// Audit gate should show ✓
	assert.match(joined, /audit.*✓/);
	const statusLine = renderStatusLine(snap);
	assert.ok(statusLine);
	assert.match(statusLine, /ready for \/goal verify/);
});

// State 4: fully verified / done
test("layout state 4: fully verified shows gold checkmark badge and done caption", () => {
	const snap = makeSnapshot({
		goal: { id: "test-goal", title: "Test Goal", status: "done" },
		active_task: null,
		tasks: [{ id: "task-1", title: "Task One", status: "done" }],
		judge: { last_verdict: "pass", active: false },
		progress: { completed_tasks: 1, total_tasks: 1 },
		final_audit: { status: "passed" },
		user_verification: { status: "verified" },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /done/);
	assert.match(joined, /archive/);
	// verify gate should show ✓
	assert.match(joined, /verify.*✓/);
	// Title row should have ✓ badge (on first row after top border)
	const titleLine = lines[1] ?? "";
	assert.match(titleLine, /✓/);
	const statusLine = renderStatusLine(snap);
	assert.ok(statusLine);
	assert.match(statusLine, /done/);
	assert.match(statusLine, /archive/);
});

// State 5: judge failed mid-task
test("layout state 5: judge fail shows fail chip and verdict caption", () => {
	const snap = makeSnapshot({
		goal: { id: "test-goal", title: "Test Goal", status: "active" },
		active_task: "task-3",
		tasks: [
			{ id: "task-3", title: "Implement resume checkpoint", status: "active" },
		],
		judge: { last_verdict: "fail", active: false },
		progress: { completed_tasks: 2, total_tasks: 9 },
		final_audit: { status: "pending" },
		user_verification: { status: "pending" },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /✗ judge fail/);
	assert.match(joined, /see receipts\/task-3-judge\.md/);
});

test("layout state 5b: needs_more_evidence shows fail chip", () => {
	const snap = makeSnapshot({
		active_task: "task-3",
		tasks: [{ id: "task-3", title: "Resume checkpoint", status: "active" }],
		judge: { last_verdict: "needs_more_evidence", active: false },
		progress: { completed_tasks: 2, total_tasks: 9 },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /✗ judge fail/);
});

test("layout state 5: progress bar is suppressed when judge-fail caption is present", () => {
	const snap = makeSnapshot({
		active_task: "task-3",
		tasks: [{ id: "task-3", title: "Resume checkpoint", status: "active" }],
		judge: { last_verdict: "fail", active: false },
		progress: { completed_tasks: 2, total_tasks: 9 },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.doesNotMatch(joined, /▰|▱/);
	assert.match(joined, /see receipts\/task-3-judge\.md/);
});

test("layout state 6: final_audit failed shows audit gate fail (red ✗) and failure caption", () => {
	const snap = makeSnapshot({
		goal: { id: "test-goal", title: "Test Goal", status: "final_audit" },
		active_task: null,
		tasks: [{ id: "task-1", title: "Task One", status: "done" }],
		judge: { last_verdict: "fail", active: false },
		progress: { completed_tasks: 1, total_tasks: 1 },
		final_audit: { status: "failed" },
		user_verification: { status: "pending" },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /audit/);
	assert.match(joined, /✗/);
	assert.match(joined, /final audit failed/);
	assert.doesNotMatch(joined, /awaiting final audit/);
	const statusLine = renderStatusLine(snap);
	assert.ok(statusLine);
	assert.match(statusLine, /final audit failed/);
});

test("judge chip is not rendered when verdict is pass (no wallpaper)", () => {
	const snap = makeSnapshot({
		active_task: "task-1",
		tasks: [{ id: "task-1", title: "Task One", status: "active" }],
		judge: { last_verdict: "pass", active: false },
		progress: { completed_tasks: 0, total_tasks: 2 },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.doesNotMatch(joined, /judging/);
	assert.doesNotMatch(joined, /judge fail/);
	assert.doesNotMatch(joined, /judge pass/);
});

test("judge chip is not rendered when verdict is none and no active judge run", () => {
	const snap = makeSnapshot({
		active_task: "task-1",
		tasks: [{ id: "task-1", title: "Task One", status: "active" }],
		judge: { last_verdict: "none", active: false },
		progress: { completed_tasks: 0, total_tasks: 2 },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.doesNotMatch(joined, /judging|judge fail|judge pass/);
});

test("judge chip shows for blocked active task as warn", () => {
	const snap = makeSnapshot({
		active_task: "task-1",
		tasks: [{ id: "task-1", title: "Task One", status: "blocked" }],
		judge: { last_verdict: "none", active: false },
		progress: { completed_tasks: 0, total_tasks: 2 },
	});
	const lines = pickLayout(snap.state, 64);
	const joined = lines.join("\n");
	assert.match(joined, /⚠ blocked/);
});

test("status line caption is just-tasks when work is in progress with no terminal signal", () => {
	const snap = makeSnapshot({
		progress: { completed_tasks: 1, total_tasks: 3 },
	});
	const line = renderStatusLine(snap);
	assert.ok(line);
	assert.match(line, /1\/3 tasks/);
});

// ---- Layout width variants --------------------------------------------------

test("full layout (width >= 56) produces box-chrome lines at width 64", () => {
	const snap = makeSnapshot({
		progress: { completed_tasks: 3, total_tasks: 9 },
		tasks: [{ id: "task-1", title: "Task One", status: "active" }],
	});
	const lines = pickLayout(snap.state, 64);
	// Top and bottom border
	assert.match(lines[0] ?? "", /╭/);
	assert.match(lines[lines.length - 1] ?? "", /╰/);
	// Every line should be exactly 64 visible cells
	for (const line of lines) {
		const w = visWidth(line);
		assert.equal(w, 64, `line has width ${w}, expected 64: ${JSON.stringify(line)}`);
	}
});

test("compact layout (36 <= width < 56) produces 4-line box", () => {
	const snap = makeSnapshot({
		progress: { completed_tasks: 1, total_tasks: 3 },
		tasks: [{ id: "task-1", title: "Task One", status: "active" }],
	});
	const lines = pickLayout(snap.state, 48);
	assert.equal(lines.length, 4, `expected 4 lines, got ${lines.length}`);
	assert.match(lines[0] ?? "", /╭/);
	assert.match(lines[3] ?? "", /╰/);
	// Every line should be exactly 48 visible cells
	for (const line of lines) {
		const w = visWidth(line);
		assert.equal(w, 48, `compact line has width ${w}, expected 48`);
	}
});

test("minimal layout (width < 36) produces a single line with no box chrome", () => {
	const snap = makeSnapshot({
		progress: { completed_tasks: 1, total_tasks: 3 },
		tasks: [{ id: "task-1", title: "Task One", status: "active" }],
	});
	const lines = pickLayout(snap.state, 28);
	assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}`);
	// No box chrome
	assert.doesNotMatch(lines[0] ?? "", /╭|╰/);
	// Must be within the width
	const w = visWidth(lines[0] ?? "");
	assert.ok(w <= 28, `minimal line has width ${w}, should be <= 28`);
});

test("renderHud leaves room for Pi string-widget horizontal padding", () => {
	const snap = makeSnapshot({
		progress: { completed_tasks: 1, total_tasks: 3 },
		tasks: [{ id: "task-1", title: "Task One", status: "active" }],
	});
	const original = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: 64 });
	try {
		const lines = renderHud(snap);
		assert.ok(lines.length > 0, "renderHud should produce widget lines");
		for (const line of lines) {
			const w = visWidth(line);
			assert.ok(w <= 62, `line has width ${w}, expected <= 62 to avoid Text padding wrap`);
		}
	} finally {
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: original });
	}
});

test("layout dispatch boundary at width=56 picks full, width=55 picks compact", () => {
	const snap = makeSnapshot({ tasks: [{ id: "task-1", title: "T", status: "active" }] });
	assert.ok(pickLayout(snap.state, 56).length >= 5, "full layout has divider + multiple rows");
	assert.equal(pickLayout(snap.state, 55).length, 4, "compact layout is 4 lines");
});

test("layout dispatch boundary at width=36 picks compact, width=35 picks minimal", () => {
	const snap = makeSnapshot({ tasks: [{ id: "task-1", title: "T", status: "active" }] });
	assert.equal(pickLayout(snap.state, 36).length, 4, "compact at 36");
	assert.equal(pickLayout(snap.state, 35).length, 1, "minimal at 35");
});

// ---- normalizeGoalState -----------------------------------------------

test("normalizeGoalState populates final_audit from YAML data", () => {
	const raw = {
		goal: { id: "g1", title: "Goal 1", status: "active" },
		tasks: [],
		active_task: null,
		final_audit: { status: "passed", receipt: null, judge_run_id: null },
		user_verification: { status: "pending", verified_at: null, verified_by: null, note: null },
	};
	const state = normalizeGoalState(raw);
	assert.ok(state);
	assert.equal(state.final_audit.status, "passed");
	assert.equal(state.user_verification.status, "pending");
});

test("normalizeGoalState defaults final_audit and user_verification when absent", () => {
	const raw = {
		goal: { id: "g2", title: "Goal 2", status: "draft" },
		tasks: [],
		active_task: null,
	};
	const state = normalizeGoalState(raw);
	assert.ok(state);
	assert.equal(state.final_audit.status, "pending");
	assert.equal(state.user_verification.status, "pending");
});

test("normalizeGoalState populates task status field", () => {
	const raw = {
		goal: { id: "g3", title: "Goal 3", status: "active" },
		tasks: [
			{ id: "task-1", title: "Task One", status: "awaiting_judge", receipt: null },
		],
		active_task: "task-1",
		final_audit: { status: "pending" },
		user_verification: { status: "pending" },
	};
	const state = normalizeGoalState(raw);
	assert.ok(state);
	assert.equal(state.tasks[0]?.status, "awaiting_judge");
});
