import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROACTIVE_REFRESH_LEAD_MS, cleanupLaunch, ensureFreshTokens, finishTokenLease, getDbStatus, getSlotTokenHealth, getUsage, ingestDirectPiLiveUsage, ingestLiveUsage, isProcessAlive, listReservations, prepareLaunch, refreshUsage, resolveStateRoot, selectSingleActivePiSlot, shouldStealRefreshLock, startTokenLease, syncBack, unbrickSlot } from '../src/index.js';
import codexBalancedProvider, { getBalancedCodexModels, loadHostingPiAiRuntime, mapBalancedCodexModels, resolveHostingPiPackageRoot } from '../extensions/pi/index.js';
import { getModels } from '@earendil-works/pi-ai/compat';

const exec = promisify(execFile);

// ── refresh seam ───────────────────────────────────────────────────────────
// The balancer owns the token exchange, so its true boundary is the wire.
// Stubbing fetch runs the REAL refreshCodexToken — endpoint URL, form body,
// status handling, response-field validation, and the exact error strings
// classifyOAuthRefreshError keys off — plus every caller above it.
//
// The previous seam faked openaiCodexOAuthProvider.refreshToken, handing the
// lease path a pre-correct credential and exercising none of that. It is also
// why a dead import went unnoticed for ten days: a test that replaces the
// symbol it is meant to be testing cannot notice the symbol is undefined.
type TokenStub = { restore(): void; readonly calls: URLSearchParams[] };
function stubTokenEndpoint(handler: (body: URLSearchParams) => Response | Promise<Response>): TokenStub {
  const original = globalThis.fetch;
  const calls: URLSearchParams[] = [];
  (globalThis as any).fetch = async (url: unknown, init: any) => {
    assert.equal(String(url), 'https://auth.openai.com/oauth/token', 'refresh must hit the Codex token endpoint');
    const body = new URLSearchParams(String(init?.body ?? ''));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.ok(body.get('client_id'), 'refresh must send a client_id');
    calls.push(body);
    return handler(body);
  };
  return { restore: () => { (globalThis as any).fetch = original; }, calls };
}
const tokenOk = (access: string, refresh: string, expiresInSeconds = 3600) =>
  new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresInSeconds }), { status: 200, headers: { 'content-type': 'application/json' } });
const tokenHttpError = (status: number, body: string) => new Response(body, { status });
const invalidGrant = () => tokenHttpError(400, '{"error":"invalid_grant"}');
async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cab-')); }
async function writeJson(p: string, v: unknown) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(v)); }
function fakeCodexJwt(accountId = 'acct-test', expSeconds?: number): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, ...(expSeconds ? { exp: expSeconds } : {}) })}.sig`;
}
// Real 3-part base64url JWT whose payload parses fine but carries NO chatgpt_account_id claim.
function fakeClaimlessJwt(expSeconds?: number): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'no-account-claim', ...(expSeconds ? { exp: expSeconds } : {}) })}.sig`;
}
async function eventually<T>(fn: () => Promise<T | undefined>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== undefined) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`condition not met within ${timeoutMs}ms${last === undefined ? '' : `; last=${String(last)}`}`);
}

async function writeFakeCodexBin(dir: string) {
  const bin = path.join(dir, 'codex');
  await fs.writeFile(bin, `#!/usr/bin/env node\nconst fs=require('fs'), path=require('path');\nconst home=process.env.CODEX_HOME;\nconst session=path.join(home,'sessions','2026','05','28','probe.jsonl');\nfs.mkdirSync(path.dirname(session), {recursive:true});\nfs.appendFileSync(session, JSON.stringify({timestamp:new Date().toISOString(), type:'event_msg', payload:{type:'token_count', rate_limits:{primary:{used_percent:23, window_minutes:300, resets_at:2000}, secondary:{used_percent:84, window_minutes:10080, resets_at:3000}, plan_type:'pro', rate_limit_reached_type:null}}})+'\\n');\nconsole.log('OK');\n`, { mode: 0o755 });
  return bin;
}

test('resolveStateRoot uses env override and default suffix', () => {
  assert.equal(resolveStateRoot({ CODEX_AUTH_BALANCER_HOME: '/tmp/x' } as NodeJS.ProcessEnv), '/tmp/x');
  assert.match(resolveStateRoot({} as NodeJS.ProcessEnv), /\.bravo\/codex-auth-balancer$/);
});

test('prepareLaunch creates isolated auth and syncBack success cleans via caller', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'old' });
  const p = await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
  assert.equal(p.env.CODEX_HOME, path.join(iso, 'codex'));
  await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: 'new' });
  const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'auth.json'), 'utf8')).access_token, 'new');
});

test('syncBack copies Pi auth updates back to the selected slot', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'codex-old' });
  await writeJson(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), { type: 'oauth', refresh: 'pi-old' });
  await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
  await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: 'codex-new' });
  await writeJson(path.join(iso, 'pi-agent', 'auth.json'), { type: 'oauth', refresh: 'pi-new' });
  const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'auth.json'), 'utf8')).access_token, 'codex-new');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), 'utf8')).refresh, 'pi-new');
});

test('syncBack detects Pi auth conflicts', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'codex-old' });
  await writeJson(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), { type: 'oauth', refresh: 'pi-old' });
  await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
  await writeJson(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), { type: 'oauth', refresh: 'other' });
  const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(r.conflict, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), 'utf8')).refresh, 'other');
});

test('syncBack conflict retains isolated dir', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'old' });
  await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'other' });
  await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: 'new' });
  const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(r.conflict, true);
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'old' });
  const retry = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(retry.conflict, true);
  const inactive = await listReservations({ stateRoot: root, includeInactive: true });
  assert.equal(inactive[0]?.state, 'conflict');
  assert.ok(await fs.stat(iso));
});

test('concurrent syncBack for same generation is serialized by compare-and-swap', async () => {
  const root = await tmp(); const iso1 = await tmp(); const iso2 = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'old' });
  await prepareLaunch(iso1, { stateRoot: root, slot: 's1' });
  await prepareLaunch(iso2, { stateRoot: root, slot: 's1' });
  await writeJson(path.join(iso1, 'codex', 'auth.json'), { access_token: 'new-1' });
  await writeJson(path.join(iso2, 'codex', 'auth.json'), { access_token: 'new-2' });
  const results = await Promise.all([syncBack(iso1, { stateRoot: root, slot: 's1' }), syncBack(iso2, { stateRoot: root, slot: 's1' })]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.conflict).length, 1);
  assert.match(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'auth.json'), 'utf8')).access_token, /^new-[12]$/);
});

test('CLI concurrent sync-back for same generation allows only one writer', async () => {
  const root = await tmp(); const iso1 = await tmp(); const iso2 = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'old' });
  await prepareLaunch(iso1, { stateRoot: root, slot: 's1' });
  await prepareLaunch(iso2, { stateRoot: root, slot: 's1' });
  await writeJson(path.join(iso1, 'codex', 'auth.json'), { access_token: 'cli-1' });
  await writeJson(path.join(iso2, 'codex', 'auth.json'), { access_token: 'cli-2' });
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const env = { ...process.env, CODEX_AUTH_BALANCER_HOME: root };
  const [one, two] = await Promise.all([
    exec(process.execPath, [cli, 'sync-back', '--json', '--isolated-dir', iso1, '--slot', 's1'], { env, timeout: 5000 }),
    exec(process.execPath, [cli, 'sync-back', '--json', '--isolated-dir', iso2, '--slot', 's1'], { env, timeout: 5000 }),
  ]);
  const results = [JSON.parse(one.stdout), JSON.parse(two.stdout)];
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.conflict).length, 1);
  assert.match(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'auth.json'), 'utf8')).access_token, /^cli-[12]$/);
});

test('CLI JSON redacts token material', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'super-secret-token' });
  const { stdout } = await exec(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'prepare-launch', '--json', '--isolated-dir', iso, '--slot', 's1'], { env: { ...process.env, CODEX_AUTH_BALANCER_HOME: root }, timeout: 5000 });
  assert.doesNotMatch(stdout, /super-secret-token/);
  assert.equal(JSON.parse(stdout).slot, 's1');
  assert.doesNotMatch(stdout, /auth_hash|expected_generation|[a-f0-9]{64}/i);
});

test('cleanupLaunch refuses unprepared directories', async () => {
  const root = await tmp(); const iso = await tmp();
  await assert.rejects(cleanupLaunch(iso), /missing balancer metadata/);
  await assert.rejects(prepareLaunch(path.join(root, 'nested'), { stateRoot: root }), /inside stateRoot/);
});

test('prepareLaunch removes isolated dir after partial secret copy failure', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  await fs.mkdir(path.join(iso, 'pi-agent', 'auth.json'), { recursive: true });
  await assert.rejects(prepareLaunch(iso, { stateRoot: root, slot: 's1' }));
  await assert.rejects(fs.stat(iso), /ENOENT/);
});

test('getUsage distinguishes active Pi from active Codex account attribution', async () => {
  const root = await tmp(); const home = await tmp();
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await writeJson(path.join(root, 'accounts', 'pi-slot', 'auth.json'), { access_token: 'tok-pi' });
    await writeJson(path.join(root, 'accounts', 'pi-slot', 'pi-openai-codex.json'), { accountId: 'acct-pi' });
    await writeJson(path.join(root, 'accounts', 'codex-slot', 'auth.json'), { access_token: 'tok-codex' });
    await writeJson(path.join(root, 'accounts', 'codex-slot', 'pi-openai-codex.json'), { accountId: 'acct-codex' });
    await writeJson(path.join(home, '.pi', 'agent', 'auth.json'), { 'openai-codex': { accountId: 'acct-pi' } });
    await writeJson(path.join(home, '.codex', 'auth.json'), { accountId: 'acct-codex' });
    const usage = await getUsage({ stateRoot: root });
    const bySlot = Object.fromEntries(usage.accounts.map(account => [account.slot, account]));
    assert.equal(bySlot['pi-slot'].activePi, true);
    assert.equal(bySlot['pi-slot'].activeCodex, false);
    assert.equal(bySlot['codex-slot'].activePi, false);
    assert.equal(bySlot['codex-slot'].activeCodex, true);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  }
});

test('direct Pi live ingestion writes to activePi slot and skips activeCodex-only', async () => {
  assert.equal(selectSingleActivePiSlot({ generatedAt: 1, staleAfterMs: 1, accounts: [
    { slot: 'pi-slot', label: 'pi-slot', activePi: true, activeCodex: false, status: 'ok' },
    { slot: 'codex-slot', label: 'codex-slot', activePi: false, activeCodex: true, status: 'ok' },
  ] }), 'pi-slot');

  const root = await tmp(); const home = await tmp();
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await writeJson(path.join(root, 'accounts', 'pi-slot', 'auth.json'), { access_token: 'tok-pi' });
    await writeJson(path.join(root, 'accounts', 'pi-slot', 'pi-openai-codex.json'), { accountId: 'acct-pi' });
    await writeJson(path.join(root, 'accounts', 'codex-slot', 'auth.json'), { access_token: 'tok-codex' });
    await writeJson(path.join(root, 'accounts', 'codex-slot', 'pi-openai-codex.json'), { accountId: 'acct-codex' });
    await writeJson(path.join(home, '.pi', 'agent', 'auth.json'), { 'openai-codex': { accountId: 'acct-pi' } });
    await writeJson(path.join(home, '.codex', 'auth.json'), { accountId: 'acct-codex' });

    const result = await ingestDirectPiLiveUsage({
      stateRoot: root,
      headers: { 'x-codex-rate-limits': JSON.stringify({ rate_limits: { primary: { remaining_percent: 42, reset_at: 1_780_000_000 } } }) },
    });
    assert.deepEqual(result, { ok: true, ingested: true, slot: 'pi-slot' });
    const usage = await getUsage({ stateRoot: root });
    const bySlot = Object.fromEntries(usage.accounts.map(account => [account.slot, account]));
    assert.equal(bySlot['pi-slot'].usage?.source, 'live');
    assert.equal(bySlot['pi-slot'].usage?.primary?.remainingPercent, 42);
    assert.equal(bySlot['pi-slot'].usage?.primary?.resetAt, 1_780_000_000_000);
    assert.equal(bySlot['codex-slot'].usage?.source, 'unknown');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  }
});

test('getUsage marks old v2 cache stale by generated_at', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  await writeJson(path.join(root, 'cache', 'usage.json'), { schema_version: 2, generated_at: Date.now() - 60_000, accounts: { s1: { slot: 's1', primary: { label: 'primary', remainingPercent: 42 } } } });
  const usage = await getUsage({ stateRoot: root, staleAfterMs: 1 });
  assert.equal(usage.error, 'stale');
  assert.equal(usage.accounts[0].usage?.primary?.remainingPercent, 42);
});

test('usage cache migration preserves legacy windows shape', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  await writeJson(path.join(root, 'cache', 'usage.json'), {
    schema_version: 2,
    generated_at: Date.now(),
    accounts: { s1: { slot: 's1', windows: { primary: { label: 'primary', remainingPercent: 55 }, secondary: { label: 'secondary', remaining_percent: 66 } } } },
  });
  const usage = await getUsage({ stateRoot: root });
  assert.equal(usage.accounts[0].usage?.primary?.remainingPercent, 55);
  assert.equal(usage.accounts[0].usage?.secondary?.remainingPercent, 66);
});

test('usage cache migration accepts raw legacy slot map', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  await writeJson(path.join(root, 'cache', 'usage.json'), {
    s1: { windows: { primary: { label: 'primary', remainingPercent: 12 }, secondary: { label: 'secondary', remaining_percent: 34 } } },
  });
  const usage = await getUsage({ stateRoot: root });
  assert.equal(usage.accounts[0].usage?.primary?.remainingPercent, 12);
  assert.equal(usage.accounts[0].usage?.secondary?.remainingPercent, 34);
  assert.ok(usage.generatedAt > 0);
});

test('ingestLiveUsage normalizes live metadata for an explicit slot', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  const result = await ingestLiveUsage({ stateRoot: root, slot: 's1', rateLimits: { rate_limits: { primary: { remaining_percent: 64, reset_at: 1_780_000_000_000 }, secondary: { remaining_percent: 25, reset_in_seconds: 99 } } } });
  assert.deepEqual(result, { ok: true, ingested: true, slot: 's1' });
  const usage = await getUsage({ stateRoot: root });
  assert.equal(usage.accounts[0].usage?.source, 'live');
  assert.equal(usage.accounts[0].usage?.primary?.remainingPercent, 64);
  assert.equal(usage.accounts[0].usage?.primary?.resetAt, 1_780_000_000_000);
  assert.equal(usage.accounts[0].usage?.secondary?.remainingPercent, 25);
  assert.equal(usage.accounts[0].usage?.secondary?.resetInSeconds, 99);
});

test('ingestLiveUsage normalizes camelCase live reset timestamps at write boundary', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  await ingestLiveUsage({ stateRoot: root, slot: 's1', rateLimits: { primary: { remainingPercent: 93, resetAt: 1_780_000_000 }, secondary: { remainingPercent: 76, resetAt: 1_780_864_078 } } });
  const usage = await getUsage({ stateRoot: root });
  assert.equal(usage.accounts[0].usage?.primary?.remainingPercent, 93);
  assert.equal(usage.accounts[0].usage?.primary?.resetAt, 1_780_000_000_000);
  assert.equal(usage.accounts[0].usage?.secondary?.remainingPercent, 76);
  assert.equal(usage.accounts[0].usage?.secondary?.resetAt, 1_780_864_078_000);
});

test('ingestLiveUsage converts used_percent and accepts JSON rate-limit headers', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  await ingestLiveUsage({
    stateRoot: root,
    slot: 's1',
    headers: {
      authorization: 'Bearer live-secret-token',
      'x-codex-rate-limits': JSON.stringify({ rate_limits: { primary: { used_percent: 12.5, resets_at: 2000 }, secondary: { used_percent: 100, resets_at: 2_000_000_000_000 } } }),
    },
  });
  const usage = await getUsage({ stateRoot: root });
  assert.equal(usage.accounts[0].usage?.primary?.remainingPercent, 87.5);
  assert.equal(usage.accounts[0].usage?.primary?.resetAt, 2_000_000);
  assert.equal(usage.accounts[0].usage?.secondary?.remainingPercent, 0);
  assert.equal(usage.accounts[0].usage?.secondary?.resetAt, 2_000_000_000_000);
  const dbBytes = await fs.readFile(path.join(root, 'balancer.sqlite3'));
  assert.equal(dbBytes.includes(Buffer.from('live-secret-token')), false);
  assert.equal(dbBytes.includes(Buffer.from('authorization')), false);
});

test('ingestLiveUsage attributes by reservation/launch and skips ambiguous unattributed live data', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  const prepared = await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
  const skipped = await ingestLiveUsage({ stateRoot: root, rateLimits: { rate_limits: { primary: { remaining_percent: 1 } } } });
  assert.equal(skipped.ingested, false);
  assert.equal(skipped.skipped, 'ambiguous_attribution');
  const attributed = await ingestLiveUsage({ stateRoot: root, reservation_id: prepared.metadata.reservation_id, launch_id: prepared.metadata.launch_id, rateLimits: { rate_limits: { primary: { used_percent: 33 } } } });
  assert.deepEqual(attributed, { ok: true, ingested: true, slot: 's1' });
  const usage = await getUsage({ stateRoot: root });
  assert.equal(usage.accounts[0].usage?.source, 'live');
  assert.equal(usage.accounts[0].usage?.primary?.remainingPercent, 67);
});


test('refreshUsage probes Codex CLI for both slots and stores remaining percent', async () => {
  const root = await tmp(); const binDir = await tmp();
  await writeFakeCodexBin(binDir);
  await writeJson(path.join(root, 'accounts', 'a', 'auth.json'), { OPENAI_API_KEY: 'tok-a' });
  await writeJson(path.join(root, 'accounts', 'b', 'auth.json'), { OPENAI_API_KEY: 'tok-b' });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  try {
    const usage = await refreshUsage({ stateRoot: root });
    assert.equal(usage.accounts.length, 2);
    for (const account of usage.accounts) {
      assert.equal(account.status, 'ok');
      assert.equal(account.usage?.primary?.remainingPercent, 77);
      assert.equal(account.usage?.primary?.resetAt, 2_000_000);
      assert.equal(account.usage?.secondary?.remainingPercent, 16);
      assert.equal(account.usage?.secondary?.resetAt, 3_000_000);
    }
    const status = await getDbStatus({ stateRoot: root });
    assert.equal(status.accountCount, 2);
    assert.ok(status.generatedAt);
    await assert.rejects(fs.readFile(path.join(root, 'cache', 'usage.json'), 'utf8'), /ENOENT/);
  } finally {
    process.env.PATH = oldPath;
  }
});


test('prepareLaunch does not hard-reject stale zero windows', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'low', 'auth.json'), { access_token: 'tok-low' });
  await writeJson(path.join(root, 'accounts', 'stale-zero', 'auth.json'), { access_token: 'tok-stale' });
  await writeJson(path.join(root, 'cache', 'usage.json'), {
    schema_version: 2,
    generated_at: Date.now() - 60 * 60_000,
    accounts: {
      low: { slot: 'low', status: 'ok', updatedAt: Date.now() - 60 * 60_000, primary: { label: 'primary', remainingPercent: 75 }, secondary: { label: 'secondary', remainingPercent: 16 } },
      'stale-zero': { slot: 'stale-zero', status: 'ok', updatedAt: Date.now() - 60 * 60_000, primary: { label: 'primary', remainingPercent: 100 }, secondary: { label: 'secondary', remainingPercent: 0 } },
    },
  });
  const prepared = await prepareLaunch(await tmp(), { stateRoot: root });
  assert.equal(prepared.slot, 'stale-zero');
  assert.deepEqual(prepared.selection?.penalties, ['stale_usage']);
});

test('prepareLaunch reserves active slots atomically and distributes concurrent launches', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'a', 'auth.json'), { access_token: 'tok-a' });
  await writeJson(path.join(root, 'accounts', 'b', 'auth.json'), { access_token: 'tok-b' });
  await writeJson(path.join(root, 'cache', 'usage.json'), {
    schema_version: 2,
    generated_at: Date.now(),
    accounts: {
      a: { slot: 'a', status: 'ok', updatedAt: Date.now(), primary: { label: 'primary', remainingPercent: 100 }, secondary: { label: 'secondary', remainingPercent: 100, resetAt: Date.now() + 7 * 24 * 60 * 60_000 } },
      b: { slot: 'b', status: 'ok', updatedAt: Date.now(), primary: { label: 'primary', remainingPercent: 100 }, secondary: { label: 'secondary', remainingPercent: 100, resetAt: Date.now() + 7 * 24 * 60 * 60_000 } },
    },
  });
  const [one, two] = await Promise.all([prepareLaunch(await tmp(), { stateRoot: root }), prepareLaunch(await tmp(), { stateRoot: root })]);
  assert.deepEqual([one.slot, two.slot].sort(), ['a', 'b']);
  const reservations = await listReservations({ stateRoot: root });
  assert.equal(reservations.length, 2);
  assert.ok(one.metadata.reservation_id);
  assert.ok(two.metadata.launch_id);
});

// NOTE: the legacy "pi-balanced launches Pi with isolated auth" test was removed when the
// copied-credential launch path was retired. The thin-launcher behavior (marker env, state
// home, verbatim argv, no isolated auth files, nested-launch guard) is now covered by
// test/pi-balanced.test.ts.

// NOTE: The syncBack newest-wins merge was removed (refresh-token rollback hazard): access-token
// exp does not order the opaque single-use refresh token, so a merge could roll the refresh token
// back and brick the slot. The two former "merges a strictly-newer child credential" tests were
// removed with it. Conflicts are now always retained; the retain coverage below is what remains.
test('syncBack retains canonical (no merge) when a child has a newer-exp token on conflict', async () => {
  // Both codex and Pi conflicts must RETAIN canonical even when the child token is strictly newer:
  // exp ordering must never advance the slot, because it cannot order the refresh token.
  {
    const root = await tmp(); const iso = await tmp();
    const earlierExp = Math.floor((Date.now() + 60_000) / 1000);
    const laterExp = Math.floor((Date.now() + 3_600_000) / 1000);
    await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: fakeCodexJwt('acct', earlierExp) });
    await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
    const canon = fakeCodexJwt('acct', earlierExp + 1);
    await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: canon });
    await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: fakeCodexJwt('acct', laterExp) });
    const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
    assert.equal(r.conflict, true);
    assert.equal(r.ok, false);
    assert.equal(r.retainedDir, iso);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'auth.json'), 'utf8')).access_token, canon);
  }
  {
    const root = await tmp(); const iso = await tmp();
    const earlierExp = Math.floor((Date.now() + 60_000) / 1000);
    const laterExp = Math.floor((Date.now() + 3_600_000) / 1000);
    await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'codex-old' });
    await writeJson(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), { access: fakeCodexJwt('acct', earlierExp), refresh: 'pi-old' });
    await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
    await writeJson(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), { access: fakeCodexJwt('acct', earlierExp + 1), refresh: 'pi-other' });
    await writeJson(path.join(iso, 'pi-agent', 'auth.json'), { 'openai-codex': { access: fakeCodexJwt('acct', laterExp), refresh: 'pi-new' } });
    const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
    assert.equal(r.conflict, true);
    assert.equal(r.ok, false);
    const canon = JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), 'utf8'));
    assert.equal(canon.refresh, 'pi-other');
  }
});

test('syncBack does NOT regress to an older or claimless child on conflict', async () => {
  // (i) child exp <= canonical exp => no merge, existing conflict preserved.
  {
    const root = await tmp(); const iso = await tmp();
    const olderExp = Math.floor((Date.now() + 60_000) / 1000);
    const newerExp = Math.floor((Date.now() + 3_600_000) / 1000);
    await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: fakeCodexJwt('acct', olderExp) });
    await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
    // Canonical rotated to a strictly-NEWER token; the child is older => must not regress.
    const canonNewer = fakeCodexJwt('acct', newerExp);
    await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: canonNewer });
    await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: fakeCodexJwt('acct', olderExp) });
    const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
    assert.equal(r.conflict, true);
    assert.equal(r.ok, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'auth.json'), 'utf8')).access_token, canonNewer);
  }
  // (ii) child token is newer-exp but CLAIMLESS => no merge, claim-bearing canonical preserved.
  {
    const root = await tmp(); const iso = await tmp();
    const earlierExp = Math.floor((Date.now() + 60_000) / 1000);
    const laterExp = Math.floor((Date.now() + 3_600_000) / 1000);
    await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: fakeCodexJwt('acct', earlierExp) });
    await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
    const canonClaim = fakeCodexJwt('acct', earlierExp + 1);
    await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: canonClaim });
    await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: fakeClaimlessJwt(laterExp) });
    const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
    assert.equal(r.conflict, true);
    assert.equal(r.ok, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'auth.json'), 'utf8')).access_token, canonClaim);
  }
});

async function writePiHostFixture(layout: 'nested' | 'hoisted', version: string) {
  const install = await tmp();
  const host = layout === 'nested'
    ? path.join(install, 'pi-host')
    : path.join(install, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const aiRoot = layout === 'nested'
    ? path.join(host, 'node_modules', '@earendil-works', 'pi-ai')
    : path.join(install, 'node_modules', '@earendil-works', 'pi-ai');
  const cli = path.join(host, 'dist', 'cli.js');
  const modern = Number(version.split('.')[1]) >= 80;
  const moduleRelative = modern ? 'dist/compat.js' : 'dist/index.js';
  const modulePath = path.join(aiRoot, moduleRelative);
  await writeJson(path.join(host, 'package.json'), { name: '@earendil-works/pi-coding-agent', version });
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(cli, '// faithful fake Pi CLI entrypoint\n');
  await writeJson(path.join(aiRoot, 'package.json'), {
    name: '@earendil-works/pi-ai', version, type: 'module', main: './dist/index.js',
    exports: modern ? { '.': './dist/index.js', './compat': './dist/compat.js' } : { '.': './dist/index.js' },
  });
  await fs.mkdir(path.dirname(modulePath), { recursive: true });
  await fs.writeFile(modulePath, `
const model = { id: 'fixture-${layout}', provider: 'openai-codex', api: 'openai-codex-responses' };
export const getModels = provider => provider === 'openai-codex' ? [model] : [];
export const streamSimpleOpenAICodexResponses = () => ({ runtime: '${layout}-${version}' });
export const createAssistantMessageEventStream = () => ({ runtime: '${layout}-${version}' });
`);
  if (modern) {
    await fs.mkdir(path.join(aiRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(aiRoot, 'dist', 'index.js'), 'export const modernRootMustNotBeUsed = true;\n');
  }
  return { install, host, cli, aiRoot, modulePath };
}

for (const fixture of [
  { layout: 'nested' as const, version: '0.80.5' },
  { layout: 'hoisted' as const, version: '0.80.5' },
  { layout: 'nested' as const, version: '0.79.9' },
  { layout: 'hoisted' as const, version: '0.79.9' },
]) {
  test(`host runtime resolution supports ${fixture.layout} Pi ${fixture.version} pi-ai`, async () => {
    const built = await writePiHostFixture(fixture.layout, fixture.version);
    const runtime = await loadHostingPiAiRuntime({ entrypoint: built.cli });
    assert.equal(resolveHostingPiPackageRoot(built.cli), built.host);
    assert.equal(runtime.packageRoot, built.aiRoot);
    assert.equal(runtime.modulePath, built.modulePath);
    assert.equal(runtime.models[0]?.id, `fixture-${fixture.layout}`);
    assert.equal((runtime.streamSimpleOpenAICodexResponses({} as any, {} as any, {}) as any).runtime, `${fixture.layout}-${fixture.version}`);
  });
}

test('host runtime resolution follows a symlinked global-style Pi bin to its real entrypoint', async () => {
  const fixture = await writePiHostFixture('nested', '0.80.5');
  const bin = path.join(path.dirname(fixture.host), 'bin', 'pi');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.symlink(fixture.cli, bin);
  const runtime = await loadHostingPiAiRuntime({ entrypoint: bin });
  assert.equal(resolveHostingPiPackageRoot(bin), fixture.host);
  assert.equal(runtime.packageRoot, fixture.aiRoot);
  assert.equal(runtime.models[0]?.id, 'fixture-nested');
});

test('host runtime resolution follows an npx-cache-style bin symlink and hoisted dependency graph', async () => {
  const fixture = await writePiHostFixture('hoisted', '0.80.5');
  const npxBin = path.join(fixture.install, 'node_modules', '.bin', 'pi');
  await fs.mkdir(path.dirname(npxBin), { recursive: true });
  await fs.symlink(fixture.cli, npxBin);
  const runtime = await loadHostingPiAiRuntime({ entrypoint: npxBin });
  assert.equal(resolveHostingPiPackageRoot(npxBin), fixture.host);
  assert.equal(runtime.packageRoot, fixture.aiRoot);
  assert.equal(runtime.models[0]?.id, 'fixture-hoisted');
});

test('recognized Pi host fails closed when its pi-ai runtime lacks the streamer', async () => {
  const fixture = await writePiHostFixture('nested', '0.80.5');
  await fs.writeFile(fixture.modulePath, `
export const getModels = () => [{ id: 'catalog-only' }];
export const createAssistantMessageEventStream = () => ({});
`);
  await assert.rejects(() => loadHostingPiAiRuntime({ entrypoint: fixture.cli }), /both the Codex catalog and streamer/);
});

test('non-Pi consumers retain an injected local runtime seam', async () => {
  const model = { id: 'local-only' } as any;
  const stream = (() => ({})) as any;
  const runtime = await loadHostingPiAiRuntime({
    entrypoint: path.join(await tmp(), 'test.js'),
    localModulePath: import.meta.url,
    localModule: {
      getModels: () => [model],
      streamSimpleOpenAICodexResponses: stream,
      createAssistantMessageEventStream: () => ({}) as any,
    },
  });
  assert.deepEqual(runtime.models, [model]);
  assert.equal(runtime.streamSimpleOpenAICodexResponses, stream);
});

test('repo-local Pi loads the extension and lists the GPT-5.6 family at the upstream 272k window', async () => {
  // End-to-end through the real pi binary: the resolver unit tests above prove the extension
  // binds to its host's pi-ai, this proves the whole path actually loads and what a user sees.
  // It also guards the context cap at the surface it is read from — the balancer must not
  // re-apply the retired 372k extended-window override.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const localPi = path.join(repoRoot, 'node_modules', '.bin', 'pi');
  const extension = path.join(repoRoot, 'packages', 'codex-auth-balancer', 'dist', 'extensions', 'pi', 'index.js');
  const { stdout, stderr } = await exec(localPi, [
    '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-extensions',
    '-e', extension, '--list-models', 'bravo-codex-balanced',
  ], { timeout: 15_000 });
  const output = `${stdout}\n${stderr}`;
  assert.match(output, /bravo-codex-balanced\/gpt-5\.5\s/);
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.match(output, new RegExp(`bravo-codex-balanced/${id.replace(/\./g, '\\.')}\\s+272K\\s`), `${id} should list at the upstream 272k window`);
  }
  assert.doesNotMatch(output, /\s372K\s/);
});

test('balanced provider mirrors the installed openai-codex catalog exactly', () => {
  const native = getModels('openai-codex');
  const balanced = getBalancedCodexModels();
  assert.ok(native.length > 0);
  assert.deepEqual(
    balanced.map(model => model.id),
    native.map(model => `bravo-codex-balanced/${model.id}`),
  );
});

test('balanced catalog transform re-badges native Codex models and passes context metadata through', () => {
  const native = [
    { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, maxTokens: 128000, cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 272000, maxTokens: 128000, cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272000, maxTokens: 128000, cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272000, maxTokens: 128000, cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 } },
    { id: 'gpt-5.6-experimental', name: 'GPT-5.6 Experimental', contextWindow: 272000, maxTokens: 64000, cost: { input: 3, output: 18, cacheRead: 0.3, cacheWrite: 0 } },
  ].map(model => ({
    ...model,
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text', 'image'],
  })) as any;

  const balanced = mapBalancedCodexModels(native);
  assert.deepEqual(balanced.map(model => model.id), native.map((model: any) => `bravo-codex-balanced/${model.id}`));
  for (const [index, model] of balanced.entries()) {
    const upstream = native[index]!;
    assert.deepEqual(model, {
      ...upstream,
      id: `bravo-codex-balanced/${upstream.id}`,
      provider: 'bravo-codex-balanced',
      api: 'openai-codex-responses',
    });
  }
  // The GPT-5.6 family stays on the 272k window upstream advertises; the balancer must not
  // re-introduce the 372k extended-window override it used to apply here.
  for (const model of balanced) {
    if (/gpt-5\.6-(sol|terra|luna)$/.test(model.id)) assert.equal(model.contextWindow, 272000);
  }
});

test('balanced provider defaults to SSE so response headers ingest live usage', async () => {
  const root = await tmp();
  const oldHome = process.env.CODEX_AUTH_BALANCER_HOME;
  const oldFetch = globalThis.fetch;
  const oldWebSocket = globalThis.WebSocket;
  process.env.CODEX_AUTH_BALANCER_HOME = root;
  const token = fakeCodexJwt('acct-s1');
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: token, expiry_date: Date.now() + 30 * 60_000 });
  await writeJson(path.join(root, 'cache', 'usage.json'), { schema_version: 2, generated_at: Date.now(), accounts: { s1: { slot: 's1', status: 'ok', updatedAt: Date.now(), primary: { label: 'primary', remainingPercent: 100 } } } });

  let registered: any;
  codexBalancedProvider({ registerProvider: (_id: string, provider: any) => { registered = provider; }, on: () => {} } as any);
  let fetchCount = 0;
  let webSocketConstructed = false;
  try {
    (globalThis as any).WebSocket = class {
      constructor() {
        webSocketConstructed = true;
        throw new Error('WebSocket should not be used by default balanced provider transport');
      }
    };
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      const sse = 'data: {"type":"response.done","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}\n\n';
      return new Response(sse, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-rate-limits': JSON.stringify({ rate_limits: { primary: { remaining_percent: 61, reset_at: 1234 }, secondary: { used_percent: 80 } } }),
        },
      });
    };

    const model = registered.models[0];
    const stream = registered.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, { sessionId: 'balanced-sse-test' });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    assert.equal(events.at(-1)?.type, 'done');
    assert.equal(fetchCount, 1);
    assert.equal(webSocketConstructed, false);

    const live = await eventually(async () => {
      const usage = await getUsage({ stateRoot: root });
      return usage.accounts[0]?.usage?.source === 'live' ? usage.accounts[0] : undefined;
    });
    assert.equal(live.usage?.primary?.remainingPercent, 61);
    assert.equal(live.usage?.secondary?.remainingPercent, 20);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldWebSocket === undefined) delete (globalThis as any).WebSocket; else globalThis.WebSocket = oldWebSocket;
    if (oldHome === undefined) delete process.env.CODEX_AUTH_BALANCER_HOME; else process.env.CODEX_AUTH_BALANCER_HOME = oldHome;
  }
});

test('provider re-asserts its api-handler override before every model-stream path (turn, compaction, branch summary) so it survives pi reload() resetApiProviders', () => {
  // Regression: pi 0.79.8 reload() (print-mode + interactive TUI) calls
  // resetApiProviders(), wiping our `openai-codex-responses` override and
  // restoring only built-ins. After that, codex-balanced requests hit the
  // built-in handler with our placeholder apiKey and the upstream throws
  // "Failed to extract accountId from token" without ever leasing. The fix
  // re-registers the provider on session_start and turn_start so the override
  // is reinstalled before each dispatch.
  const registrations: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const mockPi = {
    registerProvider: (id: string, _provider: any) => { registrations.push(id); },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(event, handler); },
  };

  codexBalancedProvider(mockPi as any);

  // Initial load registers exactly once and subscribes to every lifecycle event
  // that precedes a model-stream dispatch: turns (turn_start), (re)start
  // (session_start), and the two non-turn stream paths (compaction +
  // branch-summary), whose pre-stream events are session_before_compact and
  // session_before_tree.
  assert.deepEqual(registrations, ['bravo-codex-balanced']);
  assert.ok(handlers.has('session_start'), 'subscribes to session_start');
  assert.ok(handlers.has('turn_start'), 'subscribes to turn_start');
  assert.ok(handlers.has('session_before_compact'), 'subscribes to session_before_compact');
  assert.ok(handlers.has('session_before_tree'), 'subscribes to session_before_tree');

  // Simulate a reload() wipe followed by the next turn: turn_start must
  // re-register (reinstall the override) before the model is dispatched.
  handlers.get('turn_start')!({ type: 'turn_start', turnIndex: 0, timestamp: 0 }, {});
  assert.deepEqual(registrations, ['bravo-codex-balanced', 'bravo-codex-balanced']);

  // session_start (e.g. reload's re-emit) also re-asserts.
  handlers.get('session_start')!({ type: 'session_start' }, {});
  assert.equal(registrations.length, 3);

  // Compaction runs after agent_end, before the next turn_start; if a reset
  // landed in that gap, only session_before_compact can reinstall the override
  // before the summarization stream. It must re-assert and must NOT return a
  // truthy result (which would cancel/replace compaction).
  const beforeCompactResult = handlers.get('session_before_compact')!(
    { type: 'session_before_compact', preparation: {}, branchEntries: [], signal: {} },
    {},
  );
  assert.equal(beforeCompactResult, undefined, 'session_before_compact handler returns nothing (no cancel/replace)');
  assert.equal(registrations.length, 4);

  // Branch summarization (tree navigation / fork) runs outside any turn; only
  // session_before_tree can reinstall the override before its summary stream.
  // Same falsy-return contract: must not cancel/replace the tree operation.
  const beforeTreeResult = handlers.get('session_before_tree')!(
    { type: 'session_before_tree', preparation: {}, signal: {} },
    {},
  );
  assert.equal(beforeTreeResult, undefined, 'session_before_tree handler returns nothing (no cancel/replace)');
  assert.equal(registrations.length, 5);
  assert.ok(registrations.every((id) => id === 'bravo-codex-balanced'));
});

test('startTokenLease extracts token from slot Pi auth, honors affinity, and finish is idempotent', async () => {
  const root = await tmp();
  const aToken = fakeCodexJwt('acct-a', Math.floor((Date.now() + 60_000) / 1000));
  await writeJson(path.join(root, 'accounts', 'a', 'auth.json'), { access_token: 'codex-a-token', expiry_date: Date.now() + 60_000 });
  await writeJson(path.join(root, 'accounts', 'a', 'pi-openai-codex.json'), { access: aToken, expires: Date.now() + 60_000 });
  await writeJson(path.join(root, 'accounts', 'b', 'auth.json'), { access_token: 'codex-b-token', expiry_date: Date.now() + 60_000 });
  const first = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, preferred_slot: 'a', session_affinity_key: 'sess-1' });
  assert.equal(first.access_token, aToken);
  assert.equal(first.slot, 'a');
  const done = await finishTokenLease({ stateRoot: root, lease_id: first.lease_id, reservation_id: first.reservation_id, launch_id: first.launch_id, status: 'completed' });
  assert.equal(done.already_final, false);
  const retry = await finishTokenLease({ stateRoot: root, lease_id: first.lease_id, reservation_id: first.reservation_id, launch_id: first.launch_id, status: 'failed' });
  assert.equal(retry.already_final, true);
  const second = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, session_affinity_key: 'sess-1' });
  assert.equal(second.slot, 'a');
});

test('startTokenLease accepts Codex CLI tokens auth shape in slot Pi auth', async () => {
  const root = await tmp();
  const access = fakeCodexJwt('acct-tokens', Math.floor((Date.now() + 60_000) / 1000));
  await writeJson(path.join(root, 'accounts', 'tokens', 'auth.json'), { access_token: 'codex-token', expiry_date: Date.now() + 60_000 });
  await writeJson(path.join(root, 'accounts', 'tokens', 'pi-openai-codex.json'), {
    auth_mode: 'chatgpt',
    tokens: { access_token: access, refresh_token: 'refresh-token', account_id: 'acct-tokens' },
  });
  const lease = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, preferred_slot: 'tokens' });
  assert.equal(lease.access_token, access);
  await finishTokenLease({ stateRoot: root, lease_id: lease.lease_id, reservation_id: lease.reservation_id, launch_id: lease.launch_id, status: 'completed' });
});

test('startTokenLease refreshes near-expired OAuth credentials before leasing', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'refresh', 'pi-openai-codex.json'), { access: 'old-access-token', refresh: 'refresh-token', expires: Date.now() + 10 });
  await writeJson(path.join(root, 'accounts', 'refresh', 'auth.json'), { access_token: 'codex-token', expiry_date: Date.now() + 60_000 });
  const refreshedToken = fakeCodexJwt('acct-1', 3600);
  const stub = stubTokenEndpoint(() => tokenOk(refreshedToken, 'new-refresh-token', 60));
  try {
    const lease = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, preferred_slot: 'refresh' });
    assert.equal(lease.access_token, refreshedToken);
    // The stale refresh token on disk is what gets sent, and the rotated one is persisted.
    assert.equal(stub.calls[0]?.get('refresh_token'), 'refresh-token');
    const stored = JSON.parse(await fs.readFile(path.join(root, 'accounts', 'refresh', 'pi-openai-codex.json'), 'utf8'));
    assert.equal(stored.access, refreshedToken);
    assert.equal(stored.refresh, 'new-refresh-token');
  } finally {
    stub.restore();
  }
});

test('startTokenLease fails closed on empty token and expires stale leases', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'empty', 'auth.json'), { access_token: '' });
  await assert.rejects(startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'm', purpose: 'manual', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 0, preferred_slot: 'empty' }), /no usable access token/);
  const inactive = await listReservations({ stateRoot: root, includeInactive: true });
  assert.equal(inactive[0]?.state, 'failed');

  await writeJson(path.join(root, 'accounts', 'ok', 'auth.json'), { access_token: fakeCodexJwt('acct-ok', 3600), expiry_date: Date.now() + 60_000 });
  const lease = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'm', purpose: 'manual', expected_runtime_ms: 1, ttl_safety_buffer_ms: 0, preferred_slot: 'ok' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'm', purpose: 'manual', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 0, preferred_slot: 'ok' });
  const states = await listReservations({ stateRoot: root, includeInactive: true });
  assert.equal(states.find(r => r.id === lease.reservation_id)?.state, 'expired');
});

test('CLI token prints only access token and stores redacted lease metadata', async () => {
  const root = await tmp();
  const cliToken = fakeCodexJwt('acct-cli', Math.floor((Date.now() + 10 * 60_000) / 1000));
  const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: cliToken, refresh_token: 'refresh-secret', expiry_date: Date.now() + 10 * 60_000 });
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const env = { ...process.env, CODEX_AUTH_BALANCER_HOME: root };
  const { stdout, stderr } = await exec(process.execPath, [cli, 'token', '--provider', 'bravo-codex-balanced', '--lease-key', '00000000-0000-4000-8000-000000000001', '--model', 'bravo-codex-balanced/fake'], { env, timeout: 5000 });
  assert.equal(stdout, `${cliToken}\n`);
  assert.doesNotMatch(stderr, new RegExp(`${escapeRe(cliToken)}|refresh-secret`));
  const files = await fs.readdir(path.join(root, 'leases', 'keys'));
  assert.equal(files.length, 1);
  const leaseFile = await fs.readFile(path.join(root, 'leases', 'keys', files[0]), 'utf8');
  assert.doesNotMatch(leaseFile, new RegExp(`${escapeRe(cliToken)}|refresh-secret`));
  await exec(process.execPath, [cli, 'token-finish', '--lease-key', '00000000-0000-4000-8000-000000000001', '--status', 'completed'], { env, timeout: 5000 });
  await assert.rejects(fs.stat(path.join(root, 'leases', 'keys', files[0])), /ENOENT/);
});

test('syncBack and cleanup preserve terminal reservation state', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'old' });
  const p = await prepareLaunch(iso, { stateRoot: root, slot: 's1', runId: 'run1', rootRunId: 'root1' });
  assert.equal((await listReservations({ stateRoot: root })).length, 1);
  await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: 'new' });
  const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(r.ok, true);
  const retry = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(retry.ok, true);
  assert.equal(retry.conflict, false);
  assert.equal((await listReservations({ stateRoot: root })).length, 0);
  const inactive = await listReservations({ stateRoot: root, includeInactive: true });
  assert.equal(inactive.find(x => x.id === p.metadata.reservation_id)?.state, 'completed');
  await cleanupLaunch(iso);
  const released = await listReservations({ stateRoot: root, includeInactive: true });
  assert.equal(released.find(x => x.id === p.metadata.reservation_id)?.state, 'completed');
});

const leaseArgs = (root: string, slot: string) => ({ stateRoot: root, provider: 'bravo-codex-balanced' as const, model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request' as const, expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, preferred_slot: slot });
async function seedRefreshSlot(root: string, slot: string) {
  await writeJson(path.join(root, 'accounts', slot, 'pi-openai-codex.json'), { access: 'old-access-token', refresh: 'refresh-token', expires: Date.now() + 10 });
  await writeJson(path.join(root, 'accounts', slot, 'auth.json'), { access_token: 'codex-token', expiry_date: Date.now() + 60_000 });
}
function latestFailedDetails(root: string, reservationId: string | undefined): any {
  assert.ok(reservationId, 'expected a failed reservation id');
  const db = new DatabaseSync(path.join(root, 'balancer.sqlite3'));
  try {
    const row = db.prepare('SELECT details_json FROM launch_events WHERE reservation_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1').get(reservationId, 'failed') as { details_json?: string } | undefined;
    return row?.details_json ? JSON.parse(row.details_json) : undefined;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

test('startTokenLease marks slot broken on invalid_grant refresh failure and stops selecting it', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'broke');
  const stub = stubTokenEndpoint(invalidGrant);
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'broke')), /selected slot access token refresh failed/);
  } finally {
    stub.restore();
  }
  const usage = await getUsage({ stateRoot: root });
  const slot = usage.accounts.find(a => a.slot === 'broke');
  assert.equal(slot?.status, 'broken');
  assert.equal(slot?.problem?.code, 'refresh_invalid_grant');
  // A follow-up selection must not pick the broken slot. With it being the only
  // slot, chooseSlot has no candidate and startTokenLease must not succeed on it.
  await writeJson(path.join(root, 'accounts', 'healthy', 'auth.json'), { access_token: fakeCodexJwt('acct-healthy', 3600), expiry_date: Date.now() + 60_000 });
  const next = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, session_affinity_key: 'sess-broke' });
  assert.notEqual(next.slot, 'broke');
});

test('startTokenLease recovers from a concurrent rotation: invalid_grant but a fresh valid token appeared on disk', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'race');
  const slotAuth = path.join(root, 'accounts', 'race', 'pi-openai-codex.json');
  const freshJwt = fakeCodexJwt('acct-1', 3600);
  // Simulate a concurrent pi-balanced child that rotated our token and synced the fresh
  // credential to disk BEFORE our refresh of the stale token returns invalid_grant.
  const stub = stubTokenEndpoint(async () => {
    await writeJson(slotAuth, { access: freshJwt, refresh: 'r1', expires: Date.now() + 3_600_000 });
    return invalidGrant();
  });
  try {
    const lease = await startTokenLease(leaseArgs(root, 'race'));
    assert.equal(lease.access_token, freshJwt);
  } finally {
    stub.restore();
  }
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'race');
  assert.notEqual(slot?.status, 'broken');
});

test('startTokenLease does NOT chain-retry with a rotated refresh token (reuse-safety); bricks instead', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'advance');
  const slotAuth = path.join(root, 'accounts', 'advance', 'pi-openai-codex.json');
  await writeJson(slotAuth, { access: 'old-access-token', refresh: 'r0', expires: Date.now() + 10 });
  const stub = stubTokenEndpoint(async () => {
    // A concurrent process rotated r0 -> r1 on disk but left NO usable access token. Replaying/
    // advancing to r1 could trip OpenAI refresh-token reuse detection and invalidate the whole
    // family, so we must NOT try it: recovery only adopts a usable access token, never another refresh.
    await writeJson(slotAuth, { access: 'old-access-token', refresh: 'r1', expires: Date.now() + 10 });
    return invalidGrant();
  });
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'advance')), /selected slot access token refresh failed/);
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 1); // tried r0 exactly once; never retried with the rotated r1
  assert.equal(stub.calls[0]?.get('refresh_token'), 'r0');
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'advance');
  assert.equal(slot?.status, 'broken');
});

test('startTokenLease still bricks on invalid_grant when the on-disk token never advances (genuinely dead)', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'dead');
  // Always invalid_grant and never mutate the file: the token cannot advance, so no recovery.
  const stub = stubTokenEndpoint(invalidGrant);
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'dead')), /selected slot access token refresh failed/);
  } finally {
    stub.restore();
  }
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'dead');
  assert.equal(slot?.status, 'broken');
  assert.equal(slot?.problem?.code, 'refresh_invalid_grant');
});

test('startTokenLease atomic write leaves no temp files behind', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'atomic');
  const freshJwt = fakeCodexJwt('acct-1', 3600);
  const stub = stubTokenEndpoint(() => tokenOk(freshJwt, 'new-refresh-token'));
  try {
    const lease = await startTokenLease(leaseArgs(root, 'atomic'));
    assert.equal(lease.access_token, freshJwt);
  } finally {
    stub.restore();
  }
  const slotDir = path.join(root, 'accounts', 'atomic');
  const entries = await fs.readdir(slotDir);
  assert.deepEqual(entries.filter(e => e.includes('.tmp.')), []);
  const stored = JSON.parse(await fs.readFile(path.join(slotDir, 'pi-openai-codex.json'), 'utf8'));
  assert.equal(stored.access, freshJwt);
});

test('startTokenLease does not break slot on transient refresh failure', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'flap');
  const failing = stubTokenEndpoint(() => tokenHttpError(503, 'upstream'));
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'flap')), /selected slot access token refresh failed/);
  } finally {
    failing.restore();
  }
  const usage = await getUsage({ stateRoot: root });
  const slot = usage.accounts.find(a => a.slot === 'flap');
  assert.notEqual(slot?.status, 'broken');
  // Still selectable: refresh now succeeds and the slot leases.
  const healthy = stubTokenEndpoint(() => tokenOk(fakeCodexJwt('acct-1', 3600), 'new-refresh-token', 60));
  try {
    const lease = await startTokenLease(leaseArgs(root, 'flap'));
    assert.equal(lease.slot, 'flap');
  } finally {
    healthy.restore();
  }
});

test('startTokenLease records real error_kind in telemetry on hard failure', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'tele');
  const stub = stubTokenEndpoint(invalidGrant);
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'tele')), /selected slot access token refresh failed/);
  } finally {
    stub.restore();
  }
  const reservation = (await listReservations({ stateRoot: root, includeInactive: true })).find(r => r.state === 'failed');
  assert.ok(reservation, 'expected a failed reservation');
  const details = latestFailedDetails(root, reservation?.id);
  assert.equal(details?.error_kind, 'invalid_grant');
});

test('startTokenLease redacts secrets from recorded refresh failure details', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'redact');
  const jwt = 'eyJabc.eyJdef.sigghi';
  // The upstream error body is echoed into the message verbatim, so a provider
  // that reflects a token back at us is a real way secrets reach the event log.
  const stub = stubTokenEndpoint(() => tokenHttpError(400, `refresh blew up token=${jwt} Bearer sk-secret`));
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'redact')), /selected slot access token refresh failed/);
  } finally {
    stub.restore();
  }
  const reservation = (await listReservations({ stateRoot: root, includeInactive: true })).find(r => r.state === 'failed');
  const details = latestFailedDetails(root, reservation?.id);
  assert.match(details?.message, /\[REDACTED_TOKEN\]/);
  assert.match(details?.message, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(details?.message, /sk-secret/);
  assert.doesNotMatch(details?.message, /sigghi/);
});

test('startTokenLease preserves the generic refresh failure error message contract', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'contract');
  const stub = stubTokenEndpoint(invalidGrant);
  try {
    await startTokenLease(leaseArgs(root, 'contract'));
    assert.fail('expected startTokenLease to reject');
  } catch (error) {
    assert.equal((error as Error).message, 'selected slot access token refresh failed');
  } finally {
    stub.restore();
  }
});

test('unbrickSlot clears broken status and makes the slot selectable again', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'fixme');
  const broken = stubTokenEndpoint(invalidGrant);
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'fixme')), /selected slot access token refresh failed/);
  } finally {
    broken.restore();
  }
  assert.equal((await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'fixme')?.status, 'broken');
  unbrickSlot(root, 'fixme');
  assert.equal((await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'fixme')?.status, 'unknown');
  // Re-auth happened out of band; a healthy refresh now leases the slot.
  const healthy = stubTokenEndpoint(() => tokenOk(fakeCodexJwt('acct-1', 3600), 'new-refresh-token', 60));
  try {
    const lease = await startTokenLease(leaseArgs(root, 'fixme'));
    assert.equal(lease.slot, 'fixme');
  } finally {
    healthy.restore();
  }
});

test('startTokenLease leases pass-through a valid claim-bearing token without refreshing', async () => {
  const root = await tmp();
  const token = fakeCodexJwt('acct-1', 3600);
  await writeJson(path.join(root, 'accounts', 'passthru', 'pi-openai-codex.json'), { access: token, refresh: 'refresh-token', expires: Date.now() + 3_600_000 });
  await writeJson(path.join(root, 'accounts', 'passthru', 'auth.json'), { access_token: 'codex-token', expiry_date: Date.now() + 3_600_000 });
  const stub = stubTokenEndpoint(() => { throw new Error('refresh should not be called for a claim-bearing token'); });
  try {
    const lease = await startTokenLease(leaseArgs(root, 'passthru'));
    assert.equal(stub.calls.length, 0);
    assert.equal(lease.access_token, token);
    assert.equal(lease.slot, 'passthru');
  } finally {
    stub.restore();
  }
});

test('startTokenLease refreshes a not-yet-expired but claimless cached token', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'claimless', 'pi-openai-codex.json'), { access: fakeClaimlessJwt(3600), refresh: 'refresh-token', expires: Date.now() + 3_600_000 });
  // auth.json must exist for the slot to be discovered by scanInternalAccounts; the lease reads piAuthPath (pi-openai-codex.json) first.
  await writeJson(path.join(root, 'accounts', 'claimless', 'auth.json'), { access_token: fakeClaimlessJwt(3600), expiry_date: Date.now() + 3_600_000 });
  const refreshed = fakeCodexJwt('acct-1', 3600);
  const stub = stubTokenEndpoint(() => tokenOk(refreshed, 'r2'));
  try {
    const lease = await startTokenLease(leaseArgs(root, 'claimless'));
    assert.equal(stub.calls.length, 1);
    assert.equal(lease.access_token, refreshed);
    const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'claimless');
    assert.notEqual(slot?.status, 'broken');
  } finally {
    stub.restore();
  }
});

test('startTokenLease marks slot broken + fails when refresh still yields a claimless token', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'stillclaimless', 'pi-openai-codex.json'), { access: fakeClaimlessJwt(3600), refresh: 'refresh-token', expires: Date.now() + 3_600_000 });
  // auth.json must exist for the slot to be discovered by scanInternalAccounts; the lease reads piAuthPath (pi-openai-codex.json) first.
  await writeJson(path.join(root, 'accounts', 'stillclaimless', 'auth.json'), { access_token: fakeClaimlessJwt(3600), expiry_date: Date.now() + 3_600_000 });
  await writeJson(path.join(root, 'accounts', 'good', 'auth.json'), { access_token: fakeCodexJwt('acct-good', 3600), expiry_date: Date.now() + 3_600_000 });
  const stub = stubTokenEndpoint(() => tokenOk(fakeClaimlessJwt(3600), 'r2'));
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'stillclaimless')), /selected slot access token refresh failed/);
  } finally {
    stub.restore();
  }
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'stillclaimless');
  assert.equal(slot?.status, 'broken');
  assert.equal(slot?.problem?.code, 'refresh_claimless_token');
  // A subsequent lease without a preferred slot must pick the healthy slot, not the broken one.
  const next = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, session_affinity_key: 'sess-stillclaimless' });
  assert.equal(next.slot, 'good');
});

test('startTokenLease marks broken + fails a claimless token that has no refresh token', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'norefresh', 'auth.json'), { access_token: fakeClaimlessJwt(3600), expiry_date: Date.now() + 3_600_000 });
  await assert.rejects(startTokenLease(leaseArgs(root, 'norefresh')), /no accountId claim/);
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'norefresh');
  assert.equal(slot?.status, 'broken');
  assert.equal(slot?.problem?.code, 'claimless_access_token');
});

// FIX E: an EXPIRED claimless token with no refresh token reaches the in-loop `!refreshToken`
// branch (it cannot return early via the unexpired-ttl shortcut). That poison pill must be
// quarantined (broken snapshot + account-id error) instead of throwing a bare TTL/expiry error
// that leaves the slot selectable next turn.
test('startTokenLease marks broken + fails a claimless EXPIRED token with no refresh token', async () => {
  const root = await tmp();
  const pastExpSeconds = Math.floor((Date.now() - 60_000) / 1000);
  // pi-openai-codex.json is read first; claimless access token, expired, NO refresh field.
  await writeJson(path.join(root, 'accounts', 'expnorefresh', 'pi-openai-codex.json'), { access: fakeClaimlessJwt(pastExpSeconds), expires: Date.now() - 60_000 });
  // auth.json must exist so the slot is discovered by scanInternalAccounts.
  await writeJson(path.join(root, 'accounts', 'expnorefresh', 'auth.json'), { access_token: fakeClaimlessJwt(pastExpSeconds), expiry_date: Date.now() - 60_000 });
  await assert.rejects(startTokenLease(leaseArgs(root, 'expnorefresh')), /no accountId claim/);
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'expnorefresh');
  assert.equal(slot?.status, 'broken');
  assert.equal(slot?.problem?.code, 'claimless_access_token');
});

// --- withRefreshLock hardening -------------------------------------------------------------
// Replicates refreshLockDir()/sha() from src/index.ts: the cross-process lock for a slot lives
// at <root>/leases/refresh-locks/<sha256(slot)[:32]>. Kept in the test so a path drift in src
// would surface as a failing steal/no-steal integration test rather than silently diverging.
function refreshLockDirForTest(root: string, slot: string): string {
  return path.join(root, 'leases', 'refresh-locks', createHash('sha256').update(slot).digest('hex').slice(0, 32));
}

test('shouldStealRefreshLock truth table: only a stale AND dead lock is stealable', () => {
  const staleMs = 30_000;
  assert.equal(shouldStealRefreshLock({ ageMs: 60_000, ownerAlive: false, staleMs }), true);  // stale + dead
  assert.equal(shouldStealRefreshLock({ ageMs: 60_000, ownerAlive: true, staleMs }), false);   // stale + alive
  assert.equal(shouldStealRefreshLock({ ageMs: 1_000, ownerAlive: false, staleMs }), false);   // fresh + dead
  assert.equal(shouldStealRefreshLock({ ageMs: 1_000, ownerAlive: true, staleMs }), false);    // fresh + alive
});

test('isProcessAlive: true for self, false for a dead/zero pid', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2147483646), false); // almost-certainly-dead high pid
  assert.equal(isProcessAlive(0), false);
});

test('withRefreshLock serializes two concurrent refreshes for the same slot (lock makes the 2nd re-read)', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'serialize');
  const slotAuth = path.join(root, 'accounts', 'serialize', 'pi-openai-codex.json');
  const freshJwt = fakeCodexJwt('acct-1', Math.floor((Date.now() + 3_600_000) / 1000));
  // Each exchange: await a small delay (forces the two leases to overlap inside the
  // lock window), then WRITE the fresh far-future token to disk like the real refresh path does.
  const stub = stubTokenEndpoint(async () => {
    await new Promise(r => setTimeout(r, 50));
    await writeJson(slotAuth, { access: freshJwt, refresh: 'r1', expires: Date.now() + 3_600_000 });
    return tokenOk(freshJwt, 'r1');
  });
  try {
    // Both promises created before any await so they genuinely race for the same lock.
    const p1 = startTokenLease(leaseArgs(root, 'serialize'));
    const p2 = startTokenLease(leaseArgs(root, 'serialize'));
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.access_token, freshJwt);
    assert.equal(b.access_token, freshJwt);
    // The lock serialized them: the 2nd acquirer re-read the now-fresh token and skipped refresh.
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('withRefreshLock steals a stale lock whose owner pid is dead', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'deadowner');
  const lockDir = refreshLockDirForTest(root, 'deadowner');
  await fs.mkdir(lockDir, { recursive: true });
  // Dead owner + old mtime => stale AND dead => stealable.
  await writeJson(path.join(lockDir, 'owner.json'), { schema_version: 1, pid: 2147483646, nonce: 'dead-owner-nonce', created_at: Date.now() - 120_000 });
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lockDir, old, old);
  const freshJwt = fakeCodexJwt('acct-1', Math.floor((Date.now() + 3_600_000) / 1000));
  const stub = stubTokenEndpoint(() => tokenOk(freshJwt, 'r1'));
  try {
    const lease = await startTokenLease(leaseArgs(root, 'deadowner'));
    assert.equal(lease.access_token, freshJwt);
    assert.equal(lease.slot, 'deadowner');
  } finally {
    stub.restore();
  }
});

test('withRefreshLock does NOT steal a fresh lock held by a live owner (times out instead)', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'liveowner');
  const lockDir = refreshLockDirForTest(root, 'liveowner');
  await fs.mkdir(lockDir, { recursive: true });
  // Live owner (this process) + fresh mtime => never stolen; acquisition must time out.
  await writeJson(path.join(lockDir, 'owner.json'), { schema_version: 1, pid: process.pid, nonce: 'live-owner-nonce', created_at: Date.now() });
  const now = new Date();
  await fs.utimes(lockDir, now, now);
  const priorEnv = process.env.CODEX_BALANCER_REFRESH_LOCK_ACQUIRE_MS;
  process.env.CODEX_BALANCER_REFRESH_LOCK_ACQUIRE_MS = '400';
  const stub = stubTokenEndpoint(() => tokenOk(fakeCodexJwt('acct-1', 3600), 'r1'));
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'liveowner')), /timed out waiting for token refresh lock/);
  } finally {
    stub.restore();
    if (priorEnv === undefined) delete process.env.CODEX_BALANCER_REFRESH_LOCK_ACQUIRE_MS;
    else process.env.CODEX_BALANCER_REFRESH_LOCK_ACQUIRE_MS = priorEnv;
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// FIX A.1: the lock holder's `finally` must NOT delete a lock that another owner has stolen and
// re-taken. Simulate the steal from inside the refresh callback (while we still hold the lock) by
// overwriting owner.json with a FOREIGN nonce. After the lease completes, the foreign owner.json
// must still exist — proving our finally only deletes on a matching nonce, never on different.
test('withRefreshLock finally does NOT delete a lock re-taken by another owner (foreign nonce)', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'foreignsteal');
  const lockDir = refreshLockDirForTest(root, 'foreignsteal');
  const ownerPath = path.join(lockDir, 'owner.json');
  const freshJwt = fakeCodexJwt('acct-1', Math.floor((Date.now() + 3_600_000) / 1000));
  const stub = stubTokenEndpoint(async () => {
    // Mid-run, a different process "steals" and re-takes the lock: overwrite owner.json with a
    // foreign nonce. Our finally must see the mismatch and leave this lock intact.
    await writeJson(ownerPath, { schema_version: 1, pid: process.pid, nonce: 'foreign-stealer-nonce', created_at: Date.now() });
    return tokenOk(freshJwt, 'r1');
  });
  try {
    const lease = await startTokenLease(leaseArgs(root, 'foreignsteal'));
    assert.equal(lease.access_token, freshJwt);
    // The foreign-owned lock must NOT have been deleted by our finally.
    const remaining = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    assert.equal(remaining.nonce, 'foreign-stealer-nonce');
  } finally {
    stub.restore();
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ── proactive refresh (ensureFreshTokens) ──────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
/** Seed a slot whose access token is claim-bearing and expires in `expiresInDays`. */
async function seedAgingSlot(root: string, slot: string, expiresInDays: number, refreshToken: string | null = 'r0') {
  const expSeconds = Math.floor((Date.now() + expiresInDays * DAY) / 1000);
  await writeJson(path.join(root, 'accounts', slot, 'auth.json'), {
    tokens: { access_token: fakeCodexJwt(`acct-${slot}`, expSeconds), ...(refreshToken ? { refresh_token: refreshToken } : {}) },
  });
}

test('ensureFreshTokens leaves a token that is still far from expiry alone', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'young', 9);
  const stub = stubTokenEndpoint(() => { throw new Error('must not refresh a young token'); });
  try {
    const [outcome] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(outcome.action, 'fresh');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('ensureFreshTokens rotates a token inside the lead window and persists the new refresh token', async () => {
  const root = await tmp();
  // Inside PROACTIVE_REFRESH_LEAD_MS, but still perfectly usable right now: the
  // whole point is refreshing while the old token would still have worked.
  await seedAgingSlot(root, 'aging', (PROACTIVE_REFRESH_LEAD_MS / DAY) - 1);
  const rotated = fakeCodexJwt('acct-aging', Math.floor((Date.now() + 10 * DAY) / 1000));
  const stub = stubTokenEndpoint(() => tokenOk(rotated, 'r1', 10 * 24 * 3600));
  try {
    const [outcome] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(outcome.action, 'refreshed');
    assert.equal(stub.calls[0]?.get('refresh_token'), 'r0');
    const stored = JSON.parse(await fs.readFile(path.join(root, 'accounts', 'aging', 'auth.json'), 'utf8'));
    assert.equal(stored.tokens.access_token, rotated);
    // The rotated single-use refresh token MUST be persisted; stranding it bricks the slot.
    assert.equal(stored.tokens.refresh_token, 'r1');
  } finally {
    stub.restore();
  }
});

test('ensureFreshTokens records an invalid_grant failure, bricks the slot, and then backs off', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'revoked', 1);
  const stub = stubTokenEndpoint(invalidGrant);
  try {
    const [failure] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(failure.action, 'failed');
    assert.equal(failure.errorKind, 'invalid_grant');
    // A durable failure must be visible on the slot before anything tries to lease it.
    const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'revoked');
    assert.equal(slot?.status, 'broken');
    assert.equal(slot?.problem?.code, 'refresh_invalid_grant');

    // Second call inside the cooldown must not hit the wire again: a persistently
    // dead refresh cannot be allowed to spin on every session start.
    const callsAfterFirst = stub.calls.length;
    const [second] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(second.action, 'cooldown');
    assert.equal(stub.calls.length, callsAfterFirst);
  } finally {
    stub.restore();
  }
});

test('ensureFreshTokens reports a transient failure without bricking the slot', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'flaky', 1);
  const stub = stubTokenEndpoint(() => tokenHttpError(503, 'upstream'));
  try {
    const [outcome] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(outcome.action, 'failed');
    assert.equal(outcome.errorKind, 'transient');
    const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'flaky');
    assert.notEqual(slot?.status, 'broken');
  } finally {
    stub.restore();
  }
});

test('ensureFreshTokens surfaces a malformed token response as a durable failure', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'garbage', 1);
  // Injected fault at the true boundary: a 200 that is missing required fields.
  // A provider-object fake could never produce this, which is exactly the class
  // of bug that response validation exists to catch.
  const stub = stubTokenEndpoint(() => new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }));
  try {
    const [outcome] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(outcome.action, 'failed');
    assert.equal(outcome.errorKind, 'invalid_grant');
    // The half-written response must not have clobbered the on-disk credential.
    const stored = JSON.parse(await fs.readFile(path.join(root, 'accounts', 'garbage', 'auth.json'), 'utf8'));
    assert.equal(stored.tokens.refresh_token, 'r0');
  } finally {
    stub.restore();
  }
});

test('ensureFreshTokens reports a credential with no refresh token as unrefreshable', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'norefresh', 1, null);
  const stub = stubTokenEndpoint(() => { throw new Error('nothing to exchange'); });
  try {
    const [outcome] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(outcome.action, 'unrefreshable');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('ensureFreshTokens adopts a token another process refreshed while it waited on the lock', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'raced', 1);
  const authPath = path.join(root, 'accounts', 'raced', 'auth.json');
  const adopted = fakeCodexJwt('acct-raced', Math.floor((Date.now() + 10 * DAY) / 1000));
  // Stand in for the concurrent writer: land a fresh credential before we look
  // under the lock. Re-reading there is what makes double-rotation impossible.
  await writeJson(authPath, { tokens: { access_token: adopted, refresh_token: 'r-other' } });
  const stub = stubTokenEndpoint(() => { throw new Error('must not rotate a token another process already refreshed'); });
  try {
    const [outcome] = await ensureFreshTokens({ stateRoot: root });
    assert.equal(outcome.action, 'fresh');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('getSlotTokenHealth reports expiry and flags slots that cannot self-heal', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'healthy', 9);
  await seedAgingSlot(root, 'stranded', 1, null);
  const health = await getSlotTokenHealth({ stateRoot: root });
  const healthy = health.find(h => h.slot === 'healthy');
  const stranded = health.find(h => h.slot === 'stranded');

  assert.ok(healthy && healthy.expiresInMs! > 8 * DAY, 'expiry is read from the leased credential');
  assert.equal(healthy?.hasRefreshToken, true);
  assert.equal(healthy?.claimBearing, true);
  assert.equal(healthy?.needsReauth, false);
  // No refresh token: this one is going to die on its own and needs a human.
  assert.equal(stranded?.needsReauth, true);
});

test('getSlotTokenHealth flags a slot whose refresh token was revoked', async () => {
  const root = await tmp();
  await seedAgingSlot(root, 'revoked', 1);
  const stub = stubTokenEndpoint(invalidGrant);
  try {
    await ensureFreshTokens({ stateRoot: root });
  } finally {
    stub.restore();
  }
  const health = (await getSlotTokenHealth({ stateRoot: root })).find(h => h.slot === 'revoked');
  assert.equal(health?.needsReauth, true, 'a recorded invalid_grant means the refresh token is dead');
  assert.equal(health?.lastProactiveAttempt?.ok, false);
});

test('ensureFreshTokens never throws, even when the state root is unreadable', async () => {
  const outcomes = await ensureFreshTokens({ stateRoot: path.join(await tmp(), 'does-not-exist') });
  assert.deepEqual(outcomes, []);
});
