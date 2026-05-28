import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupLaunch, getUsage, importAuthswap, prepareLaunch, resolveStateRoot, syncBack } from '../src/index.js';

const exec = promisify(execFile);
async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cab-')); }
async function writeJson(p: string, v: unknown) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(v)); }

test('resolveStateRoot uses env override and default suffix', () => {
  assert.equal(resolveStateRoot({ CODEX_AUTH_BALANCER_HOME: '/tmp/x' } as NodeJS.ProcessEnv), '/tmp/x');
  assert.match(resolveStateRoot({} as NodeJS.ProcessEnv), /\.bravo\/codex-auth-balancer$/);
});

test('importAuthswap copies accounts and tolerates missing primary remaining percent', async () => {
  const root = await tmp(); const legacy = await tmp();
  await writeJson(path.join(legacy, 'accounts', 'a', 'auth.json'), { access_token: 'tok' });
  await writeJson(path.join(legacy, 'accounts', 'a', 'pi-openai-codex.json'), { refresh_token: 'pi' });
  await writeJson(path.join(legacy, 'cache', 'usage.json'), { a: { slot: 'a', windows: { primary: {}, secondary: { remainingPercent: 50 } } } });
  const r = await importAuthswap(legacy, { stateRoot: root });
  assert.deepEqual(r.imported, ['a']);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'cache', 'usage.json'), 'utf8')).a.windows.secondary.remainingPercent, 50);
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

test('syncBack conflict retains isolated dir', async () => {
  const root = await tmp(); const iso = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'old' });
  await prepareLaunch(iso, { stateRoot: root, slot: 's1' });
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'other' });
  await writeJson(path.join(iso, 'codex', 'auth.json'), { access_token: 'new' });
  const r = await syncBack(iso, { stateRoot: root, slot: 's1' });
  assert.equal(r.conflict, true);
  assert.ok(await fs.stat(iso));
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

test('getUsage marks old cache stale by mtime', async () => {
  const root = await tmp();
  await writeJson(path.join(root, 'accounts', 's1', 'auth.json'), { access_token: 'tok' });
  const cache = path.join(root, 'cache', 'usage.json');
  await writeJson(cache, { s1: { primary: { remainingPercent: 42 } } });
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(cache, old, old);
  const usage = await getUsage({ stateRoot: root, staleAfterMs: 1 });
  assert.equal(usage.error, 'stale');
});
