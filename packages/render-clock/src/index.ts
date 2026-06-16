export interface RenderClockScheduler {
  now(): number;
  setInterval(cb: () => void, ms: number): { unref?(): void };
  clearInterval(t: { unref?(): void }): void;
}

export interface RenderClockSubscriber {
  id: string;
  intervalMs?: number;
  reconcile(tick: { now: number; seq: number; reason: "timer" | "manual" }): void | Promise<void>;
}

export interface RenderClock {
  subscribe(s: RenderClockSubscriber): () => void;
  tick(reason?: "manual"): void;
  now(): number;
  subscriberCount(): number;
  isRunning(): boolean;
}

type IntervalHandle = { unref?(): void };
type TickReason = "timer" | "manual";

type SubscriberRecord = {
  subscriber: RenderClockSubscriber;
  effectiveIntervalMs: number;
  lastReconcileAt: number | undefined;
  inFlight: boolean;
};

const DEFAULT_BASE_INTERVAL_MS = 1000;
const GLOBAL_CLOCK_SYMBOL = Symbol.for("@bravo/render-clock");
const GLOBAL_CLOCK_RESET_SYMBOL = Symbol.for("@bravo/render-clock:reset-target");

type ResettableRenderClock = RenderClock & {
  [GLOBAL_CLOCK_RESET_SYMBOL]?: (clock: RenderClock) => void;
};

function createProductionScheduler(): RenderClockScheduler {
  return {
    now: () => Date.now(),
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
    clearInterval: (t) => globalThis.clearInterval(t as ReturnType<typeof globalThis.setInterval>),
  };
}

function normalizeBaseIntervalMs(baseIntervalMs: number | undefined): number {
  if (baseIntervalMs === undefined) return DEFAULT_BASE_INTERVAL_MS;
  if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) {
    throw new Error("baseIntervalMs must be a positive finite number");
  }
  return baseIntervalMs;
}

function logReconcileError(error: unknown): void {
  console.error("[render-clock] subscriber reconcile failed", error);
}

export function createRenderClock(opts: { baseIntervalMs?: number; scheduler?: RenderClockScheduler } = {}): RenderClock {
  const baseIntervalMs = normalizeBaseIntervalMs(opts.baseIntervalMs);
  const scheduler = opts.scheduler ?? createProductionScheduler();
  const subscribers = new Map<string, SubscriberRecord>();
  let intervalHandle: IntervalHandle | undefined;
  let seq = 0;

  function effectiveIntervalMs(intervalMs: number | undefined): number {
    if (intervalMs === undefined) return baseIntervalMs;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return baseIntervalMs;
    return Math.max(baseIntervalMs, intervalMs);
  }

  function startIfNeeded(): void {
    if (intervalHandle !== undefined || subscribers.size === 0) return;
    intervalHandle = scheduler.setInterval(() => runTick("timer"), baseIntervalMs);
    intervalHandle.unref?.();
  }

  function stopIfIdle(): void {
    if (intervalHandle === undefined || subscribers.size !== 0) return;
    const handle = intervalHandle;
    intervalHandle = undefined;
    scheduler.clearInterval(handle);
  }

  function runTick(reason: TickReason): void {
    seq += 1;
    const tickNow = scheduler.now();
    const snapshot = Array.from(subscribers.values());

    for (const record of snapshot) {
      if (record.inFlight) continue;
      if (
        record.lastReconcileAt !== undefined &&
        tickNow - record.lastReconcileAt < record.effectiveIntervalMs
      ) {
        continue;
      }

      record.lastReconcileAt = tickNow;

      try {
        const result = record.subscriber.reconcile({ now: tickNow, seq, reason });
        if (result && typeof (result as Promise<void>).then === "function") {
          record.inFlight = true;
          Promise.resolve(result)
            .catch(logReconcileError)
            .finally(() => {
              record.inFlight = false;
            });
        }
      } catch (error) {
        logReconcileError(error);
      }
    }
  }

  return {
    subscribe(subscriber) {
      const record: SubscriberRecord = {
        subscriber,
        effectiveIntervalMs: effectiveIntervalMs(subscriber.intervalMs),
        lastReconcileAt: undefined,
        inFlight: false,
      };
      subscribers.set(subscriber.id, record);
      startIfNeeded();

      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        if (subscribers.get(subscriber.id) === record) {
          subscribers.delete(subscriber.id);
          stopIfIdle();
        }
      };
    },

    tick() {
      runTick("manual");
    },

    now() {
      return scheduler.now();
    },

    subscriberCount() {
      return subscribers.size;
    },

    isRunning() {
      return intervalHandle !== undefined;
    },
  };
}

function getGlobalClockSlot(): { [GLOBAL_CLOCK_SYMBOL]?: ResettableRenderClock } {
  return globalThis as typeof globalThis & { [GLOBAL_CLOCK_SYMBOL]?: ResettableRenderClock };
}

function createResettableGlobalClock(initialTarget: RenderClock): ResettableRenderClock {
  let target = initialTarget;
  const activeUnsubscribes = new Set<() => void>();

  const facade: ResettableRenderClock = {
    subscribe: (s) => {
      const unsubscribeTarget = target.subscribe(s);
      let unsubscribed = false;

      const unsubscribe = () => {
        if (unsubscribed) return;
        unsubscribed = true;
        activeUnsubscribes.delete(unsubscribe);
        unsubscribeTarget();
      };

      activeUnsubscribes.add(unsubscribe);
      return unsubscribe;
    },
    tick: (reason) => target.tick(reason),
    now: () => target.now(),
    subscriberCount: () => target.subscriberCount(),
    isRunning: () => target.isRunning(),
  };

  Object.defineProperty(facade, GLOBAL_CLOCK_RESET_SYMBOL, {
    value: (clock: RenderClock) => {
      for (const unsubscribe of Array.from(activeUnsubscribes)) {
        unsubscribe();
      }
      activeUnsubscribes.clear();
      target = clock;
    },
    enumerable: false,
  });

  return facade;
}

function getOrCreateGlobalRenderClock(): ResettableRenderClock {
  const slot = getGlobalClockSlot();
  if (!slot[GLOBAL_CLOCK_SYMBOL]) {
    slot[GLOBAL_CLOCK_SYMBOL] = createResettableGlobalClock(createRenderClock());
  }
  return slot[GLOBAL_CLOCK_SYMBOL];
}

export const renderClock: RenderClock = getOrCreateGlobalRenderClock();

/**
 * Test-only hook: replace the global singleton's underlying clock with one that
 * uses an injected scheduler. Behavior tests should prefer createRenderClock().
 */
export function __resetRenderClockForTest(scheduler?: RenderClockScheduler): RenderClock {
  const next = createRenderClock({ scheduler });
  const slot = getGlobalClockSlot();
  const existing = slot[GLOBAL_CLOCK_SYMBOL];

  if (existing?.[GLOBAL_CLOCK_RESET_SYMBOL]) {
    existing[GLOBAL_CLOCK_RESET_SYMBOL](next);
    return existing;
  }

  const facade = createResettableGlobalClock(next);
  slot[GLOBAL_CLOCK_SYMBOL] = facade;
  return facade;
}
