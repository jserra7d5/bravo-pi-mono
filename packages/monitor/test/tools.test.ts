import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { buildStartTool, buildStopTool, buildListTool, buildLookTool, buildAttentionTool, buildOutputTool, buildResultTool, buildAckTool } from '../src/tools/index.js';
import { StreamMonitorManager } from '../src/stream/stream-manager.js';
import { MonitorStatusService } from '../src/runtime/status.js';

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
    assert.deepEqual(listed.details.monitors.map((m: any) => m.name), ['mine']);
    const listedAll = await (listTool as any).execute('tc4', { include_all_sessions: true }, undefined, undefined, fakeCtx('/tmp/session-a.json'));
    assert.equal(listedAll.details.monitors.length, 2);

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
    assert.equal(listed.details.monitors[0].check_type, 'command');
    assert.match(listed.details.monitors[0].command, /printf/);
    assert.match(listed.content[0].text, /state=completed/);
    assert.match(listed.content[0].text, /type=command/);
    assert.match(listed.content[0].text, /cmd/);
    assert.match(listed.content[0].text, /printf/);

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
    assert.match(sent[0].message.content, /Command monitor output/);
    assert.match(sent[0].message.content, /wake-line/);
    assert.match(sent[1].message.content, /Command monitor .* completed/);
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
    assert.equal(stopped.details.command, command);
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
