import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBalancedStreamRunner } from '../extensions/pi/index.js';
import { serveLeaseService, leaseServiceCall } from '../src/lease-service.js';
import { listReservations, listRateLimitCooldowns, getUsage } from '../src/index.js';

const model = { id: 'gpt-6-luna', provider: 'bravo-codex-balanced', api: 'openai-codex-responses', baseUrl: 'https://x' } as any;
function jwt(id: string) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: id }, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
}
function msg() { return { role: 'assistant', content: [], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6-luna', stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any; }
async function collect(stream: AsyncIterable<any>) { const events: any[] = []; for await (const event of stream) events.push(event); return events; }

test('real loopback lease service drives runner, rotates and fails closed without local state', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hub-'));
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-client-'));
  const prior = { url: process.env.CODEX_AUTH_BALANCER_URL, key: process.env.CODEX_AUTH_BALANCER_KEY_COMMAND, home: process.env.HOME, state: process.env.CODEX_AUTH_BALANCER_HOME };
  let server: Awaited<ReturnType<typeof serveLeaseService>> | undefined;
  try {
    for (const slot of ['a', 'b']) {
      const dir = path.join(root, 'accounts', slot);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ access_token: jwt(slot), expires_at: Date.now() + 86400000 }));
    }
    server = await serveLeaseService(root, 0);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    process.env.CODEX_AUTH_BALANCER_URL = url;
    process.env.CODEX_AUTH_BALANCER_KEY_COMMAND = `node -p "JSON.parse(require('fs').readFileSync('${path.join(root, 'runtime', 'lease-service-credential.json')}')).nonce"`;
    process.env.HOME = local;
    process.env.CODEX_AUTH_BALANCER_HOME = local;
    const slots: string[] = [];
    const runner = createBalancedStreamRunner({ createUpstream: ((_m: any, _c: any, options: any) => (async function* () {
      const payload = JSON.parse(Buffer.from(String(options.apiKey).split('.')[1], 'base64url').toString('utf8'));
      const slot = payload['https://api.openai.com/auth'].chatgpt_account_id as string;
      slots.push(slot);
      if (slots.length === 2) {
        await options.onResponse?.({ status: 429, headers: {} }, _m);
        yield { type: 'error', reason: 'error', error: { ...msg(), stopReason: 'error', errorMessage: 'rate limit' } };
      } else {
        await options.onResponse?.({ status: 200, headers: { 'x-codex-rate-limits': JSON.stringify({ rate_limits: { primary: { remaining_percent: 70, window_minutes: 300 } } }) } }, _m);
        yield { type: 'done', reason: 'stop', message: msg() };
      }
    })()) as any, sleep: async () => {} });
    const first = await collect(runner(model, { messages: [] } as any, { sessionId: 'first' } as any));
    assert.ok(first.some(e => e.type === 'done'), JSON.stringify(first));
    const second = await collect(runner(model, { messages: [] } as any, { sessionId: 'second' } as any));
    assert.ok(second.some(e => e.type === 'done'), JSON.stringify(second));
    assert.equal(slots.length, 3);
    assert.notEqual(slots[1], slots[2]);
    assert.ok(listRateLimitCooldowns({ stateRoot: root }).some(c => c.slot === slots[1]));
    assert.ok((await listReservations({ stateRoot: root, includeInactive: true })).some(r => r.state === 'completed'));
    let ingested = false;
    for (let i = 0; i < 30; i++) {
      ingested = (await getUsage({ stateRoot: root })).accounts.some(a => a.usage?.primary?.remainingPercent === 70);
      if (ingested) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ingested, 'hub must persist response usage');
    assert.deepEqual(await fs.readdir(local), []);
    const noncePath = path.join(root, 'runtime', 'lease-service-credential.json');
    assert.equal((await fs.stat(noncePath)).mode & 0o777, 0o600);
    const unauthorized = await fetch(`${url}/listSlots`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong' } });
    assert.equal(unauthorized.status, 401);
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    const other = path.join(root, 'other-hub');
    await fs.mkdir(path.join(other, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(other, 'runtime', 'lease-service-credential.json'), JSON.stringify({ nonce: 'changed-nonce' }), { mode: 0o600 });
    server = await serveLeaseService(other, address.port);
    const counter = path.join(root, 'rekeys.txt');
    process.env.CODEX_AUTH_BALANCER_KEY_COMMAND = `node -e "require('fs').appendFileSync('${counter}','1'); process.stdout.write('wrong')"`;
    await assert.rejects(leaseServiceCall('listSlots'), /401/);
    assert.equal(await fs.readFile(counter, 'utf8'), '1', '401 must trigger exactly one re-key');
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    const failed = await collect(createBalancedStreamRunner({ createUpstream: () => { throw new Error('upstream reached'); } })(model, { messages: [] } as any, { sessionId: 'down' } as any));
    assert.match(JSON.stringify(failed), /Codex lease service unreachable.*127\.0\.0\.1/);
    assert.deepEqual(await fs.readdir(local), []);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    for (const [key, value] of Object.entries({ CODEX_AUTH_BALANCER_URL: prior.url, CODEX_AUTH_BALANCER_KEY_COMMAND: prior.key, HOME: prior.home, CODEX_AUTH_BALANCER_HOME: prior.state })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(local, { recursive: true, force: true });
  }
});
