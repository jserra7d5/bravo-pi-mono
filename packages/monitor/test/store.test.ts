import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { generateMonitorId } from '../src/ids.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const store = new JsonlMonitorStore(dir);
  return { dir, store };
}

function sampleRecord(id: string): any {
  return {
    monitor_id: id,
    version: 1,
    owner: { actor_id: 'test', actor_type: 'system' as const },
    scope: 'session' as const,
    state: 'running' as const,
    check: { type: 'file' as const, path: '/tmp/monitor-store-test', mode: 'exists' as const },
    schedule: { interval_ms: 5000 },
    attention: { notify: true, wake_agent: false, throttle_ms: 30000 },
    retention: { max_results: 10, max_events: 10 },
    labels: {},
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    failure_count: 0,
    consecutive_failure_count: 0,
    run_count: 0,
  };
}

test('create and get', async () => {
  const { dir, store } = tmpStore();
  try {
    const rec = sampleRecord('m1');
    await store.create(rec);
    const got = await store.get('m1');
    assert.equal(got?.monitor_id, 'm1');
    assert.equal(got?.state, 'running');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('list filters by state', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create({ ...sampleRecord('m1'), state: 'running' });
    await store.create({ ...sampleRecord('m2'), state: 'failed' });
    const running = await store.list({ states: ['running'] });
    assert.equal(running.length, 1);
    assert.equal(running[0].monitor_id, 'm1');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('update increments version', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create(sampleRecord('m1'));
    const updated = await store.update('m1', 1, { state: 'failed' });
    assert.equal(updated.version, 2);
    assert.equal(updated.state, 'failed');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('update with wrong expected version throws', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create(sampleRecord('m1'));
    await assert.rejects(() => store.update('m1', 99, { state: 'failed' }), /Conflict/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('update blocks terminal stopped monitor resurrection but permits cleanup and archive', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create({ ...sampleRecord('m1'), state: 'stopped', lease_id: 'lease-1', lease_expires_at: new Date(Date.now() + 10000).toISOString() });
    for (const state of ['running', 'triggered', 'failed', 'completed'] as const) {
      await assert.rejects(() => store.update('m1', undefined, { state }), /Conflict/);
      assert.equal((await store.get('m1'))?.state, 'stopped');
    }

    const cleaned = await store.update('m1', undefined, { state: 'stopped', lease_id: undefined, lease_expires_at: undefined, next_run_at: undefined });
    assert.equal(cleaned.state, 'stopped');
    assert.equal(cleaned.lease_id, undefined);

    const archived = await store.update('m1', undefined, { state: 'archived' });
    assert.equal(archived.state, 'archived');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('results append and list', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create(sampleRecord('m1'));
    await store.appendResult({
      result_id: 'r1',
      monitor_id: 'm1',
      status: 'matched',
      condition_matched: true,
      triggered: true,
      created_at: new Date().toISOString(),
    });
    const results = await store.listResults('m1', {});
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'matched');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('claimDue returns running monitors with past next_run_at', async () => {
  const { dir, store } = tmpStore();
  try {
    const rec = sampleRecord('m1');
    rec.next_run_at = new Date(Date.now() - 1000).toISOString();
    await store.create(rec);
    const claimed = await store.claimDue(new Date(), { lease_id: 'l1', ttl_ms: 30000 });
    assert.equal(claimed.length, 1);
    assert.ok(claimed[0].lease_id);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('releaseLease clears lease and sets next_run_at', async () => {
  const { dir, store } = tmpStore();
  try {
    const rec = sampleRecord('m1');
    rec.next_run_at = new Date(Date.now() - 1000).toISOString();
    await store.create(rec);
    const claimed = await store.claimDue(new Date(), { lease_id: 'l1', ttl_ms: 30000 });
    const leaseId = claimed[0].lease_id!;
    const next = new Date(Date.now() + 5000).toISOString();
    await store.releaseLease('m1', leaseId, next);
    const got = await store.get('m1');
    assert.equal(got?.lease_id, undefined);
    assert.equal(got?.next_run_at, next);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('appendEvent records stale events without moving stopped monitor to triggered or failed', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create({ ...sampleRecord('m1'), state: 'stopped' });
    await store.appendEvent({ event_id: 'e-triggered', monitor_id: 'm1', type: 'triggered', created_at: new Date().toISOString() });
    let got = await store.get('m1');
    assert.equal(got?.state, 'stopped');
    await store.appendEvent({ event_id: 'e-failed', monitor_id: 'm1', type: 'failed', created_at: new Date().toISOString() });
    got = await store.get('m1');
    assert.equal(got?.state, 'stopped');
    const events = await store.listEvents({ monitor_id: 'm1' });
    assert.equal(events.filter((e) => e.type === 'triggered' || e.type === 'failed').length, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('prune archives old terminal monitors', async () => {
  const { dir, store } = tmpStore();
  try {
    const rec = sampleRecord('m1');
    rec.state = 'stopped';
    rec.updated_at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await store.create(rec);
    const summary = await store.prune(new Date());
    assert.equal(summary.monitors_archived, 1);
    const got = await store.get('m1');
    assert.equal(got?.state, 'archived');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('results persist across restart', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create(sampleRecord('m1'));
    await store.appendResult({
      result_id: 'r1',
      monitor_id: 'm1',
      status: 'matched',
      condition_matched: true,
      triggered: true,
      created_at: new Date().toISOString(),
    });
    const store2 = new JsonlMonitorStore(dir);
    const results = await store2.listResults('m1', {});
    assert.equal(results.length, 1);
    assert.equal(results[0].result_id, 'r1');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
