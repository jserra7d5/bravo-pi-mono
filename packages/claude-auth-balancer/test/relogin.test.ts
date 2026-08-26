import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { readActiveAuthWarnings, setRefreshWarning } from '../src/health.js';
import { reloginClaudeSlot } from '../src/relogin.js';

const roots: string[] = []; after(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));
const DAY = 86_400_000;
function fixture(deadline = Date.now() + 20 * DAY) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-relogin-')); roots.push(root);
  const authswap = path.join(root, 'authswap'); const dir = path.join(authswap, 'providers', 'anthropic', 'credentials'); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.credentials-1-a@x.com.json');
  writeFileSync(file, JSON.stringify({ keep: true, claudeAiOauth: { accessToken: 'old-a', refreshToken: 'old-r', expiresAt: Date.now() + DAY, refreshTokenExpiresAt: deadline, subscriptionType: 'max', unknown: 7 } }, null, 2));
  const state = path.join(root, 'state-root'); const bin = path.join(root, 'bin'); mkdirSync(bin);
  process.env.AUTHSWAP_DIR = authswap; process.env.CLAUDE_AUTH_BALANCER_HOME = state; process.env.PATH = `${bin}:${process.env.PATH}`;
  return { root, authswap, state, file, bin };
}
function fake(f: ReturnType<typeof fixture>, body: string) { const p = path.join(f.bin, 'claude'); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); }
function valid(deadline = Date.now() + 30 * DAY) { return JSON.stringify({ claudeAiOauth: { accessToken: 'new-a', refreshToken: 'new-r', expiresAt: Date.now() + DAY, refreshTokenExpiresAt: deadline, scopes: ['x'] } }); }
const writeLogin = (credential: string, email = 'a@x.com') => `printf '%s' '${credential}' > "$CLAUDE_CONFIG_DIR/.credentials.json"\nprintf '%s' '${JSON.stringify({ oauthAccount: { emailAddress: email } })}' > "$CLAUDE_CONFIG_DIR/.claude.json"`;
async function endpoint(status = 200) { const server = http.createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 200 ? JSON.stringify({ access_token: 'refreshed-a', refresh_token: 'refreshed-r', expires_in: 3600 }) : JSON.stringify({ error: 'invalid_grant' })); }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, close: () => new Promise<void>(r => server.close(() => r())) }; }

test('T6 claude leaves the slot byte-identical for missing, malformed, and wrong-account logins', async () => {
  for (const body of ['exit 1', `echo nope > "$CLAUDE_CONFIG_DIR/.credentials.json"`, writeLogin(valid(), 'other@x.com')]) {
    const f = fixture(), before = readFileSync(f.file); fake(f, body);
    assert.notEqual(await reloginClaudeSlot('1'), 0); assert.deepEqual(readFileSync(f.file), before);
    const temp = path.join(f.state, 'tmp'); assert.equal(existsSync(temp) ? readdirSync(temp).length : 0, 0);
  }
});

test('T7 claude happy path merges fields, writes mode 0600, releases lock, and clears warning', async () => {
  const f = fixture(); fake(f, writeLogin(valid()));
  setRefreshWarning(f.state, '1', { code: 'refresh-terminal', slot: '1', message: 'dead', at: Date.now() });
  assert.equal(await reloginClaudeSlot('1'), 0);
  const stored = JSON.parse(readFileSync(f.file, 'utf8')); assert.equal(stored.keep, true); assert.equal(stored.claudeAiOauth.subscriptionType, 'max'); assert.equal(stored.claudeAiOauth.unknown, 7); assert.equal(stored.claudeAiOauth.accessToken, 'new-a');
  assert.equal(statSync(f.file).mode & 0o777, 0o600); assert.equal(existsSync(`${f.file}.refresh.lock`), false); assert.deepEqual(readActiveAuthWarnings(f.state, [{ slot: '1', email: 'a@x.com', credentialPath: f.file }]), []);
});

test('T8 claude --if-needed refreshes only when deadline is far out and otherwise always logs in', async () => {
  let f = fixture(Date.now() + 20 * DAY), trip = path.join(f.root, 'spawned'); fake(f, `touch ${trip}`); let ep = await endpoint();
  assert.equal(await reloginClaudeSlot('1', true, ep.url), 0); assert.equal(existsSync(trip), false); await ep.close();
  f = fixture(Date.now() + 3 * DAY); trip = path.join(f.root, 'spawned'); fake(f, `touch ${trip}\n${writeLogin(valid())}`); ep = await endpoint();
  assert.equal(await reloginClaudeSlot('1', true, ep.url), 0); assert.equal(existsSync(trip), true); await ep.close();
  f = fixture(Date.now() + 20 * DAY); trip = path.join(f.root, 'spawned'); fake(f, `touch ${trip}\n${writeLogin(valid())}`); ep = await endpoint(400);
  assert.equal(await reloginClaudeSlot('1', true, ep.url), 0); assert.equal(existsSync(trip), true); await ep.close();
});

test('T9 active warning filtering follows the credential write timestamp', () => {
  const f = fixture(); const at = Date.now(); setRefreshWarning(f.state, '1', { code: 'refresh-terminal', slot: '1', message: 'dead', at });
  const account = { slot: '1', email: 'a@x.com', credentialPath: f.file };
  const setExpiry = (expiresAt: number) => writeFileSync(f.file, JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt } }));
  setExpiry(at + 3600_000); assert.deepEqual(readActiveAuthWarnings(f.state, [account], at), []);
  setExpiry(at - 3600_000); assert.equal(readActiveAuthWarnings(f.state, [account], at).length, 1);
  rmSync(f.file); assert.equal(readActiveAuthWarnings(f.state, [account], at).length, 1);
});

test('T11 claude lock contention retries then fails without writing through the lock', { timeout: 12_000 }, async () => {
  const f = fixture(), before = readFileSync(f.file); fake(f, writeLogin(valid())); writeFileSync(`${f.file}.refresh.lock`, '');
  assert.equal(await reloginClaudeSlot('1'), 1); assert.deepEqual(readFileSync(f.file), before);
});
