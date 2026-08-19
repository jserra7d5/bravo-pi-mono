// Proxy behaviour against a REAL local HTTP upstream.
//
// The fake is placed at the wire, not at a decision seam: the balancer performs
// genuine socket I/O, real header handling, real gzip, and a real streaming
// relay. Nothing is stubbed inside the code under test.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, test } from 'node:test';

import { writeSlotObservation } from '../src/accounts.js';
import { AffinityStore } from '../src/affinity.js';
import { MetricsStore } from '../src/metrics.js';
import { SESSION_HEADER, startProxy } from '../src/proxy.js';

const cleanups: (() => void)[] = [];
after(() => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
});

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build an authswap-shaped credential tree with fake, clearly-not-real tokens. */
function fakeAuthswap(slots: { slot: string; email: string; token: string; expiresInMs?: number }[]): string {
  const root = tmpRoot('cab-authswap-');
  const dir = path.join(root, 'providers', 'anthropic', 'credentials');
  mkdirSync(dir, { recursive: true });
  for (const s of slots) {
    writeFileSync(
      path.join(dir, `.credentials-${s.slot}-${s.email}.json`),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: s.token,
          refreshToken: `fake-refresh-${s.slot}`,
          expiresAt: Date.now() + (s.expiresInMs ?? 3_600_000),
          subscriptionType: 'max',
        },
      }),
    );
  }
  return root;
}

type UpstreamCall = { authorization?: string; path: string; body: string };

function sseBody(model: string, cacheRead: number, output: number): string {
  return (
    `event: message_start\n` +
    `data: {"type":"message_start","message":{"id":"m","model":"${model}","usage":{"input_tokens":7,"cache_read_input_tokens":${cacheRead},"cache_creation_input_tokens":0}}}\n\n` +
    `event: message_delta\n` +
    `data: {"type":"message_delta","usage":{"output_tokens":${output}}}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`
  );
}

/** A local stand-in for api.anthropic.com. `handler` decides each response. */
async function upstream(
  handler: (call: UpstreamCall, res: http.ServerResponse) => void,
  usageHandler?: (call: UpstreamCall, res: http.ServerResponse) => void,
): Promise<{ url: string; calls: UpstreamCall[]; probes: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const probes: UpstreamCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const call: UpstreamCall = {
        authorization: req.headers.authorization,
        path: req.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      if (call.path === '/api/oauth/usage') {
        probes.push(call);
        if (usageHandler) {
          usageHandler(call, res);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          five_hour: { utilization: 10, resets_at: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() },
          seven_day: { utilization: 10, resets_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
        }));
        return;
      }
      calls.push(call);
      handler(call, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls, probes };
}

async function boot(options: {
  authswapRoot: string;
  upstreamUrl: string;
  allowOverage?: boolean;
  metrics?: boolean;
  upstreamHeaderTimeoutMs?: number;
  stateRoot?: string;
}): Promise<{ url: string; stateRoot: string }> {
  const stateRoot = options.stateRoot ?? tmpRoot('cab-state-');
  const { server, url } = await startProxy({
    port: 0,
    upstream: options.upstreamUrl,
    stateRoot,
    authswapRoot: options.authswapRoot,
    allowOverage: options.allowOverage,
    metrics: options.metrics ?? false,
    upstreamHeaderTimeoutMs: options.upstreamHeaderTimeoutMs,
  });
  cleanups.push(() => server.close());
  return { url, stateRoot };
}

async function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-supplied', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const OK_HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.10',
  'anthropic-ratelimit-unified-7d-utilization': '0.10',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
};

test('a pre-header stall is bounded without imposing a streaming-body deadline', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const up = await upstream((_call, _res) => { /* deliberately never send headers */ });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, upstreamHeaderTimeoutMs: 75 });
  const started = Date.now();
  const out = await post(url, { model: 'claude-opus-5' });
  assert.equal(out.status, 502);
  assert.ok(Date.now() - started < 1000, 'pre-header dead transport must fail promptly');
});

test('a body stream stays alive beyond the short header timeout once headers arrive', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const up = await upstream((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: one\n\n');
    setTimeout(() => res.end('event: done\ndata: two\n\n'), 150);
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, upstreamHeaderTimeoutMs: 40 });
  const out = await post(url, { model: 'claude-opus-5', stream: true });
  assert.equal(out.status, 200);
  assert.match(out.text, /data: two/, 'body remained connected after header deadline elapsed');
});

test('a pre-header socket abort fails the request without retrying messages', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const up = await upstream((_call, res) => res.socket?.destroy());
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });
  const out = await post(url, { model: 'claude-opus-5' });
  assert.equal(out.status, 502);
  assert.equal(up.calls.length, 1, 'messages must not be blindly replayed');
});

test('the client-supplied Authorization is replaced with the selected account token', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-slot-1' }]);
  const up = await upstream((_call, res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...OK_HEADERS });
    res.end('{"ok":true}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const out = await post(url, { model: 'claude-opus-5', messages: [] });
  assert.equal(out.status, 200);
  assert.equal(up.calls.length, 1);
  assert.equal(up.calls[0]!.authorization, 'Bearer tok-slot-1');
  assert.notEqual(up.calls[0]!.authorization, 'Bearer client-supplied');
});

test('the request body is forwarded byte-for-byte', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const up = await upstream((_c, res) => {
    res.writeHead(200, OK_HEADERS);
    res.end('{}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const payload = {
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ name: 'x', description: 'y', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  };
  await post(url, payload);
  assert.equal(
    up.calls[0]!.body,
    JSON.stringify(payload),
    'any rewrite here would invalidate the cached prefix',
  );
});

test('a session sticks to one account across many requests', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await upstream((_c, res) => {
    res.writeHead(200, OK_HEADERS);
    res.end('{}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  for (let i = 0; i < 6; i += 1) {
    await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'session-alpha' });
  }
  const tokens = new Set(up.calls.map(c => c.authorization));
  assert.equal(tokens.size, 1, `expected one account, saw ${[...tokens].join(', ')}`);
});

test('fresh non-Fable routing waits for probes and drains the earliest weekly reset', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await upstream((_call, res) => {
    res.writeHead(200, OK_HEADERS).end('{}');
  }, (call, res) => {
    const busy = call.authorization === 'Bearer tok-1';
    const fiveHourReset = new Date(Date.now() + (busy ? 5 : 1) * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(Date.now() + (busy ? 24 : 144) * 60 * 60 * 1000).toISOString();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      five_hour: { utilization: busy ? 80 : 1, resets_at: fiveHourReset },
      seven_day: { utilization: busy ? 80 : 1, resets_at: weeklyReset },
    }));
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's1' });

  assert.equal(
    up.calls[0]!.authorization,
    'Bearer tok-1',
    'earlier weekly reset wins despite worse utilization, headroom, and 5h reset',
  );
  assert.equal(up.probes.length, 2);
  assert.ok(up.probes.every(call => call.body === ''), 'probe made no messages/body call');
});

test('real proxy retains non-Fable affinity at 99% then switches on hard exhaustion', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const stateRoot = tmpRoot('cab-drain-affinity-');
  const reset = (Date.now() + 24 * 60 * 60 * 1000) / 1000;
  writeSlotObservation(stateRoot, {
    slot: '1',
    observedAt: Date.now(),
    claims: { byId: { '7d': { id: '7d', utilization: 0.99, reset } } },
  });
  writeSlotObservation(stateRoot, {
    slot: '2',
    observedAt: Date.now(),
    claims: { byId: { '7d': { id: '7d', utilization: 0.1, reset: reset + 86_400 } } },
  });
  new AffinityStore({ stateRoot }).touch('drain-session', '1', 'claude-opus-5');
  const up = await upstream((call, res) => {
    const exhausted = call.authorization === 'Bearer tok-1';
    res.writeHead(200, {
      ...OK_HEADERS,
      'anthropic-ratelimit-unified-7d-utilization': exhausted ? '1.0' : '0.10',
    }).end('{}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot });

  assert.equal((await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'drain-session' })).status, 200);
  assert.equal((await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'drain-session' })).status, 200);
  assert.deepEqual(up.calls.map(call => call.authorization), ['Bearer tok-1', 'Bearer tok-2']);
});

// --- injected faults ------------------------------------------------------

test('a crossed persisted reset triggers a probe before fresh lease selection', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const stateRoot = tmpRoot('cab-reset-probe-');
  const now = Date.now();
  writeSlotObservation(stateRoot, {
    slot: '1',
    observedAt: now - 1,
    claims: { byId: { '5h': { id: '5h', utilization: 0.9, reset: (now - 1000) / 1000 } } },
  });
  const order: string[] = [];
  const up = await upstream((_call, res) => {
    order.push('messages');
    res.writeHead(200, OK_HEADERS).end('{}');
  }, (_call, res) => {
    order.push('usage');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      five_hour: { utilization: 10, resets_at: new Date(now + 5 * 60 * 60 * 1000).toISOString() },
    }));
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot });

  assert.equal((await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'reset-session' })).status, 200);
  assert.deepEqual(order, ['usage', 'messages']);
});

test('an evacuating fallback that preserves affinity never waits for or sends a due probe', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const stateRoot = tmpRoot('cab-affinity-fallback-');
  const reset = (Date.now() + 2 * 60 * 60 * 1000) / 1000;
  for (const slot of ['1', '2']) {
    writeSlotObservation(stateRoot, {
      slot,
      observedAt: 0,
      claims: { byId: { '7d': { id: '7d', utilization: 0.96, reset } } },
    });
  }
  new AffinityStore({ stateRoot }).touch('hot-session', '2', 'claude-opus-5');
  const up = await upstream((call, res) => {
    assert.equal(call.authorization, 'Bearer tok-2');
    res.writeHead(200, OK_HEADERS).end('{}');
  }, (_call, _res) => { /* a probe would stall until its absolute deadline */ });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot });
  const started = Date.now();

  assert.equal((await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'hot-session' })).status, 200);
  assert.ok(Date.now() - started < 500, 'affinity-preserving fallback did not wait on probe timeout');
  assert.equal(up.probes.length, 0);
});

test('a 429 rotates to the other account within the same client request', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await upstream((call, res) => {
    if (call.authorization === 'Bearer tok-1') {
      res.writeHead(429, { 'anthropic-ratelimit-unified-7d-utilization': '1.0' });
      res.end('{"type":"error"}');
      return;
    }
    res.writeHead(200, OK_HEADERS);
    res.end('{"ok":true}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const out = await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's1' });
  assert.equal(out.status, 200, 'the client never saw the 429');
  assert.equal(out.text, '{"ok":true}');
  assert.deepEqual(
    up.calls.map(c => c.authorization),
    ['Bearer tok-1', 'Bearer tok-2'],
  );
});

test('when every account 429s the client gets an honest 429, not a hang', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await upstream((_c, res) => {
    res.writeHead(429, {});
    res.end('{"type":"error"}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const out = await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's1' });
  assert.equal(out.status, 429);
  assert.match(out.text, /claude-auth-balancer/);
});

test('an expired credential is skipped rather than sent to the wire', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-expired', expiresInMs: -1000 },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await upstream((_c, res) => {
    res.writeHead(200, OK_HEADERS);
    res.end('{}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  await post(url, { model: 'claude-opus-5' });
  assert.equal(up.calls[0]!.authorization, 'Bearer tok-2');
  assert.ok(!up.calls.some(c => c.authorization === 'Bearer tok-expired'));
});

test('with no usable account the proxy answers 429 instead of failing open', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1', expiresInMs: -1000 },
  ]);
  const up = await upstream((_c, res) => {
    res.writeHead(200, {});
    res.end('{}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const out = await post(url, { model: 'claude-opus-5' });
  assert.equal(out.status, 429);
  assert.equal(up.calls.length, 0, 'nothing was sent upstream');
});

test('an upstream connection failure surfaces as 502, not a hang', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  // Bind then immediately close so the port refuses connections.
  const dead = http.createServer();
  await new Promise<void>(r => dead.listen(0, '127.0.0.1', () => r()));
  const port = (dead.address() as { port: number }).port;
  await new Promise<void>(r => dead.close(() => r()));

  const { url } = await boot({ authswapRoot, upstreamUrl: `http://127.0.0.1:${port}` });
  const out = await post(url, { model: 'claude-opus-5' });
  assert.equal(out.status, 502);
});

// --- streaming + metrics --------------------------------------------------

test('a gzipped SSE stream reaches the client intact and is still measured', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const body = sseBody('claude-opus-5', 261_443, 57);
  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
  const up = await upstream((_c, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
      ...OK_HEADERS,
    });
    res.end(gz);
  });
  const { url, stateRoot } = await boot({ authswapRoot, upstreamUrl: up.url, metrics: true });

  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'stream-session' },
    body: JSON.stringify({ model: 'claude-opus-5', stream: true }),
  });
  // fetch transparently gunzips; the payload must be byte-identical to upstream's
  assert.equal(res.status, 200);
  assert.equal(await res.text(), body);

  // give the observation branch a tick to land
  await new Promise(r => setTimeout(r, 150));

  const store = new MetricsStore(stateRoot);
  try {
    const rows = store.query('SELECT slot, model, cache_read_tokens, output_tokens, cost_usd FROM requests') as Record<
      string,
      number | string
    >[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['slot'], '1');
    assert.equal(rows[0]!['model'], 'claude-opus-5');
    assert.equal(rows[0]!['cache_read_tokens'], 261_443);
    assert.equal(rows[0]!['output_tokens'], 57);
    assert.ok(Number(rows[0]!['cost_usd']) > 0, 'cost was attributed');
  } finally {
    store.close();
  }
});

test('metrics attribute usage to the account that actually served the request', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await upstream((call, res) => {
    if (call.authorization === 'Bearer tok-1') {
      res.writeHead(429, {});
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...OK_HEADERS });
    res.end(sseBody('claude-opus-5', 1000, 10));
  });
  const { url, stateRoot } = await boot({ authswapRoot, upstreamUrl: up.url, metrics: true });

  await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'attr' });
  await new Promise(r => setTimeout(r, 150));

  const store = new MetricsStore(stateRoot);
  try {
    const rows = store.query('SELECT slot, cache_read_tokens FROM requests') as Record<string, number | string>[];
    assert.equal(rows.length, 1, 'the 429 attempt did not record a usage row');
    assert.equal(rows[0]!['slot'], '2', 'usage belongs to the account that served it');
    assert.equal(rows[0]!['cache_read_tokens'], 1000);
  } finally {
    store.close();
  }
});
