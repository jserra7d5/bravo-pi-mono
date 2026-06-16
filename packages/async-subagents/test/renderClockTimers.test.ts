import test from "node:test";
import assert from "node:assert/strict";
import { createRenderClock, type RenderClockScheduler } from "@bravo/render-clock";
import { __subscribeAsyncLeaseForTest } from "../extensions/pi/index.js";

function makeScheduler(start = 0): RenderClockScheduler & { advance(ms: number): void; fire(): void; activeIntervals(): number } {
  let now = start;
  const intervals = new Set<() => void>();
  return {
    now: () => now,
    setInterval(cb: () => void) {
      intervals.add(cb);
      return { cb };
    },
    clearInterval(handle: { cb?: () => void }) {
      if (handle.cb) intervals.delete(handle.cb);
    },
    advance(ms: number) {
      now += ms;
    },
    fire() {
      for (const cb of Array.from(intervals)) cb();
    },
    activeIntervals() {
      return intervals.size;
    },
  } as RenderClockScheduler & { advance(ms: number): void; fire(): void; activeIntervals(): number };
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

test("async lease uses render clock cadence and unsubscribe", async () => {
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  let calls = 0;
  const unsubscribe = __subscribeAsyncLeaseForTest(clock, () => { calls += 1; });

  clock.tick("manual");
  assert.equal(calls, 1);
  await flushMicrotasks();

  scheduler.advance(4_999);
  clock.tick("manual");
  assert.equal(calls, 1, "lease must not run before the 5s subscriber interval is due");

  scheduler.advance(1);
  clock.tick("manual");
  assert.equal(calls, 2, "lease runs on the due render-clock tick");
  await flushMicrotasks();

  unsubscribe();
  scheduler.advance(5_000);
  clock.tick("manual");
  assert.equal(calls, 2, "unsubscribe removes the lease subscriber");
});

test("async lease render-clock subscriber suppresses overlap while the lease body is pending", async () => {
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  const pending = deferred();
  let calls = 0;
  __subscribeAsyncLeaseForTest(clock, () => {
    calls += 1;
    return pending.promise;
  });

  clock.tick("manual");
  assert.equal(calls, 1);

  scheduler.advance(5_000);
  clock.tick("manual");
  assert.equal(calls, 1, "still-pending lease body must not be re-entered on the next due tick");

  pending.resolve();
  await flushMicrotasks();
  scheduler.advance(5_000);
  clock.tick("manual");
  assert.equal(calls, 2, "lease may run again after the prior body settles");
});

test("async lease render-clock subscriber catches rejected lease bodies", async () => {
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    let calls = 0;
    __subscribeAsyncLeaseForTest(clock, () => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    });

    assert.doesNotThrow(() => clock.tick("manual"));
    await flushMicrotasks();
    assert.equal(calls, 1);
    assert.equal(errors.length, 1, "render clock logs and swallows rejected lease bodies");
  } finally {
    console.error = originalError;
  }
});
