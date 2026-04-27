import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { MonitorScheduler } from '../src/scheduler/scheduler.js';
import { MonitorStatusService } from '../src/runtime/status.js';
import { buildStartTool } from '../src/tools/index.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const store = new JsonlMonitorStore(dir);
  return { dir, store };
}

function fakeCtx() {
  return { sessionManager: { getSessionFile: () => '' }, actor_id: 'test' };
}

test('scheduler tick triggers timer monitor', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'tick-test',
      check: { type: 'timer' },
      schedule: { delay_ms: 1000 },
    }, undefined, undefined, fakeCtx());

    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 200, leaseTtlMs: 5000 });
    scheduler.start();

    // Wait for tick
    await new Promise((r) => setTimeout(r, 800));
    await scheduler.tick('timer');
    await new Promise((r) => setTimeout(r, 400));

    const m = await store.get(started.details.monitor_id);
    assert.ok(m);
    // Should have run and been triggered (timer always triggers)
    assert.ok(m!.run_count >= 1, `expected run_count >= 1, got ${m!.run_count}`);

    await scheduler.stop();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('scheduler file monitor triggers when file exists', async () => {
  const { dir, store } = tmpStore();
  const filePath = join(dir, 'watch.txt');
  try {
    writeFileSync(filePath, 'hello');
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'file-test',
      check: { type: 'file', path: filePath, mode: 'exists' },
      schedule: { delay_ms: 1000 },
    }, undefined, undefined, fakeCtx());

    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 200, leaseTtlMs: 5000 });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 800));
    await scheduler.tick('timer');
    await new Promise((r) => setTimeout(r, 400));

    const m = await store.get(started.details.monitor_id);
    assert.ok(m);
    assert.ok(m!.run_count >= 1, `expected run_count >= 1, got ${m!.run_count}`);
    // File exists so it should be triggered
    assert.equal(m!.state, 'triggered');

    await scheduler.stop();
  } finally {
    try { unlinkSync(filePath); } catch {}
    rmSync(dir, { recursive: true });
  }
});

test('scheduler persists wake delivery state for triggered monitors', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any;
  try {
    const startTool = buildStartTool(pi, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'wake-test',
      check: { type: 'timer' },
      schedule: {},
      attention: { notify: true, wake_agent: true, message: 'wake me' },
    }, undefined, undefined, { ...fakeCtx(), ui: { notify: () => {} } });

    const status = new MonitorStatusService(store, pi);
    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 }, status);
    scheduler.start({ ui: { notify: () => {}, setStatus: () => {} } });
    await new Promise((r) => setTimeout(r, 150));
    await scheduler.stop();

    const results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.attention_delivery?.wake_attempted, true);
    assert.equal(results[0]!.attention_delivery?.wake_delivered, true);
    assert.equal(results[0]!.attention_delivery?.notify_delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.triggerTurn, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('status service backfills undelivered wake attention', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any;
  try {
    const startTool = buildStartTool(pi, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'backfill-test',
      check: { type: 'timer' },
      schedule: { delay_ms: 1000 },
      attention: { wake_agent: true, notify: false, message: 'backfill me' },
    }, undefined, undefined, fakeCtx());
    await store.appendResult({
      result_id: 'r-backfill',
      monitor_id: started.details.monitor_id,
      status: 'matched',
      condition_matched: true,
      triggered: true,
      created_at: new Date().toISOString(),
      attention_delivery: { message: 'backfill me', severity: 'warning', notify_attempted: false, notify_delivered: false, wake_attempted: true, wake_delivered: false, wake_error: 'pi.sendMessage unavailable' },
    });

    const status = new MonitorStatusService(store, pi);
    const count = await status.backfillPending({});
    assert.equal(count, 1);
    assert.equal(sent.length, 1);
    const results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results[0]!.attention_delivery?.wake_delivered, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('paused monitor does not run', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'paused-test',
      check: { type: 'timer' },
      schedule: { delay_ms: 1000 },
    }, undefined, undefined, fakeCtx());

    await store.update(started.details.monitor_id, undefined, { state: 'paused' });

    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 200, leaseTtlMs: 5000 });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 800));
    await scheduler.tick('timer');
    await new Promise((r) => setTimeout(r, 400));

    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.run_count, 0);

    await scheduler.stop();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
