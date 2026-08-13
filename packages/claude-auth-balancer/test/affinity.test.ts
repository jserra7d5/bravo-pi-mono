import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { AffinityStore, DEFAULT_LEASE_TTL_MS } from '../src/affinity.js';

const roots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cab-affinity-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test('a session sticks to its slot across requests', () => {
  const store = new AffinityStore({ stateRoot: tmpRoot() });
  assert.equal(store.lookup('sess-a'), undefined);
  store.touch('sess-a', '2');
  assert.equal(store.lookup('sess-a'), '2');
  assert.equal(store.lookup('sess-b'), undefined, 'other sessions are unaffected');
});

test('the lease slides forward on every request so an active session never lapses', () => {
  let now = 1_000_000;
  const store = new AffinityStore({ stateRoot: tmpRoot(), now: () => now });
  const first = store.touch('sess', '1');

  now += DEFAULT_LEASE_TTL_MS - 1000;
  assert.equal(store.lookup('sess'), '1', 'still inside the window');
  const second = store.touch('sess', '1');
  assert.ok(second.expires_at > first.expires_at, 'expiry moved forward');
  assert.equal(second.created_at, first.created_at, 'same lease, not a new one');

  now += DEFAULT_LEASE_TTL_MS - 1000;
  assert.equal(store.lookup('sess'), '1', 'the slide kept it alive');
});

test('an idle session past the cache TTL loses affinity, which is the free rebalance point', () => {
  let now = 1_000_000;
  const store = new AffinityStore({ stateRoot: tmpRoot(), now: () => now });
  store.touch('sess', '1');
  now += DEFAULT_LEASE_TTL_MS + 1;
  assert.equal(store.lookup('sess'), undefined, 'cache is gone, so the pin is worthless');
});

test('moving a session to a new slot starts a new lease', () => {
  let now = 1_000_000;
  const store = new AffinityStore({ stateRoot: tmpRoot(), now: () => now });
  const first = store.touch('sess', '1');
  now += 5_000;
  const moved = store.touch('sess', '2');
  assert.equal(moved.slot, '2');
  assert.notEqual(moved.created_at, first.created_at);
  assert.equal(store.lookup('sess'), '2');
});

test('session ids are not written to disk in the clear', () => {
  const root = tmpRoot();
  const store = new AffinityStore({ stateRoot: root });
  const sessionId = '6b1dd77c-2564-4838-a9c2-a0048da88e6e';
  store.touch(sessionId, '1');
  const dir = path.join(root, 'leases', 'affinity');
  const names = readdirSync(dir);
  assert.equal(names.length, 1);
  assert.ok(!names[0]!.includes(sessionId), 'filename is a hash');
  for (const name of names) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!text.includes(sessionId), 'lease body carries no raw session id');
  }
});

test('expired leases are swept, unlike the Codex balancer which never unlinked them', () => {
  let now = 1_000_000;
  const root = tmpRoot();
  const store = new AffinityStore({ stateRoot: root, now: () => now, sweepIntervalMs: 0 });
  for (let i = 0; i < 25; i += 1) store.touch(`sess-${i}`, '1');
  const dir = path.join(root, 'leases', 'affinity');
  assert.equal(readdirSync(dir).length, 25);

  now += DEFAULT_LEASE_TTL_MS + 1;
  const removed = store.maybeSweep(true);
  assert.equal(removed, 25);
  assert.equal(readdirSync(dir).length, 0, 'no lease files leak');
});

test('live leases survive a sweep', () => {
  let now = 1_000_000;
  const root = tmpRoot();
  const store = new AffinityStore({ stateRoot: root, now: () => now, sweepIntervalMs: 0 });
  store.touch('old', '1');
  now += DEFAULT_LEASE_TTL_MS + 1;
  store.touch('new', '2');
  assert.equal(store.maybeSweep(true), 1);
  assert.equal(store.lookup('new'), '2');
  assert.equal(store.list().length, 1);
});

test('the sweep is rate-limited so it does not run on every request', () => {
  // Short lease, long sweep interval, so a lease can expire *between* sweeps.
  let now = 1_000_000;
  const root = tmpRoot();
  const store = new AffinityStore({
    stateRoot: root,
    now: () => now,
    ttlMs: 1_000,
    sweepIntervalMs: 300_000,
  });
  const dir = path.join(root, 'leases', 'affinity');

  store.touch('a', '1');
  now += 2_000; // 'a' has expired
  store.lookup('a'); // first lookup ever -> sweep runs
  assert.equal(readdirSync(dir).length, 0, 'the first sweep collected it');

  store.touch('b', '1');
  now += 2_000; // 'b' expired, but only 2s since the last sweep
  assert.equal(store.lookup('b'), undefined, 'an expired lease is never handed out');
  assert.equal(readdirSync(dir).length, 1, 'expired but not yet swept — sweeping is amortized');

  now += 300_000;
  store.lookup('b');
  assert.equal(readdirSync(dir).length, 0, 'collected on the next eligible sweep');
});

test('a corrupt lease file is treated as absent and removed, not fatal', () => {
  const root = tmpRoot();
  const store = new AffinityStore({ stateRoot: root, sweepIntervalMs: 0 });
  store.touch('sess', '1');
  const dir = path.join(root, 'leases', 'affinity');
  const file = path.join(dir, readdirSync(dir)[0]!);
  writeFileSync(file, '{ this is not json');
  assert.equal(store.lookup('sess'), undefined);
  assert.doesNotThrow(() => store.maybeSweep(true));
  assert.equal(readdirSync(dir).length, 0);
});
