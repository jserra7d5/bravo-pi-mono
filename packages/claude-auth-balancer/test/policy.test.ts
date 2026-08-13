import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseClaims } from '../src/claims.js';
import {
  computeHeadroom,
  quotaForModel,
  selectAccount,
} from '../src/policy.js';
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

test('a fresh session picks the account with the most headroom', () => {
  const s = selectAccount({
    accounts: [joseph(JOSEPH_HAIKU), nad(NAD_FABLE)],
    model: 'claude-opus-5',
    nowMs: NOW,
  });
  assert.equal(s.slot, '1', 'nad at 1% beats joseph at 91%');
  assert.equal(s.decision, 'fresh');
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

test('an account at 95% is evacuated even though it still has headroom', () => {
  const hot: AccountState = {
    slot: '2',
    health: 'ok',
    claims: parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': '0.95' }),
  };
  const s = selectAccount({
    accounts: [hot, nad(NAD_FABLE)],
    model: 'claude-opus-5',
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

test('when every account is at 95%+ the session stays put and keeps its cache', () => {
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
    model: 'claude-opus-5',
    affinitySlot: '2',
    nowMs: NOW,
  });
  assert.equal(s.slot, '2', 'moving buys no quota, so do not pay a cache re-create');
  assert.equal(s.decision, 'evacuating-fallback');
});

test('with all accounts hot and no affinity, the least-spent one wins', () => {
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
  const s = selectAccount({ accounts: [hotA, hotB], model: 'claude-opus-5', nowMs: NOW });
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

test('selection is deterministic when headroom ties', () => {
  const a: AccountState = { slot: '2', health: 'ok' };
  const b: AccountState = { slot: '1', health: 'ok' };
  for (let i = 0; i < 5; i += 1) {
    const s = selectAccount({ accounts: [a, b], model: 'claude-opus-5', nowMs: NOW });
    assert.equal(s.slot, '1', 'stable slot-id tie-break');
  }
});
