import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { checkCodex, recoverAbandonedRelogin, reloginCodexSlot } from '../src/relogin.js';

const roots: string[] = []; after(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));
const jwt = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
function auth(id = 'acct-1', refresh = 'refresh-old', expiry = Date.now() + 86_400_000) {
  return { tokens: { id_token: jwt({ auth_time: 1_700_000_000, 'https://api.openai.com/profile.email': 'a@x.com' }), access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: id } }), refresh_token: refresh, account_id: id, expiry_date: expiry } };
}
function fixture(): { root: string; slot: string; file: string; bin: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-relogin-')); roots.push(root);
  const slot = path.join(root, 'accounts', '1'); mkdirSync(slot, { recursive: true });
  const file = path.join(slot, 'auth.json'); writeFileSync(file, JSON.stringify(auth(), null, 2));
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  return { root, slot, file, bin };
}
function fake(f: ReturnType<typeof fixture>, body: string) {
  const file = path.join(f.bin, 'codex'); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755);
  process.env.PATH = `${f.bin}:${process.env.PATH}`;
}
async function endpoint(status = 200) {
  const server = http.createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 200 ? JSON.stringify({ access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }), refresh_token: 'refresh-new', expires_in: 3600 }) : JSON.stringify({ error: 'invalid_grant' })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/token`;
  return { url, close: () => new Promise<void>(r => server.close(() => r())) };
}

test('T1 codex restores a byte-identical credential after SIGKILL, SIGINT, and SIGTERM mid-login', async () => {
  for (const signal of ['SIGKILL', 'SIGINT', 'SIGTERM'] as const) {
    const f = fixture(); const before = readFileSync(f.file);
    fake(f, 'rm "$CODEX_HOME/auth.json"; echo deleted >&2; exec sleep 30');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'relogin', '--slot', '1', '--json'], { cwd: process.cwd(), env: { ...process.env, CODEX_AUTH_BALANCER_HOME: f.root }, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolve, reject) => { let seen = false; child.stderr.on('data', b => { if (String(b).includes('deleted')) { seen = true; resolve(); } }); child.on('error', reject); child.on('close', () => { if (!seen) reject(new Error('login child exited before deleting auth.json')); }); });
    child.kill(signal); await new Promise(r => child.once('close', r));
    recoverAbandonedRelogin(f.root, '1');
    assert.deepEqual(readFileSync(f.file), before, signal);
  }
});

test('T2 codex restores after the login child deletes auth and exits non-zero', async () => {
  const f = fixture(), before = readFileSync(f.file); fake(f, 'rm "$CODEX_HOME/auth.json"; exit 1');
  const result = await reloginCodexSlot({ stateRoot: f.root, slot: '1' });
  assert.equal(result.ok, false); assert.deepEqual(readFileSync(f.file), before); assert.equal(existsSync(`${f.file}.relogin-backup`), false);
});

test('T3 codex rejects a wrong-identity credential and restores the original bytes', async () => {
  const f = fixture(), before = readFileSync(f.file);
  fake(f, `cat > "$CODEX_HOME/auth.json" <<'EOF'\n${JSON.stringify(auth('other'))}\nEOF`);
  const result = await reloginCodexSlot({ stateRoot: f.root, slot: '1' });
  assert.equal(result.ok, false); assert.deepEqual(readFileSync(f.file), before);
});

test('T4 codex happy path installs matching new bytes and removes the backup', async () => {
  const f = fixture(); const ep = await endpoint();
  fake(f, `if [ "$1" = login ]; then cat > "$CODEX_HOME/auth.json" <<'EOF'\n${JSON.stringify(auth('acct-1', 'login-new'))}\nEOF\nfi`);
  const result = await reloginCodexSlot({ stateRoot: f.root, slot: '1', tokenUrl: ep.url }); await ep.close();
  assert.equal(result.ok, true); assert.equal(existsSync(`${f.file}.relogin-backup`), false); assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).tokens.refresh_token, 'refresh-new');
});

test('T5 codex --if-needed uses the real local token endpoint and falls through on invalid_grant', async () => {
  const good = fixture(); const trip = path.join(good.root, 'spawned'); fake(good, `touch ${trip}; exit 1`);
  let ep = await endpoint();
  assert.equal((await reloginCodexSlot({ stateRoot: good.root, slot: '1', ifNeeded: true, tokenUrl: ep.url })).ok, true); assert.equal(existsSync(trip), false); await ep.close();
  const bad = fixture(); const tripped = path.join(bad.root, 'spawned'); fake(bad, `touch ${tripped}; rm "$CODEX_HOME/auth.json"; exit 1`);
  ep = await endpoint(400);
  await reloginCodexSlot({ stateRoot: bad.root, slot: '1', ifNeeded: true, tokenUrl: ep.url }); assert.equal(existsSync(tripped), true); await ep.close();
});

test('T12 a login credential without expiry is healthy before refresh and gets expiry backfilled', async () => {
  const f = fixture(); const noExpiry = auth(); delete (noExpiry.tokens as any).expiry_date;
  writeFileSync(f.file, JSON.stringify(noExpiry)); assert.equal(checkCodex(f.root).accounts[0]?.level, 'ok');
  const ep = await endpoint();
  fake(f, `if [ "$1" = login ]; then cat > "$CODEX_HOME/auth.json" <<'EOF'\n${JSON.stringify(noExpiry)}\nEOF\nfi`);
  assert.equal((await reloginCodexSlot({ stateRoot: f.root, slot: '1', tokenUrl: ep.url })).ok, true); await ep.close();
  assert.equal(typeof JSON.parse(readFileSync(f.file, 'utf8')).tokens.expiry_date, 'number');
});
