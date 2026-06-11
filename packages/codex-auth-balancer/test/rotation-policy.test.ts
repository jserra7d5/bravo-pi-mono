import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRateLimit,
  chooseNextSlot,
  backoffDelayMs,
  runWithRotation,
  DEFAULT_ROTATION_CONFIG,
  type SlotInfo,
  type Attempt,
  type AttemptOutcome,
} from '../extensions/pi/rotation-policy.js';

// ── classifyRateLimit ──────────────────────────────────────────────────────
test('classifyRateLimit: HTTP 429 status is a rate limit', () => {
  assert.equal(classifyRateLimit({ status: 429 }), true);
});
test('classifyRateLimit: non-429 status alone is not a rate limit', () => {
  assert.equal(classifyRateLimit({ status: 400 }), false);
  assert.equal(classifyRateLimit({ status: 200 }), false);
});
test('classifyRateLimit: the {"detail":"Rate limit exceeded"} body is detected', () => {
  assert.equal(classifyRateLimit({ errorText: '{"detail":"Rate limit exceeded"}' }), true);
});
test('classifyRateLimit: friendly "usage limit" message is detected', () => {
  assert.equal(classifyRateLimit({ errorText: 'You have hit your ChatGPT usage limit (pro plan). Try again in ~5 min.' }), true);
});
test('classifyRateLimit: unrelated errors are not rate limits', () => {
  assert.equal(classifyRateLimit({ errorText: "invalid_request_error: Tool 'image_generation' is not supported." }), false);
  assert.equal(classifyRateLimit({}), false);
});

// ── chooseNextSlot ─────────────────────────────────────────────────────────
const slots = (xs: Array<[string, number | undefined]>): SlotInfo[] => xs.map(([slot, primaryRemaining]) => ({ slot, primaryRemaining }));

test('chooseNextSlot: picks the untried slot with the most primary remaining', () => {
  const got = chooseNextSlot(slots([['1', 40], ['2', 90]]), new Set(['1']), new Map(), 1000);
  assert.equal(got, '2');
});
test('chooseNextSlot: returns undefined when every slot has been tried', () => {
  const got = chooseNextSlot(slots([['1', 40], ['2', 90]]), new Set(['1', '2']), new Map(), 1000);
  assert.equal(got, undefined);
});
test('chooseNextSlot: a slot in active cooldown is deprioritized', () => {
  const cooldown = new Map([['2', 5000]]); // cooled until t=5000
  const got = chooseNextSlot(slots([['1', 10], ['2', 90]]), new Set(), cooldown, 1000);
  assert.equal(got, '1'); // 2 has more remaining but is cooled, so 1 wins
});
test('chooseNextSlot: falls back to a cooled slot when all candidates are cooled', () => {
  const cooldown = new Map([['1', 5000], ['2', 5000]]);
  const got = chooseNextSlot(slots([['1', 10], ['2', 90]]), new Set(), cooldown, 1000);
  assert.equal(got, '2'); // both cooled -> pick best remaining
});
test('chooseNextSlot: an expired cooldown does not deprioritize', () => {
  const cooldown = new Map([['2', 500]]); // expired by t=1000
  const got = chooseNextSlot(slots([['1', 10], ['2', 90]]), new Set(), cooldown, 1000);
  assert.equal(got, '2');
});

// ── backoffDelayMs ─────────────────────────────────────────────────────────
test('backoffDelayMs: round 0 with mid jitter equals the base delay', () => {
  assert.equal(backoffDelayMs(0, DEFAULT_ROTATION_CONFIG, 0.5), 1000);
});
test('backoffDelayMs: jitter spans +/-25% of base', () => {
  assert.equal(backoffDelayMs(0, DEFAULT_ROTATION_CONFIG, 0), 750);
  assert.equal(backoffDelayMs(0, DEFAULT_ROTATION_CONFIG, 1), 1250);
});
test('backoffDelayMs: exponential growth is capped', () => {
  // base*2^round would be huge; cap is 8000, mid jitter -> exactly cap
  assert.equal(backoffDelayMs(10, DEFAULT_ROTATION_CONFIG, 0.5), 8000);
});

// ── runWithRotation ────────────────────────────────────────────────────────
type ScriptedDeps = {
  script: AttemptOutcome[];
  slotList?: SlotInfo[];
};
function harness(opts: ScriptedDeps) {
  const attempts: Array<string | undefined> = [];
  const sleeps: number[] = [];
  const cooldown = new Map<string, number>();
  let exhausted = 0;
  let i = 0;
  let clock = 1000;
  const slotList = opts.slotList ?? slots([['1', 80], ['2', 80]]);
  const deps = {
    runAttempt: async (forcedSlot: string | undefined): Promise<Attempt> => {
      attempts.push(forcedSlot);
      const outcome = opts.script[Math.min(i, opts.script.length - 1)];
      i += 1;
      // emulate auto-selection landing on slot '1' first, forced slots thereafter
      const slot = forcedSlot ?? '1';
      return { outcome, slot };
    },
    listSlots: async () => slotList,
    cooldown,
    config: DEFAULT_ROTATION_CONFIG,
    sleep: async (ms: number) => { sleeps.push(ms); },
    rand: () => 0.5,
    now: () => clock,
    signalAborted: () => false,
    onExhausted: () => { exhausted += 1; },
  };
  return { deps, attempts, sleeps, cooldown, get exhausted() { return exhausted; } };
}

test('runWithRotation: a first-attempt success makes exactly one attempt', async () => {
  const h = harness({ script: ['done'] });
  await runWithRotation(h.deps);
  assert.deepEqual(h.attempts, [undefined]); // auto-selection only
  assert.equal(h.exhausted, 0);
  assert.equal(h.sleeps.length, 0);
});

test('runWithRotation: a 429 on the first slot rotates to the other slot', async () => {
  const h = harness({ script: ['rate-limited', 'done'] });
  await runWithRotation(h.deps);
  assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[0], undefined);     // auto first
  assert.equal(h.attempts[1], '2');           // forced to the other slot
  assert.equal(h.exhausted, 0);
  assert.ok(h.cooldown.has('1'));             // failed slot put on cooldown
});

test('runWithRotation: a lease-failed on the first slot rotates to the next and succeeds', async () => {
  const h = harness({ script: ['lease-failed', 'done'] });
  await runWithRotation(h.deps);
  assert.deepEqual(h.attempts, [undefined, '2'], 'auto first, then forced to the other slot');
  assert.equal(h.exhausted, 0);
  assert.ok(!h.cooldown.has('1'), 'a lease failure must NOT cooldown the slot (unlike a 429)');
});

test('runWithRotation: all slots lease-failed exhausts after covering every slot', async () => {
  const h = harness({ script: ['lease-failed'] }); // always fails to lease
  await runWithRotation(h.deps);
  // 2 rounds x 2 slots = 4 attempts, one backoff sleep between rounds
  assert.equal(h.attempts.length, 4);
  assert.ok(h.attempts.includes('1') || h.attempts.includes(undefined), 'slot 1 covered (auto or forced)');
  assert.ok(h.attempts.includes('2'), 'slot 2 covered');
  assert.equal(h.exhausted, 1);
  assert.equal(h.cooldown.size, 0, 'lease failures never cooldown any slot');
});

test('runWithRotation: when both slots rate-limit it backs off then exhausts', async () => {
  const h = harness({ script: ['rate-limited'] }); // always rate-limited
  await runWithRotation(h.deps);
  // 2 rounds x 2 slots = 4 attempts, one backoff sleep between rounds
  assert.equal(h.attempts.length, 4);
  assert.equal(h.sleeps.length, 1);
  assert.equal(h.exhausted, 1);
});

test('runWithRotation: a single-account install does not back off or double-try', async () => {
  const h = harness({ script: ['rate-limited'], slotList: slots([['1', 50]]) });
  await runWithRotation(h.deps);
  assert.equal(h.attempts.length, 1, 'one attempt only, no second round');
  assert.equal(h.sleeps.length, 0, 'no back-off when there is nothing to rotate to');
  assert.equal(h.exhausted, 1);
});

test('runWithRotation: a non-rate error surfaces immediately without rotating', async () => {
  const h = harness({ script: ['other-error'] });
  await runWithRotation(h.deps);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.exhausted, 0);
});

test('runWithRotation: an error after content has streamed does not rotate', async () => {
  const h = harness({ script: ['streamed-error'] });
  await runWithRotation(h.deps);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.exhausted, 0);
});

test('runWithRotation: abort stops the loop without exhausting', async () => {
  const h = harness({ script: ['rate-limited'] });
  let calls = 0;
  h.deps.signalAborted = () => (++calls > 1); // abort after first attempt
  await runWithRotation(h.deps);
  assert.ok(h.attempts.length <= 2);
  assert.equal(h.exhausted, 0);
});
