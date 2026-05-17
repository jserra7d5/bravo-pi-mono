// Standalone tests (not wired into npm run check, no tsconfig under .pi/). Run with:
//   node --experimental-strip-types --test .pi/extensions/__tests__/codex-usage.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	c,
	bar,
	codexThreshold,
	codexWindowSegment,
	costSegment,
	ctxSegment,
	formatTokens,
	identityColor,
	identitySlot,
	pickLayoutWidths,
	renderFooter,
	renderStatsLine,
	renderTopLine,
	stripAnsi,
	threshold,
	visWidth,
	type FooterRenderState,
} from "../codex-usage.ts";
import {
	identitySlot as asyncSubagentsIdentitySlot,
	identityColor as asyncSubagentsIdentityColor,
} from "../../../packages/async-subagents/extensions/pi/renderers.ts";

function makeState(overrides: Partial<FooterRenderState> = {}): FooterRenderState {
	return {
		cwd: "~/p/bravo-pi-mono",
		branch: "main",
		sessionName: null,
		model: "gpt-5.5",
		provider: "openai-codex",
		providerCount: 2,
		thinking: "medium",
		ctxPct: 12,
		ctxUsed: 33_000,
		ctxWindow: 272_000,
		ctxKnown: true,
		cost: 0.42,
		sub: true,
		codex: {
			primary: 80,
			primaryReset: "4h",
			secondary: 55,
			secondaryReset: "4d",
		},
		...overrides,
	};
}

// ── threshold ──────────────────────────────────────────────────────────────

test("threshold returns the correct color for each band", () => {
	assert.equal(threshold(0), c.dim);
	assert.equal(threshold(49.9), c.dim);
	assert.equal(threshold(50), c.text);
	assert.equal(threshold(69.9), c.text);
	assert.equal(threshold(70), c.warn);
	assert.equal(threshold(89.9), c.warn);
	assert.equal(threshold(90), c.bad);
	assert.equal(threshold(100), c.bad);
});

test("codexThreshold treats input as remaining percent", () => {
	assert.equal(codexThreshold(100), c.ok);
	assert.equal(codexThreshold(31), c.ok);
	assert.equal(codexThreshold(30), c.warn);
	assert.equal(codexThreshold(11), c.warn);
	assert.equal(codexThreshold(10), c.bad);
	assert.equal(codexThreshold(0), c.bad);
});

// ── identity color ─────────────────────────────────────────────────────────

test("identityColor is deterministic and distributes across the palette", () => {
	const names = [
		"gpt-5.5",
		"claude-opus-4-7",
		"claude-sonnet-4-6",
		"claude-haiku-4-5",
		"gpt-4o",
		"o3-mini",
		"gemini-2.5",
		"llama-3.3",
		"deepseek-r2",
		"mistral-large",
	];
	const slots = new Set<number>();
	for (const name of names) {
		const a = identityColor(name);
		const b = identityColor(name);
		assert.equal(a, b, `identityColor(${name}) is not deterministic`);
		slots.add(identitySlot(name));
	}
	// Across 10 distinct names we expect more than one bucket — guards against an
	// all-zero hash bug.
	assert.ok(slots.size >= 4, `expected multiple identity slots, got ${slots.size}`);
});

test("identitySlot for empty string falls into a valid bucket", () => {
	const slot = identitySlot("");
	assert.ok(slot >= 0 && slot < c.id.length);
});

// ── palette harmony with async-subagents ───────────────────────────────────
// Guards against drift between the footer palette and the async-subagents
// card palette. The slot mapping is shared (same hash, same modulus); the RGB
// triplets MUST stay byte-identical so the same name renders in the same hue
// across packages.

test("identitySlot matches async-subagents for canonical model names", () => {
	const names = [
		"gpt-5.5",
		"claude-opus-4-7",
		"claude-sonnet-4-6",
		"claude-haiku-4-5",
		"gemini-2.5",
		"o3-mini",
		"llama-3.3",
		"deepseek-r2",
	];
	for (const name of names) {
		assert.equal(
			identitySlot(name),
			asyncSubagentsIdentitySlot(name),
			`slot drift for ${name}`,
		);
	}
});

test("identityColor for canonical model names maps to expected slot index", () => {
	// Known fixed slots — guards against the hash algorithm changing under us.
	const expected: Array<[string, number]> = [
		["gpt-5.5", 2],
		["claude-opus-4-7", 7],
		["claude-sonnet-4-6", 2],
		["claude-haiku-4-5", 2],
	];
	for (const [name, slot] of expected) {
		assert.equal(identitySlot(name), slot, `slot for ${name}`);
		assert.equal(identityColor(name), c.id[slot], `color for ${name}`);
	}
});

test("c.id palette is byte-identical to async-subagents IDENTITY_PALETTE", () => {
	// We can't import IDENTITY_PALETTE directly (it's not exported), but we can
	// resolve every slot via identityColor on a probe set that covers all 8
	// slots and assert each entry matches.
	for (let slot = 0; slot < c.id.length; slot++) {
		// Build a string that hashes to this slot. Brute-force a short probe.
		let probe = "";
		for (let i = 0; i < 256; i++) {
			const candidate = String.fromCharCode(65 + i);
			if (identitySlot(candidate) === slot) {
				probe = candidate;
				break;
			}
		}
		assert.notEqual(probe, "", `could not find probe for slot ${slot}`);
		assert.equal(
			asyncSubagentsIdentityColor(probe),
			c.id[slot],
			`palette drift at slot ${slot}`,
		);
	}
});

// ── bar ────────────────────────────────────────────────────────────────────

test("bar fills the correct cell count and preserves total width", () => {
	const inputs: Array<[number, number, number]> = [
		[0, 16, 0],
		[100, 16, 16],
		[50, 16, 8],
		[58.3, 16, 9], // 9.328 rounded
		[12.5, 8, 1], // 1.0 rounded
		[12.6, 8, 1], // 1.008 rounded
	];
	for (const [pct, width, expectFilled] of inputs) {
		const out = bar(pct, width, c.ok);
		const stripped = stripAnsi(out);
		assert.equal(stripped.length, width, `width mismatch for pct=${pct}`);
		const filled = (stripped.match(/▰/g) ?? []).length;
		const empty = (stripped.match(/▱/g) ?? []).length;
		assert.equal(filled, expectFilled, `fill count mismatch for pct=${pct}, width=${width}`);
		assert.equal(filled + empty, width);
	}
});

test("bar clamps out-of-range percentages", () => {
	assert.equal(stripAnsi(bar(-5, 10, c.ok)).length, 10);
	assert.equal(stripAnsi(bar(150, 10, c.ok)).length, 10);
	const overshoot = bar(150, 10, c.ok);
	assert.equal((stripAnsi(overshoot).match(/▰/g) ?? []).length, 10);
});

// ── formatTokens ───────────────────────────────────────────────────────────

test("formatTokens handles boundary values", () => {
	assert.equal(formatTokens(1), "1");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_000), "1.0k");
	assert.equal(formatTokens(9_999), "10.0k");
	assert.equal(formatTokens(10_000), "10k");
	assert.equal(formatTokens(999_999), "1000k");
	assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatTokens handles 0, exact 1M, and non-finite/negative as 0", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(1_000_000), "1.0M");
	assert.equal(formatTokens(-100), "0");
	assert.equal(formatTokens(Number.NaN), "0");
	assert.equal(formatTokens(Number.POSITIVE_INFINITY), "0");
});

// ── layout dispatch ────────────────────────────────────────────────────────

test("pickLayoutWidths dispatches on terminal width boundaries", () => {
	assert.deepEqual(pickLayoutWidths(40), { ctxBar: 6, codexBar: 3 });
	assert.deepEqual(pickLayoutWidths(59), { ctxBar: 6, codexBar: 3 });
	assert.deepEqual(pickLayoutWidths(60), { ctxBar: 8, codexBar: 4 });
	assert.deepEqual(pickLayoutWidths(79), { ctxBar: 8, codexBar: 4 });
	assert.deepEqual(pickLayoutWidths(80), { ctxBar: 12, codexBar: 6 });
	assert.deepEqual(pickLayoutWidths(119), { ctxBar: 12, codexBar: 6 });
	assert.deepEqual(pickLayoutWidths(120), { ctxBar: 16, codexBar: 10 });
	assert.deepEqual(pickLayoutWidths(240), { ctxBar: 16, codexBar: 10 });
});

// ── segments ───────────────────────────────────────────────────────────────

test("ctxSegment renders ?% when context is unknown", () => {
	const out = ctxSegment(0, 0, 200_000, 12, false);
	const plain = stripAnsi(out);
	assert.ok(plain.startsWith("ctx "));
	assert.ok(plain.includes("?%"));
});

test("ctxSegment renders percent and used/window when known", () => {
	const out = ctxSegment(58.3, 158_000, 272_000, 12, true);
	const plain = stripAnsi(out);
	assert.ok(plain.includes("58.3%"));
	assert.ok(plain.includes("158k/272k"));
});

test("costSegment formats with 3 decimals under $1 and 2 above", () => {
	assert.equal(stripAnsi(costSegment(0.192, true)!), "$0.192 sub");
	assert.equal(stripAnsi(costSegment(0.412, false)!), "$0.412");
	assert.equal(stripAnsi(costSegment(3.4, true)!), "$3.40 sub");
	assert.equal(stripAnsi(costSegment(1.0, false)!), "$1.00");
	assert.equal(costSegment(null, false), null);
});

test("costSegment with $0 still renders", () => {
	const out = costSegment(0, true);
	assert.ok(out);
	assert.equal(stripAnsi(out!), "$0.000 sub");
});

test("codexWindowSegment renders nothing when remainingPct is null", () => {
	assert.equal(codexWindowSegment("5h", null, "1h", 10), null);
});

test("codexWindowSegment includes reset time when present", () => {
	const out = codexWindowSegment("5h", 28, "2h14m", 10);
	assert.ok(out);
	const plain = stripAnsi(out!);
	assert.ok(plain.includes("5h "));
	assert.ok(plain.includes("28%"));
	assert.ok(plain.includes("in 2h14m"));
});

test("codexWindowSegment omits reset when null", () => {
	const out = codexWindowSegment("wk", 47, null, 6);
	assert.ok(out);
	assert.ok(!stripAnsi(out!).includes("in "));
});

// ── overflow / dropping ────────────────────────────────────────────────────

test("renderStatsLine drops codex windows right-to-left when line would overflow", () => {
	const state = makeState();
	const wide = renderStatsLine(120, state);
	assert.ok(stripAnsi(wide).includes("wk"));
	assert.ok(stripAnsi(wide).includes("5h"));

	// At a narrow width, both codex windows should be dropped while ctx and cost
	// stay (greedy drop from right).
	const narrow = renderStatsLine(40, state);
	const narrowPlain = stripAnsi(narrow);
	assert.ok(narrowPlain.includes("ctx"), "narrow line should keep ctx");
	assert.ok(!narrowPlain.includes("wk"), "narrow line should drop wk first");
});

test("renderStatsLine drops only wk when 5h still fits", () => {
	// craft a width that fits ctx + cost + 5h but not wk
	const state = makeState({ codex: { primary: 80, primaryReset: "4h", secondary: 55, secondaryReset: "4d" } });
	for (let width = 50; width <= 120; width++) {
		const line = renderStatsLine(width, state);
		const plain = stripAnsi(line);
		if (plain.includes("5h") && !plain.includes("wk")) {
			return; // found the regime, test passes
		}
	}
	assert.fail("no width regime drops only wk");
});

// ── full footer / pwd truncation ───────────────────────────────────────────

test("renderTopLine middle-truncates long cwd", () => {
	const state = makeState({
		cwd: "~/Documents/projects/internal/2026-q2/research-spike/very-long-experiment-name/repo",
		branch: "main",
	});
	const line = renderTopLine(80, state);
	const plain = stripAnsi(line);
	assert.ok(plain.length <= 80, `line too wide: ${plain.length}`);
	assert.ok(plain.includes("…"), "expected ellipsis for middle truncation");
	// head and tail should be preserved
	assert.ok(plain.startsWith("~/"), "head should be preserved");
	assert.ok(plain.includes("repo"), "tail should be preserved");
});

test("renderTopLine drops provider prefix when only one provider is registered", () => {
	const state = makeState({ providerCount: 1, provider: "anthropic", model: "claude-opus-4-7" });
	const line = renderTopLine(120, state);
	const plain = stripAnsi(line);
	assert.ok(plain.includes("claude-opus-4-7"));
	assert.ok(!plain.includes("anthropic ·"), "provider prefix should be dropped");
});

test("renderTopLine includes provider prefix when multiple providers exist", () => {
	const state = makeState({ providerCount: 2, provider: "openai-codex" });
	const plain = stripAnsi(renderTopLine(120, state));
	assert.ok(plain.includes("openai-codex"));
});

test("renderTopLine handles missing model gracefully", () => {
	const state = makeState({ model: null, provider: null, providerCount: 0, thinking: null });
	const plain = stripAnsi(renderTopLine(80, state));
	assert.ok(plain.includes("no model"));
});

test("renderTopLine omits thinking label when null", () => {
	const state = makeState({ thinking: null });
	const plain = stripAnsi(renderTopLine(120, state));
	assert.ok(!plain.includes("thinking"));
});

test("renderTopLine renders session name with separator", () => {
	const state = makeState({ sessionName: "footer-work" });
	const plain = stripAnsi(renderTopLine(120, state));
	assert.ok(plain.includes("• footer-work"));
});

// ── renderFooter end-to-end ────────────────────────────────────────────────

test("renderFooter returns two lines for normal state", () => {
	const lines = renderFooter(makeState(), 120);
	assert.equal(lines.length, 2);
	for (const line of lines) {
		assert.ok(visWidth(line) <= 120, `line too wide: ${visWidth(line)}`);
	}
});

test("renderFooter respects width at the narrow boundary (60)", () => {
	const lines = renderFooter(makeState(), 60);
	assert.equal(lines.length, 2);
	for (const line of lines) {
		assert.ok(visWidth(line) <= 60, `line too wide at 60: ${visWidth(line)}`);
	}
});

test("renderFooter still emits two lines when codex data is missing", () => {
	const lines = renderFooter(makeState({ codex: null }), 94);
	assert.equal(lines.length, 2);
	const stats = stripAnsi(lines[1]);
	assert.ok(!stats.includes("5h"));
	assert.ok(!stats.includes("wk"));
});

test("renderFooter handles unknown context (post-compaction)", () => {
	const lines = renderFooter(makeState({ ctxKnown: false, ctxPct: 0, ctxUsed: 0 }), 94);
	assert.ok(stripAnsi(lines[1]).includes("?%"));
});

// ── extreme-narrow overflow on both lines ──────────────────────────────────

test("renderFooter stats line never exceeds width even at extreme narrow", () => {
	// Stats line MUST hard-clamp via truncEnd; top line only middle-truncates
	// cwd (branch + session are preserved by design — they're identity info).
	const state = makeState({
		cwd: "~/Documents/projects/internal/2026-q2/very-long-experiment-name/repo",
		ctxPct: 88,
		ctxUsed: 240_000,
		ctxWindow: 272_000,
	});
	for (const width of [40, 44, 50, 60, 80, 94, 120]) {
		const lines = renderFooter(state, width);
		assert.equal(lines.length, 2, `expected 2 lines at width=${width}`);
		assert.ok(
			visWidth(lines[1]) <= width,
			`stats line too wide at width=${width}: got ${visWidth(lines[1])}`,
		);
	}
});

test("renderTopLine middle-truncates long cwd to fit when branch+session are reasonable", () => {
	// Realistic case: long cwd, short branch — top line should respect width.
	const state = makeState({
		cwd: "~/Documents/projects/internal/2026-q2/very-long-experiment-name/repo",
		branch: "main",
		sessionName: null,
	});
	for (const width of [60, 80, 94, 120]) {
		const line = renderTopLine(width, state);
		assert.ok(
			visWidth(line) <= width,
			`top line too wide at width=${width}: got ${visWidth(line)}`,
		);
	}
});

test("renderFooter at width=40 keeps ctx and drops codex windows", () => {
	const state = makeState({ ctxPct: 76, ctxUsed: 207_000 });
	const lines = renderFooter(state, 40);
	const stats = stripAnsi(lines[1]);
	assert.ok(stats.includes("ctx"), "ctx must remain at width=40");
	assert.ok(!stats.includes("wk "), "wk dropped at width=40");
	assert.ok(!stats.includes("5h "), "5h dropped at width=40");
});

// ── threshold sanity at exact boundary values ──────────────────────────────

test("codexThreshold at exact boundaries 10 and 30", () => {
	// Documented behavior: <=10 is bad, <=30 is warn.
	assert.equal(codexThreshold(30), c.warn);
	assert.equal(codexThreshold(30.0), c.warn);
	assert.equal(codexThreshold(10), c.bad);
	assert.equal(codexThreshold(10.0), c.bad);
	assert.equal(codexThreshold(10.1), c.warn);
});
