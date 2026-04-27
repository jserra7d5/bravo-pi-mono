import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { buildStartTool, buildStopTool, buildListTool, buildLookTool } from '../src/tools/index.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const store = new JsonlMonitorStore(dir);
  return { dir, store };
}

function fakeCtx() {
  return { sessionManager: { getSessionFile: () => '' }, actor_id: 'test' };
}

test('monitor_start creates a timer monitor', async () => {
  const { dir, store } = tmpStore();
  try {
    const tool = buildStartTool({} as any, store);
    const res = await (tool as any).execute('tc1', {
      name: 'test-timer',
      check: { type: 'timer' },
      schedule: { delay_ms: 5000 },
    }, undefined, undefined, fakeCtx());
    assert.ok(res.details.monitor_id);
    assert.equal(res.details.state, 'running');
    const got = await store.get(res.details.monitor_id);
    assert.equal(got?.name, 'test-timer');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_start creates a file monitor', async () => {
  const { dir, store } = tmpStore();
  try {
    const tool = buildStartTool({} as any, store);
    const res = await (tool as any).execute('tc1', {
      name: 'test-file',
      check: { type: 'file', path: '/tmp/test', mode: 'exists' },
      schedule: { interval_ms: 10000 },
    }, undefined, undefined, fakeCtx());
    assert.ok(res.details.monitor_id);
    const got = await store.get(res.details.monitor_id);
    assert.equal(got?.check.type, 'file');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_stop stops a monitor', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc1', {
      name: 'stop-me',
      check: { type: 'timer' },
      schedule: { delay_ms: 5000 },
    }, undefined, undefined, fakeCtx());
    const stopTool = buildStopTool({} as any, store);
    const stopped = await (stopTool as any).execute('tc2', { monitor_id: started.details.monitor_id });
    assert.equal(stopped.details.state, 'stopped');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_list returns monitors', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    await (startTool as any).execute('tc1', { name: 'a', check: { type: 'timer' }, schedule: { delay_ms: 5000 } }, undefined, undefined, fakeCtx());
    await (startTool as any).execute('tc2', { name: 'b', check: { type: 'timer' }, schedule: { delay_ms: 5000 } }, undefined, undefined, fakeCtx());
    const listTool = buildListTool({} as any, store);
    const listed = await (listTool as any).execute('tc3', {});
    assert.equal(listed.details.monitors.length, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_look returns monitor details', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc1', { name: 'look-me', check: { type: 'timer' }, schedule: { delay_ms: 5000 } }, undefined, undefined, fakeCtx());
    const lookTool = buildLookTool({} as any, store);
    const looked = await (lookTool as any).execute('tc2', { monitor_id: started.details.monitor_id });
    assert.equal(looked.details.monitor.monitor_id, started.details.monitor_id);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
