import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseClaims } from '../src/claims.js';
import {
  capacityForTier,
  computeFleetTerms,
  computeHeadroom,
  DEFAULT_PULL_COOLDOWN_MS,
  quotaForModel,
  REFERENCE_CAPACITY,
  selectAccount,
} from '../src/policy.js';
import type { DemandModel } from '../src/demand.js';
import { weekHour } from '../src/demand.js';
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

test('the captured fixture pair drains the earliest weekly reset despite 5h pressure', () => {
  // Verbatim 2026-08-13 headers. Slot 2 resets in 1.3d, slot 1 in 3.5d. Slot 2
  // sits at 46% 5h with 72% of the window gone — projected 64%, bucket 2 —
  // against slot 1's 1%, bucket 0. The earlier reset day wins; the bucket only
  // spreads within one reset day.
  const s = selectAccount({
    accounts: [nad(NAD_FABLE), joseph(JOSEPH_HAIKU)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2');
  assert.equal(s.decision, 'fresh');
  assert.match(s.reason, /weekly on 2 resets in 1\.3d, earliest, beat 1 \(3\.5d\)/);
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

test('a fresh non-Fable session drains the earliest weekly reset even through a hot 5h', () => {
  // Slot 2 resets in 2d and is 78% into its 5h with 40% of the window gone —
  // projected past 100%, bucket 4 — against slot 1's 5%, bucket 0, resetting
  // in 5d. Concentrating on the early reset leaves slot 1's 5h window unopened
  // for the next peak. A hot-bucket escape from this order was tried and
  // reverted (spec step 5): replay showed no benefit.
  const s = selectAccount({
    accounts: [nad(fiveHour('0.05', 3 * 60 * 60 * 1000, LATE_WEEKLY)), joseph(fiveHour('0.78', 3 * 60 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2');
  assert.equal(s.decision, 'fresh');
  assert.match(s.reason, /weekly on 2 resets in 2\.0d, earliest, beat 1 \(5\.0d\)/);
});

test('the 5h bucket spreads within one reset day', () => {
  // Same reset day (2.0d and 2.9d both floor to 2). 55% at 40% elapsed
  // projects past 100% — bucket 4 — against 10%, bucket 1: the cooler one wins.
  const sameDay = { ...EARLY_WEEKLY, 'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + Math.floor(2.9 * 86400)) };
  const s = selectAccount({
    accounts: [nad(fiveHour('0.10', 3 * 60 * 60 * 1000, sameDay)), joseph(fiveHour('0.55', 3 * 60 * 60 * 1000, EARLY_WEEKLY))],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1', 'a cooler bucket decides among accounts resetting the same day');
  assert.equal(s.decision, 'fresh');
  assert.match(s.reason, /projected 5h bucket 1 on 1 beat bucket 4 on 2/);
});

test('reproduces 2026-09-02: a fresh Opus session no longer lands on the latest-resetting account', () => {
  // Slots 2 and 3 reset in 2.3d and 2.5d; slot 1 in 4.6d, behind pace, but
  // with the coolest 5h bucket. Old ranking sent the session to slot 1. Now 2
  // and 3 tie on reset day and the 5h bucket picks between them.
  const day = (d: number, u7d: string) => ({
    'anthropic-ratelimit-unified-7d-utilization': u7d,
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + Math.floor(d * 86400)),
  });
  const s = selectAccount({
    accounts: [
      nad(fiveHour('0.02', 3 * 60 * 60 * 1000, day(4.6, '0.60'))),
      joseph(fiveHour('0.26', 3 * 60 * 60 * 1000, day(2.3, '0.11'))),
      { ...joseph(fiveHour('0.12', 3 * 60 * 60 * 1000, day(2.5, '0.07'))), slot: '3' },
    ],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '3');
  assert.match(s.reason, /weekly on 3 resets in 2\.5d, earliest, beat 1 \(4\.6d\)/);
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

test('fresh Fable picks spread on the 5h bucket within one reset day', () => {
  // The hot account is far ahead of weekly pace (95% left) and wins on
  // spendable headroom; the bucket term must override that. Both accounts
  // reset the same day so the reset-day term is neutral.
  const hot: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims(fiveHour('0.72', 3 * 60 * 60 * 1000, {
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 6 * 86400 + 3600),
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.05',
      'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(NOW / 1000) + 6 * 86400 + 3600),
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

test('the earliest weekly reset takes fresh sessions even when it is behind pace', () => {
  // Slot 2 resets first but has spent 60% with 4 of 7 days left: behind pace.
  // Slot 3 resets later and has spent 5% with 6 days left: 9% ahead of pace.
  // The deadline wins; pacing only ranks within one reset day.
  const s = selectAccount({ accounts: [weekly('2', '0.60', undefined, 4), weekly('3', '0.05', undefined, 6)], model: 'claude-opus-5', nowMs: NOW });
  assert.equal(s.slot, '2');
  assert.match(s.reason, /weekly on 2 resets in 4\.0d, earliest, beat 3 \(6\.0d\)/);
  const same = selectAccount({ accounts: [weekly('2', '0.60', undefined, 4), weekly('3', '0.05', undefined, 4.5)], model: 'claude-opus-5', nowMs: NOW });
  assert.equal(same.slot, '3', 'within one reset day, furthest ahead of pace wins');
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
// An account holding more weekly quota than the demand forecast can burn
// before its reset has SURPLUS: whatever is unspent at the reset is gone. It
// leads fresh ranking ahead of the 5h bucket and is the one planned reason a
// serviceable warm hold is broken.

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

/**
 * A demand model with `perHour` W20/h everywhere, or `at(hoursFromNow)` when
 * given. k = 0.2, so a 20x's 5h window burns at most 0.04 W20/h.
 */
const demandOf = (perHour: number, at?: (hoursFromNow: number) => number, freshBurn = 0): DemandModel => {
  const hourly = new Array<number>(168).fill(perHour);
  if (at) for (let h = 0; h < 168; h += 1) hourly[weekHour(NOW + h * H)] = at(h);
  return { computedAt: NOW, w20PerUsd: { general: 1, fable: 1 }, k: 0.2, freshBurn, hourly, overrides: [] };
};
/** More demand than a 20x can serve (0.05 > 0.04 W20/h): a small remainder is always reachable. */
const HEAVY = demandOf(0.05);

const verdict = (accounts: AccountState[], slot: string, demand: DemandModel | undefined, nowMs = NOW) => {
  const fleet = computeFleetTerms(accounts, nowMs, demand);
  return computeHeadroom(accounts.find(a => a.slot === slot)!, 'claude-opus-5', nowMs, { demand, fleet: fleet.get(slot) });
};

test('an account holding more than the forecast can reach is expiring', () => {
  // 87% left, reset in 8.5h: the demand can burn at most 0.34 of it.
  const fleet = [account('4', 0.13, 8.5), account('2', 0.05, 69)];
  const soon = verdict(fleet, '4', HEAVY);
  assert.equal(soon.weeklyExpiring, true);
  assert.equal(Number(soon.surplus.toFixed(3)), 0.53);
  assert.equal(verdict(fleet, '2', HEAVY).weeklyExpiring, false, 'days out: the demand reaches it');
  // 8.5 demand hours is outside the terminal window, so 95% still means the ceiling.
  assert.equal(verdict([account('4', 0.95, 8.5)], '4', HEAVY).weeklyExpiring, false, 'above the ceiling on 7d');
  assert.equal(verdict([account('4', 0.13, 8.5, 0.96)], '4', HEAVY).weeklyExpiring, false, 'above the ceiling on 5h');
});

test('without a demand model nothing is expiring', () => {
  assert.equal(verdict([account('4', 0.13, 8.5)], '4', undefined).weeklyExpiring, false);
  assert.equal(computeFleetTerms([account('4', 0.13, 8.5)], NOW, undefined).size, 0);
});

test('the same clock distance expires on a quiet night and not at a peak', () => {
  // Half a weekly left, resetting in 30h.
  const half = [account('4', 0.5, 30)];
  const quiet = demandOf(0.05, h => (h < 30 ? 0.001 : 0.05));
  assert.equal(verdict(half, '4', quiet).weeklyExpiring, true, '30 quiet hours burn ~0.03');
  assert.equal(verdict(half, '4', HEAVY).weeklyExpiring, false, '30 busy hours burn up to 1.2');
});

test('a 5x absorbs only what its quarter-size 5h window can burn', () => {
  // 0.59 W20 of weekly, 70h to its reset, plenty of demand: at 0.01 W20/h the
  // 5x window caps it at 0.7, so it is reachable; at a quarter of that
  // demand's rate it is not.
  const fiveX = { ...account('5', 0, 70), capacity: capacityForTier('default_claude_max_5x') };
  const term = computeFleetTerms([fiveX], NOW, HEAVY).get('5')!;
  assert.equal(Number(term.weekly.toFixed(3)), Number((1 / 1.7).toFixed(3)));
  assert.equal(Number(term.absorbable.toFixed(3)), 0.7, '0.25 × 0.2 / 5 W20/h for 70h');
  const slower = computeFleetTerms([{ ...fiveX, claims: account('5', 0, 20).claims }], NOW, HEAVY).get('5')!;
  assert.ok(slower.surplus > 0, 'twenty hours at a 5x rate cannot spend its week');
});

test('a Fable surplus is measured on the Fable budget, not the general one', () => {
  // 7d 25% used (0.75 left) but 7d_oi 50% used at fallback 0.5: 0.25 left for Fable.
  const target = account('4', 0.25, 40);
  target.claims = { ...target.claims!, byId: { ...target.claims!.byId, '7d_oi': { ...target.claims!.byId['7d_oi']!, utilization: 0.5 } } };
  const quiet = demandOf(0.01);
  assert.equal(Number(computeFleetTerms([target], NOW, quiet, 'claude-opus-5').get('4')!.surplus.toFixed(2)), 0.35);
  assert.equal(Number(computeFleetTerms([target], NOW, quiet, 'claude-fable-5').get('4')!.surplus.toFixed(2)), -0.15);
  const sel = selectAccount({
    accounts: [account('2', 0.05, 69, 0.03), target],
    model: 'claude-fable-5', affinitySlot: '2', nowMs: NOW, demand: quiet,
  });
  assert.equal(sel.decision, 'affinity-hold', 'no Fable quota would be stranded, so no re-create');
});

test('earlier deadlines take their share of the demand first', () => {
  const fleet = [account('3', 0.2, 4), account('4', 0.13, 8.5)];
  const terms = computeFleetTerms(fleet, NOW, HEAVY);
  assert.equal(Number(terms.get('3')!.absorbable.toFixed(3)), 0.16, 'rate-capped: 0.04 × 4h');
  assert.equal(Number(terms.get('4')!.absorbable.toFixed(3)), 0.265, '0.425 of demand, less the 0.16 slot 3 takes');
});

// --- terminal weekly burndown ----------------------------------------------
//
// Observed live 2026-09-21: slot 1 sat at 95.0% weekly with its reset 2.7h
// away, so the ceiling excluded it from every fresh pick and 5% of a weekly
// budget was going to reach 04:00 unspent. Within eight hours of demand of the
// reset that ceiling is backwards, so it is lifted for weekly claims only.

test('a weekly at the ceiling near its reset burns down instead', () => {
  const h = verdict([account('1', 0.95, 2.7, 0)], '1', HEAVY);
  assert.equal(h.evacuating, false, 'the ceiling is lifted, so fresh picks are allowed');
  assert.equal(h.weeklyTerminal, true);
  assert.equal(h.weeklyExpiring, false, 'busy hours reach a 5% remainder, so nothing is stranded');
  assert.equal(Number(h.headroom.toFixed(3)), 0.05);
});

test('terminal distance is measured in demand, not on the clock', () => {
  // 20 clock hours out, but the next 20 hours are nearly idle.
  const quiet = demandOf(0.05, h => (h < 20 ? 0.001 : 0.05));
  assert.equal(verdict([account('1', 0.96, 20, 0)], '1', quiet).evacuating, false);
  assert.equal(verdict([account('1', 0.96, 20, 0)], '1', HEAVY).evacuating, true, '20 busy hours are not terminal');
  // With no demand model the hours are clock hours: today's 8h rule.
  assert.equal(verdict([account('1', 0.96, 7.5, 0)], '1', undefined).evacuating, false);
  assert.equal(verdict([account('1', 0.96, 8.5, 0)], '1', undefined).evacuating, true);
});

test('the terminal window takes fresh picks from a later deadline', () => {
  const accounts = [account('2', 0.05, 69, 0.03), account('1', 0.95, 2.7, 0)];
  for (const model of ['claude-opus-5', 'claude-fable-5']) {
    const sel = selectAccount({ accounts, model, nowMs: NOW, demand: HEAVY });
    assert.equal(sel.slot, '1', model);
    assert.equal(sel.decision, 'fresh');
  }
});

test('a terminal remainder is spent by fresh picks but never bought with a cache re-create', () => {
  const accounts = [account('2', 0.05, 69, 0.03), account('1', 0.95, 2.7, 0)];
  const sel = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW, demand: HEAVY });
  assert.equal(sel.slot, '2');
  assert.equal(sel.decision, 'affinity-hold');
});

test('a weekly reserve is never spent, not even by the burndown', () => {
  // Slot 2 holds 10% back. At 88% it is past its own 95% ceiling (88/90).
  const reserved = { ...account('2', 0.88, 30, 0), weeklyReserve: 0.1 };
  const h = computeHeadroom(reserved, 'claude-opus-5', NOW);
  assert.equal(h.evacuating, true, 'fresh picks stop well short of the reserve');
  assert.equal(Number(h.headroom.toFixed(3)), 0.02, 'what is left above the reserve, in W20');
  // Inside the terminal window the lift spends up to the reserve, no further.
  const terminal = verdict([{ ...account('2', 0.88, 2.7, 0), weeklyReserve: 0.1 }], '2', HEAVY);
  assert.equal(terminal.evacuating, false);
  assert.equal(terminal.weeklyTerminal, true);
  // At the reserve the account is spent: a warm session leaves it.
  const spent = { ...account('2', 0.9, 2.7, 0), weeklyReserve: 0.1 };
  assert.equal(computeHeadroom(spent, 'claude-opus-5', NOW).eligible, false);
  const sel = selectAccount({
    accounts: [account('1', 0.05, 69, 0.03), spent],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
    demand: HEAVY,
  });
  assert.equal(sel.slot, '1');
  assert.equal(sel.decision, 'affinity-broken');
});

test('overage never bills through a reserve: at the reserve the server would spend it', () => {
  const withOverage = (u7: number) => {
    const a = { ...account('2', u7, 30, 0), weeklyReserve: 0.1 };
    a.claims = { ...a.claims!, byId: { ...a.claims!.byId, overage: { id: 'overage', status: 'allowed' } } };
    return a;
  };
  const sel = selectAccount({ accounts: [withOverage(0.9)], model: 'claude-opus-5', nowMs: NOW, allowOverage: true });
  assert.notEqual(sel.slot, '2');
  assert.equal(computeHeadroom(withOverage(0.5), 'claude-opus-5', NOW).overageAvailable, true, 'below it, unchanged');
});

test('a reserve keeps 70% of its size on the 5h window', () => {
  // 10% weekly reserve: 7% of the 5h window is held. 93% of 5h is spent.
  const at = (u5: number) => ({ ...account('2', 0.3, 60, u5), weeklyReserve: 0.1 });
  assert.equal(computeHeadroom(at(0.93), 'claude-opus-5', NOW).eligible, false);
  assert.ok(computeHeadroom(at(0.92), 'claude-opus-5', NOW).eligible);
  const sel = selectAccount({
    accounts: [account('1', 0.05, 69, 0.03), at(0.93)],
    model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW,
  });
  assert.equal(sel.slot, '1', 'a warm session leaves before the 5h reserve');
});

test('a reserve is not counted as supply the demand can absorb', () => {
  const plain = computeFleetTerms([account('2', 0.5, 30)], NOW, HEAVY).get('2')!;
  const reserved = computeFleetTerms([{ ...account('2', 0.5, 30), weeklyReserve: 0.1 }], NOW, HEAVY).get('2')!;
  assert.equal(Number(plain.weekly.toFixed(3)), 0.5);
  assert.equal(Number(reserved.weekly.toFixed(3)), 0.4);
});

test('the 5h claim is never terminal — it refills, it does not expire', () => {
  // 96% on 5h with the window resetting in 3h: inside the weekly terminal
  // window, and still an evacuation, because nothing is rescued by spending a
  // window that refills on its own.
  const h = verdict([account('4', 0.13, 2.7, 0.96)], '4', HEAVY);
  assert.equal(h.evacuating, true);
  assert.equal(h.weeklyTerminal, false);
});

test('an exhausted terminal account stops taking sessions and releases the warm ones', () => {
  const spent = account('1', 1.0, 2.7, 0);
  assert.equal(computeHeadroom(spent, 'claude-opus-5', NOW).eligible, false);
  const sel = selectAccount({
    accounts: [account('2', 0.05, 69, 0.03), spent],
    model: 'claude-opus-5',
    affinitySlot: '1',
    nowMs: NOW,
    demand: HEAVY,
  });
  assert.equal(sel.slot, '2');
  assert.equal(sel.decision, 'affinity-broken');
});

test('a fresh pick lands on the expiring account even from a hotter 5h bucket', () => {
  // slot 4: 5h at 60% (bucket 2), 0.53 W20 the forecast cannot reach in 8.5h.
  // slot 2: 5h at 3% (bucket 0), weekly resets in three days.
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5, 0.6)];
  // Opus only: a Fable surplus is measured on 7d_oi (see the Fable test above).
  for (const model of ['claude-opus-5']) {
    const sel = selectAccount({ accounts, model, nowMs: NOW, demand: HEAVY });
    assert.equal(sel.slot, '4', model);
    assert.equal(sel.decision, 'fresh');
    assert.match(sel.reason, /weekly quota on 4 expires in 8\.5h with 0\.530 W20 more than forecast demand can reach; draining it first/);
  }
});

test('a warm session is moved onto an expiring account, paying one re-create', () => {
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5)];
  // Opus only: a Fable surplus is measured on 7d_oi (see the Fable test above).
  for (const model of ['claude-opus-5']) {
    const sel = selectAccount({ accounts, model, affinitySlot: '2', nowMs: NOW, demand: HEAVY });
    assert.equal(sel.slot, '4', model);
    assert.equal(sel.decision, 'affinity-broken');
    assert.match(sel.reason, /moved sticky slot 2 there \(one cache re-create\)/);
  }
});

test('a session moved within the cooldown is not pulled again', () => {
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5)];
  const recent = selectAccount({
    accounts, model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW, demand: HEAVY,
    affinitySince: NOW - DEFAULT_PULL_COOLDOWN_MS + H,
  });
  assert.equal(recent.decision, 'affinity-hold');
  const settled = selectAccount({
    accounts, model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW, demand: HEAVY,
    affinitySince: NOW - DEFAULT_PULL_COOLDOWN_MS,
  });
  assert.equal(settled.slot, '4');
});

test('a warm session already on an expiring account holds, even if another expires sooner', () => {
  const accounts = [account('3', 0.2, 4), account('4', 0.13, 8.5)];
  const sel = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '4', nowMs: NOW, demand: HEAVY });
  assert.equal(sel.slot, '4');
  assert.equal(sel.decision, 'affinity-hold');
});

test('once the expiring account resets the moved session stays put — no thrash', () => {
  const later = NOW + 9 * H; // slot 4 reset at +8.5h; its window is now projected a week out
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5)];
  const sel = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '4', nowMs: later, demand: HEAVY });
  assert.equal(sel.slot, '4');
  assert.equal(sel.decision, 'affinity-hold');
  assert.equal(verdict(accounts, '4', HEAVY, later).weeklyExpiring, false);
});

test('an expiring account above the ceiling or with nothing left does not pull a warm session', () => {
  for (const expiring of [account('4', 0.13, 8.5, 0.96), account('4', 0.95, 8.5)]) {
    const sel = selectAccount({
      accounts: [account('2', 0.05, 69, 0.03), expiring],
      model: 'claude-opus-5',
      affinitySlot: '2',
      nowMs: NOW,
      demand: HEAVY,
    });
    assert.equal(sel.slot, '2');
    assert.equal(sel.decision, 'affinity-hold');
  }
});

test('a small surplus is taken by fresh picks but does not pull a warm session', () => {
  // 0.05 W20 the forecast cannot reach: worth a free placement, not a re-create.
  const small = demandOf(0.05, h => (h < 8.5 ? 0.005 : 0.05));
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.9, 8.5)];
  assert.ok(verdict(accounts, '4', small).surplus < 0.1);
  assert.equal(selectAccount({ accounts, model: 'claude-opus-5', nowMs: NOW, demand: small }).slot, '4');
  const warm = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW, demand: small });
  assert.equal(warm.decision, 'affinity-hold');
});

// --- heavy sessions and the 5h window ------------------------------------------

test('a heavy session is not pulled onto a window it would exhaust within the cache TTL', () => {
  // slot 4's 5h window has 0.9 × 0.2 = 0.18 W20 left.
  const accounts = [account('2', 0.05, 69, 0.03), account('4', 0.13, 8.5)];
  const heavy = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW, demand: HEAVY, sessionRate: 0.3 });
  assert.equal(heavy.decision, 'affinity-hold');
  const light = selectAccount({ accounts, model: 'claude-opus-5', affinitySlot: '2', nowMs: NOW, demand: HEAVY, sessionRate: 0.1 });
  assert.equal(light.slot, '4');
});

test('a re-picked session with measured burn prefers a window it fits in', () => {
  // Same reset day and bucket; the 5x would win on slot order but its 5h
  // window (0.9 × 0.25 × 0.2 = 0.045 W20) cannot hold 0.1 W20/h for an hour.
  const fiveX = { ...account('1', 0.1, 50), capacity: capacityForTier('default_claude_max_5x') };
  const accounts = [fiveX, account('2', 0.1, 50)];
  assert.equal(selectAccount({ accounts, model: 'claude-opus-5', nowMs: NOW, demand: HEAVY }).slot, '1');
  assert.equal(selectAccount({ accounts, model: 'claude-opus-5', nowMs: NOW, demand: HEAVY, sessionRate: 0.1 }).slot, '2');
  // Fitting nowhere is not a refusal: being served beats being refused.
  assert.equal(selectAccount({ accounts: [fiveX], model: 'claude-opus-5', nowMs: NOW, demand: HEAVY, sessionRate: 1 }).slot, '1');
});

test('a typical fresh session weighs four times as much on a 5x window', () => {
  // freshBurn 0.02 W20: 10% of a 20x window (0.2), 40% of a 5x's (0.05).
  const demand = demandOf(0.05, undefined, 0.02);
  // Resets 100h out, so neither holds a surplus the demand cannot reach.
  const fiveX = { ...account('1', 0.1, 100, 0), capacity: capacityForTier('default_claude_max_5x') };
  const twentyX = account('2', 0.1, 100, 0);
  assert.equal(computeHeadroom(fiveX, 'claude-opus-5', NOW, { demand }).fiveHourBucket, 1);
  assert.equal(computeHeadroom(twentyX, 'claude-opus-5', NOW, { demand }).fiveHourBucket, 0);
  assert.equal(selectAccount({ accounts: [fiveX, twentyX], model: 'claude-opus-5', nowMs: NOW, demand }).slot, '2');
});

test('pacing holds quota back in proportion to demand ahead, not time', () => {
  // Reset in 30h, half the weekly left. Quiet hours ahead mean little of the
  // week's demand remains, so more of the remainder is spendable now.
  const quiet = demandOf(0.05, h => (h < 30 ? 0.001 : 0.05));
  const a = account('4', 0.5, 30);
  const byDemand = computeHeadroom(a, 'claude-opus-5', NOW, { demand: quiet }).spendableHeadroom;
  const byClock = computeHeadroom(a, 'claude-opus-5', NOW).spendableHeadroom;
  assert.ok(byDemand > byClock, `${byDemand} !> ${byClock}`);
  // A flat profile paces exactly like the clock.
  const flat = computeHeadroom(a, 'claude-opus-5', NOW, { demand: HEAVY }).spendableHeadroom;
  assert.equal(Number(flat.toFixed(6)), Number(byClock.toFixed(6)));
});

// --- an observed account whose weekly window has not opened -----------------
//
// `/api/oauth/usage` reports a window that has rolled over and not been
// reopened as `{utilization: 0.0, resets_at: null}`, so the background sweep
// stores a 7d claim with a utilization and NO reset. That is a third state:
// not "unobserved" (we know nothing), and not "observed with a deadline".
// The server anchors the 7-day window on first use, so this is the one budget
// that cannot expire unspent — and therefore the last one worth spending.

const DAY_MS = 86_400_000;

/** The shape the usage sweep persists for an account with no window open. */
const unopenedWeekly = (slot: string): AccountState => ({
  slot,
  health: 'ok',
  claims: { byId: {
    '5h': { id: '5h', utilization: 0, status: 'allowed' },
    '7d': { id: '7d', utilization: 0, status: 'allowed' },
  } },
});

/** An account mid-week: `util` of its weekly spent, resetting in `days`. */
const openWeekly = (slot: string, util: number, days: number): AccountState => ({
  slot,
  health: 'ok',
  claims: { byId: {
    '5h': { id: '5h', utilization: 0.1, status: 'allowed', reset: (NOW + 4 * 3_600_000) / 1000 },
    '7d': { id: '7d', utilization: util, status: 'allowed', reset: (NOW + days * DAY_MS) / 1000 },
  } },
});

test('a weekly window that has not opened is not a deadline, and does not fake full pacing headroom', () => {
  const open = computeHeadroom(openWeekly('2', 0.4, 1.5), 'claude-opus-5', NOW);
  const unopened = computeHeadroom(unopenedWeekly('1'), 'claude-opus-5', NOW);

  assert.equal(unopened.weeklyWindowUnopened, true);
  assert.equal(unopened.projectedWeeklyResetAt, undefined, 'there is no reset to project');
  assert.equal(unopened.weeklyExpiring, false, 'a window that never opened cannot expire');
  assert.equal(unopened.headroom, 1, 'the full week is still available to spend');
  // Pacing holds quota back in proportion to the window still ahead. An
  // unopened window has the WHOLE period ahead, so nothing is owed to now.
  assert.equal(unopened.spendableHeadroom, 0);
  assert.ok(
    open.spendableHeadroom > unopened.spendableHeadroom,
    `a real deadline must outrank no deadline: ${open.spendableHeadroom} !> ${unopened.spendableHeadroom}`,
  );
});

test('a fresh session drains the earliest real weekly deadline before an unopened window', () => {
  // The regression this pins: an unopened weekly leaves `projectedWeeklyResetAt`
  // undefined, which also means "never observed" — a sentinel that sorts FIRST.
  // Conflating the two sends every fresh session to the one account with no
  // deadline while a 60% weekly remainder runs out its 1.5-day clock.
  const selection = selectAccount({
    accounts: [unopenedWeekly('1'), openWeekly('2', 0.4, 1.5), openWeekly('3', 0.2, 3.5)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(selection.slot, '2');
  assert.match(selection.reason ?? '', /resets in 1\.5d/);
});

test('an unobserved account still sorts ahead of one whose window has not opened', () => {
  // The two states share an undefined reset and must NOT share an ordering:
  // an account we know nothing about is worth a request precisely so that the
  // request observes it.
  const selection = selectAccount({
    accounts: [unopenedWeekly('1'), { slot: '2', health: 'ok' }],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(selection.slot, '2');
});

test('an unopened weekly is still spendable when nothing else can serve', () => {
  // Ranking it last must not strand it: with every other account exhausted it
  // is the account that serves.
  const spent: AccountState = {
    slot: '2',
    health: 'ok',
    claims: { byId: { '7d': { id: '7d', utilization: 1, status: 'rejected', reset: (NOW + 2 * DAY_MS) / 1000 } } },
  };
  const selection = selectAccount({
    accounts: [unopenedWeekly('1'), spent],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(selection.slot, '1');
});

test('a routing reason calls an unopened window what it is, not "unobserved"', () => {
  const selection = selectAccount({
    accounts: [unopenedWeekly('1'), openWeekly('2', 0.4, 1.5)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.match(selection.reason ?? '', /no window open/);
  assert.doesNotMatch(selection.reason ?? '', /unobserved/);
});

test('an unopened weekly does not yank a warm session to drain a window that is not running', () => {
  // Before the sweep recorded idle readings, a long-idle account's stale claim
  // was projected forward into an invented reset that eventually fell inside
  // the expiring horizon. The policy then moved a warm session there to
  // "drain" a window the server had never opened, paying a real cache
  // re-create for nothing.
  const selection = selectAccount({
    accounts: [openWeekly('1', 0.3, 5), unopenedWeekly('2')],
    model: 'claude-opus-5',
    affinitySlot: '1',
    nowMs: NOW,
  });
  assert.equal(selection.slot, '1', 'a warm, serviceable affinity is held');
});

// --- mixed plan sizes --------------------------------------------------------
//
// Utilization is a fraction of the account's own budget. A Max 5x budget is a
// quarter of a 20x's on 5h and 1/1.7 of it on 7d.

const FIVE_X = capacityForTier('default_claude_max_5x');
const fiveX = (a: AccountState): AccountState => ({ ...a, capacity: FIVE_X });

test('plan tiers map to capacities; an unread or unknown tier is the 20x reference', () => {
  assert.deepEqual(FIVE_X, { fiveHour: 0.25, weekly: 1 / 1.7 });
  assert.equal(capacityForTier('default_claude_max_20x'), REFERENCE_CAPACITY);
  assert.equal(capacityForTier(undefined), REFERENCE_CAPACITY);
  assert.equal(capacityForTier('default_claude_max_40x'), REFERENCE_CAPACITY);
});

test("a 5x account's headroom is in 20x units, a quarter of the 20x's on the same 5h meter", () => {
  // 60% of 5h and 30% of 7d used: the 20x binds on 5h at 0.4.
  const big = computeHeadroom(account('2', 0.3, 69, 0.6), 'claude-opus-5', NOW);
  assert.equal(big.bindingClaim, '5h');
  assert.equal(Number(big.headroom.toFixed(4)), 0.4);
  const small = computeHeadroom(fiveX(account('5', 0.3, 69, 0.6)), 'claude-opus-5', NOW);
  // 5h: 0.4 * 0.25 = 0.1; 7d: 0.7 / 1.7 = 0.41
  assert.equal(small.bindingClaim, '5h');
  assert.equal(Number(small.headroom.toFixed(4)), 0.1);
  const weeklyBound = computeHeadroom(fiveX(account('5', 0.9, 69, 0)), 'claude-opus-5', NOW);
  assert.equal(weeklyBound.bindingClaim, '7d');
  assert.equal(Number(weeklyBound.headroom.toFixed(4)), Number((0.1 / 1.7).toFixed(4)));
});

test('pacing stays in each account\'s own fractions, whatever the plan', () => {
  // Greedy ranking on fractions already gives a 5x fewer sessions: each one
  // moves its fractions 1.7x further. Scaling pacing would make a behind-pace
  // 5x read as less behind than a 20x at the same fraction.
  const big = computeHeadroom(account('2', 0.3, 69, 0.1), 'claude-opus-5', NOW);
  const small = computeHeadroom(fiveX(account('5', 0.3, 69, 0.1)), 'claude-opus-5', NOW);
  assert.equal(small.spendableHeadroom, big.spendableHeadroom);
  assert.equal(small.fiveHourBucket, big.fiveHourBucket);
});

test('an expiring 5x needs more of its own window to pull a warm session than a 20x does', () => {
  // Same meters on both: 30% of 5h left. On a 20x that is 0.3 of a 20x window;
  // on a 5x it is 0.075, too little to be worth moving a herd onto.
  const held = account('2', 0.05, 69, 0.03);
  const pulledBy20x = selectAccount({
    accounts: [held, account('4', 0.13, 8.5, 0.7)],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
    demand: HEAVY,
  });
  assert.equal(pulledBy20x.slot, '4');
  assert.equal(pulledBy20x.decision, 'affinity-broken');

  const notPulled = selectAccount({
    accounts: [held, fiveX(account('4', 0.13, 8.5, 0.7))],
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
    demand: HEAVY,
  });
  assert.equal(notPulled.slot, '2');
  assert.equal(notPulled.decision, 'affinity-hold');

  // A fresh session has no cache to lose, so the 5x still drains first.
  const fresh = selectAccount({
    accounts: [held, fiveX(account('4', 0.13, 8.5, 0.7))],
    model: 'claude-opus-5',
    nowMs: NOW,
    demand: HEAVY,
  });
  assert.equal(fresh.slot, '4');
  assert.match(fresh.reason, /expires in 8\.5h/);
});
