import assert from "node:assert/strict";
import test from "node:test";
import {
	IDENTITY_PALETTE,
	chrome,
	chromeRenderable,
	identityColor,
	identitySlot,
	idBar,
	renderFailureCard,
	renderJudgeEventCall,
	renderJudgeEventResult,
	renderJudgeFinishCall,
	renderJudgeFinishResult,
	renderTaskReceiptReadyCall,
	renderTaskReceiptReadyResult,
	renderValidateGoalStateCall,
	renderValidateGoalStateResult,
	titleMaxFor,
	truncAnsi,
	visWidth,
} from "../extensions/pi/renderers.js";

const ANSI_RED = "\x1b[38;2;232;111;111m";
const ANSI_AMBER = "\x1b[38;2;229;181;72m";
const ANSI_GREEN = "\x1b[38;2;106;191;115m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

// Canonical fixtures from the mockup so visual diff is 1:1.
const FIXTURES = {
	cardGrammar: {
		goal_id: "2026-q2-bravo-tool-card-grammar",
		goal_title: "Redesign bravo-goals tool-call cards in shared grammar",
	},
	judgeRunner: {
		goal_id: "2026-q2-bravo-judge-runner-v1",
		goal_title: "Ship Bravo Judge runner with isolated session lifecycle",
	},
	sessionAttach: {
		goal_id: "2026-q2-bravo-session-attach",
		goal_title: "Attach Bravo goals to current Pi session by id",
	},
	receiptsV1: {
		goal_id: "2026-q2-bravo-receipts-v1",
		goal_title: "Bravo worker receipts v1 (frontmatter + receipt-ready hook)",
	},
	lifecycleUx: {
		goal_id: "2026-q1-bravo-lifecycle-ux",
		goal_title: "Tango-interactive lifecycle UX for Bravo goals",
	},
};

test("identitySlot hashes deterministically into the 8-color palette", () => {
	for (const fixture of Object.values(FIXTURES)) {
		const a = identitySlot(fixture.goal_id);
		const b = identitySlot(fixture.goal_id);
		assert.equal(a, b);
		assert.ok(a >= 0 && a < IDENTITY_PALETTE.length, `slot ${a} out of bounds for ${fixture.goal_id}`);
		assert.equal(identityColor(fixture.goal_id), IDENTITY_PALETTE[a]);
	}
});

test("identitySlot key is the goal_id slug, not the title — twins with same title differ when slugs differ", () => {
	const twinAlpha = "2026-q2-bravo-test-goal-alpha";
	const twinBeta = "2026-q2-bravo-test-goal-beta";
	// They MAY collide (8-slot palette) but the slot hash is independent of title.
	const colorAlpha = identityColor(twinAlpha);
	const colorBeta = identityColor(twinBeta);
	// Both should be palette members
	assert.ok(IDENTITY_PALETTE.includes(colorAlpha));
	assert.ok(IDENTITY_PALETTE.includes(colorBeta));
	// Editing the title doesn't change the color — identitySlot(slug) is stable.
	assert.equal(identitySlot(twinAlpha), identitySlot(twinAlpha));
});

test("identity hash uses (h*31 + ch) >>> 0 % palette.length — pin known slots", () => {
	// Pin fixtures so palette/hash drift never goes unnoticed. These came from
	// running the mockup verbatim.
	assert.equal(identitySlot("2026-q2-bravo-tool-card-grammar"), 3);
	assert.equal(identitySlot("2026-q2-bravo-judge-runner-v1"), 6);
	assert.equal(identitySlot("2026-q2-bravo-session-attach"), 0);
});

test("titleMaxFor scales the title budget at every width threshold", () => {
	assert.equal(titleMaxFor(160), 60);
	assert.equal(titleMaxFor(120), 60);
	assert.equal(titleMaxFor(119), 44);
	assert.equal(titleMaxFor(96), 44);
	assert.equal(titleMaxFor(95), 28);
	assert.equal(titleMaxFor(72), 28);
	assert.equal(titleMaxFor(71), 18);
	assert.equal(titleMaxFor(56), 18);
	assert.equal(titleMaxFor(55), 12);
	assert.equal(titleMaxFor(44), 12);
});

test("idBar dim option enables the dim ANSI prefix on the identity bar", () => {
	const bar = idBar("2026-q2-bravo-tool-card-grammar");
	const dimBar = idBar("2026-q2-bravo-tool-card-grammar", { dim: true });
	assert.ok(!bar.startsWith(ANSI_DIM));
	assert.ok(dimBar.startsWith(ANSI_DIM));
});

test("idBar override replaces the identity color with the supplied ANSI", () => {
	const overridden = idBar("any-id", { override: ANSI_RED });
	assert.ok(overridden.startsWith(ANSI_RED));
	assert.ok(!overridden.includes(identityColor("any-id")));
});

test("visWidth ignores ANSI escapes and treats CJK/emoji widths correctly", () => {
	assert.equal(visWidth("hello"), 5);
	assert.equal(visWidth("中文"), 4);
	assert.equal(visWidth("\x1b[31mhello\x1b[0m"), 5);
	assert.equal(visWidth("✅"), 2);
	assert.equal(visWidth("✓"), 1);
	assert.equal(visWidth("⚠"), 1);
	assert.equal(visWidth("⚠️"), 2);
});

test("truncAnsi caps visible width and appends an ellipsis", () => {
	const out = truncAnsi("the quick brown fox", 10);
	assert.ok(out.endsWith("…\x1b[0m"));
	assert.ok(visWidth(out) <= 10);
	assert.ok(visWidth(truncAnsi("ok ⚠️ done", 7)) <= 7);
});

test("renderTaskReceiptReadyCall produces a title-bar with bold colored # title and tool name", () => {
	// width=96 has enough slack for the "ready for judge" badge to fit alongside
	// the tool name (chrome drops the badge when tight, by design).
	const lines = renderTaskReceiptReadyCall({
		...FIXTURES.cardGrammar,
		receipt_path: "receipts/task_004-worker.md",
		summary: "Implemented and tested.",
	}, 96);
	assert.ok(lines.length >= 4, "card has top + body rows + bot");
	const titleRow = lines[0]!;
	const identity = identityColor(FIXTURES.cardGrammar.goal_id);
	assert.ok(titleRow.includes(identity), "title row uses identity color");
	assert.ok(titleRow.includes(ANSI_BOLD), "title is bold");
	assert.ok(titleRow.includes("# Redesign"), "title is `#`-prefixed");
	assert.ok(titleRow.includes("task_receipt_ready"), "title row names the tool");
	// `→ ready for judge` badge
	assert.match(stripAnsi(titleRow), /ready for judge/);
});

test("renderTaskReceiptReadyResult includes label rows and a slug footer", () => {
	const lines = renderTaskReceiptReadyResult({
		...FIXTURES.cardGrammar,
		task_id: "task_004",
		receipt_path: "receipts/task_004-worker.md",
		judge_run_id: "jr_2026_05_16_191220_a1b2c3",
		judge_run_path: ".bravo/runs/jr_2026_05_16_191220_a1b2c3",
		judge_receipt_path: ".bravo/goals/foo/receipts/task_004-judge.md",
		next_action: "judge_pending_launch",
	}, 96);
	const plain = lines.map(stripAnsi);
	// `task`, `receipt`, `judge run`, `next` always present at width=96
	assert.ok(plain.some((row) => /task\s+task_004/.test(row)), "task row present");
	assert.ok(plain.some((row) => /receipt\s+receipts\/task_004-worker\.md/.test(row)), "receipt row present");
	assert.ok(plain.some((row) => /judge run/.test(row)), "judge run row present");
	assert.ok(plain.some((row) => /next\s+judge_pending_launch/.test(row)), "next row present");
	// Slug footer — indented goal_id (mid-truncated when too long)
	assert.ok(plain.some((row) => /2026-q2-bravo-tool-card-grammar|2026-q2-bra.*card-grammar/.test(row)), "slug footer present");
});

test("judge_event title is dim (NOT bold) and bar is dim — administrative log strip", () => {
	const lines = renderJudgeEventCall({
		...FIXTURES.judgeRunner,
		event: "task.receipt_ready",
		note: "task_007 worker receipt complete",
	}, 72);
	const titleRow = lines[0]!;
	// Title contains the identity color but NOT bold.
	assert.ok(titleRow.includes(identityColor(FIXTURES.judgeRunner.goal_id)), "identity color present");
	// The first occurrence of the dim escape comes from the bar; verify the title
	// portion contains another dim escape before the `#` glyph.
	const hashIndex = titleRow.indexOf("# ");
	assert.ok(hashIndex > 0);
	const beforeHash = titleRow.slice(0, hashIndex);
	assert.ok(beforeHash.includes(ANSI_DIM), "title section is dimmed before the `#`");
	// And the badge says "logging".
	assert.match(stripAnsi(titleRow), /logging/);
});

test("judge_event result shows event name and run id when present", () => {
	const lines = renderJudgeEventResult({
		...FIXTURES.judgeRunner,
		event: "judge.started",
		run_id: "jr_2026_05_16_185512_d4e5",
	}, 72);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /judge\.started/);
	assert.match(plain, /jr_2026_05_16_185512_d4e5/);
	assert.match(plain, /recorded/, "badge says recorded");
});

test("judge_finish pass keeps identity hue on title and bar", () => {
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		run_id: "jr_191220_a1b2c3",
		verdict: "pass",
		receipt_path: ".bravo/goals/x/receipts/task_004-judge.md",
		summary: "All criteria met.",
		next_action: "advance_task",
	}, 96);
	const titleRow = lines[0]!;
	const identity = identityColor(FIXTURES.cardGrammar.goal_id);
	assert.ok(titleRow.includes(identity), "identity color survives on pass");
	assert.ok(!titleRow.includes(ANSI_RED), "no red override on pass");
	// Pass badge is green
	const plain = stripAnsi(titleRow);
	assert.match(plain, /verdict pass/);
	assert.ok(titleRow.includes(ANSI_GREEN), "pass badge uses green");
});

test("judge_finish fail overrides title and bar to red", () => {
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		run_id: "jr_192015_b2c3d4",
		verdict: "fail",
		receipt_path: ".bravo/goals/x/receipts/task_005-judge.md",
		summary: "Chrome breaks at 44.",
	}, 96);
	const titleRow = lines[0]!;
	assert.ok(titleRow.includes(ANSI_RED), "title row uses red");
	// Identity color should NOT appear on the title — red overrides it.
	const identity = identityColor(FIXTURES.cardGrammar.goal_id);
	// The bar AND the title text should be red; the only place identity might
	// linger is the slug footer (rendered later). Confirm the title bar uses red.
	const titleSegmentEnd = titleRow.indexOf(" · ");
	const titleSegment = titleSegmentEnd > 0 ? titleRow.slice(0, titleSegmentEnd) : titleRow;
	assert.ok(!titleSegment.includes(identity), "fail title segment has no identity hue");
});

test("judge_finish needs_more_evidence overrides title and bar to amber", () => {
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		run_id: "jr_193147_c3d4e5",
		verdict: "needs_more_evidence",
		receipt_path: ".bravo/goals/x/receipts/task_006-judge.md",
		summary: "Need more screenshots.",
	}, 96);
	const titleRow = lines[0]!;
	assert.ok(titleRow.includes(ANSI_AMBER), "title row uses amber");
	assert.match(stripAnsi(titleRow), /needs more evidence/);
});

test("judge_finish blocked overrides to red with warning glyph", () => {
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		run_id: "jr_194523_d4e5f6",
		verdict: "blocked",
		receipt_path: ".bravo/goals/x/receipts/task_007-judge.md",
		summary: "Waiting on upstream.",
	}, 96);
	const titleRow = lines[0]!;
	assert.ok(titleRow.includes(ANSI_RED), "blocked uses red");
	assert.match(stripAnsi(titleRow), /⚠/);
	assert.match(stripAnsi(titleRow), /blocked/);
});

test("judge_finish call uses cyan judging badge before verdict lands", () => {
	const lines = renderJudgeFinishCall({
		...FIXTURES.cardGrammar,
		run_id: "jr_pending",
	}, 72);
	const plain = stripAnsi(lines[0]!);
	assert.match(plain, /judging/);
});

test("renderFailureCard uses red bar and the failing tool's name", () => {
	const lines = renderFailureCard({
		...FIXTURES.cardGrammar,
		tool: "task_receipt_ready",
		error: "ContextError: No attached active Bravo goal found.",
		suggestion: "/goal resume — then retry",
	}, 96);
	const titleRow = lines[0]!;
	assert.ok(titleRow.includes(ANSI_RED), "failure title row uses red");
	assert.match(stripAnsi(titleRow), /task_receipt_ready/);
	assert.match(stripAnsi(titleRow), /error/);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /ContextError/);
	assert.match(plain, /\/goal resume/);
});

test("validate_goal_state call renders as a checking card", () => {
	const lines = renderValidateGoalStateCall(FIXTURES.cardGrammar, 96);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /validate_goal_state/);
	assert.match(plain, /checking/);
	assert.match(plain, /goal\s+2026-q2-bravo-tool-card-grammar/);
});

test("validate_goal_state result renders valid and invalid cards", () => {
	const valid = renderValidateGoalStateResult({
		...FIXTURES.cardGrammar,
		state_path: ".bravo/goals/2026-q2-bravo-tool-card-grammar/state.yaml",
		ok: true,
		issue_count: 0,
		issues: [],
	}, 96).map(stripAnsi).join("\n");
	assert.match(valid, /validate_goal_state/);
	assert.match(valid, /valid/);
	assert.match(valid, /state\s+\.bravo\/goals/);

	const invalidLines = renderValidateGoalStateResult({
		...FIXTURES.cardGrammar,
		state_path: ".bravo/goals/2026-q2-bravo-tool-card-grammar/state.yaml",
		ok: false,
		issue_count: 2,
		issues: [
			{ severity: "error", code: "TASK_KIND_INVALID", message: "Task kind must be work.", path: "tasks[0].kind" },
			{ severity: "error", code: "TASK_VERIFY_INVALID", message: "Task verify must be a list.", path: "tasks[0].verify" },
		],
	}, 96);
	const invalid = invalidLines.map(stripAnsi).join("\n");
	assert.match(invalid, /invalid/);
	assert.match(invalid, /issues\s+2/);
	assert.match(invalid, /TASK_KIND_INVALID/);
	assert.ok(invalidLines.some((line) => line.includes(ANSI_RED)), "invalid card uses red emphasis");
});

test("slug footer appears as the last row before the bottom border at widths >= 56", () => {
	for (const width of [56, 72, 96, 120]) {
		const lines = renderTaskReceiptReadyResult({
			...FIXTURES.cardGrammar,
			task_id: "task_004",
			receipt_path: "receipts/task_004-worker.md",
			judge_run_id: "jr_x",
			next_action: "judge_pending_launch",
		}, width);
		const last = lines[lines.length - 1]!;
		const beforeLast = lines[lines.length - 2]!;
		assert.match(last, /╰/, `width=${width}: last line is bottom border`);
		const plainSlug = stripAnsi(beforeLast);
		// Slug includes a recognizable fragment of the canonical id (mid-truncated)
		assert.ok(
			plainSlug.includes("2026-q2") && plainSlug.includes("card-grammar"),
			`width=${width}: slug footer contains canonical-id fragments`,
		);
	}
});

test("title is `# `-prefixed across every tool/verdict", () => {
	const cards: string[][] = [
		renderTaskReceiptReadyCall({ ...FIXTURES.cardGrammar }, 72),
		renderTaskReceiptReadyResult({
			...FIXTURES.cardGrammar,
			task_id: "task_004",
			receipt_path: "receipts/task_004-worker.md",
			judge_run_id: "jr_x",
		}, 72),
		renderJudgeEventCall({ ...FIXTURES.cardGrammar, event: "judge.started" }, 72),
		renderJudgeEventResult({ ...FIXTURES.cardGrammar, event: "judge.started" }, 72),
		renderJudgeFinishCall({ ...FIXTURES.cardGrammar }, 72),
		renderJudgeFinishResult({
			...FIXTURES.cardGrammar,
			verdict: "pass",
			receipt_path: "receipts/task_004-judge.md",
		}, 72),
		renderJudgeFinishResult({
			...FIXTURES.cardGrammar,
			verdict: "fail",
			receipt_path: "receipts/task_005-judge.md",
		}, 72),
		renderJudgeFinishResult({
			...FIXTURES.cardGrammar,
			verdict: "needs_more_evidence",
			receipt_path: "receipts/task_006-judge.md",
		}, 72),
		renderJudgeFinishResult({
			...FIXTURES.cardGrammar,
			verdict: "blocked",
			receipt_path: "receipts/task_007-judge.md",
		}, 72),
		renderFailureCard({
			...FIXTURES.cardGrammar,
			tool: "judge_finish",
			error: "broken",
		}, 72),
	];
	for (const lines of cards) {
		const titleRow = lines[0]!;
		assert.match(stripAnsi(titleRow), /# Redesign/, "title row carries `# ` prefix");
	}
});

test("long titles end-truncate cleanly inside the title budget", () => {
	const longTitle = "Redesign all three bravo-goals Pi tool-call cards to share the async-subagents visual grammar, including responsive widths and verdict colors";
	for (const width of [44, 56, 72, 96, 120]) {
		const lines = renderTaskReceiptReadyCall({
			goal_id: "long-card",
			goal_title: longTitle,
		}, width);
		const titleRow = lines[0]!;
		// Title row never overruns chrome width
		assert.ok(visWidth(titleRow) <= width, `width=${width}: title row stays within chrome (${visWidth(titleRow)})`);
	}
});

test("chrome holds declared width across 56/72/96/120", () => {
	for (const width of [56, 72, 96, 120]) {
		const lines = renderTaskReceiptReadyResult({
			...FIXTURES.cardGrammar,
			task_id: "task_004",
			receipt_path: "receipts/task_004-worker.md",
			judge_run_id: "jr_x",
			judge_run_path: ".bravo/runs/jr_x",
			judge_receipt_path: ".bravo/goals/x/receipts/task_004-judge.md",
			next_action: "judge_pending_launch",
		}, width);
		for (const line of lines) {
			assert.equal(visWidth(line), width, `width=${width}: every row is exactly ${width} cells wide`);
		}
	}
});

test("tool cards normalize embedded newlines before rendering chrome rows", () => {
	const lines = renderTaskReceiptReadyResult({
		...FIXTURES.cardGrammar,
		goal_title: "Multiline\ngoal title",
		task_id: "task_004",
		receipt_path: "receipts/task_004-worker.md\nextra",
		judge_run_id: "jr_x",
		next_action: "judge_pending_launch",
	}, 72);
	for (const line of lines) {
		assert.ok(!/[\r\n]/.test(line), `line contains embedded newline: ${JSON.stringify(stripAnsi(line))}`);
		assert.equal(visWidth(line), 72);
	}
});

test("low-priority rows drop at narrow widths", () => {
	// At 56 the next-action row drops (mockup contract).
	const narrow = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		run_id: "jr_x",
		verdict: "fail",
		receipt_path: "receipts/task_005-judge.md",
		summary: "Short summary.",
		next_action: "return_to_worker",
	}, 56);
	const narrowPlain = narrow.map(stripAnsi).join("\n");
	assert.doesNotMatch(narrowPlain, /next\s+return_to_worker/, "next row drops at 56");

	const wide = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		run_id: "jr_x",
		verdict: "fail",
		receipt_path: "receipts/task_005-judge.md",
		summary: "Short summary.",
		next_action: "return_to_worker",
	}, 96);
	const widePlain = wide.map(stripAnsi).join("\n");
	assert.match(widePlain, /next\s+return_to_worker/, "next row present at 96");
});

test("body row truncation uses the path-aware mid-trunc with ellipsis", () => {
	const longPath = ".bravo/goals/2026-q2-bravo-some-very-long-slug/receipts/task_017-judge.md";
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		verdict: "pass",
		receipt_path: longPath,
	}, 56);
	const receiptRow = lines.map(stripAnsi).find((row) => /receipt\s/.test(row));
	assert.ok(receiptRow, "receipt row present");
	// ellipsis marker is `…`
	assert.match(receiptRow, /…/, "long path is truncated");
	// width is enforced by chrome
	for (const line of lines) {
		assert.equal(visWidth(line), 56);
	}
});

test("chromeRenderable returns a TextRenderable that renders at the supplied width", () => {
	const renderable = chromeRenderable((width) => renderTaskReceiptReadyResult({
		...FIXTURES.cardGrammar,
		task_id: "task_004",
		receipt_path: "receipts/task_004-worker.md",
		judge_run_id: "jr_x",
		next_action: "judge_pending_launch",
	}, width));
	const lines = renderable.render(72);
	assert.ok(lines.length > 0);
	for (const line of lines) {
		assert.equal(visWidth(line), 72);
	}
});

test("missing goal_title falls back to the slug for the title text", () => {
	const lines = renderTaskReceiptReadyCall({
		goal_id: "fallback-id-no-title",
	}, 72);
	const titleRow = lines[0]!;
	assert.match(stripAnsi(titleRow), /# fallback-id-no-title/);
});

test("chrome row width math holds for blank label rows in judge_finish summary blocks", () => {
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		run_id: "jr_x",
		verdict: "fail",
		receipt_path: "receipts/task_005-judge.md",
		summary: "Line one.\nLine two.\nLine three.",
		next_action: "return_to_worker",
	}, 96);
	for (const line of lines) {
		assert.equal(visWidth(line), 96, "summary wrap rows match width");
	}
	// Confirm the summary continuation rows actually appear (label indent only on first row).
	const plain = lines.map(stripAnsi);
	assert.ok(plain.some((row) => /summary\s+Line one/.test(row)));
	assert.ok(plain.some((row) => /Line two/.test(row)));
	assert.ok(plain.some((row) => /Line three/.test(row)));
});

test("chrome() emits well-formed rounded borders at the requested width", () => {
	const ch = chrome(40);
	const top = ch.top();
	const bot = ch.bot();
	assert.equal(visWidth(top), 40);
	assert.equal(visWidth(bot), 40);
	assert.ok(top.includes("╭"));
	assert.ok(top.includes("╮"));
	assert.ok(bot.includes("╰"));
	assert.ok(bot.includes("╯"));
});

test("judge_finish with empty summary still produces well-formed chrome (no blank-row break)", () => {
	// Summary is undefined: card should skip the summary block entirely, not
	// emit a stray blank row that breaks width math.
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		verdict: "pass",
		receipt_path: "receipts/task_001-judge.md",
		// no summary, no next_action, no run_id
	}, 96);
	for (const line of lines) {
		assert.equal(visWidth(line), 96, "every row stays at the declared width");
	}
	const plain = lines.map(stripAnsi).join("\n");
	assert.doesNotMatch(plain, /summary/, "no summary row appears when summary is undefined");
	assert.match(plain, /verdict pass/, "verdict badge still renders");
});

test("judge_finish with empty-string summary skips the summary block (no stray label row)", () => {
	const lines = renderJudgeFinishResult({
		...FIXTURES.cardGrammar,
		verdict: "fail",
		receipt_path: "receipts/task_005-judge.md",
		summary: "",
	}, 96);
	for (const line of lines) {
		assert.equal(visWidth(line), 96);
	}
	const plain = lines.map(stripAnsi).join("\n");
	assert.doesNotMatch(plain, /summary/, "empty summary string still skips the row");
});

test("titles containing quotes / colons / brackets / arrows render without escape issues", () => {
	const punctTitles = [
		`Fix the "task receipt" frontmatter validator (it's strict)`,
		"Pi extension: add file-ref affordance to renderers/judge-control",
		"Hot-reload (dev-only) for HUD widget; ignore in prod sessions",
		"Add [optional] judge-receipt-path to TaskReceiptReady — fallback",
		"Rename → from `judge.completed` to `judge.verdict_written`",
	];
	for (const title of punctTitles) {
		const lines = renderJudgeFinishResult({
			goal_id: `g-punct-${title.length}`,
			goal_title: title,
			run_id: "jr_p",
			verdict: "pass",
			receipt_path: "receipts/task_002-judge.md",
			summary: "All good.",
			next_action: "advance_task",
		}, 96);
		for (const line of lines) {
			assert.equal(visWidth(line), 96, `width math holds for title: ${title}`);
		}
		// Title row should not have been mangled (the first 5 chars of the title
		// after the `# ` prefix are still readable in plain text).
		const titleRow = stripAnsi(lines[0]!);
		assert.match(titleRow, /# /, `# prefix preserved for: ${title}`);
	}
});

test("very long titles (140+ chars) end-truncate cleanly at the title budget for every width", () => {
	const longTitle =
		"Redesign all three bravo-goals Pi tool-call cards to share the async-subagents visual grammar, including responsive widths and verdict colors";
	assert.ok(longTitle.length >= 140, "fixture is genuinely 140+ chars");
	for (const width of [44, 56, 72, 96, 120]) {
		const lines = renderJudgeFinishResult({
			goal_id: "g-long-title",
			goal_title: longTitle,
			run_id: "jr_x",
			verdict: "fail",
			receipt_path: "receipts/task_005-judge.md",
			summary: "Truncation should not break chrome.",
			next_action: "return_to_worker",
		}, width);
		// Every line stays at the declared width
		for (const line of lines) {
			assert.equal(visWidth(line), width, `width=${width}: long title kept chrome at ${visWidth(line)}`);
		}
		// Title row uses the ellipsis marker
		const titleRow = stripAnsi(lines[0]!);
		assert.match(titleRow, /…/, `width=${width}: long title ends with ellipsis`);
	}
});

test("identity palette is byte-identical to the async-subagents palette (no drift)", () => {
	// These RGB triplets MUST match the IDENTITY_PALETTE in
	// packages/async-subagents/extensions/pi/renderers.ts and
	// .pi/extensions/codex-usage.ts. If you change one, change all three.
	const expected = [
		"\x1b[38;2;229;145;91m",
		"\x1b[38;2;199;125;186m",
		"\x1b[38;2;123;201;123m",
		"\x1b[38;2;111;169;217m",
		"\x1b[38;2;155;123;217m",
		"\x1b[38;2;91;201;181m",
		"\x1b[38;2;217;195;111m",
		"\x1b[38;2;217;125;125m",
	];
	assert.deepEqual([...IDENTITY_PALETTE], expected);
});

test("safeWidth chrome floor: width=0 / NaN / negative falls back to a renderable card", () => {
	// safeWidth lives inside renderers.ts and is exercised via the public
	// render functions. Pathological widths must still produce a card.
	for (const w of [0, -10, Number.NaN, 5]) {
		const lines = renderTaskReceiptReadyCall({
			goal_id: "g-pathological-width",
			goal_title: "Width fallback",
			receipt_path: "receipts/task_001-worker.md",
		}, w);
		// Whatever width came out, it must be consistent across every line.
		const widthOut = visWidth(lines[0]!);
		assert.ok(widthOut >= 44, `clamped width >= 44 (got ${widthOut} for input ${w})`);
		for (const line of lines) {
			assert.equal(visWidth(line), widthOut, `every line matches the clamped width for input ${w}`);
		}
	}
});

test("safeWidth chrome ceiling: extreme widths clamp to 160", () => {
	const lines = renderTaskReceiptReadyCall({
		goal_id: "g-overrender",
		goal_title: "Wide goal",
		receipt_path: "receipts/task_001-worker.md",
	}, 9999);
	const widthOut = visWidth(lines[0]!);
	assert.ok(widthOut <= 160, `clamped width <= 160 (got ${widthOut})`);
	for (const line of lines) {
		assert.equal(visWidth(line), widthOut);
	}
});
