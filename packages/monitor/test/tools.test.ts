import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlMonitorStore } from '../src/store/jsonl-store.js';
import { buildStartTool, buildStopTool, buildListTool } from '../src/tools/index.js';
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await predicate(), true);
}

function processExists(marker: string): boolean {
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 1000 });
  if (ps.error || ps.status !== 0) return false;
  return ps.stdout.split('\n').some((line) => line.includes(marker));
}

test('monitor_start requires kind-specific v2 fields', async () => {
  const { dir, store } = tmpStore();
  try {
    await assert.rejects(
      () => (buildStartTool({} as any, store) as any).execute('tc-no-kind', { name: 'missing-kind' }, undefined, undefined, fakeCtx()),
      /requires v2 kind/
    );
    await assert.rejects(
      () => (buildStartTool({} as any, store) as any).execute('tc-file-missing-mode', { kind: 'file', path: '/tmp/x' }, undefined, undefined, fakeCtx()),
      /Invalid file check mode/
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_start creates v2 file monitor with generated output_path and list shows current session', async () => {
  const { dir, store } = tmpStore();
  try {
    process.env.PI_MONITOR_HOME = dir;
    const filePath = join(dir, 'watch.txt');
    const startTool = buildStartTool({} as any, store);
    const mine = await (startTool as any).execute('tc1', { kind: 'file', name: 'mine', path: filePath, file_mode: 'exists', interval_s: 5 }, undefined, undefined, fakeCtx('/tmp/a.json'));
    await (startTool as any).execute('tc2', { kind: 'file', name: 'other', path: filePath, file_mode: 'exists', interval_s: 5 }, undefined, undefined, fakeCtx('/tmp/b.json'));

    assert.equal(mine.details.kind, 'file');
    assert.match(mine.details.output_path, /monitors\/mon-.*\/output\.log$/);
    const got = await store.get(mine.details.monitor_id);
    assert.equal(got?.metadata.monitor_v2, true);
    assert.equal(got?.metadata.kind, 'file');
    assert.equal(got?.schedule.interval_ms, 5000);
    assert.equal((got?.check as any).mode, 'exists');

    const listTool = buildListTool({} as any, store);
    const listed = await (listTool as any).execute('tc-list', {}, undefined, undefined, fakeCtx('/tmp/a.json'));
    assert.deepEqual(listed.details.items.map((m: any) => m.name), ['mine']);
    const listedAll = await (listTool as any).execute('tc-list-all', { include_all_sessions: true }, undefined, undefined, fakeCtx('/tmp/a.json'));
    assert.equal(listedAll.details.items.length, 2);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('v2 stream writes generated output_path and sends standardized event envelope', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  try {
    process.env.PI_MONITOR_HOME = dir;
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc-stream', {
      kind: 'stream',
      name: 'v2-stream',
      command: 'printf "v2-line\\n"',
      throttle_s: 0,
      wake: 'on_event',
      idempotency_key: 'v2-stream-key',
    }, undefined, undefined, fakeCtx());

    await waitFor(() => existsSync(started.details.output_path) && readFileSync(started.details.output_path, 'utf8').includes('v2-line'));
    assert.match(readFileSync(started.details.output_path, 'utf8'), /v2-line/);
    const event = sent.find((e) => String(e.message.content).startsWith('[MONITOR EVENT — NOT USER INPUT]'));
    assert.ok(event);
    assert.equal(event.message.customType, 'monitor-event');
    assert.equal(event.message.details.kind, 'stream');
    assert.equal(event.message.details.event_type, 'event');
    assert.equal(event.options.triggerTurn, true);
    assert.doesNotMatch(event.message.content, /v2-line/);

    const duplicate = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc-dupe', { kind: 'stream', command: 'printf nope', idempotency_key: 'v2-stream-key' }, undefined, undefined, fakeCtx());
    assert.equal(duplicate.details.idempotent, true);
    assert.equal(duplicate.details.monitor_id, started.details.monitor_id);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('monitor_start v2 rejects obvious workload commands and invalid poll shell:false', async () => {
  const { dir, store } = tmpStore();
  try {
    await assert.rejects(
      () => (buildStartTool({} as any, store) as any).execute('tc-workload', { kind: 'stream', command: 'npm test', wake: 'never' }, undefined, undefined, fakeCtx()),
      /observer, not background bash|not run workloads/
    );
    await assert.rejects(
      () => (buildStartTool({} as any, store) as any).execute('tc-shell-false', { kind: 'poll', command: 'printf ok', interval_s: 5, shell: false }, undefined, undefined, fakeCtx()),
      /shell:false is not supported/
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('v2 poll uses seconds and suppresses unchanged state', async () => {
  const { dir, store } = tmpStore();
  try {
    process.env.PI_MONITOR_HOME = dir;
    const started = await (buildStartTool({} as any, store) as any).execute('tc-poll', { kind: 'poll', name: 'poll', command: 'printf "same-state\\n"', interval_s: 5, wake: 'never' }, undefined, undefined, fakeCtx());
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

test('v2 poll emits standardized wake envelope on state change', async () => {
  const { dir, store } = tmpStore();
  const sent: any[] = [];
  const stateFile = join(dir, 'state.txt');
  let scheduler: MonitorScheduler | undefined;
  try {
    process.env.PI_MONITOR_HOME = dir;
    writeFileSync(stateFile, 'one');
    const status = new MonitorStatusService(store, { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
    const started = await (buildStartTool({} as any, store, status) as any).execute('tc-poll-run', { kind: 'poll', name: 'poll-run', command: `cat ${JSON.stringify(stateFile)}`, interval_s: 5, wake: 'on_event' }, undefined, undefined, fakeCtx());
    scheduler = new MonitorScheduler(store, { tickIntervalMs: 60 }, status);
    scheduler.start(fakeCtx());
    await waitFor(async () => (await store.get(started.details.monitor_id))?.run_count === 1);
    assert.equal(sent[0]?.message.customType, 'monitor-event');
    assert.ok(String(sent[0]?.message.content).startsWith('[MONITOR EVENT — NOT USER INPUT]'));
    assert.equal(sent[0]?.message.details.kind, 'poll');
    assert.equal(sent[0]?.message.details.event_type, 'event');
  } finally {
    await scheduler?.stop();
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('queued throttled stream events are suppressed after manual stop', async () => {
  const { dir } = tmpStore();
  const sent: any[] = [];
  try {
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const started = streams.start({
      stream_id: 'queued-stop',
      command: `sh -c 'printf "queued-line\\n"; sleep 20'`,
      description: 'queued-stop',
      wake_on_line: true,
      event_throttle_ms: 1000,
      notify: false,
    });
    await waitFor(() => existsSync(started.output_file) && readFileSync(started.output_file, 'utf8').includes('queued-line'));
    const outcome = await streams.stopAndWait(started.stream_id, 1000);
    assert.equal(outcome.stopped, true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(sent.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('manual stop suppresses terminal stream wake', async () => {
  const { dir } = tmpStore();
  const sent: any[] = [];
  try {
    const streams = new StreamMonitorManager({ sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any, dir);
    const started = streams.start({
      stream_id: 'terminal-stop',
      command: `sh -c 'sleep 20'`,
      description: 'terminal-stop',
      wake_on_completion: true,
      notify: false,
    });
    const outcome = await streams.stopAndWait(started.stream_id, 1000);
    assert.equal(outcome.stopped, true);
    assert.equal(sent.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('monitor_stop stops v2 stream process and cleans persisted state', async () => {
  const { dir, store } = tmpStore();
  const marker = `monitor-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    process.env.PI_MONITOR_HOME = dir;
    const streams = new StreamMonitorManager({ sendMessage: () => undefined } as any, dir);
    const started = await (buildStartTool({} as any, store, undefined, streams) as any).execute('tc-stop', { kind: 'stream', name: 'stop-me', command: `sh -c 'sleep 20' ${marker}`, wake: 'never' }, undefined, undefined, fakeCtx());
    await waitFor(() => processExists(marker));
    await store.update(started.details.monitor_id, undefined, { lease_id: 'lease-stop', lease_expires_at: new Date(Date.now() + 10000).toISOString() });
    const stopped = await (buildStopTool({} as any, store, undefined, streams) as any).execute('tc-stop2', { monitor_id: started.details.monitor_id }, undefined, undefined, fakeCtx());
    assert.equal(stopped.details.state, 'stopped');
    assert.equal(stopped.details.output_path, started.details.output_path);
    await waitFor(() => !processExists(marker));
    const persisted = await store.get(started.details.monitor_id);
    assert.equal(persisted?.state, 'stopped');
    assert.equal(persisted?.next_run_at, undefined);
    assert.equal(persisted?.lease_id, undefined);
    assert.equal(persisted?.lease_expires_at, undefined);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('/monitors stop routes through stream stop and persisted cleanup path', async () => {
  const { dir } = tmpStore();
  const marker = `slash-monitor-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const notifications: any[] = [];
  try {
    process.env.PI_MONITOR_HOME = dir;
    const pi = {
      on: () => undefined,
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      sendMessage: () => undefined,
    };
    monitorExtension(pi as any);
    const ctx = { ...fakeCtx(), ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } };
    const started = await tools.monitor_start.execute('tc-slash-stop', { kind: 'stream', name: 'slash-stop-me', command: `sh -c 'sleep 20' ${marker}`, wake: 'never' }, undefined, undefined, ctx);
    await waitFor(() => processExists(marker));

    await commands.monitors.handler(`stop ${started.details.monitor_id}`, ctx);

    await waitFor(() => !processExists(marker));
    const verifierStore = new JsonlMonitorStore(dir);
    const persisted = await verifierStore.get(started.details.monitor_id);
    assert.equal(persisted?.state, 'stopped');
    assert.equal(persisted?.next_run_at, undefined);
    assert.equal(persisted?.lease_id, undefined);
    assert.equal(persisted?.lease_expires_at, undefined);
    const events = await verifierStore.listEvents({ monitor_id: started.details.monitor_id, types: ['stopped'] });
    assert.ok(events.length >= 1);
    assert.match(notifications[0]?.message, /Stopped/);
  } finally {
    delete process.env.PI_MONITOR_HOME;
    rmSync(dir, { recursive: true });
  }
});

test('monitor extension registers only v2 model-facing monitor tools and prompt observer guidance', async () => {
  const handlers: Record<string, any> = {};
  const tools: string[] = [];
  const pi = { on: (name: string, handler: any) => { handlers[name] = handler; }, registerTool: (tool: any) => tools.push(tool.name), registerCommand: () => undefined };
  monitorExtension(pi as any);
  assert.deepEqual(tools, ['monitor_start', 'monitor_list', 'monitor_stop']);
  const res = await handlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: { selectedTools: ['monitor_start', 'monitor_list', 'monitor_stop'] } });
  assert.match(res.systemPrompt, /durable observer, not background bash/);
  assert.match(res.systemPrompt, /output_path/);
});
