import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseClaims } from '../src/claims.js';
import {
  computeHeadroom,
  quotaForModel,
  selectAccount,
} from '../src/policy.js';
import { pricingForModel } from '../src/usage.js';
import type { AccountState } from '../src/policy.js';

import { JOSEPH_FABLE, JOSEPH_HAIKU, NAD_FABLE } from './fixtures.js';

// All fixture resets are in the future relative to this instant, so no claim
// reads as "already reset".
const NOW = 1_786_660_000_000;

const joseph = (headers: Record<string, string>): AccountState => ({
  slot: '2',
  email: 'joseph.b.serra@gmail.com',
  health: 'ok',
  claims: parseClaims(headers),
  observedAt: NOW,
});

const nad = (headers: Record<string, string>): AccountState => ({
  slot: '1',
  email: 'info@notanotherdashboard.com',
  health: 'ok',
  claims: parseClaims(headers),
  observedAt: NOW,
});

test('Fable is quoted at double general burn and gated on its own weekly claim', () => {
  const quota = quotaForModel('claude-fable-5');
  assert.equal(quota.costMultiplier, 2);
  assert.equal(quota.extraClaim, '7d_oi');

  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', undefined]) {
    const q = quotaForModel(model);
    assert.equal(q.costMultiplier, 1, `${model} should burn at 1x`);
    assert.equal(q.extraClaim, undefined);
  }
});

test('every Fable id Claude Code sends matches the Fable quota and price', () => {
  // Seen live in the metrics table: claude-fable-5, claude-fable-5-1,
  // claude-fable-5.1. The 1m-context variant carries a bracket suffix.
  for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-fable-5.1', 'CLAUDE-FABLE-5-1']) {
    assert.equal(quotaForModel(model).extraClaim, '7d_oi', model);
    assert.equal(quotaForModel(model).costMultiplier, 2, model);
    assert.deepEqual(pricingForModel(model), { input: 10, output: 50 }, model);
  }
});

test('Opus headroom is bound by the weekly claim on a near-spent account', () => {
  const h = computeHeadroom(joseph(JOSEPH_HAIKU), 'claude-opus-5', NOW);
  // 7d is 91% used -> 0.09 remaining, burned at 1x
  assert.equal(Number(h.headroom.toFixed(4)), 0.09);
  assert.equal(h.bindingClaim, '7d');
  assert.equal(Number(h.peakUtilization?.toFixed(4)), 0.91);
});

test('Fable halves general headroom because it burns quota twice as fast', () => {
  const opus = computeHeadroom(joseph(JOSEPH_FABLE), 'claude-opus-5', NOW);
  const fable = computeHeadroom(joseph(JOSEPH_FABLE), 'claude-fable-5', NOW);

  assert.equal(Number(opus.headroom.toFixed(4)), 0.09);
  assert.equal(Number(fable.headroom.toFixed(4)), 0.045, 'same weekly, half the Fable requests');
  assert.equal(fable.bindingClaim, '7d');
});

test("Fable's own weekly claim can bind before the general one", () => {
  // General weekly barely touched, but the Fable sub-budget is nearly gone.
  const account: AccountState = {
    slot: '9',
    health: 'ok',
    claims: parseClaims({
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-7d-utilization': '0.10',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.98',
    }),
  };
  const h = computeHeadroom(account, 'claude-fable-5', NOW);
  assert.equal(h.bindingClaim, '7d_oi');
  // 0.02 remaining of a half-sized budget, at 2x burn -> 0.02*0.5/2
  assert.equal(Number(h.headroom.toFixed(4)), 0.005);
});

test('the Fable sub-budget is rescaled into general-weekly units', () => {
  // 7d_oi is a fraction of a HALF-SIZED budget, so it is not comparable with a
  // general claim until it is rescaled. Units, normalized to Opus-equivalent
  // requests as a fraction of the general weekly budget B (request cost c):
  //   general claim, remaining r    -> r*B / (2c)            -> r / 2
  //   7d_oi,         remaining r_oi -> r_oi*0.5*B / (2c)      -> r_oi * 0.5 / 2
  // Here: general = 1.0/2 = 0.50, 7d_oi = 0.60*0.5/2 = 0.15 -> 7d_oi binds.
  // Treating r_oi as already-normalized (0.60) would report 0.50 and pick the
  // general claim, which is 4x too generous on the Fable budget.
  const account: AccountState = {
    slot: '9',
    health: 'ok',
    claims: parseClaims({
      'anthropic-ratelimit-unified-5h-utilization': '0.0',
      'anthropic-ratelimit-unified-7d-utilization': '0.0',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.40',
      'anthropic-ratelimit-unified-fallback-percentage': '0.5',
    }),
  };
  const h = computeHeadroom(account, 'claude-fable-5', NOW);
  assert.equal(h.bindingClaim, '7d_oi');
  assert.equal(Number(h.headroom.toFixed(4)), 0.15);
});

test("the response's own fallback-percentage overrides the model default", () => {
  const mk = (pct: string) => ({
    slot: '9',
    health: 'ok' as const,
    claims: parseClaims({
      'anthropic-ratelimit-unified-7d-utilization': '0.0',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.0',
      'anthropic-ratelimit-unified-fallback-percentage': pct,
    }),
  });
  // A full sub-budget worth 25% of weekly buys half as much as one worth 50%.
  assert.equal(Number(computeHeadroom(mk('0.5'), 'claude-fable-5', NOW).headroom.toFixed(4)), 0.25);
  assert.equal(Number(computeHeadroom(mk('0.25'), 'claude-fable-5', NOW).headroom.toFixed(4)), 0.125);
});

test('an unobserved account is assumed full rather than exhausted', () => {
  const h = computeHeadroom({ slot: '3', health: 'ok' }, 'claude-opus-5', NOW);
  assert.equal(h.headroom, 1);
  assert.equal(h.bindingClaim, undefined);
  assert.equal(h.eligible, true);
});

test('a claim whose window already reset counts as empty, not as last seen', () => {
  const account = joseph(JOSEPH_HAIKU);
  // Jump past the 7d reset (1786770000) but the 5h fixture reset too.
  const after = 1_786_780_000_000;
  const h = computeHeadroom(account, 'claude-opus-5', after);
  assert.equal(h.headroom, 1);
  assert.ok(h.spendableHeadroom < 1, 'projected next resets retain pacing after rollover');
});

test('expired tokens and reauth-needed accounts are not selectable', () => {
  const expired = computeHeadroom(
    { slot: '4', health: 'ok', tokenExpiresAt: NOW - 1 },
    'claude-opus-5',
    NOW,
  );
  assert.equal(expired.eligible, false);
  assert.equal(expired.reason, 'token-expired');

  const reauth = computeHeadroom({ slot: '5', health: 'needs-reauth' }, 'claude-opus-5', NOW);
  assert.equal(reauth.eligible, false);
  assert.equal(reauth.reason, 'needs-reauth');
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('the captured fixture pair is the herd case: 5h pressure outranks drain-first', () => {
  // Verbatim 2026-08-13 headers. Slot 2 is further ahead of weekly pace but
  // sits at 46% 5h with 72% of the window gone — projected 64%, bucket 2 —
  // against slot 1's 1%, bucket 0. Under a single 70% ceiling slot 2 kept
  // collecting fresh sessions all the way to the threshold; that is exactly
  // the herd the bucket exists to break up.
  const s = selectAccount({
    accounts: [nad(NAD_FABLE), joseph(JOSEPH_HAIKU)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1');
  assert.equal(s.decision, 'fresh');
  const b = Object.fromEntries(s.breakdown.map(x => [x.slot, x]));
  assert.equal(b['2']!.fiveHourBucket, 2, '46% at 72% elapsed projects to 64%');
  assert.equal(b['1']!.fiveHourBucket, 0);
});

test('non-Fable fresh picks pace the weekly: furthest ahead of pace wins', () => {
  const claimHeaders = (utilization: number, weeklyResetMs: number) => ({
    // No reset means the short window cannot add a pacing constraint to this
    // test, which specifically compares weekly reset horizons.
    'anthropic-ratelimit-unified-5h-utilization': '0',
    'anthropic-ratelimit-unified-7d-utilization': String(utilization),
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(weeklyResetMs / 1000)),
  });
  const sooner = nad(claimHeaders(0.32, NOW + 38 * 60 * 60 * 1000));
  const later = joseph(claimHeaders(0.02, NOW + 152 * 60 * 60 * 1000));

  const s = selectAccount({ accounts: [later, sooner], model: 'claude-opus-5', nowMs: NOW });

  assert.equal(s.slot, '1', '68% resetting in 38h is more spendable than 98% resetting in 152h');
  assert.ok(
    s.breakdown.find(account => account.slot === '1')!.spendableHeadroom >
      s.breakdown.find(account => account.slot === '2')!.spendableHeadroom,
  );
  assert.match(s.reason, /most spendable headroom on 1 \(0\.454 ahead of pace/);
});

test('affinity is held even when another account has far more headroom', () => {
  const s = selectAccount({
    accounts: [joseph(JOSEPH_HAIKU), nad(NAD_FABLE)],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'a warm cache is worth 20x more than spare quota');
  assert.equal(s.decision, 'affinity-hold');
});

test('affinity breaks once the sticky account is exhausted', () => {
  const spent: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '1.0' }),
  };
  const s = selectAccount({
    accounts: [spent, nad(NAD_FABLE)],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1');
  assert.equal(s.decision, 'affinity-broken');
});

test('non-Fable affinity holds at 95% and 99% while quota remains positive', () => {
  for (const utilization of ['0.95', '0.99', '0.9999']) {
    const hot: AccountState = {
      slot: '2',
      health: 'ok',
      claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': utilization }),
    };
    const s = selectAccount({
      accounts: [hot, nad(NAD_FABLE)],
      model: 'claude-opus-5',
      affinitySlot: '2',
      nowMs: NOW,
    });
    assert.equal(s.slot, '2');
    assert.equal(s.decision, 'affinity-hold');
    assert.match(s.reason, /until quota exhaustion/);
  }
});

test('Fable preserves proactive evacuation at 95%', () => {
  const hot: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '0.95' }),
  };
  const s = selectAccount({
    accounts: [hot, nad(NAD_FABLE)],
    model: 'claude-fable-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1');
  assert.equal(s.decision, 'affinity-broken');
  assert.match(s.reason, /evacuated/);
});

test('91% does not evacuate — an allowed_warning is not the threshold', () => {
  const s = selectAccount({
    accounts: [joseph(JOSEPH_HAIKU), nad(NAD_FABLE)],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.decision, 'affinity-hold', 'the server warned, but the session stays');
});

test('when every Fable account is at 95%+ the session stays put and keeps its cache', () => {
  const hotA: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '0.96' }),
  };
  const hotB: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '0.97' }),
  };
  const s = selectAccount({
    accounts: [hotA, hotB],
    model: 'claude-fable-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'moving buys no quota, so do not pay a cache re-create');
  assert.equal(s.decision, 'evacuating-fallback');
});

test('with all Fable accounts hot and no affinity, the least-spent one wins', () => {
  const hotA: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '0.99' }),
  };
  const hotB: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '0.96' }),
  };
  const s = selectAccount({ accounts: [hotA, hotB], model: 'claude-fable-5', nowMs: NOW });
  assert.equal(s.slot, '2');
  assert.equal(s.decision, 'evacuating-fallback');
});

test('the evacuation threshold reads raw utilization, not model-scaled headroom', () => {
  // 7d at 0.50 -> Fable headroom 0.25, well under any threshold, but raw
  // utilization is 0.50. A scaled comparison would wrongly evacuate.
  const account: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '0.50' }),
  };
  const h = computeHeadroom(account, 'claude-fable-5', NOW);
  assert.equal(Number(h.headroom.toFixed(4)), 0.25);
  assert.equal(h.evacuating, false);
  assert.equal(Number(h.peakUtilization?.toFixed(4)), 0.5);
});

test('overage is not spent unless explicitly allowed', () => {
  const spent: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims(JOSEPH_HAIKU),
  };
  spent.claims = parseClaims({ ...JOSEPH_HAIKU, 'anthropic-ratelimit-unified-7d-utilization': '1.0' });

  const blocked = selectAccount({ accounts: [spent], model: 'claude-opus-5', nowMs: NOW });
  assert.equal(blocked.slot, undefined);
  assert.equal(blocked.decision, 'exhausted');

  const allowed = selectAccount({
    accounts: [spent],
    model: 'claude-opus-5',
    nowMs: NOW,
    allowOverage: true,
  });
  assert.equal(allowed.slot, '2');
  assert.equal(allowed.decision, 'overage-fallback');
});

test('an org with overage disabled is never used as an overage fallback', () => {
  const spent: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({ ...NAD_FABLE, 'anthropic-ratelimit-unified-7d-utilization': '1.0' }),
  };
  const s = selectAccount({
    accounts: [spent],
    model: 'claude-opus-5',
    nowMs: NOW,
    allowOverage: true,
  });
  assert.equal(s.slot, undefined, 'overage-status: rejected means there is no fallback');
  assert.equal(s.decision, 'exhausted');
});

test('an unobserved account is picked first so it gets observed; ties use numeric slot order', () => {
  const missing: AccountState = { slot: '0', health: 'ok' };
  const reset = String((NOW + 24 * 60 * 60 * 1000) / 1000);
  const known10: AccountState = { slot: '10', health: 'ok', claims: parseClaims({
    'anthropic-ratelimit-unified-7d-utilization': '0.9',
    'anthropic-ratelimit-unified-7d-reset': reset,
  }) };
  const known2: AccountState = { slot: '2', health: 'ok', claims: parseClaims({
    'anthropic-ratelimit-unified-7d-utilization': '0.1',
    'anthropic-ratelimit-unified-7d-reset': reset,
  }) };
  assert.equal(
    selectAccount({ accounts: [known10, missing, known2], model: 'claude-opus-5', nowMs: NOW }).slot,
    '0',
    'an unobserved account is assumed full and ahead of pace',
  );
  assert.equal(
    selectAccount({ accounts: [known10, known2], model: 'claude-opus-5', nowMs: NOW }).slot,
    '2',
    '90% remaining is further ahead of pace than 10%',
  );
  const twin10 = { ...known2, slot: '10' };
  for (let i = 0; i < 5; i += 1) {
    const s = selectAccount({ accounts: [twin10, known2], model: 'claude-opus-5', nowMs: NOW });
    assert.equal(s.slot, '2', 'canonical numeric-aware ordering puts slot 2 before slot 10');
  }
});

// --- the fresh-pick ceiling ------------------------------------------------
//
// Reproduces the observed live state on 2026-08-19: slot 2 at 97% weekly with
// the earlier reset, slot 1 at 40% with the later one. Pacing already prefers
// slot 1 here; the ceiling is what keeps a fresh session off a 97% account
// even when ranking would not.

const CEILING_HOT = {
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 2 * 86400),
  'anthropic-ratelimit-unified-7d-utilization': '0.97',
};

const CEILING_COOL = {
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 5 * 86400),
  'anthropic-ratelimit-unified-7d-utilization': '0.40',
};

test('a fresh non-Fable session skips a 97% account even when it resets first', () => {
  const s = selectAccount({
    accounts: [nad(CEILING_COOL), joseph(CEILING_HOT)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1', 'a cacheless session must not start on a 97% account');
  assert.equal(s.decision, 'fresh');
});

test('a warm non-Fable session on a 97% account still holds through the ceiling', () => {
  const s = selectAccount({
    accounts: [nad(CEILING_COOL), joseph(CEILING_HOT)],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'the cache is worth more than the 3% left elsewhere');
  assert.equal(s.decision, 'affinity-hold');
});

test('with every non-Fable account above the ceiling, pacing decides again', () => {
  const s = selectAccount({
    accounts: [nad({ ...CEILING_HOT, 'anthropic-ratelimit-unified-7d-utilization': '0.96' }), joseph(CEILING_HOT)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  // 4% remaining is a hair further ahead of pace than 3%; what matters is
  // that a slot was returned at all rather than an `exhausted` verdict.
  assert.equal(s.decision, 'fresh');
  assert.equal(s.slot, '1');
  assert.match(s.reason, /every account at or above 95%/);
});

test('the fresh-pick ceiling still prefers the more spendable cool account', () => {
  const earlier = { ...CEILING_COOL, 'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 3 * 86400) };
  const s = selectAccount({
    accounts: [nad(CEILING_COOL), { ...joseph(earlier), slot: '3' }],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '3', 'the ceiling filters the pool; it does not replace the ranking');
});

test('a non-Fable session whose slot exhausted lands below the ceiling, not on the hottest', () => {
  const spent: AccountState = {
    slot: '3',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '1.0' }),
  };
  const s = selectAccount({
    accounts: [spent, nad(CEILING_COOL), joseph(CEILING_HOT)],
    model: 'claude-opus-5',
    affinitySlot: '3',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1');
  assert.equal(s.decision, 'affinity-broken');
});

// --- the 5h bucket on fresh picks ------------------------------------------
//
// Reproduces the observed live state on 2026-08-24: slot 2 at 51% 5h carrying
// 14 of 17 warm leases while slots 1 and 3 sat near zero. Drain-first keeps
// feeding fresh sessions to slot 2, growing the herd that later exhausts its
// 5h bucket — and migrates — together. Bucketed ranking spreads that herd from
// the first quarter of the window instead of at one threshold. Buckets are on
// utilization PROJECTED to the reset: every fixture below has 3h of its 5h
// window left (40% elapsed), so a level of x projects to x / 0.4.

const fiveHour = (utilization: string, resetInMs: number, weekly: Record<string, string> = {}) => ({
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor((NOW + resetInMs) / 1000)),
  'anthropic-ratelimit-unified-5h-utilization': utilization,
  ...weekly,
});

const EARLY_WEEKLY = {
  'anthropic-ratelimit-unified-7d-utilization': '0.35',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 2 * 86400),
};
const LATE_WEEKLY = {
  'anthropic-ratelimit-unified-7d-utilization': '0.0',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 5 * 86400),
};

test('a fresh non-Fable session avoids a 5h-hot account even when it resets first', () => {
  // Slot 2 wins pacing (35% used, resets in 2d) but is 78% into its 5h with
  // 40% of the window gone — projected past 100%, bucket 4 — against slot 1's
  // 5%, projected 12.5%, bucket 0.
  const s = selectAccount({
    accounts: [nad(fiveHour('0.05', 3 * 60 * 60 * 1000, LATE_WEEKLY)), joseph(fiveHour('0.78', 3 * 60 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1', 'fresh sessions must stop joining the herd on the hot 5h account');
  assert.equal(s.decision, 'fresh');
  assert.match(s.reason, /projected 5h bucket 0 on 1 beat bucket 4 on 2/);
});

test('the 5h bucket spreads well before the old 70% threshold', () => {
  // 55% is under any single ceiling that would have fired, but at 40% elapsed
  // it projects past 100% — this is the case a threshold could not catch.
  const s = selectAccount({
    accounts: [nad(fiveHour('0.10', 3 * 60 * 60 * 1000, LATE_WEEKLY)), joseph(fiveHour('0.55', 3 * 60 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1', 'a cooler bucket outranks weekly pacing');
  assert.equal(s.decision, 'fresh');
  assert.match(s.reason, /projected 5h bucket 1 on 1 beat bucket 4 on 2/);
});

test('within one 5h bucket, weekly pacing still decides', () => {
  // 10% and 12% project to 25% and 30%: both bucket 1, so pacing is untouched.
  const s = selectAccount({
    accounts: [nad(fiveHour('0.10', 3 * 60 * 60 * 1000, LATE_WEEKLY)), joseph(fiveHour('0.12', 3 * 60 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'equal 5h pressure must not disturb weekly consolidation');
  assert.doesNotMatch(s.reason, /5h bucket/);
});

test('with every account in the same hot bucket, weekly pacing decides', () => {
  const s = selectAccount({
    accounts: [nad(fiveHour('0.85', 3 * 60 * 60 * 1000, LATE_WEEKLY)), joseph(fiveHour('0.78', 3 * 60 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'furthest ahead of weekly pace wins when nowhere is cooler');
  assert.equal(s.decision, 'fresh');
  assert.doesNotMatch(s.reason, /5h bucket/);
});

test('warm affinity holds straight through a hot 5h bucket', () => {
  const s = selectAccount({
    accounts: [nad(fiveHour('0.05', 3 * 60 * 60 * 1000, LATE_WEEKLY)), joseph(fiveHour('0.90', 3 * 60 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'the bucket term steers cacheless sessions only');
  assert.equal(s.decision, 'affinity-hold');
});

test('a hot 5h window refilling within the cache horizon buckets as cool', () => {
  // 78% but resetting in 20 minutes: the bucket refills before a new session
  // could meaningfully burn it, so pacing keeps its pick.
  const s = selectAccount({
    accounts: [nad(fiveHour('0.05', 3 * 60 * 60 * 1000, LATE_WEEKLY)), joseph(fiveHour('0.78', 20 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2');
  assert.doesNotMatch(s.reason, /5h bucket/);
});

test('fresh Fable picks also avoid a 5h-hot account', () => {
  // The hot account is far ahead of weekly pace (95% left, resets tomorrow)
  // and wins on spendable headroom; the bucket term must override that.
  const hot: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims(fiveHour('0.72', 3 * 60 * 60 * 1000, {
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 1 * 86400),
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.05',
      'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(NOW / 1000) + 1 * 86400),
    })),
  };
  const cool: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims(fiveHour('0.05', 3 * 60 * 60 * 1000, {
      'anthropic-ratelimit-unified-7d-utilization': '0.60',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 6 * 86400),
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.60',
      'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(NOW / 1000) + 6 * 86400),
    })),
  };
  // A bucket width above 1 puts every account in bucket 0, disabling spreading.
  const unfiltered = selectAccount({ accounts: [cool, hot], model: 'claude-fable-5', nowMs: NOW, fresh5hBucket: 1.01 });
  assert.equal(unfiltered.slot, '2', 'precondition: spendable ranking alone prefers the hot account');
  const s = selectAccount({ accounts: [cool, hot], model: 'claude-fable-5', nowMs: NOW });
  assert.equal(s.slot, '1');
  assert.match(s.reason, /projected 5h bucket 0 on 1 beat bucket 4 on 2/);
});

test('the 5h bucket is on projected utilization, not the current level', () => {
  // 60% with 90 minutes left (70% elapsed) projects to 86%: bucket 3.
  // 30% with 4h left (20% elapsed) projects to 150%, capped at 100%: bucket 4.
  const late = nad(fiveHour('0.60', 90 * 60 * 1000, LATE_WEEKLY));
  const early = joseph(fiveHour('0.30', 4 * 60 * 60 * 1000, LATE_WEEKLY));
  const hLate = computeHeadroom(late, 'claude-opus-5', NOW);
  const hEarly = computeHeadroom(early, 'claude-opus-5', NOW);
  assert.equal(Number(hLate.fiveHourProjected!.toFixed(2)), 0.86);
  assert.equal(hLate.fiveHourBucket, 3);
  assert.equal(hEarly.fiveHourProjected, 1);
  assert.equal(hEarly.fiveHourBucket, 4);
  const s = selectAccount({ accounts: [early, late], model: 'claude-opus-5', nowMs: NOW });
  assert.equal(s.slot, '1', 'the account that will not exhaust its window is the cooler one');
});

test('too early in a 5h window the raw level is used, not a noisy projection', () => {
  // 5% at six minutes in would project to 250%. Under 30 minutes elapsed the
  // level stands: bucket 0.
  const h = computeHeadroom(nad(fiveHour('0.05', 5 * 60 * 60 * 1000 - 6 * 60 * 1000)), 'claude-opus-5', NOW);
  assert.equal(h.fiveHourProjected, 0.05);
  assert.equal(h.fiveHourBucket, 0);
});

// --- weekly pacing and the Fable reservation --------------------------------

const weekly = (slot: string, util7d: string, util7dOi: string | undefined, resetInDays: number): AccountState => ({
  slot,
  health: 'ok',
  observedAt: NOW,
  claims: parseClaims({
    'anthropic-ratelimit-unified-5h-utilization': '0.05',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(NOW / 1000) + 3 * 3600),
    'anthropic-ratelimit-unified-7d-utilization': util7d,
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + resetInDays * 86400),
    ...(util7dOi === undefined ? {} : {
      'anthropic-ratelimit-unified-7d_oi-utilization': util7dOi,
      'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(NOW / 1000) + resetInDays * 86400),
    }),
    'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  }),
});

test('pacing sends fresh sessions to the account furthest ahead of pace, not the earliest reset', () => {
  // Slot 2 resets first but has spent 60% with 4 of 7 days left: behind pace.
  // Slot 3 resets later and has spent 5% with 6 days left: 9% ahead of pace.
  const s = selectAccount({ accounts: [weekly('2', '0.60', undefined, 4), weekly('3', '0.05', undefined, 6)], model: 'claude-opus-5', nowMs: NOW });
  assert.equal(s.slot, '3');
  const b = Object.fromEntries(s.breakdown.map(x => [x.slot, x]));
  assert.equal(Number(b['2']!.spendableHeadroom.toFixed(3)), -0.171, 'behind pace reads negative');
  assert.equal(Number(b['3']!.spendableHeadroom.toFixed(3)), 0.093);
});

test('non-Fable picks hold back the general weekly that Fable can still use', () => {
  // Identical general weekly; slot 5 has spent its Fable sub-budget, slot 6 has
  // not. Opus goes where Fable cannot follow; Fable goes where its budget is.
  const spentOi = weekly('5', '0.30', '0.90', 3);
  const fullOi = weekly('6', '0.30', '0.00', 3);
  const opus = selectAccount({ accounts: [fullOi, spentOi], model: 'claude-opus-5', nowMs: NOW });
  assert.equal(opus.slot, '5');
  assert.match(opus.reason, /0\.050 held for Fable/);
  const b = Object.fromEntries(opus.breakdown.map(x => [x.slot, x]));
  assert.equal(Number(b['5']!.reservedForFable.toFixed(3)), 0.05, '10% of a half-weekly sub-budget');
  assert.equal(Number(b['6']!.reservedForFable.toFixed(3)), 0.5);
  const fable = selectAccount({ accounts: [fullOi, spentOi], model: 'claude-fable-5-1', nowMs: NOW });
  assert.equal(fable.slot, '6');
  assert.equal(b['5']!.eligible, true, 'reservation is ranking only');
});

test('the reservation is a ranking term and never blocks a non-Fable pick', () => {
  const only = weekly('6', '0.30', '0.00', 3);
  const s = selectAccount({ accounts: [only], model: 'claude-opus-5', nowMs: NOW });
  assert.equal(s.slot, '6');
  assert.equal(s.decision, 'fresh');
});

test('an unobserved Fable sub-budget reserves nothing', () => {
  const h = computeHeadroom(weekly('7', '0.30', undefined, 3), 'claude-opus-5', NOW);
  assert.equal(h.reservedForFable, 0);
});

test('a 5h window refilling within the cache horizon does not block a fresh non-Fable pick', () => {
  const soon = {
    'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(NOW / 1000) + 7 * 60),
    'anthropic-ratelimit-unified-5h-utilization': '0.98',
    ...CEILING_HOT,
    'anthropic-ratelimit-unified-7d-utilization': '0.10',
  };
  const s = selectAccount({
    accounts: [joseph(soon), nad(CEILING_COOL)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'a bucket that refills before the cache expires is not a reason to move');
});

// --- expiring weekly quota -------------------------------------------------
//
// An account whose general 7d window resets within the horizon, still holding
// real headroom, is a hard deadline: whatever is unspent at the reset is gone.
// It leads fresh ranking ahead of the 5h bucket and is the one planned reason
// a serviceable warm hold is broken.

const H = 3_600_000;
/** Weekly resets in `weeklyInH` hours; 5h window resets in 3h. */
const account = (slot: string, util7d: number, weeklyInH: number, util5h = 0.1): AccountState => ({
  slot,
  health: 'ok',
  observedAt: NOW,
  claims: parseClaims({
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': String((NOW + 3 * H) / 1000),
    'anthropic-ratelimit-unified-5h-utilization': String(util5h),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': String((NOW + weeklyInH * H) / 1000),
    'anthropic-ratelimit-unified-7d-utilization': String(util7d),
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
    'anthropic-ratelimit-unified-7d_oi-reset': String((NOW + weeklyInH * H) / 1000),
    'anthropic-ratelimit-unified-7d_oi-utilization': String(util7d),
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  }),
});

test('a weekly resetting within 12h with headroom left is flagged expiring', () => {
  assert.equal(computeHeadroom(account('4', 0.13, 8.5), 'claude-opus-5', NOW).weeklyExpiring, true);
  assert.equal(computeHeadroom(account('2', 0.05, 69), 'claude-opus-5', NOW).weeklyExpiring, false, 'days out');
  assert.equal(computeHeadroom(account('4', 0.95, 8.5), 'claude-opus-5', NOW).weeklyExpiring, false, 'nothing left to spend');
  assert.equal(computeHeadroom(account('4', 0.13, 8.5, 0.96), 'claude-opus-5', NOW).weeklyExpiring, false, 'above the ceiling on 5h');
});

test('a fresh pick lands on the expiring account even from a hotter 5h bucket', () => {
  // slot 4: 5h at 60% (bucket 2), weekly 87% unspent and gone in 8.5h.
  // slot 2: 5h at 3% (bucket 0), weekly resets in three days.
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5, 0.6)];
  for (const model of ['claude-opus-5', 'claude-fable-5']) {
    const sel = selectAccount({ accounts, model, nowMs: NOW });
    assert.equal(sel.slot, '4', model);
    assert.equal(sel.decision, 'fresh');
    assert.match(sel.reason, /weekly quota on 4 expires in 8\.5h/);
  }
});

test('a warm session is moved onto an expiring account, paying one re-create', () => {
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5)];
  for (const model of ['claude-opus-5', 'claude-fable-5']) {
    const sel = selectAccount({ accounts, model, affinitySlot: '2', nowMs: NOW });
    assert.equal(sel.slot, '4', model);
    assert.equal(sel.decision, 'affinity-broken');
    assert.match(sel.reason, /moved sticky slot 2 there \(one cache re-create\)/);
  }
});

test('a warm session already on an expiring account holds, even if another expires sooner', () => {
  const accounts = [account('3', 0.2, 4), account('4', 0.13, 8.5)];
  const sel = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '4', nowMs: NOW });
  assert.equal(sel.slot, '4');
  assert.equal(sel.decision, 'affinity-hold');
});

test('once the expiring account resets the moved session stays put — no thrash', () => {
  const later = NOW + 9 * H; // slot 4 reset at +8.5h; its window is now projected a week out
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5)];
  const sel = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '4', nowMs: later });
  assert.equal(sel.slot, '4');
  assert.equal(sel.decision, 'affinity-hold');
  assert.equal(computeHeadroom(accounts[1]!, 'claude-opus-5', later).weeklyExpiring, false);
});

test('an expiring account above the ceiling or with nothing left does not pull a warm session', () => {
  for (const expiring of [account('4', 0.13, 8.5, 0.96), account('4', 0.95, 8.5)]) {
    const sel = selectAccount({
      accounts: [account('2', 0.05, 69, 0.03), expiring],
      model: 'claude-opus-5',
      affinitySlot: '2',
      nowMs: NOW,
    });
    assert.equal(sel.slot, '2');
    assert.equal(sel.decision, 'affinity-hold');
  }
});

test('a horizon of 0 disables the expiring term entirely', () => {
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5, 0.6)];
  const sel = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW, expiringHorizonMs: 0 });
  assert.equal(sel.slot, '2');
  assert.equal(sel.decision, 'affinity-hold');
});
