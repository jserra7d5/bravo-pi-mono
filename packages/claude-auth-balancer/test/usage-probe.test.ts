import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadAccountStates, readSlotObservation, readSlotPlan, recordObservation, writeSlotPlan } from '../src/accounts.js';
import { computeHeadroom } from '../src/policy.js';
import { claimsFromUsageBody, PLAN_PROBE_STALE_MS, UsageProbe } from '../src/usage-probe.js';

const cleanups: (() => void)[] = [];
after(() => cleanups.reverse().forEach(fn => fn()));

function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cab-probe-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function account(root: string) {
  const credentialPath = path.join(root, 'credential.json');
  writeFileSync(credentialPath, JSON.stringify({ claudeAiOauth: { accessToken: 'canonical-token' } }));
  return { slot: '1', email: 'a@example.com', credentialPath };
}

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('legacy usage mapping recognizes only existing claim semantics', () => {
  const claims = claimsFromUsageBody({
    five_hour: { utilization: 25, resets_at: '2026-01-01T05:00:00Z' },
    seven_day: { utilization: 50, resets_at: 1767225600 },
    seven_day_opus: { utilization: 75, resets_at: 1767225600000 },
    mystery_model: { utilization: 99 },
  })!;
  assert.equal(claims.byId['5h']?.utilization, 0.25);
  assert.equal(claims.byId['7d']?.utilization, 0.5);
  assert.equal(claims.byId['7d']?.reset, 1767225600);
  assert.equal(claims.byId['7d_oi'], undefined, 'legacy model bucket semantics are not invented');
  assert.equal(claims.byId.mystery_model, undefined);
});

test('a rolled-over window with no reset is recorded as an idle reading, not discarded', () => {
  // Captured 2026-09-05 from a live Max account whose windows had rolled over:
  // the server nulls every reset and only reopens a window on first use, so
  // discarding this reading leaves the account unobservable until traffic
  // happens to land on it.
  const claims = claimsFromUsageBody({
    five_hour: { utilization: 0.0, resets_at: null, limit_dollars: null, locked_reason: null },
    seven_day: { utilization: 0.0, resets_at: null, limit_dollars: null, locked_reason: null },
    seven_day_opus: null,
  })!;
  assert.equal(claims.byId['5h']?.utilization, 0);
  assert.equal(claims.byId['5h']?.status, 'allowed');
  assert.equal(claims.byId['5h']?.reset, undefined);
  assert.equal(claims.byId['7d']?.utilization, 0);
  assert.equal(claims.byId['7d']?.reset, undefined);
  const headroom = computeHeadroom({ slot: '1', health: 'ok', claims }, 'claude-opus-5', Date.now());
  assert.equal(headroom.headroom, 1, 'an unopened window is fully spendable');
  assert.equal(headroom.weeklyExpiring, false, 'a window that has not opened cannot be expiring');
});

test('a reset-less window is only trusted at zero utilization', () => {
  // The server has never sent "25% used, no window". Admitting the shape would
  // let a malformed response replace a real claim through mergeClaims().
  for (const five_hour of [
    { utilization: 25, resets_at: null },
    { utilization: 100, resets_at: null },
    { utilization: 0.5, resets_at: null },
  ]) {
    assert.equal(claimsFromUsageBody({ five_hour }), undefined);
  }
});

test('an idle reading refreshes the window it observed without erasing the ones it did not', async () => {
  const root = temp();
  const selected = account(root);
  const now = Date.now();
  const fableWeekly = { id: '7d_oi', utilization: 0.95, status: 'allowed_warning', reset: (now + 86_400_000) / 1000 };
  recordObservation(root, '1', {
    byId: {
      '5h': { id: '5h', utilization: 0.8, status: 'allowed', reset: (now - 60_000) / 1000 },
      '7d_oi': fableWeekly,
    },
  }, now - 10);
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      five_hour: { utilization: 0.0, resets_at: null },
      seven_day: { utilization: 0.0, resets_at: null },
    }));
  });
  const probe = new UsageProbe({ upstream: url, stateRoot: root, now: () => now });

  assert.equal(await probe.probe(selected), 'updated');
  const after = readSlotObservation(root, '1')!;
  assert.equal(after.observedAt, now, 'the observation timestamp advances, so nothing reads stale');
  assert.equal(after.claims?.byId['5h']?.utilization, 0);
  assert.equal(after.claims?.byId['5h']?.reset, undefined);
  // `7d_oi` is absent from the usage endpoint's mapped windows, so the
  // server saying nothing about it must not delete what we already knew.
  assert.deepEqual(after.claims?.byId['7d_oi'], fableWeekly);
});

test('invalid utilization or reset does not emit a destructive partial claim', () => {
  for (const five_hour of [
    { utilization: -1, resets_at: '2026-01-01T05:00:00Z' },
    { utilization: 101, resets_at: '2026-01-01T05:00:00Z' },
    { utilization: Number.NaN, resets_at: '2026-01-01T05:00:00Z' },
    { utilization: Number.POSITIVE_INFINITY, resets_at: '2026-01-01T05:00:00Z' },
    { resets_at: '2026-01-01T05:00:00Z' },
    { utilization: 25, resets_at: -1 },
    { utilization: 25, resets_at: 0 },
    { utilization: 25, resets_at: 'not-a-date' },
  ]) {
    assert.equal(claimsFromUsageBody({ five_hour }), undefined);
  }
});

test('invalid endpoint fields cannot erase prior utilization/status or restore full headroom', async () => {
  const root = temp();
  const selected = account(root);
  const now = Date.now();
  recordObservation(root, '1', {
    byId: {
      '5h': {
        id: '5h',
        utilization: 0.99,
        status: 'allowed_warning',
        reset: (now + 60_000) / 1000,
      },
      '7d': {
        id: '7d',
        utilization: 0.99,
        status: 'allowed_warning',
        reset: (now + 60_000) / 1000,
      },
    },
  }, now - 10);
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      five_hour: { utilization: 101, resets_at: new Date(now + 60_000).toISOString() },
      seven_day: { utilization: 25, resets_at: -1 },
    }));
  });
  const probe = new UsageProbe({ upstream: url, stateRoot: root, now: () => now });

  assert.equal(await probe.probe(selected), 'empty');
  const prior = readSlotObservation(root, '1')!;
  assert.equal(prior.claims?.byId['5h']?.utilization, 0.99);
  assert.equal(prior.claims?.byId['5h']?.status, 'allowed_warning');
  assert.equal(prior.claims?.byId['7d']?.utilization, 0.99);
  assert.equal(prior.claims?.byId['7d']?.status, 'allowed_warning');
  const headroom = computeHeadroom({ slot: '1', health: 'ok', claims: prior.claims }, 'claude-opus-5', now).headroom;
  assert.ok(Math.abs(headroom - 0.01) < 1e-9);
});

test('prepare can rotate the credential and GET rereads the refreshed token', async () => {
  const root = temp();
  const selected = account(root);
  let prepareCalls = 0;
  const url = await serve((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer refreshed-token');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ five_hour: { utilization: 33, resets_at: '2026-01-01T05:00:00Z' } }));
  });
  const probe = new UsageProbe({
    upstream: url,
    stateRoot: root,
    now: Date.now,
    prepare: async prepared => {
      prepareCalls += 1;
      assert.equal(prepared.slot, selected.slot);
      writeFileSync(prepared.credentialPath, JSON.stringify({ claudeAiOauth: { accessToken: 'refreshed-token' } }));
    },
  });

  assert.equal(await probe.probe(selected), 'updated');
  assert.equal(prepareCalls, 1);
  assert.equal(readSlotObservation(root, '1')?.claims?.byId['5h']?.utilization, 0.33);
});

test('usage probe uses GET OAuth wire contract, dedupes, and cannot overwrite newer inference headers', async () => {
  const root = temp();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const url = await serve(async (req, res) => {
    calls += 1;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/oauth/usage');
    assert.equal(req.headers.authorization, 'Bearer canonical-token');
    assert.equal(req.headers['anthropic-beta'], 'oauth-2025-04-20');
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ five_hour: { utilization: 80, resets_at: '2026-01-01T05:00:00Z' } }));
  });
  let now = 1000;
  const probe = new UsageProbe({ upstream: url, stateRoot: root, now: () => now, timeoutMs: 1000 });
  const first = probe.probe(account(root));
  const second = probe.probe(account(root));
  await new Promise(resolve => setImmediate(resolve));
  recordObservation(root, '1', { byId: { '5h': { id: '5h', utilization: 0.1 } } }, ++now);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['updated', 'updated']);
  assert.equal(calls, 1);
  assert.equal(readSlotObservation(root, '1')?.claims?.byId['5h']?.utilization, 0.1);
});

test('a slow-drip body cannot extend the absolute probe deadline', async () => {
  const root = temp();
  let calls = 0;
  const url = await serve((_req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 15);
    res.on('close', () => clearInterval(timer));
  });
  const probe = new UsageProbe({ upstream: url, stateRoot: root, now: Date.now, timeoutMs: 80 });
  const started = Date.now();
  assert.equal(await probe.probe(account(root)), 'failed');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 60 && elapsed < 300, `absolute deadline elapsed=${elapsed}ms`);

  const later = new UsageProbe({ upstream: url, stateRoot: root, now: Date.now, timeoutMs: 80 });
  assert.equal(await later.probe(account(root)), 'backoff');
  assert.equal(calls, 1, 'deadline failure persisted backoff');
});

test('only reset windows the conservative probe mapping can refresh become due', () => {
  const root = temp();
  const now = 50_000;
  const probe = new UsageProbe({ upstream: 'http://127.0.0.1', stateRoot: root, now: () => now });
  const observation = (id: '5h' | '7d' | '7d_oi', resetMs: number) => ({
    slot: '1',
    observedAt: now - 1,
    claims: { byId: { [id]: { id, reset: resetMs / 1000 } } },
  });

  assert.equal(probe.isDue(observation('5h', now - 1)), true);
  assert.equal(probe.isDue(observation('7d', now - 1)), true);
  assert.equal(probe.isDue(observation('7d_oi', now - 1)), false);
  assert.equal(probe.isDue(observation('5h', now + 1)), false);
});

test('429 retry-after is persisted and suppresses a later probe instance', async () => {
  const root = temp();
  let calls = 0;
  const url = await serve((_req, res) => {
    calls += 1;
    res.writeHead(429, { 'retry-after': '30' }).end();
  });
  const now = 10_000;
  const first = new UsageProbe({ upstream: url, stateRoot: root, now: () => now });
  assert.equal(await first.probe(account(root)), 'backoff');
  const second = new UsageProbe({ upstream: url, stateRoot: root, now: () => now + 1000 });
  assert.equal(await second.probe(account(root)), 'backoff');
  assert.equal(calls, 1);
  const state = JSON.parse(readFileSync(path.join(root, 'state', 'usage-probe', '1.json'), 'utf8')) as { retryAt: number };
  assert.equal(state.retryAt, now + 30_000);
});

// Shape captured 2026-09-22 from a live Max account's /api/oauth/profile.
const profileBody = (tier: string) => JSON.stringify({
  account: { has_claude_max: true, has_claude_pro: false },
  organization: { organization_type: 'claude_max', rate_limit_tier: tier, subscription_status: 'active' },
});

test('the plan probe reads the tier over the OAuth wire contract and sizes the account', async () => {
  const root = temp();
  const url = await serve((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/oauth/profile');
    assert.equal(req.headers.authorization, 'Bearer canonical-token');
    assert.equal(req.headers['anthropic-beta'], 'oauth-2025-04-20');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(profileBody('default_claude_max_5x'));
  });
  let now = 1_000_000;
  const probe = new UsageProbe({ upstream: url, stateRoot: root, now: () => now });
  const selected = account(root);

  assert.equal(probe.isPlanDue('1'), true, 'an unread plan is due');
  assert.equal(await probe.probePlan(selected), 'updated');
  assert.deepEqual(readSlotPlan(root, '1'), { tier: 'default_claude_max_5x', observedAt: now });
  assert.equal(probe.isPlanDue('1'), false);
  now += PLAN_PROBE_STALE_MS;
  assert.equal(probe.isPlanDue('1'), true, 'a day-old plan is re-read');

  // The policy input the router builds carries the plan read off the wire.
  const authswap = path.join(root, 'authswap');
  const dir = path.join(authswap, 'providers', 'anthropic', 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials-1-a@example.com.json'), readFileSync(selected.credentialPath));
  const { states } = loadAccountStates({ stateRoot: root, authswapRoot: authswap, nowMs: now, weeklyReserves: new Map() });
  assert.deepEqual(states[0]?.capacity, { fiveHour: 0.25, weekly: 1 / 1.7 });
});

test('a failed or malformed plan read keeps the prior plan', async () => {
  const root = temp();
  const replies: [number, string][] = [
    [500, '{}'],
    [200, '{"organization":{}}'],
    [200, 'not json'],
  ];
  const url = await serve((_req, res) => {
    const [status, body] = replies.shift()!;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  writeSlotPlan(root, '1', { tier: 'default_claude_max_5x', observedAt: 1 });
  const probe = new UsageProbe({ upstream: url, stateRoot: root, now: Date.now });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await probe.probePlan(account(root)), 'failed');
    assert.deepEqual(readSlotPlan(root, '1'), { tier: 'default_claude_max_5x', observedAt: 1 });
  }
});
