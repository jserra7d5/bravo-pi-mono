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
): Promise<{ url: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const call: UpstreamCall = {
        authorization: req.headers.authorization,
        path: req.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      calls.push(call);
      handler(call, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls };
}

async function boot(options: {
  authswapRoot: string;
  upstreamUrl: string;
  allowOverage?: boolean;
  metrics?: boolean;
}): Promise<{ url: string; stateRoot: string }> {
  const stateRoot = tmpRoot('cab-state-');
  const { server, url } = await startProxy({
    port: 0,
    upstream: options.upstreamUrl,
    stateRoot,
    authswapRoot: options.authswapRoot,
    allowOverage: options.allowOverage,
    metrics: options.metrics ?? false,
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

test('distinct sessions are free to land on different accounts', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  // slot 1 nearly spent, slot 2 fresh -> a new session should prefer slot 2
  const up = await upstream((call, res) => {
    const busy = call.authorization === 'Bearer tok-1';
    res.writeHead(200, {
      'anthropic-ratelimit-unified-5h-utilization': busy ? '0.80' : '0.01',
      'anthropic-ratelimit-unified-7d-utilization': busy ? '0.80' : '0.01',
    });
    res.end('{}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's1' });
  await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's2' });
  await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's3' });

  const last = up.calls.at(-1)!;
  assert.equal(last.authorization, 'Bearer tok-2', 'new sessions route to the healthier account');
});

// --- injected faults ------------------------------------------------------

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
