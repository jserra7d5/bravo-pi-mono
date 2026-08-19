// Standalone tests (not wired into npm run check, no tsconfig under .pi/). Run after compiling/bundling with:
//   npm exec -- esbuild .pi/extensions/__tests__/footerClock.test.ts --bundle --platform=node --format=esm --outfile=/tmp/footerClock.test.mjs && node --test /tmp/footerClock.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
	applyFooterClockGate,
	footerResetBucketSignature,
	runFooterClockTick,
} from "../codex-usage.ts";
import type { CodexUsage } from "../../../packages/codex-auth-balancer/src/index.ts";

function makeUsage(resetAt: number): CodexUsage {
	return {
		accounts: [{
			slot: "1",
			label: "work",
			activePi: true,
			activeCodex: false,
			status: "ok",
			usage: {
				primary: {
					label: "primary",
					remainingPercent: 80,
					windowMinutes: 10_080,
					resetAt,
				},
				secondary: {
					label: "secondary",
					remainingPercent: 55,
					windowMinutes: 300,
					resetAt: resetAt + 24 * 60 * 60 * 1000,
				},
				updatedAt: resetAt - 1000,
				source: "cache",
			},
		}],
		generatedAt: resetAt - 1000,
		staleAfterMs: 24 * 60 * 60 * 1000,
		unavailable: false,
	};
}

test("footer reset bucket signature is stable inside a rendered bucket and changes at the reset-relative boundary", () => {
	const resetAt = 1_700_000_000_000;
	const usage = makeUsage(resetAt);

	// formatReset uses Math.ceil((resetAt - now) / 60_000), so both of these
	// times render the same primary reset bucket: 2m.
	const twoMinutesBucketA = footerResetBucketSignature(usage, resetAt - 120_000);
	const twoMinutesBucketB = footerResetBucketSignature(usage, resetAt - 60_001);
	const oneMinuteBucket = footerResetBucketSignature(usage, resetAt - 60_000);

	assert.equal(twoMinutesBucketA, twoMinutesBucketB);
	assert.notEqual(twoMinutesBucketB, oneMinuteBucket);
});

test("footer reset signature changes when only truthful window duration semantics change", () => {
	const resetAt = 1_700_000_000_000;
	const usage = makeUsage(resetAt);
	const before = footerResetBucketSignature(usage, resetAt - 120_000);
	usage.accounts[0].usage!.primary!.windowMinutes = 300;
	const after = footerResetBucketSignature(usage, resetAt - 120_000);
	assert.notEqual(before, after);
});

test("footer reset bucket signature is always a string when codex state is absent", () => {
	assert.equal(footerResetBucketSignature(undefined, 1_700_000_000_000), "null");
});

test("footer clock gate renders zero times for identical buckets and once for a bucket crossing", () => {
	const resetAt = 1_700_000_000_000;
	const usage = makeUsage(resetAt);
	let renders = 0;
	let last: string | undefined;
	const requestRender = () => { renders += 1; };

	last = applyFooterClockGate(last, footerResetBucketSignature(usage, resetAt - 120_000), requestRender);
	assert.equal(renders, 0, "initial seed must not repaint");

	last = applyFooterClockGate(last, footerResetBucketSignature(usage, resetAt - 119_000), requestRender);
	last = applyFooterClockGate(last, footerResetBucketSignature(usage, resetAt - 60_001), requestRender);
	assert.equal(renders, 0, "idle ticks inside same rendered bucket must not repaint");

	last = applyFooterClockGate(last, footerResetBucketSignature(usage, resetAt - 60_000), requestRender);
	assert.equal(renders, 1, "bucket crossing must request exactly one repaint");

	last = applyFooterClockGate(last, footerResetBucketSignature(usage, resetAt - 59_999), requestRender);
	assert.equal(renders, 1, "subsequent ticks in new bucket must stay idle");
});

test("real footer clock tick seam idles inside a bucket and renders once at bucket crossing", () => {
	const resetAt = 1_700_000_000_000;
	const usage = makeUsage(resetAt);
	let renders = 0;
	let previousSignature = footerResetBucketSignature(usage, resetAt - 120_000);
	const tick = (now: number): void => {
		previousSignature = runFooterClockTick(now, {
			previousSignature,
			usage,
			requestRender: () => { renders += 1; },
		});
	};

	tick(resetAt - 119_000);
	tick(resetAt - 60_001);
	assert.equal(renders, 0, "reconcile seam must not repaint inside the same rendered bucket");

	tick(resetAt - 60_000);
	assert.equal(renders, 1, "reconcile seam must request exactly one repaint at a bucket boundary");
});
