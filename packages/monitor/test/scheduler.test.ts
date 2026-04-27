import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { MonitorScheduler } from '../src/scheduler/scheduler.js';
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
