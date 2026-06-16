// Standalone tests (not wired into npm run check, no tsconfig under .pi/). Bundle before node --test.
import test from "node:test";
import assert from "node:assert/strict";
import { createRenderClock, type RenderClockScheduler } from "../../../packages/render-clock/src/index.ts";
import { __subscribeCodexUsagePollForTest } from "../codex-usage.ts";

function makeScheduler(start = 0): RenderClockScheduler & { advance(ms: number): void } {
	let now = start;
	return {
		now: () => now,
		setInterval() {
			return {};
		},
		clearInterval() {},
		advance(ms: number) {
			now += ms;
		},
	};
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("codex usage poll uses render clock cadence and receives the clock timestamp", async () => {
	const scheduler = makeScheduler(100);
	const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
	const calls: number[] = [];
	const unsubscribe = __subscribeCodexUsagePollForTest(clock, (now) => { calls.push(now); });

	clock.tick("manual");
	assert.deepEqual(calls, [100]);
	await flushMicrotasks();

	scheduler.advance(299_999);
	clock.tick("manual");
	assert.deepEqual(calls, [100], "poll must not run before POLL_INTERVAL_MS is due");

	scheduler.advance(1);
	clock.tick("manual");
	assert.deepEqual(calls, [100, 300_100], "poll runs on the due render-clock tick");
	await flushMicrotasks();

	unsubscribe();
	scheduler.advance(300_000);
	clock.tick("manual");
	assert.deepEqual(calls, [100, 300_100], "unsubscribe removes the poll subscriber");
});

test("codex usage poll render-clock subscriber suppresses overlap while the poll body is pending", async () => {
	const scheduler = makeScheduler();
	const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
	const pending = deferred();
	let calls = 0;
	__subscribeCodexUsagePollForTest(clock, () => {
		calls += 1;
		return pending.promise;
	});

	clock.tick("manual");
	assert.equal(calls, 1);

	scheduler.advance(300_000);
	clock.tick("manual");
	assert.equal(calls, 1, "still-pending poll body must not be re-entered on the next due tick");

	pending.resolve();
	await flushMicrotasks();
	scheduler.advance(300_000);
	clock.tick("manual");
	assert.equal(calls, 2, "poll may run again after the prior body settles");
});

test("codex usage poll render-clock subscriber catches rejected poll bodies", async () => {
	const scheduler = makeScheduler();
	const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
	const originalError = console.error;
	const errors: unknown[][] = [];
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		let calls = 0;
		__subscribeCodexUsagePollForTest(clock, () => {
			calls += 1;
			return Promise.reject(new Error("boom"));
		});

		assert.doesNotThrow(() => clock.tick("manual"));
		await flushMicrotasks();
		assert.equal(calls, 1);
		assert.equal(errors.length, 1, "render clock logs and swallows rejected poll bodies");
	} finally {
		console.error = originalError;
	}
});
