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
    check: { type: 'timer' as const },
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
    await store.create({ ...sampleRecord('m2'), state: 'paused' });
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
    const updated = await store.update('m1', 1, { state: 'paused' });
    assert.equal(updated.version, 2);
    assert.equal(updated.state, 'paused');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('update with wrong expected version throws', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create(sampleRecord('m1'));
    await assert.rejects(() => store.update('m1', 99, { state: 'paused' }), /Conflict/);
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

test('ack by monitor_id persists', async () => {
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
    const acked = await store.ackResults({ monitor_id: 'm1' });
    assert.equal(acked, 1);
    const store2 = new JsonlMonitorStore(dir);
    const results = await store2.listResults('m1', { acked: true });
    assert.equal(results.length, 1);
    assert.ok(results[0].acked_at);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('ack by result_id persists', async () => {
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
    const acked = await store.ackResults({ result_id: 'r1' });
    assert.equal(acked, 1);
    const store2 = new JsonlMonitorStore(dir);
    const results = await store2.listResults('m1', { acked: true });
    assert.equal(results.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('ack all persists', async () => {
  const { dir, store } = tmpStore();
  try {
    await store.create(sampleRecord('m1'));
    await store.create({ ...sampleRecord('m2'), monitor_id: 'm2' });
    await store.appendResult({ result_id: 'r1', monitor_id: 'm1', status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString() });
    await store.appendResult({ result_id: 'r2', monitor_id: 'm2', status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString() });
    const acked = await store.ackResults({ all: true });
    assert.equal(acked, 2);
    const store2 = new JsonlMonitorStore(dir);
    const r1 = await store2.listResults('m1', { acked: true });
    const r2 = await store2.listResults('m2', { acked: true });
    assert.equal(r1.length, 1);
    assert.equal(r2.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
