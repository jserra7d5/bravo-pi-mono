import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupLaunch, finishTokenLease, getDbStatus, getUsage, listReservations, prepareLaunch, refreshUsage, resolveStateRoot, startTokenLease, syncBack } from '../src/index.js';
import { getBalancedCodexModels } from '../extensions/pi/index.js';
import { openaiCodexOAuthProvider } from '@earendil-works/pi-ai/oauth';

const exec = promisify(execFile);
async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cab-')); }
async function writeJson(p: string, v: unknown) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(v)); }

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

test('pi-balanced launches Pi with isolated auth and preserved config/session dirs', async () => {
  const root = await tmp(); const sourceAgent = await tmp(); const binDir = await tmp(); const runRoot = path.join(await tmp(), 'run-');
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'codex-old' });
  await writeJson(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), { type: 'oauth', refresh: 'pi-old' });
  await writeJson(path.join(root, 'cache', 'usage.json'), { schema_version: 2, generated_at: Date.now(), accounts: { s1: { slot: 's1', status: 'ok', updatedAt: Date.now(), primary: { label: 'primary', remainingPercent: 100 } } } });
  await writeJson(path.join(sourceAgent, 'settings.json'), { theme: 'test' });
  await fs.mkdir(path.join(sourceAgent, 'sessions'), { recursive: true });
  const capture = path.join(await tmp(), 'env.json');
  await fs.writeFile(path.join(binDir, 'pi'), `#!/usr/bin/env node\nconst fs=require('fs'), path=require('path');\nconst agent=process.env.PI_CODING_AGENT_DIR;\nconst auth=JSON.parse(fs.readFileSync(path.join(agent,'auth.json'),'utf8'));\nfs.writeFileSync('${capture}', JSON.stringify({agent, sessions:process.env.PI_CODING_AGENT_SESSION_DIR, hasSettings:fs.existsSync(path.join(agent,'settings.json')), auth}, null, 2));\nfs.writeFileSync(path.join(agent,'auth.json'), JSON.stringify({type:'oauth', refresh:'pi-new'}));\n`, { mode: 0o755 });
  const cli = new URL('../src/pi-balanced.js', import.meta.url).pathname;
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, CODEX_AUTH_BALANCER_HOME: root, PI_CODING_AGENT_DIR: sourceAgent, PI_BALANCED_RUN_ROOT: runRoot };
  const result = await exec(process.execPath, [cli, '--version'], { env, timeout: 5000 });
  assert.equal(result.stderr.includes('Codex account slot s1'), true);
  const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.equal(captured.sessions, path.join(sourceAgent, 'sessions'));
  assert.equal(captured.hasSettings, true);
  assert.equal(captured.auth['openai-codex'].refresh, 'pi-old');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'accounts', 's1', 'pi-openai-codex.json'), 'utf8')).refresh, 'pi-new');
  assert.equal((await listReservations({ stateRoot: root })).length, 0);
});

test('balanced provider mirrors installed openai-codex models with public provider id', () => {
  const models = getBalancedCodexModels();
  assert.ok(models.length > 0);
  assert.ok(models.every(model => model.provider === 'bravo-codex-balanced'));
  assert.ok(models.every(model => model.id.startsWith('bravo-codex-balanced/')));
  assert.ok(models.every(model => model.api === 'openai-codex-responses'));
});

test('startTokenLease extracts token from slot Pi auth, honors affinity, and finish is idempotent', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'a', 'auth.json'), { access_token: 'codex-a-token', expiry_date: Date.now() + 60_000 });
  await writeJson(path.join(root, 'accounts', 'a', 'pi-openai-codex.json'), { access: 'pi-a-token-123', expires: Date.now() + 60_000 });
  await writeJson(path.join(root, 'accounts', 'b', 'auth.json'), { access_token: 'codex-b-token', expiry_date: Date.now() + 60_000 });
  const first = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, preferred_slot: 'a', session_affinity_key: 'sess-1' });
  assert.equal(first.access_token, 'pi-a-token-123');
  assert.equal(first.slot, 'a');
  const done = await finishTokenLease({ stateRoot: root, lease_id: first.lease_id, reservation_id: first.reservation_id, launch_id: first.launch_id, status: 'completed' });
  assert.equal(done.already_final, false);
  const retry = await finishTokenLease({ stateRoot: root, lease_id: first.lease_id, reservation_id: first.reservation_id, launch_id: first.launch_id, status: 'failed' });
  assert.equal(retry.already_final, true);
  const second = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, session_affinity_key: 'sess-1' });
  assert.equal(second.slot, 'a');
});

test('startTokenLease refreshes near-expired OAuth credentials before leasing', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 'refresh', 'pi-openai-codex.json'), { access: 'old-access-token', refresh: 'refresh-token', expires: Date.now() + 10 });
  await writeJson(path.join(root, 'accounts', 'refresh', 'auth.json'), { access_token: 'codex-token', expiry_date: Date.now() + 60_000 });
  const original = openaiCodexOAuthProvider.refreshToken;
  (openaiCodexOAuthProvider as any).refreshToken = async () => ({ type: 'oauth', access: 'new-access-token', refresh: 'new-refresh-token', expires: Date.now() + 60_000, accountId: 'acct-1' });
  try {
    const lease = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'bravo-codex-balanced/fake', purpose: 'pi-provider-request', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 1000, preferred_slot: 'refresh' });
    assert.equal(lease.access_token, 'new-access-token');
    const stored = JSON.parse(await fs.readFile(path.join(root, 'accounts', 'refresh', 'pi-openai-codex.json'), 'utf8'));
    assert.equal(stored.access, 'new-access-token');
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

  await writeJson(path.join(root, 'accounts', 'ok', 'auth.json'), { access_token: 'valid-token-123', expiry_date: Date.now() + 60_000 });
  const lease = await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'm', purpose: 'manual', expected_runtime_ms: 1, ttl_safety_buffer_ms: 0, preferred_slot: 'ok' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await startTokenLease({ stateRoot: root, provider: 'bravo-codex-balanced', model: 'm', purpose: 'manual', expected_runtime_ms: 1000, ttl_safety_buffer_ms: 0, preferred_slot: 'ok' });
  const states = await listReservations({ stateRoot: root, includeInactive: true });
  assert.equal(states.find(r => r.id === lease.reservation_id)?.state, 'expired');
});

test('CLI token prints only access token and stores redacted lease metadata', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'cli-token-12345', refresh_token: 'refresh-secret', expiry_date: Date.now() + 10 * 60_000 });
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const env = { ...process.env, CODEX_AUTH_BALANCER_HOME: root };
  const { stdout, stderr } = await exec(process.execPath, [cli, 'token', '--provider', 'bravo-codex-balanced', '--lease-key', '00000000-0000-4000-8000-000000000001', '--model', 'bravo-codex-balanced/fake'], { env, timeout: 5000 });
  assert.equal(stdout, 'cli-token-12345\n');
  assert.doesNotMatch(stderr, /cli-token|refresh-secret/);
  const files = await fs.readdir(path.join(root, 'leases', 'keys'));
  assert.equal(files.length, 1);
  const leaseFile = await fs.readFile(path.join(root, 'leases', 'keys', files[0]), 'utf8');
  assert.doesNotMatch(leaseFile, /cli-token|refresh-secret/);
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
