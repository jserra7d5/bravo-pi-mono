import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function fakeCtx(session = '/tmp/pi-session-a.json') {
  return { sessionManager: { getSessionFile: () => session }, actor_id: 'test' };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await predicate(), true);
}

test('scheduler file monitor triggers when v2 file condition matches and persists output', async () => {
  const { dir, store } = tmpStore();
  const filePath = join(dir, 'watch.txt');
  try {
    process.env.PI_MONITOR_HOME = dir;
    writeFileSync(filePath, 'hello');
    const started = await (buildStartTool({} as any, store) as any).execute('tc-file', { kind: 'file', name: 'file-test', path: filePath, file_mode: 'exists', interval_s: 5 }, undefined, undefined, fakeCtx());
    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 });
    scheduler.start(fakeCtx());
    await waitFor(async () => (await store.get(started.details.monitor_id))?.run_count === 1);
    await scheduler.stop();

    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.state, 'triggered');
    assert.equal(m!.run_count, 1);
    assert.ok(existsSync(started.details.output_path));
    assert.match(readFileSync(started.details.output_path, 'utf8'), /status=matched/);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('scheduler runs v2 poll monitor and keeps it running after state-change event', async () => {
  const { dir, store } = tmpStore();
  const stateFile = join(dir, 'state.txt');
  const sent: any[] = [];
  let scheduler: MonitorScheduler | undefined;
  try {
    process.env.PI_MONITOR_HOME = dir;
    writeFileSync(stateFile, 'one');
    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const started = await (buildStartTool({} as any, store, status) as any).execute('tc-poll', { kind: 'poll', name: 'poll-test', command: `cat ${JSON.stringify(stateFile)}`, interval_s: 5, wake: 'on_event' }, undefined, undefined, fakeCtx());
    scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 }, status);
    scheduler.start(fakeCtx());
    await waitFor(async () => (await store.get(started.details.monitor_id))?.run_count === 1);

    let m = await store.get(started.details.monitor_id);
    assert.equal(m!.state, 'running');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.customType, 'monitor-event');
    assert.equal(sent[0].message.details.kind, 'poll');
    assert.equal(sent[0].message.details.event_type, 'event');

    writeFileSync(stateFile, 'two');
    await store.update(started.details.monitor_id, undefined, { next_run_at: new Date().toISOString() });
    await waitFor(async () => (await store.get(started.details.monitor_id))?.run_count === 2);
    m = await store.get(started.details.monitor_id);
    assert.equal(m!.state, 'running');
  } finally {
    await scheduler?.stop();
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('v2 poll monitor failure enters failed state and wakes with failed envelope', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  let scheduler: MonitorScheduler | undefined;
  try {
    process.env.PI_MONITOR_HOME = dir;
    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const started = await (buildStartTool({} as any, store, status) as any).execute('tc-poll-fail', { kind: 'poll', name: 'poll-fail', command: 'exit 7', interval_s: 5, wake: 'on_event' }, undefined, undefined, fakeCtx());
    scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 }, status);
    scheduler.start(fakeCtx());
    await waitFor(async () => (await store.get(started.details.monitor_id))?.state === 'failed');

    const failed = sent.find((e) => String(e.message.content).startsWith('[MONITOR FAILED — NOT USER INPUT]'));
    assert.ok(failed);
    assert.equal(failed.message.customType, 'monitor-event');
    assert.equal(failed.message.details.kind, 'poll');
    assert.equal(failed.message.details.event_type, 'failed');
  } finally {
    await scheduler?.stop();
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('scheduler does not claim or wake monitors owned by a different session', async () => {
  const { dir, store } = tmpStore();
  const filePath = join(dir, 'watch.txt');
  const sent: any[] = [];
  try {
    process.env.PI_MONITOR_HOME = dir;
    writeFileSync(filePath, 'hello');
    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const started = await (buildStartTool({} as any, store, status) as any).execute('tc-foreign', { kind: 'file', name: 'foreign', path: filePath, file_mode: 'exists', interval_s: 5, wake: 'on_event' }, undefined, undefined, fakeCtx('/tmp/a.json'));
    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 }, status);
    scheduler.start(fakeCtx('/tmp/b.json'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await scheduler.stop();

    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.run_count, 0);
    assert.equal(sent.length, 0);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('status service does not backfill wake attention owned by a different session', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const filePath = join(dir, 'watch.txt');
  try {
    process.env.PI_MONITOR_HOME = dir;
    const started = await (buildStartTool({} as any, store) as any).execute('tc-backfill-foreign', { kind: 'file', name: 'foreign-backfill', path: filePath, file_mode: 'exists', interval_s: 5, wake: 'on_event' }, undefined, undefined, fakeCtx('/tmp/a.json'));
    await store.appendResult({
      result_id: 'r-foreign-backfill',
      monitor_id: started.details.monitor_id,
      status: 'matched',
      condition_matched: true,
      triggered: true,
      created_at: new Date().toISOString(),
      attention_delivery: { message: 'do not backfill wrong session', severity: 'warning', notify_attempted: false, notify_delivered: false, wake_attempted: true, wake_delivered: false },
    });

    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const count = await status.backfillPending(fakeCtx('/tmp/b.json'));
    assert.equal(count, 0);
    assert.equal(sent.length, 0);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('stale claimed poll command is not executed after stop', async () => {
  const { dir, store } = tmpStore();
  const sideEffect = join(dir, 'side-effect.txt');
  try {
    process.env.PI_MONITOR_HOME = dir;
    const started = await (buildStartTool({} as any, store) as any).execute('tc-stale-command', { kind: 'poll', name: 'stale-command', command: `printf executed > ${JSON.stringify(sideEffect)}`, interval_s: 5, wake: 'never' }, undefined, undefined, fakeCtx());
    const claimed = await store.claimDue(new Date(Date.now() + 10), { lease_id: 'ignored', ttl_ms: 5000 });
    assert.equal(claimed.length, 1);
    await store.update(started.details.monitor_id, undefined, { state: 'stopped', next_run_at: undefined, lease_id: undefined, lease_expires_at: undefined });

    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 });
    await (scheduler as any).runOne(claimed[0]);

    assert.equal(existsSync(sideEffect), false);
    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.state, 'stopped');
    assert.equal(m!.run_count, 0);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('backfill does not wake stopped monitors', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const filePath = join(dir, 'watch.txt');
  try {
    process.env.PI_MONITOR_HOME = dir;
    const started = await (buildStartTool({} as any, store) as any).execute('tc-backfill-stopped', { kind: 'file', name: 'stopped-backfill', path: filePath, file_mode: 'exists', interval_s: 5, wake: 'on_event' }, undefined, undefined, fakeCtx());
    await store.update(started.details.monitor_id, undefined, { state: 'stopped', next_run_at: undefined });
    await store.appendResult({
      result_id: 'r-stopped-backfill',
      monitor_id: started.details.monitor_id,
      status: 'matched',
      condition_matched: true,
      triggered: true,
      created_at: new Date().toISOString(),
      attention_delivery: { message: 'do not backfill stopped', severity: 'warning', notify_attempted: false, notify_delivered: false, wake_attempted: true, wake_delivered: false },
    });

    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const count = await status.backfillPending(fakeCtx());
    assert.equal(count, 0);
    assert.equal(sent.length, 0);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('scheduler aborts stale claimed v2 run when monitor was stopped', async () => {
  const { dir, store } = tmpStore();
  const filePath = join(dir, 'watch.txt');
  try {
    process.env.PI_MONITOR_HOME = dir;
    writeFileSync(filePath, 'hello');
    const started = await (buildStartTool({} as any, store) as any).execute('tc-stale', { kind: 'file', name: 'stale-stop', path: filePath, file_mode: 'exists', interval_s: 5 }, undefined, undefined, fakeCtx());
    const claimed = await store.claimDue(new Date(Date.now() + 10), { lease_id: 'ignored', ttl_ms: 5000 });
    assert.equal(claimed.length, 1);
    await store.update(started.details.monitor_id, undefined, { state: 'stopped', next_run_at: undefined, lease_id: undefined, lease_expires_at: undefined });

    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 });
    await (scheduler as any).runOne(claimed[0]);

    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.state, 'stopped');
    assert.equal(m!.run_count, 0);
    const results = await store.listResults(started.details.monitor_id, { limit: 10 });
    assert.equal(results.length, 0);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('scheduler aborts stale claim when monitor is stopped but same lease remains', async () => {
  const { dir, store } = tmpStore();
  const filePath = join(dir, 'watch.txt');
  const sent: any[] = [];
  try {
    process.env.PI_MONITOR_HOME = dir;
    writeFileSync(filePath, 'hello');
    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const started = await (buildStartTool({} as any, store, status) as any).execute('tc-stale-same-lease', { kind: 'file', name: 'same-lease-stop', path: filePath, file_mode: 'exists', interval_s: 5, wake: 'on_event' }, undefined, undefined, fakeCtx());
    const claimed = await store.claimDue(new Date(Date.now() + 10), { lease_id: 'ignored', ttl_ms: 5000 });
    assert.equal(claimed.length, 1);
    await store.update(started.details.monitor_id, undefined, { state: 'stopped', next_run_at: undefined });

    const scheduler = new MonitorScheduler(store, { tickIntervalMs: 50, leaseTtlMs: 5000 }, status);
    await (scheduler as any).runOne(claimed[0]);

    const m = await store.get(started.details.monitor_id);
    assert.equal(m!.state, 'stopped');
    assert.equal(m!.lease_id, claimed[0].lease_id);
    assert.equal(m!.run_count, 0);
    assert.equal(sent.length, 0);
    const results = await store.listResults(started.details.monitor_id, { limit: 10 });
    assert.equal(results.length, 0);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});
