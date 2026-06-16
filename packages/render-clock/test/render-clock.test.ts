import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetRenderClockForTest,
  createRenderClock,
  renderClock,
  type RenderClockScheduler,
} from "../src/index.js";

class FakeScheduler implements RenderClockScheduler {
  currentNow = 0;
  callbacks: Array<() => void> = [];
  setIntervalCalls: Array<{ ms: number; handle: { unref(): void; unrefCalled: boolean } }> = [];
  clearIntervalCalls: Array<{ unref?(): void }> = [];

  now(): number {
    return this.currentNow;
  }

  setInterval(cb: () => void, ms: number): { unref(): void; unrefCalled: boolean } {
    const handle = {
      unrefCalled: false,
      unref() {
        handle.unrefCalled = true;
      },
    };
    this.callbacks.push(cb);
    this.setIntervalCalls.push({ ms, handle });
    return handle;
  }

  clearInterval(t: { unref?(): void }): void {
    this.clearIntervalCalls.push(t);
  }

  advance(ms: number): void {
    this.currentNow += ms;
  }

  fire(index = 0): void {
    const cb = this.callbacks[index];
    assert.ok(cb, `missing interval callback ${index}`);
    cb();
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("single lazy timer, duplicate id replacement, unref, and failure isolation", async () => {
  const scheduler = new FakeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 100, scheduler });
  const calls: string[] = [];
  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    assert.equal(clock.isRunning(), false);
    const unsubA1 = clock.subscribe({ id: "a", reconcile: () => { calls.push("a1"); } });
    assert.equal(clock.isRunning(), true);
    assert.equal(scheduler.setIntervalCalls.length, 1);
    assert.equal(scheduler.setIntervalCalls[0].ms, 100);
    assert.equal(scheduler.setIntervalCalls[0].handle.unrefCalled, true);

    clock.subscribe({ id: "b", reconcile: () => { calls.push("b"); } });
    const unsubA2 = clock.subscribe({ id: "a", reconcile: () => { calls.push("a2"); } });
    assert.equal(clock.subscriberCount(), 2);
    assert.equal(scheduler.setIntervalCalls.length, 1);

    unsubA1();
    scheduler.fire();
    assert.deepEqual(calls, ["a2", "b"]);

    calls.length = 0;
    clock.subscribe({
      id: "throws",
      reconcile: () => {
        calls.push("throws");
        throw new Error("boom");
      },
    });
    clock.subscribe({
      id: "rejects",
      reconcile: () => {
        calls.push("rejects");
        return Promise.reject(new Error("nope"));
      },
    });
    clock.subscribe({ id: "later", reconcile: () => { calls.push("later"); } });

    scheduler.advance(100);
    scheduler.fire();
    await flushPromises();

    assert.deepEqual(calls, ["a2", "b", "throws", "rejects", "later"]);
    assert.equal(errors.length, 2);
    assert.equal(clock.subscriberCount(), 5);
    unsubA2();
  } finally {
    console.error = originalConsoleError;
  }
});

test("last unsubscribe clears timer; duplicate and in-tick unsubscribe are safe", () => {
  const scheduler = new FakeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 100, scheduler });
  const calls: string[] = [];

  const unsubA = clock.subscribe({ id: "a", reconcile: () => { calls.push("a"); } });
  const unsubB = clock.subscribe({ id: "b", reconcile: () => { calls.push("b"); } });
  assert.equal(scheduler.setIntervalCalls.length, 1);

  unsubA();
  assert.equal(clock.isRunning(), true);
  unsubA();
  assert.equal(clock.isRunning(), true);
  unsubB();
  assert.equal(clock.isRunning(), false);
  assert.equal(scheduler.clearIntervalCalls.length, 1);

  scheduler.fire();
  clock.tick();
  assert.deepEqual(calls, []);

  const scheduler2 = new FakeScheduler();
  const clock2 = createRenderClock({ baseIntervalMs: 100, scheduler: scheduler2 });
  const mutationCalls: string[] = [];
  let unsubSelf = () => {};
  let unsubOther = () => {};
  unsubSelf = clock2.subscribe({
    id: "self",
    reconcile: () => {
      mutationCalls.push("self");
      unsubSelf();
    },
  });
  unsubOther = clock2.subscribe({ id: "other", reconcile: () => { mutationCalls.push("other"); } });
  clock2.subscribe({
    id: "remover",
    reconcile: () => {
      mutationCalls.push("remover");
      unsubOther();
    },
  });

  clock2.tick();
  assert.deepEqual(mutationCalls, ["self", "other", "remover"]);
  assert.equal(clock2.subscriberCount(), 1);

  mutationCalls.length = 0;
  scheduler2.advance(100);
  clock2.tick();
  assert.deepEqual(mutationCalls, ["remover"]);

  assert.doesNotThrow(() => {
    unsubSelf();
    unsubOther();
  });
});

test("per-subscriber intervals are now-based, clamped to base, and do not catch up", () => {
  const scheduler = new FakeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 100, scheduler });
  const baseCalls: number[] = [];
  const slowCalls: number[] = [];
  const clampedCalls: number[] = [];

  clock.subscribe({ id: "base", reconcile: ({ now }) => { baseCalls.push(now); } });
  clock.subscribe({ id: "slow", intervalMs: 300, reconcile: ({ now }) => { slowCalls.push(now); } });
  clock.subscribe({ id: "clamped", intervalMs: 10, reconcile: ({ now }) => { clampedCalls.push(now); } });

  for (let i = 0; i < 5; i += 1) {
    scheduler.fire();
    scheduler.advance(100);
  }

  assert.deepEqual(baseCalls, [0, 100, 200, 300, 400]);
  assert.deepEqual(clampedCalls, [0, 100, 200, 300, 400]);
  assert.deepEqual(slowCalls, [0, 300]);

  scheduler.advance(1000);
  scheduler.fire();
  assert.deepEqual(slowCalls, [0, 300, 1500]);
});

test("async overlap guard skips due reconciles while a subscriber promise is in flight", async () => {
  const scheduler = new FakeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 100, scheduler });
  const slowCalls: number[] = [];
  const fastCalls: number[] = [];
  let resolveSlow: (() => void) | undefined;

  clock.subscribe({
    id: "slow",
    reconcile: ({ now }) => {
      slowCalls.push(now);
      return new Promise<void>((resolve) => {
        resolveSlow = resolve;
      });
    },
  });
  clock.subscribe({ id: "fast", reconcile: ({ now }) => { fastCalls.push(now); } });

  scheduler.fire();
  scheduler.advance(100);
  scheduler.fire();
  assert.deepEqual(slowCalls, [0]);
  assert.deepEqual(fastCalls, [0, 100]);

  assert.ok(resolveSlow);
  resolveSlow();
  await flushPromises();

  scheduler.advance(100);
  scheduler.fire();
  assert.deepEqual(slowCalls, [0, 200]);
  assert.deepEqual(fastCalls, [0, 100, 200]);
});

test("reset test hook unsubscribes active facade subscriptions before replacing target", () => {
  const oldScheduler = new FakeScheduler();
  const clock = __resetRenderClockForTest(oldScheduler);
  const calls: number[] = [];

  const unsubscribe = clock.subscribe({ id: "reset-leak", reconcile: ({ now }) => { calls.push(now); } });
  assert.equal(oldScheduler.setIntervalCalls.length, 1);
  assert.equal(oldScheduler.clearIntervalCalls.length, 0);

  const nextScheduler = new FakeScheduler();
  assert.equal(__resetRenderClockForTest(nextScheduler), clock);
  assert.equal(oldScheduler.clearIntervalCalls.length, 1);
  assert.equal(clock.subscriberCount(), 0);

  oldScheduler.fire();
  assert.deepEqual(calls, []);

  unsubscribe();
  assert.equal(oldScheduler.clearIntervalCalls.length, 1);
});

test("global singleton identity and test scheduler injection", async () => {
  const scheduler = new FakeScheduler();
  const resetClock = __resetRenderClockForTest(scheduler);
  const importedAgain = await import("../src/index.js");
  const dupSpecifier = `../src/index.js?dup=${1}`;
  const dup = await import(dupSpecifier);
  const globalClock = (globalThis as typeof globalThis & { [key: symbol]: unknown })[
    Symbol.for("@bravo/render-clock")
  ];
  const calls: number[] = [];

  assert.equal(resetClock, renderClock);
  assert.equal(importedAgain.renderClock, renderClock);
  assert.equal(dup.renderClock, renderClock);
  assert.equal(dup.renderClock, globalClock);
  assert.equal(globalClock, renderClock);

  renderClock.subscribe({ id: "singleton", reconcile: ({ now }) => { calls.push(now); } });
  assert.equal(scheduler.setIntervalCalls.length, 1);
  assert.equal(scheduler.setIntervalCalls[0].ms, 1000);
  scheduler.fire();
  assert.deepEqual(calls, [0]);
});
