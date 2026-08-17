import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasClaims, normalizeClaimId, parseClaims, projectExpiredClaims } from '../src/claims.js';

import { JOSEPH_FABLE, JOSEPH_HAIKU, NAD_FABLE } from './fixtures.js';

test('parses the general claims from a real response', () => {
  const claims = parseClaims(JOSEPH_HAIKU);
  assert.equal(claims.status, 'allowed_warning');
  assert.equal(claims.representativeClaim, '7d');
  assert.equal(claims.fallbackPercentage, 0.5);
  assert.deepEqual(claims.upgradePaths, ['overage']);
  assert.equal(claims.reset, 1786770000);

  assert.equal(claims.byId['5h']?.utilization, 0.46);
  assert.equal(claims.byId['5h']?.reset, 1786665000);
  assert.equal(claims.byId['7d']?.utilization, 0.91);
  assert.equal(claims.byId['7d']?.status, 'allowed_warning');
});

test('surpassed-threshold is not shadowed by the -status/-reset suffixes', () => {
  const claims = parseClaims(JOSEPH_HAIKU);
  assert.equal(claims.byId['7d']?.surpassedThreshold, 0.75);
  // and the claim id survived intact rather than being split at the dash
  assert.ok(!('7d-surpassed' in claims.byId));
});

test('the Fable-only 7d_oi claim parses as its own claim', () => {
  const bare = parseClaims(JOSEPH_HAIKU);
  assert.equal(bare.byId['7d_oi'], undefined, 'non-Fable responses carry no 7d_oi');

  const fable = parseClaims(JOSEPH_FABLE);
  assert.equal(fable.byId['7d_oi']?.utilization, 0.22);
  assert.equal(fable.byId['7d_oi']?.status, 'allowed');
});

test('overage disabled at org level parses reason and rejected status', () => {
  const claims = parseClaims(NAD_FABLE);
  assert.equal(claims.byId['overage']?.status, 'rejected');
  assert.equal(claims.byId['overage']?.disabledReason, 'org_level_disabled');
  assert.equal(claims.representativeClaim, '5h');
});

test('header names are matched case-insensitively', () => {
  const claims = parseClaims({ 'Anthropic-RateLimit-Unified-7d-Utilization': '0.5' });
  assert.equal(claims.byId['7d']?.utilization, 0.5);
});

test('array-valued headers collapse rather than throwing', () => {
  const claims = parseClaims({ 'anthropic-ratelimit-unified-upgrade-paths': ['overage', 'plan'] });
  assert.deepEqual(claims.upgradePaths, ['overage', 'plan']);
});

test('unknown claims and fields are tolerated, not dropped destructively', () => {
  const claims = parseClaims({
    'anthropic-ratelimit-unified-30d_xx-utilization': '0.4',
    'anthropic-ratelimit-unified-7d-brand-new-field': 'whatever',
  });
  assert.equal(claims.byId['30d_xx']?.utilization, 0.4);
});

test('responses without unified headers yield empty claims', () => {
  const claims = parseClaims({ 'content-type': 'application/json' });
  assert.equal(hasClaims(claims), false);
  assert.deepEqual(claims.byId, {});
});

test('representative claim aliases normalize into the header id space', () => {
  assert.equal(normalizeClaimId('five_hour'), '5h');
  assert.equal(normalizeClaimId('seven_day'), '7d');
  assert.equal(normalizeClaimId('something_new'), 'something_new');
});

test('non-numeric values do not become NaN', () => {
  const claims = parseClaims({ 'anthropic-ratelimit-unified-7d-utilization': 'n/a' });
  assert.equal(claims.byId['7d']?.utilization, undefined);
});

test('expired known windows project to zero utilization and the next cadence reset', () => {
  const now = Date.UTC(2026, 0, 8, 12);
  const claims = projectExpiredClaims({
    representativeClaim: '5h',
    reset: (now - 11 * 60 * 60 * 1000) / 1000,
    byId: {
      '5h': { id: '5h', status: 'rejected', utilization: 1, reset: (now - 11 * 60 * 60 * 1000) / 1000 },
      '7d': { id: '7d', utilization: 0.4, reset: (now + 1000) / 1000 },
      unknown: { id: 'unknown', utilization: 1, reset: (now - 1000) / 1000 },
    },
  }, now)!;
  assert.equal(claims.byId['5h']?.utilization, 0);
  assert.equal(claims.byId['5h']?.status, 'allowed');
  assert.equal(claims.byId['5h']?.reset, (now + 4 * 60 * 60 * 1000) / 1000);
  assert.equal(claims.reset, claims.byId['5h']?.reset);
  assert.equal(claims.byId.unknown?.utilization, 1, 'unknown cadence is not invented');
});
