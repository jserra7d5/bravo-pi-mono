import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamSimpleOpenAICodexResponses } from '@earendil-works/pi-ai';
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

type Recorder = { leaseCalls: Array<string | undefined>; finished: Array<{ lease_id: string; status: string }>; sleeps: number[]; upstreamOptions?: any[] };

function makeDeps(behavior: (slot: string) => 'rate-limit' | 'ok'): { deps: Partial<BalancedRunnerDeps>; rec: Recorder } {
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [], upstreamOptions: [] };
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
      rec.upstreamOptions?.push(options);
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

test('temporary sanitizer hides standalone OpenAI reasoning comment markers but preserves replay signatures', async () => {
  const signature = JSON.stringify({ summary: [{ text: '**Planning**\n\n<!-- -->' }], encrypted_content: 'opaque' });
  const thinkingMessage = (thinking: string) => fakeMsg({
    content: [{ type: 'thinking', thinking, thinkingSignature: signature }],
  });
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => ({
      schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
      lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
      expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
    } as any),
    finishLease: async () => ({} as any),
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_model: any, _context: any, options: any) => (async function* () {
      await options.onResponse?.({ status: 200, headers: {} }, _model);
      yield { type: 'thinking_start', contentIndex: 0, partial: thinkingMessage('') };
      yield { type: 'thinking_delta', contentIndex: 0, delta: '**Planning**\n\n<!--', partial: thinkingMessage('**Planning**\n\n<!--') };
      yield { type: 'thinking_delta', contentIndex: 0, delta: ' -->', partial: thinkingMessage('**Planning**\n\n<!-- -->') };
      yield { type: 'thinking_end', contentIndex: 0, content: '**Planning**\n\n<!-- -->', partial: thinkingMessage('**Planning**\n\n<!-- -->') };
      yield { type: 'done', reason: 'stop', message: thinkingMessage('**Planning**\n\n<!-- -->') };
    })()) as any,
    sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };

  const events = await collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const thinkingEvents = events.filter(event => event.type === 'thinking_delta' || event.type === 'thinking_end');
  const done = events.find(event => event.type === 'done');
  const finalBlock = done.message.content[0];

  assert.ok(thinkingEvents.every(event => {
    const text = event.type === 'thinking_delta' ? event.delta : event.content;
    return !text.includes('<!--') && !text.includes('-->');
  }), 'no complete or partial marker may reach the streamed reasoning consumer');
  assert.equal(finalBlock.thinking, '**Planning**\n\n');
  assert.equal(finalBlock.thinkingSignature, signature, 'signed replay payload remains byte-for-byte intact');
  assert.match(finalBlock.thinkingSignature, /<!-- -->/, 'the sanitizer only changes visible reasoning');
});

test('temporary sanitizer suppresses a split standalone marker after a single newline', async () => {
  const thinkingMessage = (thinking: string) => fakeMsg({ content: [{ type: 'thinking', thinking }] });
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => ({
      schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
      lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
      expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
    } as any),
    finishLease: async () => ({} as any),
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
    ingestUsage: async () => ({} as any),
    createUpstream: (() => (async function* () {
      yield { type: 'thinking_start', contentIndex: 0, partial: thinkingMessage('') };
      yield { type: 'thinking_delta', contentIndex: 0, delta: 'Plan\n<!--', partial: thinkingMessage('Plan\n<!--') };
      yield { type: 'thinking_delta', contentIndex: 0, delta: ' -->', partial: thinkingMessage('Plan\n<!-- -->') };
      yield { type: 'thinking_end', contentIndex: 0, content: 'Plan\n<!-- -->', partial: thinkingMessage('Plan\n<!-- -->') };
      yield { type: 'done', reason: 'stop', message: thinkingMessage('Plan\n<!-- -->') };
    })()) as any,
    sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };

  const events = await collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const deltas = events.filter(event => event.type === 'thinking_delta').map(event => event.delta);
  assert.deepEqual(deltas, ['Plan\n', '']);
  assert.ok(deltas.every(delta => !delta.includes('<!--') && !delta.includes('-->')));
  assert.equal(events.find(event => event.type === 'thinking_end').content, 'Plan\n');
  assert.equal(events.find(event => event.type === 'done').message.content[0].thinking, 'Plan\n');
});

test('temporary sanitizer flushes every incomplete marker prefix at stream end', async () => {
  for (let length = 1; length < '<!-- -->'.length; length++) {
    const reasoning = `Plan\n${'<!-- -->'.slice(0, length)}`;
    const message = fakeMsg({ content: [{ type: 'thinking', thinking: reasoning }] });
    const deps: Partial<BalancedRunnerDeps> = {
      startLease: async (input: any) => ({
        schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
        lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
        expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
      } as any),
      finishLease: async () => ({} as any),
      listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
      ingestUsage: async () => ({} as any),
      createUpstream: (() => (async function* () {
        yield { type: 'thinking_start', contentIndex: 0, partial: fakeMsg({ content: [{ type: 'thinking', thinking: '' }] }) };
        yield { type: 'thinking_delta', contentIndex: 0, delta: reasoning, partial: message };
        yield { type: 'thinking_end', contentIndex: 0, content: reasoning, partial: message };
        yield { type: 'done', reason: 'stop', message };
      })()) as any,
      sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
    };

    const events = await collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
    const deltas = events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join('');
    assert.equal(deltas, reasoning, `prefix length ${length} must flush`);
    assert.equal(events.find(event => event.type === 'thinking_end').content, reasoning);
    assert.equal(events.find(event => event.type === 'done').message.content[0].thinking, reasoning);
  }
});

test('temporary sanitizer flushes buffered legitimate bytes on terminal events without thinking_end', async () => {
  for (const terminal of ['done', 'error'] as const) {
    const reasoning = 'Plan\n<!--';
    const thinkingMessage = (thinking: string) => fakeMsg({
      content: [{ type: 'thinking', thinking }],
      ...(terminal === 'error' ? { stopReason: 'error', errorMessage: 'upstream failed' } : {}),
    });
    const deps: Partial<BalancedRunnerDeps> = {
      startLease: async (input: any) => ({
        schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
        lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
        expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
      } as any),
      finishLease: async () => ({} as any),
      listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
      ingestUsage: async () => ({} as any),
      createUpstream: (() => (async function* () {
        yield { type: 'thinking_start', contentIndex: 0, partial: thinkingMessage('') };
        yield { type: 'thinking_delta', contentIndex: 0, delta: reasoning, partial: thinkingMessage(reasoning) };
        if (terminal === 'done') yield { type: 'done', reason: 'stop', message: thinkingMessage(reasoning) };
        else yield { type: 'error', reason: 'error', error: thinkingMessage(reasoning) };
      })()) as any,
      sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
    };

    const events = await collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
    assert.equal(events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join(''), reasoning);
    assert.equal(events.find(event => event.type === terminal)[terminal === 'done' ? 'message' : 'error'].content[0].thinking, reasoning);
  }
});

test('temporary sanitizer preserves buffered bytes through locally synthesized terminal errors', async () => {
  for (const mode of ['abort', 'throw', 'eof'] as const) {
    const controller = new AbortController();
    const reasoning = 'Plan\n<!--';
    const thinkingMessage = (thinking: string) => fakeMsg({ content: [{ type: 'thinking', thinking }] });
    const deps: Partial<BalancedRunnerDeps> = {
      startLease: async (input: any) => ({
        schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
        lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
        expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
      } as any),
      finishLease: async () => ({} as any),
      listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
      ingestUsage: async () => ({} as any),
      createUpstream: (() => (async function* () {
        yield { type: 'start', partial: thinkingMessage('') };
        yield { type: 'thinking_start', contentIndex: 0, partial: thinkingMessage('') };
        yield { type: 'thinking_delta', contentIndex: 0, delta: reasoning, partial: thinkingMessage(reasoning) };
        if (mode === 'abort') {
          controller.abort();
          yield { type: 'done', reason: 'stop', message: thinkingMessage(reasoning) };
        } else if (mode === 'throw') {
          throw new Error('iterator failed');
        }
      })()) as any,
      sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
    };

    const events = await collect(createBalancedStreamRunner(deps)(
      MODEL,
      { messages: [] } as any,
      { sessionId: 's1', signal: controller.signal } as any,
    ));
    const terminal = events.find(event => event.type === 'error');
    assert.equal(events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join(''), reasoning, mode);
    assert.equal(terminal.error.content[0].thinking, reasoning, mode);
    assert.equal(terminal.reason, mode === 'abort' ? 'aborted' : 'error', mode);
  }
});

test('temporary sanitizer buffers only the active thinking block', async () => {
  const first = { type: 'thinking', thinking: 'Legitimate suffix <!--' };
  const second = { type: 'thinking', thinking: '<!--' };
  const partial = fakeMsg({ content: [first, second] });
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => ({
      schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
      lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
      expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
    } as any),
    finishLease: async () => ({} as any),
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
    ingestUsage: async () => ({} as any),
    createUpstream: (() => (async function* () {
      yield { type: 'thinking_start', contentIndex: 1, partial: fakeMsg({ content: [first, { type: 'thinking', thinking: '' }] }) };
      yield { type: 'thinking_delta', contentIndex: 1, delta: '<!--', partial };
      yield { type: 'thinking_end', contentIndex: 1, content: '<!--', partial };
      yield { type: 'done', reason: 'stop', message: partial };
    })()) as any,
    sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };

  const events = await collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const deltaEvent = events.find(event => event.type === 'thinking_delta' && event.contentIndex === 1 && event.delta === '');
  assert.equal(deltaEvent.partial.content[0].thinking, first.thinking);
  assert.equal(events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join(''), '<!--');
});

test('temporary sanitizer suppresses a marker-only reasoning stream', async () => {
  const thinkingMessage = (thinking: string) => fakeMsg({ content: [{ type: 'thinking', thinking }] });
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => ({
      schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
      lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
      expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
    } as any),
    finishLease: async () => ({} as any),
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
    ingestUsage: async () => ({} as any),
    createUpstream: (() => (async function* () {
      yield { type: 'thinking_start', contentIndex: 0, partial: thinkingMessage('') };
      yield { type: 'thinking_delta', contentIndex: 0, delta: '<!--', partial: thinkingMessage('<!--') };
      yield { type: 'thinking_delta', contentIndex: 0, delta: ' -->', partial: thinkingMessage('<!-- -->') };
      yield { type: 'thinking_end', contentIndex: 0, content: '<!-- -->', partial: thinkingMessage('<!-- -->') };
      yield { type: 'done', reason: 'stop', message: thinkingMessage('<!-- -->') };
    })()) as any,
    sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };

  const events = await collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  assert.ok(events.filter(event => event.type === 'thinking_delta').every(event => event.delta === ''));
  assert.equal(events.find(event => event.type === 'thinking_end').content, '');
  assert.equal(events.find(event => event.type === 'done').message.content[0].thinking, '');
});

test('temporary sanitizer preserves non-marker reasoning bytes exactly', async () => {
  const reasoning = 'Investigate literal `<!-- -->` output.  \r\n\r\n\r\nKeep spacing.\t';
  const message = fakeMsg({ content: [{ type: 'thinking', thinking: reasoning }] });
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => ({
      schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose,
      lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1',
      expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1',
    } as any),
    finishLease: async () => ({} as any),
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
    ingestUsage: async () => ({} as any),
    createUpstream: (() => (async function* () {
      yield { type: 'done', reason: 'stop', message };
    })()) as any,
    sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };

  const events = await collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const done = events.find(event => event.type === 'done');
  assert.equal(done.message.content[0].thinking, reasoning);
});

test('rotate-on-429: a 429 on slot 1 silently rotates to slot 2 and forwards its success', async () => {
  const { deps, rec } = makeDeps(slot => (slot === '1' ? 'rate-limit' : 'ok'));
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const types = events.map(e => e.type);

  assert.ok(types.includes('done'), 'user should receive slot 2 success');
  assert.ok(!types.includes('error'), 'the slot-1 429 error must be suppressed, not shown');
  assert.deepEqual(rec.leaseCalls, [undefined, '2'], 'auto-select first, then force the other slot');
  assert.equal(rec.upstreamOptions?.length, 2, 'one host-streamer call per leased slot');
  assert.ok(rec.upstreamOptions?.every(options => options.maxRetries === 0), 'hidden same-slot retries are disabled at the host streamer boundary');
  assert.deepEqual(rec.finished, [
    { lease_id: 'lease-1', status: 'failed' },
    { lease_id: 'lease-2', status: 'completed' },
  ]);
});

test('Pi 0.74 streamer makes exactly one wire request per leased slot despite rejecting observers', async () => {
  const piAiRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))));
  assert.equal(JSON.parse(readFileSync(join(piAiRoot, 'package.json'), 'utf8')).version, '0.74.1', 'test must exercise the pinned old runtime');

  const wireByToken = new Map<string, number>();
  const server = createServer((request, response) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    wireByToken.set(token, (wireByToken.get(token) ?? 0) + 1);
    request.resume();
    request.once('end', () => {
      if (token.includes('slot-1')) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '0' });
        response.end('{"detail":"Rate limit exceeded"}');
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":"response.done","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}\n\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const token = (slot: string) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: slot }, marker: `slot-${slot}` })}.x-slot-${slot}`;
  };
  const slotTokens = { '1': token('1'), '2': token('2') };
  const finished: Array<{ lease_id: string; status: string }> = [];
  const leaseCalls: Array<string | undefined> = [];
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => {
      leaseCalls.push(input.preferred_slot);
      const slot = (input.preferred_slot ?? '1') as '1' | '2';
      return { schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: `lease-${slot}`, access_token: slotTokens[slot], slot, label: slot, expires_at: 0, reservation_id: `res-${slot}`, launch_id: `launch-${slot}` } as any;
    },
    finishLease: async (input: any) => { finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => { throw new Error('usage observer rejected with Bearer secret-token'); },
    createUpstream: streamSimpleOpenAICodexResponses as any,
    sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };

  try {
    const model = { ...MODEL, baseUrl: `http://127.0.0.1:${address.port}`, contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
    const events = await Promise.race([
      collect(createBalancedStreamRunner(deps)(model, { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] } as any, {
        sessionId: 'offline-old-streamer',
        onResponse: () => { throw new Error('caller observer rejected with sk-secret-value'); },
      } as any)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('old-runtime streamer test timed out')), 5000)),
    ]);
    assert.equal(events.at(-1)?.type, 'done', `observer failures cannot alter successful terminal behavior: ${JSON.stringify(events.at(-1))}`);
    assert.deepEqual(leaseCalls, [undefined, '2']);
    assert.deepEqual(finished, [
      { lease_id: 'lease-1', status: 'failed' },
      { lease_id: 'lease-2', status: 'completed' },
    ]);
    assert.equal(wireByToken.get(slotTokens['1']), 1, '429 slot must not retry inside the old streamer');
    assert.equal(wireByToken.get(slotTokens['2']), 1, 'successful slot gets one wire request');
    assert.equal([...wireByToken.values()].reduce((sum, count) => sum + count, 0), 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

test('external abort waits for the single in-flight lease finalization before terminating the stream', async () => {
  const ac = new AbortController();
  let resolveFinish!: () => void;
  const finishGate = new Promise<void>((resolve) => { resolveFinish = resolve; });
  let finishCalls = 0;
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => ({ schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: 'lease-1', access_token: 'tok_slot1_xxxxxxxx', slot: '1', label: '1', expires_at: 0, reservation_id: 'res-1', launch_id: 'launch-1' } as any),
    finishLease: async () => { finishCalls++; await finishGate; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_m: any, _c: any) => (async function* () {
      ac.abort();
      await new Promise((resolve) => setImmediate(resolve));
      yield { type: 'done', reason: 'stop', message: fakeMsg() };
    })()) as any,
    sleep: async () => {}, rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };

  let streamSettled = false;
  const collecting = collect(createBalancedStreamRunner(deps)(MODEL, { messages: [] } as any, { sessionId: 's1', signal: ac.signal } as any))
    .then((events) => { streamSettled = true; return events; });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finishCalls, 1, 'abort paths share one lease-finalization call');
  assert.equal(streamSettled, false, 'terminal event waits for durable lease finalization');
  resolveFinish();
  const events = await collecting;
  assert.equal(finishCalls, 1);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal((events.at(-1) as any).reason, 'aborted');
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

test('DEFECT A: a lease failure on the auto-selected slot fails over to a healthy slot', async () => {
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => {
      rec.leaseCalls.push(input.preferred_slot);
      // Round-0 auto-selection (preferred_slot undefined) is broken; the forced slot is healthy.
      if (input.preferred_slot === undefined) throw new Error('selected slot access token refresh failed');
      const slot = input.preferred_slot;
      return { schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: `lease-${slot}`, access_token: `tok_slot${slot}_xxxxxxxx`, slot, label: slot, expires_at: 0, reservation_id: `res-${slot}`, launch_id: `launch-${slot}` } as any;
    },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_m: any, _c: any, options: any) => (async function* () {
      await options.onResponse?.({ status: 200, headers: {} }, _m);
      yield { type: 'done', reason: 'stop', message: fakeMsg() };
    })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const types = events.map(e => e.type);

  assert.ok(types.includes('done'), 'failover should deliver the healthy slot success');
  assert.ok(!types.includes('error'), 'a broken auto-selected slot must not end the turn');
  assert.deepEqual(rec.leaseCalls, [undefined, '2'], 'auto-select first, then force the healthy slot');
});

test('DEFECT A: when every slot fails to lease, the real lease error is surfaced (not the rate-limit string)', async () => {
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => { rec.leaseCalls.push(input.preferred_slot); throw new Error('selected slot access token refresh failed'); },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => ({} as any),
    createUpstream: ((_m: any, _c: any, _options: any) => (async function* () { /* never reached */ })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const errors = events.filter(e => e.type === 'error');

  assert.equal(errors.length, 1, 'exactly one terminal error event');
  const msg = String(errors[0].error.errorMessage);
  assert.match(msg, /refresh failed/, 'surfaces the genuine lease error');
  assert.doesNotMatch(msg, /rate limited/i, 'must NOT mask it with the rate-limit string');
});

test('FIX #2: extractAccountId failure on the auto-selected slot rotates to the healthy slot', async () => {
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const broken: Array<{ slot: string; code: string }> = [];
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => {
      rec.leaseCalls.push(input.preferred_slot);
      const slot = input.preferred_slot ?? '1'; // auto-selection lands on slot 1
      return { schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: `lease-${slot}`, access_token: `tok_slot${slot}_xxxxxxxx`, slot, label: slot, expires_at: 0, reservation_id: `res-${slot}`, launch_id: `launch-${slot}` } as any;
    },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }],
    ingestUsage: async () => ({} as any),
    markBroken: (slot, code) => { broken.push({ slot, code }); },
    createUpstream: ((_m: any, _c: any, options: any) => (async function* () {
      const slot = String(options.apiKey).includes('slot1') ? '1' : '2';
      if (slot === '1') {
        await options.onResponse?.({ status: 401, headers: {} }, _m);
        yield { type: 'error', reason: 'error', error: fakeMsg({ stopReason: 'error', errorMessage: 'Failed to extract accountId from token' }) };
      } else {
        await options.onResponse?.({ status: 200, headers: {} }, _m);
        yield { type: 'done', reason: 'stop', message: fakeMsg() };
      }
    })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const types = events.map(e => e.type);

  assert.ok(types.includes('done'), 'failover should deliver the healthy slot success');
  assert.ok(!types.includes('error'), 'a broken auto-selected slot must not end the turn');
  assert.deepEqual(rec.leaseCalls, [undefined, '2'], 'auto-select first, then force the healthy slot');
  assert.deepEqual(rec.finished, [
    { lease_id: 'lease-1', status: 'failed' },
    { lease_id: 'lease-2', status: 'completed' },
  ]);
  assert.ok(broken.some(b => b.slot === '1' && b.code === 'upstream_no_accountid'), 'the bad slot is quarantined broken');
});

test('FIX #2: all slots fail extractAccountId surfaces the accountId error terminally', async () => {
  const rec: Recorder = { leaseCalls: [], finished: [], sleeps: [] };
  const broken: Array<{ slot: string; code: string }> = [];
  const deps: Partial<BalancedRunnerDeps> = {
    startLease: async (input: any) => {
      rec.leaseCalls.push(input.preferred_slot);
      const slot = input.preferred_slot ?? '1'; // auto-selection lands on slot 1
      return { schema_version: 1, provider: 'bravo-codex-balanced', model: input.model, purpose: input.purpose, lease_id: `lease-${slot}`, access_token: `tok_slot${slot}_xxxxxxxx`, slot, label: slot, expires_at: 0, reservation_id: `res-${slot}`, launch_id: `launch-${slot}` } as any;
    },
    finishLease: async (input: any) => { rec.finished.push({ lease_id: input.lease_id, status: input.status }); return {} as any; },
    // listSlots reflects quarantine: a slot marked broken disappears from the pool,
    // exactly as production loadAccounts() drops broken accounts. Once both slots are
    // quarantined, the second round's "< 2 slots" guard stops further rotation.
    listSlots: async () => [{ slot: '1', primaryRemaining: 80 }, { slot: '2', primaryRemaining: 90 }].filter(s => !broken.some(b => b.slot === s.slot)),
    ingestUsage: async () => ({} as any),
    markBroken: (slot, code) => { broken.push({ slot, code }); },
    createUpstream: ((_m: any, _c: any, options: any) => (async function* () {
      await options.onResponse?.({ status: 401, headers: {} }, _m);
      yield { type: 'error', reason: 'error', error: fakeMsg({ stopReason: 'error', errorMessage: 'Failed to extract accountId from token' }) };
    })()) as any,
    sleep: async (ms: number) => { rec.sleeps.push(ms); },
    rand: () => 0.5, now: () => 1000, cooldown: new Map(),
  };
  const run = createBalancedStreamRunner(deps);
  const events = await collect(run(MODEL, { messages: [] } as any, { sessionId: 's1' } as any));
  const errors = events.filter(e => e.type === 'error');

  assert.equal(errors.length, 1, 'exactly one terminal error to the user');
  assert.match(String(errors[0].error.errorMessage), /extract accountId/i, 'surfaces the genuine accountId error');
  assert.deepEqual(rec.leaseCalls, [undefined, '2'], 'auto first, then force the other slot');
  assert.ok(broken.some(b => b.slot === '1'), 'slot 1 quarantined broken');
  assert.ok(broken.some(b => b.slot === '2'), 'slot 2 quarantined broken');
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
