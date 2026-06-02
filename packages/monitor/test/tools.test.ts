import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { buildStartTool, buildStopTool, buildListTool, buildLookTool, buildAttentionTool, buildOutputTool, buildResultTool, buildAckTool } from '../src/tools/index.js';
import { StreamMonitorManager } from '../src/stream/stream-manager.js';
import { MonitorStatusService } from '../src/runtime/status.js';
import { MonitorScheduler } from '../src/scheduler/scheduler.js';
import monitorExtension from '../src/extension.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const store = new JsonlMonitorStore(dir);
  return { dir, store };
}

function fakeCtx(session = '/tmp/pi-session-a.json') {
  return { sessionManager: { getSessionFile: () => session }, actor_id: 'test' };
}

function processExists(marker: string): boolean {
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 1000 });
  if (ps.error || ps.status !== 0) return false;
  return ps.stdout.split('\n').some((line) => line.includes(marker));
}

async function waitForProcess(marker: string, expected: boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processExists(marker) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(marker), expected);
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
    const res = await (tool as any).execute('tc2', {}, undefined, undefined, fakeCtx());
    assert.equal(res.details.attention.length, 1);
    assert.equal(res.details.attention[0].message, 'pay attention');
    assert.equal(res.details.attention[0].severity, 'warning');
    assert.equal(res.details.attention[0].wake_error, 'offline');
    const text = res.content[0].text;
    assert.match(text, /Found 1 pending monitor attention item/);
    assert.match(text, /monitor=mon-/);
    assert.match(text, /name=attention/);
    assert.match(text, /state=running/);
    assert.match(text, /status=matched/);
    assert.match(text, /message=pay attention/);
    assert.match(text, /severity=warning/);
    assert.match(text, /result=r1/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_result visible output includes persisted command observation metadata and ack state', async () => {
  const { dir, store } = tmpStore();
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'result-cmd',
      check: { type: 'command', command: 'printf "result-output\\n"; exit 7', event_throttle_ms: 10 },
      schedule: {},
    }, undefined, undefined, fakeCtx());
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');

    const res = await (buildResultTool({} as any, store) as any).execute('tc3', { monitor_id: started.details.monitor_id });
    assert.equal(res.details.results.length, 1);
    const result = res.details.results[0];
    assert.equal(result.status, 'error');
    assert.match(result.error_message, /failed \(exit 7\)/);
    assert.equal((result.observation as any).exit_code, 7);
    assert.ok((result.observation as any).output_file);

    const text = res.content[0].text;
    assert.match(text, /1 result\(s\) for monitor mon-/);
    assert.match(text, new RegExp(`- ${result.result_id}: `));
    assert.match(text, /status=error/);
    assert.match(text, /triggered=false/);
    assert.match(text, /acked=false/);
    assert.match(text, /error=Command monitor "result-cmd" failed \(exit 7\)/);
    assert.match(text, /exit_code=7/);
    assert.match(text, /output_file=/);

    await (buildAckTool({} as any, store) as any).execute('tc4', { result_id: result.result_id }, undefined, undefined, fakeCtx());
    const acked = await (buildResultTool({} as any, store) as any).execute('tc5', { monitor_id: started.details.monitor_id });
    assert.match(acked.content[0].text, /acked=true/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_list and monitor_attention default to current session only', async () => {
  const { dir, store } = tmpStore();
  try {
    const startTool = buildStartTool({} as any, store);
    const mine = await (startTool as any).execute('tc1', { name: 'mine', check: { type: 'timer' }, schedule: { delay_ms: 5000 } }, undefined, undefined, fakeCtx('/tmp/session-a.json'));
    const other = await (startTool as any).execute('tc2', { name: 'other', check: { type: 'timer' }, schedule: { delay_ms: 5000 } }, undefined, undefined, fakeCtx('/tmp/session-b.json'));
    await store.appendResult({ result_id: 'r-mine', monitor_id: mine.details.monitor_id, status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString() });
    await store.appendResult({ result_id: 'r-other', monitor_id: other.details.monitor_id, status: 'matched', condition_matched: true, triggered: true, created_at: new Date().toISOString() });

    const listTool = buildListTool({} as any, store);
    const listed = await (listTool as any).execute('tc3', {}, undefined, undefined, fakeCtx('/tmp/session-a.json'));
    assert.deepEqual(listed.details.items.map((m: any) => m.name), ['mine']);
    const listedAll = await (listTool as any).execute('tc4', { include_all_sessions: true }, undefined, undefined, fakeCtx('/tmp/session-a.json'));
    assert.equal(listedAll.details.items.length, 2);

    const attentionTool = buildAttentionTool({} as any, store);
    const attention = await (attentionTool as any).execute('tc5', {}, undefined, undefined, fakeCtx('/tmp/session-a.json'));
    assert.deepEqual(attention.details.attention.map((m: any) => m.name), ['mine']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_start creates durable command monitor and monitor_output reads it', async () => {
  const { dir, store } = tmpStore();
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', { name: 'cmd', check: { type: 'command', command: 'printf "hello-command\\n"', event_throttle_ms: 10 }, schedule: {} }, undefined, undefined, fakeCtx());
    assert.equal(started.details.ok, true);
    assert.equal(started.details.next_run_at, undefined);
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');
    assert.match(output.details.output, /hello-command/);
    const freshStreams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const recovered = await (buildOutputTool({} as any, store, freshStreams) as any).execute('tc-recovered', { monitor_id: started.details.monitor_id, block: false });
    assert.equal(recovered.details.retrieval_status, 'success');
    assert.match(recovered.details.output, /hello-command/);
    const listed = await (buildListTool({} as any, store) as any).execute('tc3', {}, undefined, undefined, fakeCtx());
    assert.equal(listed.details.items[0].kind, 'command');
    assert.equal(listed.details.items[0].state, 'ended');
    assert.match(listed.content[0].text, /ended command/);
    assert.match(listed.content[0].text, /cmd/);

    const looked = await (buildLookTool({} as any, store) as any).execute('tc4', { monitor_id: started.details.monitor_id });
    assert.match(looked.content[0].text, /type=command/);
    assert.match(looked.content[0].text, /output_file=/);
    assert.match(looked.content[0].text, /recent_result=matched/);
    assert.match(looked.content[0].text, /exit_code=0/);

    const results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results[0]!.triggered, false);
    const attention = await (buildAttentionTool({} as any, store) as any).execute('tc5', {}, undefined, undefined, fakeCtx());
    assert.equal(attention.details.attention.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('failing command monitor records error and useful look/output text', async () => {
  const { dir, store } = tmpStore();
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', { name: 'bad-cmd', check: { type: 'command', command: 'printf "bad-output\\n"; exit 7', event_throttle_ms: 10 }, schedule: {} }, undefined, undefined, fakeCtx());
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');
    assert.match(output.content[0].text, /bad-output/);
    const [result] = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(result!.status, 'error');
    assert.equal((result!.observation as any).exit_code, 7);
    const looked = await (buildLookTool({} as any, store) as any).execute('tc3', { monitor_id: started.details.monitor_id });
    assert.match(looked.content[0].text, /state=failed/);
    assert.match(looked.content[0].text, /recent_result=error/);
    assert.match(looked.content[0].text, /exit_code=7/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('command monitor wake_agent false captures output without follow-up messages and notify flag controls ui notify', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const notified: any[] = [];
  try {
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'quiet-cmd',
      check: { type: 'command', command: 'printf "quiet-line\\n"', event_throttle_ms: 10 },
      schedule: {},
      attention: { notify: false, wake_agent: false },
    }, undefined, undefined, { ...fakeCtx(), ui: { notify: (...args: any[]) => notified.push(args) } });
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');
    assert.match(output.details.output, /quiet-line/);
    assert.equal(sent.length, 0);
    assert.equal(notified.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('command monitor notify true and wake_agent false notifies without follow-up messages or backfill duplicates', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const notified: any[] = [];
  try {
    const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) };
    const streams = new StreamMonitorManager(pi as any, dir);
    const ctx = { ...fakeCtx(), ui: { notify: (...args: any[]) => notified.push(args) } };
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'notify-only-cmd',
      check: { type: 'command', command: 'printf "notify-line\\n"', event_throttle_ms: 10 },
      schedule: {},
      attention: { notify: true, wake_agent: false },
    }, undefined, undefined, ctx);
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');
    assert.match(output.details.output, /notify-line/);
    assert.equal(sent.length, 0);
    assert.ok(notified.some((args) => String(args[0]).includes('notify-line')));
    assert.ok(notified.some((args) => String(args[0]).includes('completed')));

    const results = await store.listResults(started.details.monitor_id, { limit: 10 });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.attention_delivery?.notify_attempted, true);
    assert.equal(results[0]!.attention_delivery?.notify_delivered, true);
    assert.equal(results[0]!.attention_delivery?.wake_attempted, false);
    assert.equal(results[0]!.attention_delivery?.wake_delivered, false);

    const backfilled = await new MonitorStatusService(store, pi as any).backfillPending(ctx);
    assert.equal(backfilled, 0);
    assert.equal(sent.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('command monitor notify true without ui.notify records undelivered and backfill can notify later', async () => {
  const { dir, store } = tmpStore();
  const notified: any[] = [];
  try {
    const pi = { sendMessage: () => undefined };
    const streams = new StreamMonitorManager(pi as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'notify-backfill-cmd',
      check: { type: 'command', command: 'printf "notify-backfill\\n"', event_throttle_ms: 10 },
      schedule: {},
      attention: { notify: true, wake_agent: false, message: 'notify me later' },
    }, undefined, undefined, fakeCtx());
    await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });

    let results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results[0]!.attention_delivery?.notify_attempted, true);
    assert.equal(results[0]!.attention_delivery?.notify_delivered, false);
    assert.equal(results[0]!.attention_delivery?.notify_error, 'ui.notify unavailable');
    assert.equal(results[0]!.attention_delivery?.delivered_at, undefined);

    const count = await new MonitorStatusService(store, pi as any).backfillPending({ ...fakeCtx(), ui: { notify: (...args: any[]) => notified.push(args) } });
    assert.equal(count, 0);
    assert.equal(notified.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('command monitor wake_agent true without sendMessage records undelivered and backfill can wake later', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  try {
    const streams = new StreamMonitorManager({} as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'wake-backfill-cmd',
      check: { type: 'command', command: 'printf "wake-backfill\\n"', event_throttle_ms: 10 },
      schedule: {},
      attention: { notify: false, wake_agent: true, message: 'wake me later' },
    }, undefined, undefined, fakeCtx());
    await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });

    let results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results[0]!.attention_delivery?.wake_attempted, true);
    assert.equal(results[0]!.attention_delivery?.wake_delivered, false);
    assert.equal(results[0]!.attention_delivery?.wake_error, 'pi.sendMessage unavailable');
    assert.equal(results[0]!.attention_delivery?.delivered_at, undefined);

    const count = await new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any).backfillPending(fakeCtx());
    assert.equal(count, 0);
    assert.equal(sent.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('command monitor notification and wake exceptions do not prevent completion persistence', async () => {
  const { dir, store } = tmpStore();
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => { throw new Error('send boom'); } } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'throwing-delivery-cmd',
      check: { type: 'command', command: 'printf "throwing\\n"', event_throttle_ms: 10 },
      schedule: {},
      attention: { notify: true, wake_agent: true },
    }, undefined, undefined, { ...fakeCtx(), ui: { notify: () => { throw new Error('notify boom'); } } });
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');
    const results = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.attention_delivery?.notify_delivered, false);
    assert.equal(results[0]!.attention_delivery?.notify_error, 'notify boom');
    assert.equal(results[0]!.attention_delivery?.wake_delivered, false);
    assert.equal(results[0]!.attention_delivery?.wake_error, 'send boom');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('command monitor wake_agent true sends output and completion follow-up messages', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const notified: any[] = [];
  try {
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'wake-cmd',
      check: { type: 'command', command: 'printf "wake-line\\n"', event_throttle_ms: 10 },
      schedule: {},
      attention: { notify: true, wake_agent: true },
    }, undefined, undefined, { ...fakeCtx(), ui: { notify: (...args: any[]) => notified.push(args) } });
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');
    assert.match(output.details.output, /wake-line/);
    assert.equal(sent.length, 2);
    assert.match(sent[0].message.content, /\[MONITOR EVENT — NOT USER INPUT\]/);
    assert.match(sent[0].message.content, /Output:/);
    assert.doesNotMatch(sent[0].message.content, /wake-line/);
    assert.match(sent[1].message.content, /\[MONITOR ENDED — NOT USER INPUT\]/);
    assert.equal(sent[0].message.details.event_type, 'event');
    assert.equal(sent[1].message.details.event_type, 'ended');
    assert.equal(sent[0].options.triggerTurn, true);
    assert.ok(notified.length >= 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_output distinguishes not_ready and completed-empty visible text', async () => {
  const { dir, store } = tmpStore();
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const running = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', { name: 'not-ready', check: { type: 'command', command: 'sleep 1' }, schedule: {} }, undefined, undefined, fakeCtx());
    const notReady = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: running.details.monitor_id, block: false });
    assert.equal(notReady.details.retrieval_status, 'not_ready');
    assert.match(notReady.content[0].text, /not ready/);
    await (buildStopTool({} as any, store, undefined, streams) as any).execute('tc-stop', { monitor_id: running.details.monitor_id }, undefined, undefined, fakeCtx());

    const empty = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc3', { name: 'empty', check: { type: 'command', command: 'true' }, schedule: {} }, undefined, undefined, fakeCtx());
    const completed = await (buildOutputTool({} as any, store, streams) as any).execute('tc4', { monitor_id: empty.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(completed.details.retrieval_status, 'success');
    assert.match(completed.content[0].text, /completed with no captured output/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_output reports failed empty command without saying completed and monitor_look includes exit code', async () => {
  const { dir, store } = tmpStore();
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', {
      name: 'empty-fail',
      check: { type: 'command', command: 'sh -c "exit 7"', cwd: dir },
      schedule: {},
    }, undefined, undefined, fakeCtx());
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.equal(output.details.retrieval_status, 'success');
    assert.equal(output.details.exit_code, 7);
    assert.doesNotMatch(output.content[0].text, /completed/i);
    assert.match(output.content[0].text, /failed with no captured output/);
    assert.match(output.content[0].text, /exit_code=7/);

    const look = await (buildLookTool({} as any, store) as any).execute('tc3', { monitor_id: started.details.monitor_id });
    assert.match(look.content[0].text, /state=failed/);
    assert.match(look.content[0].text, /recent_result=error/);
    assert.match(look.content[0].text, /exit_code=7/);
    assert.equal((look.content[0].text.match(new RegExp(`cwd=${dir}`, 'g')) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_output returns timeout and stop kills non-exec shell child process group', async () => {
  const { dir, store } = tmpStore();
  const marker = `monitor-stop-sleep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const command = `sh -c 'sleep 20' ${marker}`;
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', { name: 'quiet', check: { type: 'command', command }, schedule: {} }, undefined, undefined, fakeCtx());
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 50 });
    assert.equal(output.details.retrieval_status, 'timeout');
    assert.match(output.content[0].text, /timeout/);
    await waitForProcess(marker, true);
    const stopped = await (buildStopTool({} as any, store, undefined, streams) as any).execute('tc3', { monitor_id: started.details.monitor_id }, undefined, undefined, fakeCtx());
    assert.equal(stopped.details.ok, true);
    assert.equal(stopped.details.output_path, undefined);
    assert.equal(stopped.details.state, 'stopped');
    assert.notEqual(streams.get(started.details.monitor_id)?.status, 'running');
    await waitForProcess(marker, false);
    const persisted = await store.get(started.details.monitor_id);
    assert.equal(persisted?.state, 'stopped');
    assert.equal(persisted?.lease_id, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_stop escalates SIGTERM-ignoring non-exec command and persists stopped only after exit', async () => {
  const { dir, store } = tmpStore();
  const marker = `monitor-stop-node-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const command = `node -e "process.title='${marker}'; process.on(\\"SIGTERM\\",()=>{}); setInterval(()=>{},1000)"`;
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc1', { name: 'ignore-term', check: { type: 'command', command }, schedule: {} }, undefined, undefined, fakeCtx());
    await waitForProcess(marker, true);
    const stopped = await (buildStopTool({} as any, store, undefined, streams) as any).execute('tc2', { monitor_id: started.details.monitor_id }, undefined, undefined, fakeCtx());
    assert.equal(stopped.details.state, 'stopped');
    assert.notEqual(streams.get(started.details.monitor_id)?.status, 'running');
    await waitForProcess(marker, false);
    const persisted = await store.get(started.details.monitor_id);
    assert.equal(persisted?.state, 'stopped');
  } finally {
    await new StreamMonitorManager({} as any, dir).stopAll(100).catch(() => undefined);
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
    const listed = await (listTool as any).execute('tc3', {}, undefined, undefined, fakeCtx());
    assert.equal(listed.details.items.length, 2);
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

test('monitor_start accepts v2 stream schema with seconds, generated output_path, and envelope wakeups', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  try {
    process.env.PI_MONITOR_HOME = dir;
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc-v2-stream', {
      kind: 'stream',
      name: 'v2-stream',
      command: 'printf "v2-line\\n"',
      throttle_s: 0,
      wake: 'on_event',
      idempotency_key: 'v2-stream-key',
    }, undefined, undefined, fakeCtx());
    assert.equal(started.details.ok, true);
    assert.match(started.details.output_path, /monitors\/mon-.*\/output\.log$/);
    const output = await (buildOutputTool({} as any, store, streams) as any).execute('tc-v2-output', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    assert.match(output.details.output, /v2-line/);
    assert.ok(sent.some((e) => String(e.message.content).startsWith(`[MONITOR EVENT — NOT USER INPUT]`)));
    const event = sent.find((e) => String(e.message.content).startsWith(`[MONITOR EVENT — NOT USER INPUT]`));
    assert.equal(event.message.customType, 'monitor-event');
    assert.match(event.message.content, new RegExp(`Monitor ID: ${started.details.monitor_id}`));
    assert.match(event.message.content, /Kind: stream/);
    assert.match(event.message.content, /State: event/);
    assert.match(event.message.content, /Summary:/);
    assert.match(event.message.content, /Output:/);
    assert.equal(event.message.details.kind, 'stream');
    assert.equal(event.message.details.state, 'event');
    assert.equal(event.message.details.event_type, 'event');
    assert.ok(Array.isArray(event.message.details.instructions));
    assert.doesNotMatch(event.message.content, /v2-line/);

    const duplicate = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc-v2-stream-dupe', { kind: 'stream', command: 'printf nope', idempotency_key: 'v2-stream-key' }, undefined, undefined, fakeCtx());
    assert.equal(duplicate.details.idempotent, true);
    assert.equal(duplicate.details.monitor_id, started.details.monitor_id);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('v2 stream wake:on_event also wakes on failure with failed envelope', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  try {
    process.env.PI_MONITOR_HOME = dir;
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc-v2-stream-fail', {
      kind: 'stream',
      name: 'v2-stream-fail',
      command: 'exit 9',
      throttle_s: 0,
      wake: 'on_event',
    }, undefined, undefined, fakeCtx());
    await (buildOutputTool({} as any, store, streams) as any).execute('tc-v2-fail-output', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    const failed = sent.find((e) => String(e.message.content).startsWith('[MONITOR FAILED — NOT USER INPUT]'));
    assert.ok(failed);
    assert.equal(failed.message.customType, 'monitor-event');
    assert.equal(failed.message.details.event_type, 'failed');
    assert.equal(failed.message.details.kind, 'stream');
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('monitor_start v2 rejects obvious workload commands', async () => {
  const { dir, store } = tmpStore();
  try {
    await assert.rejects(
      () => (buildStartTool({} as any, store) as any).execute('tc-workload', { kind: 'stream', command: 'npm test', wake: 'never' }, undefined, undefined, fakeCtx()),
      /observer, not background bash|not run workloads/
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_start v2 poll uses interval_s and suppresses unchanged wakeups', async () => {
  const { dir, store } = tmpStore();
  try {
    process.env.PI_MONITOR_HOME = dir;
    const started = await (buildStartTool({} as any, store) as any).execute('tc-v2-poll', {
      kind: 'poll',
      name: 'v2-poll',
      command: 'printf "same-state\\n"',
      interval_s: 5,
      wake: 'on_event',
    }, undefined, undefined, fakeCtx());
    assert.equal(started.details.ok, true);
    assert.equal(started.details.kind, 'poll');
    assert.equal(started.details.name, 'v2-poll');
    assert.equal(started.details.next_action, 'wait');
    const got = await store.get(started.details.monitor_id);
    assert.equal(got?.schedule.interval_ms, 5000);
    assert.equal((got?.check as any).mode, 'poll');

    const { runCommandPollCheck } = await import('../src/checks/command.js');
    const first = await runCommandPollCheck(got!, store);
    await store.appendResult(first);
    const second = await runCommandPollCheck(got!, store);
    assert.equal(first.status, 'matched');
    assert.equal(second.status, 'not_matched');
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('v2 poll monitor remains running after changed projection and can poll again', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const stateFile = join(dir, 'state.txt');
  let scheduler: MonitorScheduler | undefined;
  try {
    process.env.PI_MONITOR_HOME = dir;
    writeFileSync(stateFile, 'one');
    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const started = await (buildStartTool({} as any, store, status) as any).execute('tc-v2-poll-run', {
      kind: 'poll',
      name: 'v2-poll-run',
      command: `cat ${JSON.stringify(stateFile)}`,
      interval_s: 5,
      wake: 'on_event',
    }, undefined, undefined, fakeCtx());
    scheduler = new MonitorScheduler(store, { tickIntervalMs: 60 }, status);
    scheduler.start(fakeCtx());
    await new Promise((resolve) => setTimeout(resolve, 250));
    let got = await store.get(started.details.monitor_id);
    assert.equal(got?.state, 'running');
    assert.equal(got?.run_count, 1);
    assert.equal(sent[0]?.message.customType, 'monitor-event');
    assert.ok(String(sent[0]?.message.content).startsWith('[MONITOR EVENT — NOT USER INPUT]'));
    assert.equal(sent[0]?.message.details.kind, 'poll');
    assert.equal(sent[0]?.message.details.event_type, 'event');

    writeFileSync(stateFile, 'two');
    await store.update(started.details.monitor_id, undefined, { next_run_at: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 250));
    got = await store.get(started.details.monitor_id);
    assert.equal(got?.state, 'running');
    assert.equal(got?.run_count, 2);
  } finally {
    await scheduler?.stop();
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('v2 poll wake:on_event also wakes on observer failure', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  let scheduler: MonitorScheduler | undefined;
  try {
    process.env.PI_MONITOR_HOME = dir;
    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const started = await (buildStartTool({} as any, store, status) as any).execute('tc-v2-poll-fail', {
      kind: 'poll',
      name: 'v2-poll-fail',
      command: 'exit 7',
      interval_s: 5,
      wake: 'on_event',
    }, undefined, undefined, fakeCtx());
    scheduler = new MonitorScheduler(store, { tickIntervalMs: 60 }, status);
    scheduler.start(fakeCtx());
    await new Promise((resolve) => setTimeout(resolve, 250));
    const got = await store.get(started.details.monitor_id);
    assert.equal(got?.state, 'failed');
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

test('monitor_start gives recovery validation for missing kind and check, and rejects v2 poll shell:false', async () => {
  const { dir, store } = tmpStore();
  try {
    await assert.rejects(
      () => (buildStartTool({} as any, store) as any).execute('tc-bad', { name: 'bad' }, undefined, undefined, fakeCtx()),
      /requires either v2 kind.*legacy check object.*Recovery/s
    );
    await assert.rejects(
      () => (buildStartTool({} as any, store) as any).execute('tc-shell-false', { kind: 'poll', command: 'printf ok', interval_s: 5, shell: false }, undefined, undefined, fakeCtx()),
      /shell:false is not supported/
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('v2 poll JSON projection uses null for missing keys and stable object canonicalization', async () => {
  const { dir, store } = tmpStore();
  try {
    const started = await (buildStartTool({} as any, store) as any).execute('tc-projection', {
      kind: 'poll',
      command: `printf '%s' '{"b":{"z":2,"a":1}}'`,
      interval_s: 5,
      projection: { type: 'json', key_paths: ['missing.key', 'b'] },
      wake: 'never',
    }, undefined, undefined, fakeCtx());
    const got = await store.get(started.details.monitor_id);
    const { runCommandPollCheck } = await import('../src/checks/command.js');
    const first = await runCommandPollCheck(got!, store);
    assert.deepEqual((first.observation as any).projected, { b: { a: 1, z: 2 }, 'missing.key': null });
    await store.appendResult(first);
    const second = await runCommandPollCheck(got!, store);
    assert.equal(second.status, 'not_matched');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor extension registers only default model-facing monitor tools and prompt observer guidance', async () => {
  const handlers: Record<string, any> = {};
  const tools: string[] = [];
  const pi = { on: (name: string, handler: any) => { handlers[name] = handler; }, registerTool: (tool: any) => tools.push(tool.name), registerCommand: () => undefined };
  monitorExtension(pi as any);
  assert.deepEqual(tools, ['monitor_start', 'monitor_list', 'monitor_stop']);
  const res = await handlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: { selectedTools: ['monitor_start', 'monitor_list', 'monitor_stop'] } });
  assert.match(res.systemPrompt, /durable observer, not background bash/);
  assert.match(res.systemPrompt, /output_path/);
});

test('command output wake success does not mark failed completion wake delivered and does not backfill successful completion', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  let calls = 0;
  try {
    const pi = { sendMessage: (message: any, options: any) => {
      calls++;
      if (calls > 1) throw new Error('completion send failed');
      sent.push({ message, options });
    } };
    const streams = new StreamMonitorManager(pi as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc-output-not-completion', {
      name: 'output-not-completion',
      check: { type: 'command', command: 'printf "line-before-completion\\n"', event_throttle_ms: 0, max_lines_per_turn: 1 },
      schedule: {},
      attention: { notify: false, wake_agent: true, message: 'completion retry' },
    }, undefined, undefined, fakeCtx());

    await (buildOutputTool({} as any, store, streams) as any).execute('tc-output-wait', { monitor_id: started.details.monitor_id, block: true, timeout_ms: 2000 });
    const [result] = await store.listResults(started.details.monitor_id, { limit: 1 });
    assert.equal(sent.length, 1);
    assert.equal(result!.attention_delivery?.wake_attempted, true);
    assert.equal(result!.attention_delivery?.wake_delivered, false);
    assert.equal(result!.attention_delivery?.wake_error, 'completion send failed');
    assert.equal(result!.attention_delivery?.delivered_at, undefined);

    const retrySent: any[] = [];
    const count = await new MonitorStatusService(store, { sendMessage: (message: any, options: any) => retrySent.push({ message, options }) } as any).backfillPending(fakeCtx());
    assert.equal(count, 0);
    assert.equal(retrySent.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
