import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { buildStartTool, buildStopTool, buildListTool, buildLookTool, buildAttentionTool, buildStreamStartTool, buildStreamListTool, buildStreamOutputTool } from '../src/tools/index.js';
import { StreamMonitorManager } from '../src/stream/stream-manager.js';

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

test('monitor_start is idempotent and schedules immediate checks by default', async () => {
  const { dir, store } = tmpStore();
  try {
    const tool = buildStartTool({} as any, store);
    const params = { name: 'idem', check: { type: 'timer' }, schedule: {}, idempotency_key: 'same-key' };
    const first = await (tool as any).execute('tc1', params, undefined, undefined, fakeCtx());
    const second = await (tool as any).execute('tc2', params, undefined, undefined, fakeCtx());
    assert.equal(second.details.monitor_id, first.details.monitor_id);
    assert.equal(second.details.idempotent, true);
    assert.ok(first.details.next_run_at);
    const listed = await store.list({ include_archived: false });
    assert.equal(listed.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_attention lists unacked triggered results', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    const started = await (startTool as any).execute('tc1', { name: 'attention', check: { type: 'timer' }, schedule: { delay_ms: 5000 } }, undefined, undefined, fakeCtx());
    await store.appendResult({ result_id: 'r1', monitor_id: started.details.monitor_id, status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString(), attention_delivery: { message: 'pay attention', severity: 'warning', notify_attempted: true, notify_delivered: false, wake_attempted: true, wake_delivered: false, wake_error: 'offline' } });
    const tool = buildAttentionTool({} as any, store);
    const res = await (tool as any).execute('tc2', {});
    assert.equal(res.details.attention.length, 1);
    assert.equal(res.details.attention[0].message, 'pay attention');
    assert.equal(res.details.attention[0].wake_error, 'offline');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('stream monitor starts and captures output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-stream-test-'));
  const sent: any[] = [];
  try {
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const startTool = buildStreamStartTool({} as any, streams);
    const started = await (startTool as any).execute('tc1', { description: 'echo-stream', command: 'printf "one\\ntwo\\n"', notify: false, event_throttle_ms: 10 }, undefined, undefined, {});
    await new Promise((r) => setTimeout(r, 150));
    const listTool = buildStreamListTool({} as any, streams);
    const listed = await (listTool as any).execute('tc2', {});
    assert.equal(listed.details.streams.length, 1);
    const outputTool = buildStreamOutputTool({} as any, streams);
    const output = await (outputTool as any).execute('tc3', { stream_id: started.details.stream_id });
    assert.match(output.content[0].text, /one/);
    assert.match(output.content[0].text, /two/);
    assert.ok(sent.some((s) => s.message.customType === 'monitor-stream-event'));
    assert.ok(sent.every((s) => s.options.triggerTurn === true));
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
