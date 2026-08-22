import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { launchClaude, resolveClaudeBin } from '../src/client-launch.js';
import { createRuntimeCredential, readRuntimeCredential } from '../src/admission.js';

const roots: string[] = [];
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cab-launch-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  mkdirSync(bin);
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const output = path.join(root, 'seen.json');
  const claude = path.join(bin, 'claude');
  writeFileSync(claude, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.TEST_OUTPUT, JSON.stringify({ args: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY, cwd: process.cwd() }));
if (process.argv.includes('--signal')) process.kill(process.pid, 'SIGTERM');
else process.exit(Number(process.env.TEST_EXIT || 0));
`);
  chmodSync(claude, 0o700);
  writeFileSync(path.join(home, '.claude', 'settings.json'), '{"untouched":true}');
  writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"oauth":"untouched"}');
  return { root, bin, home, output, claude };
}

test('launcher preserves args/cwd and scopes gateway env to fake Claude', async () => {
  const f = fixture();
  const before = new Map(readdirSync(path.join(f.home, '.claude')).map(name => [name, readFileSync(path.join(f.home, '.claude', name), 'utf8')]));
  const result = await launchClaude({
    args: ['--model', 'opus', 'a value'],
    baseUrl: 'http://127.0.0.1:9000',
    gatewayApiKey: 'runtime-nonce-for-test',
    cwd: f.root,
    stdio: 'pipe',
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, TEST_OUTPUT: f.output },
  });
  assert.deepEqual(result, { code: 0, signal: null });
  const seen = JSON.parse(readFileSync(f.output, 'utf8'));
  assert.deepEqual(seen.args, ['--model', 'opus', 'a value']);
  assert.equal(seen.base, 'http://127.0.0.1:9000');
  assert.equal(seen.key, 'runtime-nonce-for-test');
  assert.equal(seen.cwd, f.root);
  assert.deepEqual(readdirSync(path.join(f.home, '.claude')).sort(), [...before.keys()].sort());
  for (const [name, contents] of before) assert.equal(readFileSync(path.join(f.home, '.claude', name), 'utf8'), contents);
});

test('launcher reports Claude exit code and signal exactly', async () => {
  const f = fixture();
  const env = { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, TEST_OUTPUT: f.output, TEST_EXIT: '37' };
  assert.deepEqual(await launchClaude({ args: [], baseUrl: 'http://localhost:8789', gatewayApiKey: 'runtime-nonce', env, stdio: 'pipe' }), { code: 37, signal: null });
  assert.deepEqual(await launchClaude({ args: ['--signal'], baseUrl: 'http://localhost:8789', gatewayApiKey: 'runtime-nonce', env, stdio: 'pipe' }), { code: null, signal: 'SIGTERM' });
});

test('claude CLI command preserves the child exit status', () => {
  const f = fixture();
  const stateRoot = path.join(f.root, 'state');
  const credential = createRuntimeCredential(stateRoot);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'claude', '--flag', 'value'], {
    cwd: f.root,
    env: {
      ...process.env,
      CLAUDE_BIN: f.claude,
      CLAUDE_AUTH_BALANCER_HOME: stateRoot,
      CLAUDE_AUTH_BALANCER_URL: 'http://127.0.0.1:9999',
      TEST_OUTPUT: f.output,
      TEST_EXIT: '29',
    },
  });
  assert.equal(result.status, 29);
  const seen = JSON.parse(readFileSync(f.output, 'utf8'));
  assert.deepEqual(seen.args, ['--flag', 'value']);
  assert.equal(seen.base, 'http://127.0.0.1:9999');
  assert.equal(seen.key, credential.nonce);
});

test('claude CLI command fails closed when no daemon runtime credential exists', () => {
  const f = fixture();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'claude'], {
    cwd: f.root,
    env: {
      ...process.env,
      CLAUDE_BIN: f.claude,
      CLAUDE_AUTH_BALANCER_HOME: path.join(f.root, 'missing-state'),
      TEST_OUTPUT: f.output,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime credential is missing or unreadable/);
});

test('claude CLI command fails closed when daemon runtime credential is stale', () => {
  const f = fixture();
  const stateRoot = path.join(f.root, 'state');
  createRuntimeCredential(stateRoot, 9_999_999);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'claude'], {
    cwd: f.root,
    env: {
      ...process.env,
      CLAUDE_BIN: f.claude,
      CLAUDE_AUTH_BALANCER_HOME: stateRoot,
      CLAUDE_AUTH_BALANCER_URL: 'http://127.0.0.1:9999',
      TEST_OUTPUT: f.output,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dead daemon instance/);
});

test('serve removes the daemon runtime credential on SIGTERM', async () => {
  const f = fixture();
  const stateRoot = path.join(f.root, 'state');
  const authswapRoot = path.join(f.root, 'authswap');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'serve', '--port', '0'], {
    cwd: f.root,
    env: {
      ...process.env,
      CLAUDE_AUTH_BALANCER_HOME: stateRoot,
      AUTHSWAP_DIR: authswapRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not start; stdout=${stdout}`)), 5000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`serve exited early code=${code} signal=${signal}; stdout=${stdout}`));
      });
      child.stdout.on('data', () => {
        if (stdout.includes('claude-auth-balancer listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    assert.ok(readRuntimeCredential(stateRoot));
    child.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serve did not exit after SIGTERM')), 5000);
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0 || code === null) resolve();
        else reject(new Error(`serve exited with code ${code}`));
      });
    });
    assert.equal(readRuntimeCredential(stateRoot), undefined);
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
});

test('serve rejects invalid max request body caps before writing a runtime credential', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const cases: Array<{ name: string; args: string[] }> = [
    { name: 'NaN', args: ['--max-request-body-mib', 'NaN'] },
    { name: 'Infinity', args: ['--max-request-body-mib', 'Infinity'] },
    { name: 'negative', args: ['--max-request-body-mib', '-1'] },
    { name: 'zero', args: ['--max-request-body-mib', '0'] },
    { name: 'fractional', args: ['--max-request-body-mib', '1.5'] },
    { name: 'fractional-leading-zero', args: ['--max-request-body-mib', '0.5'] },
    { name: 'fractional-trailing-zero', args: ['--max-request-body-mib', '64.0'] },
    { name: 'malformed', args: ['--max-request-body-mib', '64junk'] },
    { name: 'too-large', args: ['--max-request-body-mib', '513'] },
    { name: 'missing', args: ['--max-request-body-mib'] },
  ];
  for (const c of cases) {
    const f = fixture();
    const stateRoot = path.join(f.root, 'state');
    const result = spawnSync(process.execPath, [cli, 'serve', '--port', '0', ...c.args], {
      cwd: f.root,
      env: {
        ...process.env,
        CLAUDE_AUTH_BALANCER_HOME: stateRoot,
        AUTHSWAP_DIR: path.join(f.root, 'authswap'),
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, c.name);
    assert.match(result.stderr, /--max-request-body-mib must be a finite positive integer MiB value/, c.name);
    assert.equal(readRuntimeCredential(stateRoot), undefined, c.name);
  }
});

test('CLAUDE_BIN override wins and recursive self candidate is skipped', async () => {
  const f = fixture();
  assert.equal(await resolveClaudeBin({ CLAUDE_BIN: f.claude }, '/anything'), f.claude);
  const wrapperDir = path.join(f.root, 'wrapper');
  mkdirSync(wrapperDir);
  const wrapper = path.join(wrapperDir, 'claude');
  writeFileSync(wrapper, '#!/bin/sh\nexit 1\n');
  chmodSync(wrapper, 0o700);
  assert.equal(await resolveClaudeBin({ PATH: `${wrapperDir}${path.delimiter}${f.bin}` }, wrapper), f.claude);
});
