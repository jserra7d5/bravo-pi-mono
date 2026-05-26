import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { MonitorScheduler } from '../src/scheduler/scheduler.js';
import { MonitorStatusService } from '../src/runtime/status.js';
import { buildStartTool } from '../src/tools/index.js';
import { StreamMonitorManager } from '../src/stream/stream-manager.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const store = new JsonlMonitorStore(dir);
  return { dir, store };
}

function fakeCtx(session = '/tmp/pi-session-a.json') {
  return { sessionManager: { getSessionFile: () => session }, actor_id: 'test' };
}

test('scheduler skips command monitors', async () => {
  const { dir, store } = tmpStore();
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const startTool = buildStartTool({} as any, store, undefined, streams);
    const started = await (startTool as any).execute('tc-cmd', { name: 'cmd', check: { type: 'command', command: 'exec sleep 1' }, schedule: {} }, undefined, undefined, fakeCtx());
    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 200, leaseTtlMs: 5000 });
    scheduler.start(fakeCtx());
    await scheduler.tick('timer');
    await scheduler.stop();
    await streams.stopAll(1000);
    const monitor = await store.get(started.details.monitor_id);
    assert.notEqual(monitor?.state, 'failed');
    assert.equal(monitor?.next_run_at, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

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
    scheduler.start(fakeCtx());

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
    scheduler.start(fakeCtx());
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
    scheduler.start({ ...fakeCtx(), ui: { notify: () => {}, setStatus: () => {} } });
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
    const count = await status.backfillPending(fakeCtx());
    assert.equal(count, 1);
    assert.equal(sent.length, 1);
    const results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results[0]!.attention_delivery?.wake_delivered, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('scheduler does not claim or wake monitors owned by a different session', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any;
  try {
    const startTool = buildStartTool(pi, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'foreign-session',
      check: { type: 'timer' },
      schedule: {},
      attention: { wake_agent: true, notify: false, message: 'do not wake wrong session' },
    }, undefined, undefined, fakeCtx('/tmp/pi-session-a.json'));

    const status = new MonitorStatusService(store, pi);
    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 }, status);
    scheduler.start(fakeCtx('/tmp/pi-session-b.json'));
    await new Promise((r) => setTimeout(r, 150));
    await scheduler.stop();

    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.run_count, 0);
    assert.equal(sent.length, 0);
    const results = await store.listResults(started.details.monitor_id, { limit: 10 });
    assert.equal(results.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('status service does not backfill wake attention owned by a different session', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any;
  try {
    const startTool = buildStartTool(pi, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'foreign-backfill',
      check: { type: 'timer' },
      schedule: { delay_ms: 1000 },
      attention: { wake_agent: true, notify: false, message: 'do not backfill wrong session' },
    }, undefined, undefined, fakeCtx('/tmp/pi-session-a.json'));
    await store.appendResult({
      result_id: 'r-foreign-backfill',
      monitor_id: started.details.monitor_id,
      status: 'matched',
      condition_matched: true,
      triggered: true,
      created_at: new Date().toISOString(),
      attention_delivery: { message: 'do not backfill wrong session', severity: 'warning', notify_attempted: false, notify_delivered: false, wake_attempted: true, wake_delivered: false },
    });

    const status = new MonitorStatusService(store, pi);
    const count = await status.backfillPending(fakeCtx('/tmp/pi-session-b.json'));
    assert.equal(count, 0);
    assert.equal(sent.length, 0);
    const results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results[0]!.attention_delivery?.wake_delivered, false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('scheduler aborts stale claimed run when monitor was stopped', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'stale-stop',
      check: { type: 'timer' },
      schedule: {},
    }, undefined, undefined, fakeCtx());

    const claimed = await store.claimDue(new Date(Date.now() + 10), { lease_id: 'ignored', ttl_ms: 5000 });
    assert.equal(claimed.length, 1);
    await store.update(started.details.monitor_id, undefined, { state: 'stopped', next_run_at: undefined, lease_id: undefined, lease_expires_at: undefined });

    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 200, leaseTtlMs: 5000 });
    await (scheduler as any).runOne(claimed[0]);

    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.state, 'stopped');
    assert.equal(m!.run_count, 0);
    const results = await store.listResults(started.details.monitor_id, { limit: 10 });
    assert.equal(results.length, 0);
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
    scheduler.start(fakeCtx());
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

test('backfill retries only missing wake and preserves prior notify delivery', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const notified: any[] = [];
  try {
    const startTool = buildStartTool({ sendMessage: (m: any, o: any) => sent.push({ m, o }) } as any, store);
    const started = await (startTool as any).execute('tc-preserve-notify', {
      name: 'preserve-notify', check: { type: 'timer' }, schedule: { delay_ms: 1000 }, attention: { wake_agent: true, notify: true, message: 'retry wake only' },
    }, undefined, undefined, fakeCtx());
    await store.appendResult({ result_id: 'r-preserve-notify', monitor_id: started.details.monitor_id, status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString(), attention_delivery: { message: 'retry wake only', severity: 'warning', notify_attempted: true, notify_delivered: true, wake_attempted: true, wake_delivered: false, wake_error: 'old', delivered_at: '2024-01-01T00:00:00.000Z' } });

    const count = await new MonitorStatusService(store, { sendMessage: (m: any, o: any) => sent.push({ m, o }) } as any).backfillPending({ ...fakeCtx(), ui: { notify: (...args: any[]) => notified.push(args) } });
    assert.equal(count, 1);
    assert.equal(notified.length, 0);
    assert.equal(sent.length, 1);
    const [result] = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(result!.attention_delivery?.notify_delivered, true);
    assert.equal(result!.attention_delivery?.wake_delivered, true);
    assert.equal(result!.attention_delivery?.delivered_at, '2024-01-01T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('backfill retries only missing notify and preserves prior wake delivery', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const notified: any[] = [];
  try {
    const startTool = buildStartTool({ sendMessage: (m: any, o: any) => sent.push({ m, o }) } as any, store);
    const started = await (startTool as any).execute('tc-preserve-wake', {
      name: 'preserve-wake', check: { type: 'timer' }, schedule: { delay_ms: 1000 }, attention: { wake_agent: true, notify: true, message: 'retry notify only' },
    }, undefined, undefined, fakeCtx());
    await store.appendResult({ result_id: 'r-preserve-wake', monitor_id: started.details.monitor_id, status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString(), attention_delivery: { message: 'retry notify only', severity: 'warning', notify_attempted: true, notify_delivered: false, notify_error: 'old', wake_attempted: true, wake_delivered: true, delivered_at: '2024-01-02T00:00:00.000Z' } });

    const count = await new MonitorStatusService(store, { sendMessage: (m: any, o: any) => sent.push({ m, o }) } as any).backfillPending({ ...fakeCtx(), ui: { notify: (...args: any[]) => notified.push(args) } });
    assert.equal(count, 1);
    assert.equal(notified.length, 1);
    assert.equal(sent.length, 0);
    const [result] = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(result!.attention_delivery?.notify_delivered, true);
    assert.equal(result!.attention_delivery?.wake_delivered, true);
    assert.equal(result!.attention_delivery?.delivered_at, '2024-01-02T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('notify exception does not throttle future retry', async () => {
  const { dir, store } = tmpStore();
  const notified: any[] = [];
  try {
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc-notify-throw', { name: 'notify-throw', check: { type: 'timer' }, schedule: { delay_ms: 1000 }, attention: { notify: true, wake_agent: false, throttle_ms: 60000 } }, undefined, undefined, fakeCtx());
    const monitor = (await store.get(started.details.monitor_id))!;
    const result: any = { result_id: 'r-notify-throw', monitor_id: monitor.monitor_id, status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString() };
    const status = new MonitorStatusService(store, {} as any);
    const first = await status.deliverAttention(monitor, result, { ...fakeCtx(), ui: { notify: () => { throw new Error('boom'); } } });
    assert.equal(first.notify_delivered, false);
    assert.equal(first.notify_error, 'boom');
    const second = await status.deliverAttention(monitor, result, { ...fakeCtx(), ui: { notify: (...args: any[]) => notified.push(args) } });
    assert.equal(second.notify_delivered, true);
    assert.equal(second.notify_error, undefined);
    assert.equal(notified.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
