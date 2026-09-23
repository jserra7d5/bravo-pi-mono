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

import { readSlotObservation, readSlotPlan, writeSlotObservation } from '../src/accounts.js';
import { AffinityStore } from '../src/affinity.js';
import { handlePostCompact } from '../src/compaction.js';
import { MetricsStore } from '../src/metrics.js';
import { parseClaims } from '../src/claims.js';
import { readDemandModel } from '../src/demand.js';
import { AttemptStore } from '../src/attempts.js';
import { SESSION_HEADER, startProxy } from '../src/proxy.js';

// The operator's own reserve (set in ~/.claude/settings.json) must not reach
// the accounts these tests build.
delete process.env['CLAUDE_AUTH_BALANCER_WEEKLY_RESERVE'];

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
): Promise<{ url: string; calls: UpstreamCall[]; probes: UpstreamCall[]; profiles: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const probes: UpstreamCall[] = [];
  const profiles: UpstreamCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const call: UpstreamCall = {
        authorization: req.headers.authorization,
        path: req.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      if (call.path === '/api/oauth/profile') {
        profiles.push(call);
        // tok-5x-* tokens belong to a Max 5x account; everything else is 20x.
        const tier = call.authorization?.startsWith('Bearer tok-5x-') ? 'default_claude_max_5x' : 'default_claude_max_20x';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ organization: { rate_limit_tier: tier } }));
        return;
      }
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
  return { url: `http://127.0.0.1:${port}`, calls, probes, profiles };
}

async function boot(options: {
  authswapRoot: string;
  upstreamUrl: string;
  allowOverage?: boolean;
  metrics?: boolean;
  upstreamHeaderTimeoutMs?: number;
  stateRoot?: string;
  usageSweepIntervalMs?: number;
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
    usageSweepIntervalMs: options.usageSweepIntervalMs,
    requireGatewayAuth: false,
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

test('fresh non-Fable routing waits for probes and picks the account ahead of pace', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await upstream((_call, res) => {
    res.writeHead(200, OK_HEADERS).end('{}');
  }, (call, res) => {
    const busy = call.authorization === 'Bearer tok-1';
    const fiveHourReset = new Date(Date.now() + (busy ? 5 : 1) * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(Date.now() + (busy ? 140 : 143) * 60 * 60 * 1000).toISOString();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      // Both slots reset the same day and sit in the same 5h bucket so this
      // test isolates pacing; those terms have dedicated policy tests.
      // Unprobed, both slots read as full and slot order would pick tok-1.
      five_hour: { utilization: busy ? 20 : 1, resets_at: fiveHourReset },
      seven_day: { utilization: busy ? 80 : 1, resets_at: weeklyReset },
    }));
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's1' });

  assert.equal(
    up.calls[0]!.authorization,
    'Bearer tok-2',
    '99% left is further ahead of pace than 20% left over the same six days',
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

/**
 * The exact body api.anthropic.com returns for an account whose windows have
 * rolled over and not been reopened. Captured 2026-09-05 from four live Max
 * accounts: every window nulls out, and only real traffic reopens one.
 */
const IDLE_USAGE_BODY = JSON.stringify({
  five_hour: { utilization: 0.0, resets_at: null, limit_dollars: null, locked_reason: null },
  seven_day: { utilization: 0.0, resets_at: null, limit_dollars: null, locked_reason: null },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, utilization: null },
});

test('an idle account is re-read by the background sweep with no client traffic at all', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const stateRoot = tmpRoot('cab-usage-sweep-');
  // Both accounts last observed long ago, with a 5h window that has since
  // rolled over: the exact state that reads "stale" until traffic lands.
  const stale = Date.now() - 20 * 60 * 60 * 1000;
  for (const slot of ['1', '2']) {
    writeSlotObservation(stateRoot, {
      slot,
      observedAt: stale,
      claims: { byId: { '5h': { id: '5h', utilization: 0.8, reset: stale / 1000 } } },
    });
  }
  const up = await upstream(
    (_call, res) => { res.writeHead(200, OK_HEADERS).end('{}'); },
    (_call, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(IDLE_USAGE_BODY);
    },
  );
  await boot({ authswapRoot, upstreamUrl: up.url, stateRoot });

  const deadline = Date.now() + 4000;
  let observations: (number | undefined)[] = [];
  while (Date.now() < deadline) {
    observations = ['1', '2'].map(slot => readSlotObservation(stateRoot, slot)?.observedAt);
    if (observations.every(at => at !== undefined && at > stale)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  assert.ok(
    observations.every(at => at !== undefined && at > stale),
    `sweep did not refresh both idle observations: ${JSON.stringify(observations)}`,
  );
  assert.equal(up.calls.length, 0, 'the sweep must not spend inference to read usage');
  // The rolled-over 80% reading is replaced by the server's own idle reading,
  // not merely projected forward by the local cadence model.
  for (const slot of ['1', '2']) {
    const claim = readSlotObservation(stateRoot, slot)?.claims?.byId['5h'];
    assert.equal(claim?.utilization, 0);
    assert.equal(claim?.reset, undefined, 'an unopened window has no reset to report');
  }
});

test('the sweep reads each account\'s plan tier without spending inference', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-20x-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-5x-2' },
  ]);
  const up = await upstream((_call, res) => { res.writeHead(200, OK_HEADERS).end('{}'); });
  const { stateRoot } = await boot({ authswapRoot, upstreamUrl: up.url });

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !(readSlotPlan(stateRoot, '1') && readSlotPlan(stateRoot, '2'))) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(readSlotPlan(stateRoot, '1')?.tier, 'default_claude_max_20x');
  assert.equal(readSlotPlan(stateRoot, '2')?.tier, 'default_claude_max_5x');
  assert.equal(up.calls.length, 0, 'reading the plan must not spend inference');
});

test('the sweep repeats on its interval rather than running once at startup', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const up = await upstream(
    (_call, res) => { res.writeHead(200, OK_HEADERS).end('{}'); },
    // A 200 carrying no window this balancer maps: the probe reports 'empty',
    // records nothing, and takes no backoff, so the slot stays due every tick.
    (_call, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ seven_day_cowork: null }));
    },
  );
  // The daemon runs for weeks. A sweep that fires only at startup leaves every
  // window rollover after boot unobserved, which is the whole failure this
  // exists to prevent — so one probe is not enough to pass.
  await boot({ authswapRoot, upstreamUrl: up.url, usageSweepIntervalMs: 30 });
  const deadline = Date.now() + 3000;
  while (up.probes.length < 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(up.probes.length >= 3, `sweep did not recur: ${up.probes.length} probe(s)`);
});

test('the sweep opens the 5h window on the next spill target, once', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const stateRoot = tmpRoot('cab-sweep-warm-');
  const hour = 60 * 60 * 1000;
  const inSeconds = (ms: number) => (Date.now() + ms) / 1000;
  // Slot 1 is working (window open, cool) and resets first, so it takes fresh
  // picks; slot 2 is idle with no 5h window. Both were read seconds ago, so the
  // sweep probes neither.
  writeSlotObservation(stateRoot, {
    slot: '1',
    observedAt: Date.now(),
    claims: { byId: {
      '5h': { id: '5h', utilization: 0.01, reset: inSeconds(4 * hour) },
      '7d': { id: '7d', utilization: 0.3, reset: inSeconds(48 * hour) },
    } },
  });
  writeSlotObservation(stateRoot, {
    slot: '2',
    observedAt: Date.now(),
    claims: { byId: {
      '5h': { id: '5h', utilization: 0, status: 'allowed' },
      '7d': { id: '7d', utilization: 0, reset: inSeconds(120 * hour) },
    } },
  });
  const reset = Math.floor(inSeconds(5 * hour));
  const up = await upstream((_call, res) => {
    res.writeHead(200, { ...OK_HEADERS, 'anthropic-ratelimit-unified-5h-utilization': '0.0', 'anthropic-ratelimit-unified-5h-reset': String(reset) }).end('{}');
  });
  await boot({ authswapRoot, upstreamUrl: up.url, stateRoot, usageSweepIntervalMs: 30 });
  const deadline = Date.now() + 2000;
  while (readSlotObservation(stateRoot, '2')?.claims?.byId['5h']?.reset === undefined && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(readSlotObservation(stateRoot, '2')?.claims?.byId['5h']?.reset, reset);
  // Several more sweeps: an open window is not warmed again.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(up.calls.map(c => `${c.authorization} ${c.path}`), ['Bearer tok-2 /v1/messages']);
});

test('the sweep skips an account a recent request already observed', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const stateRoot = tmpRoot('cab-sweep-due-');
  const future = (Date.now() + 4 * 60 * 60 * 1000) / 1000;
  // Slot 1 was observed seconds ago with windows that have NOT rolled over;
  // slot 2 has never been observed at all.
  writeSlotObservation(stateRoot, {
    slot: '1',
    observedAt: Date.now(),
    claims: { byId: {
      '5h': { id: '5h', utilization: 0.1, reset: future },
      '7d': { id: '7d', utilization: 0.1, reset: future },
    } },
  });
  const up = await upstream(
    (_call, res) => { res.writeHead(200, OK_HEADERS).end('{}'); },
    (_call, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(IDLE_USAGE_BODY);
    },
  );
  await boot({ authswapRoot, upstreamUrl: up.url, stateRoot, usageSweepIntervalMs: 30 });
  const deadline = Date.now() + 2000;
  while (up.probes.length < 4 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(up.probes.length > 0, 'the sweep ran at all');
  assert.deepEqual(
    [...new Set(up.probes.map(probe => probe.authorization))],
    ['Bearer tok-2'],
    'a slot observed inside the staleness horizon must not be re-probed every tick',
  );
});

test('a failing sweep probe reaches slots no request touches, without breaking requests', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const stateRoot = tmpRoot('cab-sweep-fault-');
  new AffinityStore({ stateRoot }).touch('pinned-session', '1', 'claude-opus-5');
  const up = await upstream(
    (_call, res) => { res.writeHead(200, OK_HEADERS).end('{}'); },
    (_call, res) => { res.writeHead(500).end('upstream usage is down'); },
  );
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot, usageSweepIntervalMs: 30 });

  // Slot 2 serves nothing: the session is pinned to slot 1. Only the sweep can
  // reach it, so requiring a slot-2 probe makes this test fail if the sweep is
  // deleted — the request path alone can never satisfy it.
  const deadline = Date.now() + 2000;
  while (!up.probes.some(probe => probe.authorization === 'Bearer tok-2') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(
    up.probes.some(probe => probe.authorization === 'Bearer tok-2'),
    'the sweep never reached the unrouted slot',
  );
  // Every probe 500s, repeatedly, while the proxy keeps serving.
  const out = await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'pinned-session' });
  assert.equal(out.status, 200);
  assert.equal(up.calls.at(-1)?.authorization, 'Bearer tok-1');
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
  // The background sweep probes every account on its own schedule; this test is
  // about the REQUEST path, so it is disabled here to keep the count honest.
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot, usageSweepIntervalMs: 0 });
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

test('429 rotation attempts are durable without double-counting final usage rows', async () => {
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
    res.end(sseBody('claude-opus-5', 2000, 20));
  });
  const { url, stateRoot } = await boot({ authswapRoot, upstreamUrl: up.url, metrics: true });

  await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'durable-attempts' });
  await new Promise(r => setTimeout(r, 150));

  const metrics = new MetricsStore(stateRoot);
  const attempts = new AttemptStore(stateRoot);
  try {
    const usageRows = metrics.query('SELECT slot, cache_read_tokens FROM requests') as Record<string, number | string>[];
    assert.equal(usageRows.length, 1, 'final usage is request-level, not attempt-level');
    assert.equal(usageRows[0]!['slot'], '2');

    const attemptRows = attempts.query(
      "SELECT outcome, slot_id FROM auth_balancer_attempts WHERE outcome IN ('rate_limited_pre_content', 'rotated_pre_content', 'completed') ORDER BY id",
    ) as Record<string, string>[];
    assert.deepEqual(attemptRows.map(row => row.outcome), ['rate_limited_pre_content', 'rotated_pre_content', 'completed']);
    assert.deepEqual(attemptRows.map(row => row.slot_id), ['1', '1', '2']);
  } finally {
    metrics.close();
    attempts.close();
  }
});

// --- generation transport failure ------------------------------------------
//
// Faithful seam: the upstream is a real socket that really dies mid-request,
// so the proxy's own error path, retry, and relay all run for real. Provenance
// for this behaviour is 34 transport failures over two days on the live
// deployment — 33 `bad record mac`, one ECONNRESET, every one at `pre-header`
// — each of which reached Claude Code as a hard 502.

/** An upstream that kills the connection for the first `n` calls. */
async function flakyUpstream(n: number, onServe?: (res: http.ServerResponse) => void) {
  let killed = 0;
  return upstream((_call, res) => {
    if (killed < n) {
      killed += 1;
      res.socket?.destroy();
      return;
    }
    if (onServe) {
      onServe(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...OK_HEADERS });
    res.end(sseBody('claude-opus-5', 1000, 10));
  });
}

test('a generation connection that dies after request bytes are written is terminal by default', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await flakyUpstream(1);
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const res = await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'transport-retry' });

  assert.equal(res.status, 502, 'the proxy does not replay non-idempotent generation after wire start');
  assert.equal(up.calls.length, 1, 'no re-send after request bytes may have reached upstream');
});

test('conservative generation retry policy does not spend the retry budget after wire start', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const up = await flakyUpstream(2);
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const res = await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'transport-retry-2' });

  assert.equal(res.status, 502);
  assert.equal(up.calls.length, 1);
});

test('a transport failure that never recovers ends as one 502, not an account rotation', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const up = await flakyUpstream(99);
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url });

  const res = await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'transport-dead' });

  assert.equal(res.status, 502);
  assert.equal(up.calls.length, 1, 'the budget is not used for after-wire generation failures');
  const accounts = new Set(up.calls.map(c => c.authorization));
  assert.equal(accounts.size, 1, 'a dead socket is not a reason to abandon the warm account');
});

test('a header timeout is NOT re-sent — the inference may already be running', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  // Accepts the request and never answers: the request is plausibly in flight
  // upstream, so re-sending would bill a second inference.
  const up = await upstream(() => {});
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, upstreamHeaderTimeoutMs: 200 });

  const res = await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'header-timeout' });

  assert.equal(res.status, 502);
  assert.equal(up.calls.length, 1, 'a timed-out inference is never duplicated');
});


test('a running proxy rebalances after PostCompact and then holds the new lease', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const stateRoot = tmpRoot('cab-compaction-live-');
  const now = Date.now();
  const resets: Record<string, number> = {
    '1': (now + 6 * 86_400_000) / 1000,
    '2': (now + 3 * 86_400_000) / 1000,
  };
  for (const slot of ['1', '2']) writeSlotObservation(stateRoot, {
    slot, observedAt: now,
    claims: { byId: { '7d': { id: '7d', utilization: 0.2, reset: resets[slot] } } },
  });
  new AffinityStore({ stateRoot }).touch('compact-session', '1', 'claude-opus-5');
  const up = await upstream((call, res) => {
    const slot = call.authorization === 'Bearer tok-1' ? '1' : '2';
    res.writeHead(200, {
      ...OK_HEADERS,
      'anthropic-ratelimit-unified-7d-reset': String(resets[slot]),
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    }).end('{}');
  });
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot, usageSweepIntervalMs: 0 });
  const request = () => post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'compact-session' });
  assert.equal((await request()).status, 200, 'summary uses the warm slot');
  assert.equal(handlePostCompact({ hook_event_name: 'PostCompact', session_id: 'compact-session' }, stateRoot), 1);
  assert.equal((await request()).status, 200, 'first compacted request ranks fresh');
  assert.equal((await request()).status, 200, 'later requests hold the new lease');
  assert.deepEqual(up.calls.map(call => call.authorization), ['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2']);
});

// --- demand model ------------------------------------------------------------

/** Nine days of steady traffic on slot 1 (~0.05 W20/h), recorded the way the proxy records it. */
function seedHistory(stateRoot: string, now: number): void {
  const store = new MetricsStore(stateRoot);
  let u5 = 0;
  let u7 = 0.05;
  for (let t = now - 9 * 86_400_000; t < now - 60_000; t += 15 * 60_000) {
    u5 = (u5 + 0.05) % 1;
    u7 = u7 >= 0.9 ? 0.05 : u7 + 0.013;
    store.record({
      ts: t, slot: '1', sessionHash: `s${Math.floor(t / 10_800_000)}`, model: 'claude-opus-5',
      endpoint: '/v1/messages', status: 200, decision: 'fresh', durationMs: 100,
      usage: { inputTokens: 0, outputTokens: 2_000_000 },
      claims: parseClaims({
        'anthropic-ratelimit-unified-5h-utilization': u5.toFixed(2),
        'anthropic-ratelimit-unified-7d-utilization': u7.toFixed(2),
      }),
    });
  }
  store.close();
}

function observe(stateRoot: string, slot: string, weeklyInH: number, now: number): void {
  writeSlotObservation(stateRoot, {
    slot,
    observedAt: now,
    claims: parseClaims({
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.05',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 4 * 3_600_000) / 1000)),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.10',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + weeklyInH * 3_600_000) / 1000)),
      'anthropic-ratelimit-unified-overage-status': 'rejected',
    }),
  });
}

test('the daemon learns demand from its own metrics and routes on it', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  const now = Date.now();
  const stateRoot = tmpRoot('cab-demand-');
  seedHistory(stateRoot, now);
  // Control: without the history, the same warm session holds on slot 2.
  const bare = tmpRoot('cab-demand-bare-');
  observe(bare, '1', 3, now);
  observe(bare, '2', 100, now);
  new AffinityStore({ stateRoot: bare, now: () => now - 7 * 3_600_000 }).touch('warm-one', '2', 'claude-opus-5');
  new AffinityStore({ stateRoot: bare }).touch('warm-one', '2', 'claude-opus-5');
  const control = await upstream((_call, res) => res.writeHead(200, OK_HEADERS).end('{}'));
  const held = await boot({ authswapRoot, upstreamUrl: control.url, stateRoot: bare, metrics: true, usageSweepIntervalMs: 0 });
  assert.equal((await post(held.url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'warm-one' })).status, 200);
  assert.equal(control.calls[0]!.authorization, 'Bearer tok-2', 'no history, no demand terms: it holds');

  // Slot 1's weekly resets in 3h with 90% left: far more than one account's
  // 5h window can burn by then. Slot 2 has days, and the demand to fill them.
  observe(stateRoot, '1', 3, now);
  observe(stateRoot, '2', 100, now);
  const up = await upstream((_call, res) => res.writeHead(200, OK_HEADERS).end('{}'));
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot, metrics: true, usageSweepIntervalMs: 0 });

  const demand = readDemandModel(stateRoot, Date.now())!;
  assert.ok(demand.hourly, 'nine days of history is a profile');

  // A warm session on slot 2, settled there for seven hours. Only the demand
  // terms can move it: slot 2 is serviceable, so a plain hold keeps it.
  new AffinityStore({ stateRoot, now: () => now - 7 * 3_600_000 }).touch('warm-one', '2', 'claude-opus-5');
  new AffinityStore({ stateRoot }).touch('warm-one', '2', 'claude-opus-5');
  assert.equal((await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'warm-one' })).status, 200);
  assert.equal(up.calls[0]!.authorization, 'Bearer tok-1', 'pulled onto the expiring account');
  assert.equal(new AffinityStore({ stateRoot }).lookup('warm-one', 'claude-opus-5'), '1');
});

test('a forecast the daemon can no longer refresh stops steering once stale', async () => {
  const authswapRoot = fakeAuthswap([
    { slot: '1', email: 'a@x.com', token: 'tok-1' },
    { slot: '2', email: 'b@x.com', token: 'tok-2' },
  ]);
  // Boot three hours in the past, then move to now: the tokens stay live.
  const start = Date.now() - 3 * 3_600_000;
  let clock = start;
  const stateRoot = tmpRoot('cab-demand-stale-');
  seedHistory(stateRoot, start);
  const up = await upstream((_call, res) => res.writeHead(200, OK_HEADERS).end('{}'));
  const { server, url } = await startProxy({
    port: 0, upstream: up.url, stateRoot, authswapRoot, metrics: true,
    usageSweepIntervalMs: 0, requireGatewayAuth: false, now: () => clock,
  });
  cleanups.push(() => server.close());
  assert.ok(readDemandModel(stateRoot, clock)?.hourly, 'built at startup');
  // Three hours on, with no rebuild since (the sweep is off): the same pull
  // setup as above must now hold.
  clock = Date.now();
  observe(stateRoot, '1', 3, clock);
  observe(stateRoot, '2', 100, clock);
  new AffinityStore({ stateRoot, now: () => clock - 7 * 3_600_000 }).touch('warm-one', '2', 'claude-opus-5');
  new AffinityStore({ stateRoot, now: () => clock }).touch('warm-one', '2', 'claude-opus-5');
  assert.equal((await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 'warm-one' })).status, 200);
  assert.equal(up.calls[0]!.authorization, 'Bearer tok-2');
});

test('a demand model that cannot be persisted is not used, and routing carries on without it', async () => {
  const authswapRoot = fakeAuthswap([{ slot: '1', email: 'a@x.com', token: 'tok-1' }]);
  const now = Date.now();
  const stateRoot = tmpRoot('cab-demand-fault-');
  seedHistory(stateRoot, now);
  observe(stateRoot, '1', 100, now);
  // The target path is a directory: the atomic rename fails.
  mkdirSync(path.join(stateRoot, 'state', 'demand.json'), { recursive: true });
  const up = await upstream((_call, res) => res.writeHead(200, OK_HEADERS).end('{}'));
  const { url } = await boot({ authswapRoot, upstreamUrl: up.url, stateRoot, metrics: true, usageSweepIntervalMs: 0 });
  assert.equal((await post(url, { model: 'claude-opus-5' }, { [SESSION_HEADER]: 's' })).status, 200);
  assert.equal(readDemandModel(stateRoot, Date.now()), undefined);
});
