import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { cleanupLaunch, finishTokenLease, getDbStatus, getUsage, ingestDirectPiLiveUsage, ingestLiveUsage, isProcessAlive, listReservations, prepareLaunch, refreshUsage, resolveStateRoot, selectSingleActivePiSlot, shouldStealRefreshLock, startTokenLease, syncBack, unbrickSlot } from '../src/index.js';
import codexBalancedProvider, { getBalancedCodexModels } from '../extensions/pi/index.js';
import { openaiCodexOAuthProvider } from '@earendil-works/pi-ai/oauth';

const exec = promisify(execFile);
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

test('balanced provider mirrors installed openai-codex models with public provider id', () => {
  const models = getBalancedCodexModels();
  assert.ok(models.length > 0);
  assert.ok(models.every(model => model.provider === 'bravo-codex-balanced'));
  assert.ok(models.every(model => model.id.startsWith('bravo-codex-balanced/')));
  assert.ok(models.every(model => model.api === 'openai-codex-responses'));
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

test('provider re-asserts its api-handler override on session_start and turn_start (survives pi reload() resetApiProviders)', () => {
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

  // Initial load registers exactly once and subscribes to both lifecycle events.
  assert.deepEqual(registrations, ['bravo-codex-balanced']);
  assert.ok(handlers.has('session_start'), 'subscribes to session_start');
  assert.ok(handlers.has('turn_start'), 'subscribes to turn_start');

  // Simulate a reload() wipe followed by the next turn: turn_start must
  // re-register (reinstall the override) before the model is dispatched.
  handlers.get('turn_start')!({ type: 'turn_start', turnIndex: 0, timestamp: 0 }, {});
  assert.deepEqual(registrations, ['bravo-codex-balanced', 'bravo-codex-balanced']);

  // session_start (e.g. reload's re-emit) also re-asserts.
  handlers.get('session_start')!({ type: 'session_start' }, {});
  assert.equal(registrations.length, 3);
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
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: refreshedToken, refresh: 'new-refresh-token', expires: Date.now() + 60_000, accountId: 'acct-1' });
  try {
    const lease = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, preferred_slot: 'refresh' });
    assert.equal(lease.access_token, refreshedToken);
    const stored = JSON.parse(await fs.readFile(path.join(root, 'accounts', 'refresh', 'pi-openai-codex.json'), 'utf8'));
    assert.equal(stored.access, refreshedToken);
    assert.equal(stored.refresh, 'new-refresh-token');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'); };
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'broke')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  // Simulate a concurrent pi-balanced child that rotated our token and synced the fresh
  // credential to disk BEFORE our refresh of the stale token returns invalid_grant.
  (openaiCodexOAuthProvider as any).refreshToken = async () => {
    await writeJson(slotAuth, { access: freshJwt, refresh: 'r1', expires: Date.now() + 3_600_000 });
    throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}');
  };
  try {
    const lease = await startTokenLease(leaseArgs(root, 'race'));
    assert.equal(lease.access_token, freshJwt);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'race');
  assert.notEqual(slot?.status, 'broken');
});

test('startTokenLease does NOT chain-retry with a rotated refresh token (reuse-safety); bricks instead', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'advance');
  const slotAuth = path.join(root, 'accounts', 'advance', 'pi-openai-codex.json');
  await writeJson(slotAuth, { access: 'old-access-token', refresh: 'r0', expires: Date.now() + 10 });
  let calls = 0;
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async (cred: any) => {
    calls += 1;
    // A concurrent process rotated r0 -> r1 on disk but left NO usable access token. Replaying/
    // advancing to r1 could trip OpenAI refresh-token reuse detection and invalidate the whole
    // family, so we must NOT try it: recovery only adopts a usable access token, never another refresh.
    await writeJson(slotAuth, { access: 'old-access-token', refresh: 'r1', expires: Date.now() + 10 });
    throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}');
  };
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'advance')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
  assert.equal(calls, 1); // tried r0 exactly once; never retried with the rotated r1
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'advance');
  assert.equal(slot?.status, 'broken');
});

test('startTokenLease still bricks on invalid_grant when the on-disk token never advances (genuinely dead)', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'dead');
  const original = openaiCodexOAuthProvider.refreshToken;
  // Always invalid_grant and never mutate the file: the token cannot advance, so no recovery.
  (openaiCodexOAuthProvider as any).refreshToken = async () => { throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'); };
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'dead')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
  const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'dead');
  assert.equal(slot?.status, 'broken');
  assert.equal(slot?.problem?.code, 'refresh_invalid_grant');
});

test('startTokenLease atomic write leaves no temp files behind', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'atomic');
  const freshJwt = fakeCodexJwt('acct-1', 3600);
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: freshJwt, refresh: 'new-refresh-token', expires: Date.now() + 3_600_000, accountId: 'acct-1' });
  try {
    const lease = await startTokenLease(leaseArgs(root, 'atomic'));
    assert.equal(lease.access_token, freshJwt);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { throw new Error('OpenAI Codex token refresh failed (503): upstream'); };
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'flap')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
  const usage = await getUsage({ stateRoot: root });
  const slot = usage.accounts.find(a => a.slot === 'flap');
  assert.notEqual(slot?.status, 'broken');
  // Still selectable: refresh now succeeds and the slot leases.
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: fakeCodexJwt('acct-1', 3600), refresh: 'new-refresh-token', expires: Date.now() + 60_000, accountId: 'acct-1' });
  try {
    const lease = await startTokenLease(leaseArgs(root, 'flap'));
    assert.equal(lease.slot, 'flap');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
});

test('startTokenLease records real error_kind in telemetry on hard failure', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'tele');
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'); };
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'tele')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { throw new Error(`refresh blew up token=${jwt} Bearer sk-secret`); };
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'redact')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'); };
  try {
    await startTokenLease(leaseArgs(root, 'contract'));
    assert.fail('expected startTokenLease to reject');
  } catch (error) {
    assert.equal((error as Error).message, 'selected slot access token refresh failed');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
});

test('unbrickSlot clears broken status and makes the slot selectable again', async () => {
  const root = await tmp();
  await seedRefreshSlot(root, 'fixme');
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'); };
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'fixme')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
  assert.equal((await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'fixme')?.status, 'broken');
  unbrickSlot(root, 'fixme');
  assert.equal((await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'fixme')?.status, 'unknown');
  // Re-auth happened out of band; a healthy refresh now leases the slot.
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: fakeCodexJwt('acct-1', 3600), refresh: 'new-refresh-token', expires: Date.now() + 60_000, accountId: 'acct-1' });
  try {
    const lease = await startTokenLease(leaseArgs(root, 'fixme'));
    assert.equal(lease.slot, 'fixme');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
});

test('startTokenLease leases pass-through a valid claim-bearing token without refreshing', async () => {
  const root = await tmp();
  const token = fakeCodexJwt('acct-1', 3600);
  await writeJson(path.join(root, 'accounts', 'passthru', 'pi-openai-codex.json'), { access: token, refresh: 'refresh-token', expires: Date.now() + 3_600_000 });
  await writeJson(path.join(root, 'accounts', 'passthru', 'auth.json'), { access_token: 'codex-token', expiry_date: Date.now() + 3_600_000 });
  const original = openaiCodexOAuthProvider.refreshToken;
  let refreshCalled = false;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { refreshCalled = true; throw new Error('refresh should not be called for a claim-bearing token'); };
  try {
    const lease = await startTokenLease(leaseArgs(root, 'passthru'));
    assert.equal(refreshCalled, false);
    assert.equal(lease.access_token, token);
    assert.equal(lease.slot, 'passthru');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
});

test('startTokenLease refreshes a not-yet-expired but claimless cached token', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'claimless', 'pi-openai-codex.json'), { access: fakeClaimlessJwt(3600), refresh: 'refresh-token', expires: Date.now() + 3_600_000 });
  // auth.json must exist for the slot to be discovered by scanInternalAccounts; the lease reads piAuthPath (pi-openai-codex.json) first.
  await writeJson(path.join(root, 'accounts', 'claimless', 'auth.json'), { access_token: fakeClaimlessJwt(3600), expiry_date: Date.now() + 3_600_000 });
  const refreshed = fakeCodexJwt('acct-1', 3600);
  const original = openaiCodexOAuthProvider.refreshToken;
  let refreshCalled = false;
  (openaiCodexOAuthProvider as any).refreshToken = async () => { refreshCalled = true; return { type: 'oauth', access: refreshed, refresh: 'r2', expires: Date.now() + 3_600_000, accountId: 'acct-1' }; };
  try {
    const lease = await startTokenLease(leaseArgs(root, 'claimless'));
    assert.equal(refreshCalled, true);
    assert.equal(lease.access_token, refreshed);
    const slot = (await getUsage({ stateRoot: root })).accounts.find(a => a.slot === 'claimless');
    assert.notEqual(slot?.status, 'broken');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
  }
});

test('startTokenLease marks slot broken + fails when refresh still yields a claimless token', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'stillclaimless', 'pi-openai-codex.json'), { access: fakeClaimlessJwt(3600), refresh: 'refresh-token', expires: Date.now() + 3_600_000 });
  // auth.json must exist for the slot to be discovered by scanInternalAccounts; the lease reads piAuthPath (pi-openai-codex.json) first.
  await writeJson(path.join(root, 'accounts', 'stillclaimless', 'auth.json'), { access_token: fakeClaimlessJwt(3600), expiry_date: Date.now() + 3_600_000 });
  await writeJson(path.join(root, 'accounts', 'good', 'auth.json'), { access_token: fakeCodexJwt('acct-good', 3600), expiry_date: Date.now() + 3_600_000 });
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: fakeClaimlessJwt(3600), refresh: 'r2', expires: Date.now() + 3_600_000, accountId: 'acct-1' });
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'stillclaimless')), /selected slot access token refresh failed/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  let refreshCount = 0;
  const original = openaiCodexOAuthProvider.refreshToken;
  // Each refresh: count it, await a small delay (forces the two leases to overlap inside the
  // lock window), then WRITE the fresh far-future token to disk like the real refresh path does.
  (openaiCodexOAuthProvider as any).refreshToken = async () => {
    refreshCount += 1;
    await new Promise(r => setTimeout(r, 50));
    await writeJson(slotAuth, { access: freshJwt, refresh: 'r1', expires: Date.now() + 3_600_000 });
    return { type: 'oauth', access: freshJwt, refresh: 'r1', expires: Date.now() + 3_600_000, accountId: 'acct-1' };
  };
  try {
    // Both promises created before any await so they genuinely race for the same lock.
    const p1 = startTokenLease(leaseArgs(root, 'serialize'));
    const p2 = startTokenLease(leaseArgs(root, 'serialize'));
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.access_token, freshJwt);
    assert.equal(b.access_token, freshJwt);
    // The lock serialized them: the 2nd acquirer re-read the now-fresh token and skipped refresh.
    assert.equal(refreshCount, 1);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: freshJwt, refresh: 'r1', expires: Date.now() + 3_600_000, accountId: 'acct-1' });
  try {
    const lease = await startTokenLease(leaseArgs(root, 'deadowner'));
    assert.equal(lease.access_token, freshJwt);
    assert.equal(lease.slot, 'deadowner');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  const priorEnv = process.env.CODEX_BALANCER_REFRESH_LOCK_ACQUIRE_MS;
  process.env.CODEX_BALANCER_REFRESH_LOCK_ACQUIRE_MS = '400';
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: fakeCodexJwt('acct-1', 3600), refresh: 'r1', expires: Date.now() + 3_600_000, accountId: 'acct-1' });
  try {
    await assert.rejects(startTokenLease(leaseArgs(root, 'liveowner')), /timed out waiting for token refresh lock/);
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
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
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => {
    // Mid-run, a different process "steals" and re-takes the lock: overwrite owner.json with a
    // foreign nonce. Our finally must see the mismatch and leave this lock intact.
    await writeJson(ownerPath, { schema_version: 1, pid: process.pid, nonce: 'foreign-stealer-nonce', created_at: Date.now() });
    return { type: 'oauth', access: freshJwt, refresh: 'r1', expires: Date.now() + 3_600_000, accountId: 'acct-1' };
  };
  try {
    const lease = await startTokenLease(leaseArgs(root, 'foreignsteal'));
    assert.equal(lease.access_token, freshJwt);
    // The foreign-owned lock must NOT have been deleted by our finally.
    const remaining = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    assert.equal(remaining.nonce, 'foreign-stealer-nonce');
  } finally {
    (openaiCodexOAuthProvider as any).refreshToken = original;
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
