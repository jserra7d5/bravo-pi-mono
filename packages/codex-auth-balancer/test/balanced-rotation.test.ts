import test from 'node:test';
import assert from 'node:assert/strict';
import { createBalancedStreamRunner, type BalancedRunnerDeps } from '../extensions/pi/index.js';

const MODEL = { id: 'bravo-codex-balanced/gpt-5.5', provider: 'bravo-codex-balanced', api: 'openai-codex-responses', baseUrl: 'https://x' } as any;

function fakeMsg(extra: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 0,
    ...extra,
  } as any;
}

type Recorder = { leaseCalls: Array<string | undefined>; finished: Array<{ lease_id: string; status: string }>; sleeps: number[] };

function makeDeps(behavior: (slot: string) => 'rate-limit' | 'ok'): { deps: Partial<BalancedRunnerDeps>; rec: Recorder } {
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => {
      rec.leaseCalls.push(input.preferred_slot);
      const slot = input.preferred_slot ?? '1'; // auto-selection lands on slot 1
      return {
        schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
        lease_id: `lease-${slot}`, access_token: `tok_slot${slot}_xxxxxxxx`, slot, label: slot,
        expires_at: 0, reservation_id: `res-${slot}`, launch_id: `launch-${slot}`,
      } as any;
    },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_model: any, _context: any, options: any) => (async function* () {
      const slot = String(options.apiKey).includes('slot1') ? '1' : '2';
      if (behavior(slot) === 'rate-limit') {
        await options.onResponse?.({ status: 429, headers: {} }, _model);
        yield { type: 'error', reason: 'error', error: fakeMsg({ stopReason: 'error', errorMessage: '{"detail":"Rate limit exceeded"}' }) };
      } else {
        await options.onResponse?.({ status: 200, headers: {} }, _model);
        yield { type: 'done', reason: 'stop', message: fakeMsg() };
      }
    })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5,
    now: () => 1000,
    cooldown: new Map<string, number>(),
  };
  return { deps, rec };
}

async function collect(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

test('rotate-on-429: a 429 on slot 1 silently rotates to slot 2 and forwards its success', async () => {
  const { deps, rec } = makeDeps(slot => (slot === '1' ? 'rate-limit' : 'ok'));
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const types = events.map(e => e.type);

  assert.ok(types.includes('done'), 'user should receive slot 2 success');
  assert.ok(!types.includes('error'), 'the slot-1 429 error must be suppressed, not shown');
  assert.deepEqual(rec.leaseCalls, [undefined, '2'], 'auto-select first, then force the other slot');
  assert.deepEqual(rec.finished, [
    { lease_id: 'lease-1', status: 'failed' },
    { lease_id: 'lease-2', status: 'completed' },
  ]);
});

test('rotate-on-429: when both slots 429 it backs off, exhausts, and surfaces one error', async () => {
  const { deps, rec } = makeDeps(() => 'rate-limit');
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const types = events.map(e => e.type);

  assert.equal(types.filter(t => t === 'error').length, 1, 'exactly one terminal error to the user');
  assert.ok(!types.includes('done'));
  assert.equal(rec.finished.length, 4, '2 rounds x 2 slots');
  assert.ok(rec.finished.every(f => f.status === 'failed'));
  assert.equal(rec.sleeps.length, 1, 'one back-off between the two rounds');
  const err = events.find(e => e.type === 'error');
  assert.match(String(err.error.errorMessage), /Rate limit/i, 'surfaces the real upstream rate-limit error');
});

test('rotate-on-429: an abort mid-stream does not forward a late done', async () => {
  const ac = new AbortController();
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => { rec.leaseCalls.push(input.preferred_slot); return { schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1', expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1' } as any; },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_m: any, _c: any, options: any) => (async function* () {
      await options.onResponse?.({ status: 200, headers: {} }, _m);
      ac.abort();                                                  // caller aborts before the terminal event
      yield { type: 'done', reason: 'stop', message: fakeMsg() };  // late done that must be ignored
    })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1', signal: ac.signal } as any));
  const types = events.map(e => e.type);

  assert.ok(!types.includes('done'), 'a late done after abort must not be forwarded');
  assert.equal(types.filter(t => t === 'error').length, 1, 'exactly one terminal event');
  assert.equal(events.find(e => e.type === 'error').reason, 'aborted');
  assert.deepEqual(rec.finished, [{ lease_id: 'lease-1', status: 'aborted' }], 'lease finished once, as aborted');
});

test('rotate-on-429: a forwarded upstream error has tokens/secrets redacted', async () => {
  const secret = 'Bearer sk-supersecret-123 and jwt eyJhbGc.eyJzdWIi.sigABC';
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => { rec.leaseCalls.push(input.preferred_slot); return { schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1', expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1' } as any; },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_m: any, _c: any, options: any) => (async function* () {
      await options.onResponse?.({ status: 401, headers: {} }, _m);
      yield { type: 'error', reason: 'error', error: fakeMsg({ stopReason: 'error', errorMessage: `auth failed: ${secret}` }) };
    })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const err = events.find(e => e.type === 'error');
  const msg = String(err.error.errorMessage);
  assert.ok(!msg.includes('sk-supersecret-123'), 'bearer secret must be redacted');
  assert.ok(!msg.includes('eyJhbGc.eyJzdWIi.sigABC'), 'jwt-like token must be redacted');
  assert.match(msg, /\[REDACTED/, 'redaction marker present');
});

test('rotate-on-429: a non-rate error surfaces immediately without rotating', async () => {
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => { rec.leaseCalls.push(input.preferred_slot); return { schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1', expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1' } as any; },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_m: any, _c: any, options: any) => (async function* () {
      await options.onResponse?.({ status: 400, headers: {} }, _m);
      yield { type: 'error', reason: 'error', error: fakeMsg({ stopReason: 'error', errorMessage: "invalid_request_error: Tool 'image_generation' not supported" }) };
    })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));

  assert.equal(events.filter(e => e.type === 'error').length, 1, 'the non-rate error is shown as-is');
  assert.deepEqual(rec.leaseCalls, [undefined], 'no rotation attempted');
  assert.deepEqual(rec.finished, [{ lease_id: 'lease-1', status: 'failed' }]);
});
