import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cab-pib-')); }

// Fake `pi` executable: append the launcher's argv + a few env vars to a JSON capture file,
// then exit 0. PI_BALANCED_PI_BIN points the launcher at this instead of a real `pi`.
async function writeFakePiBin(binPath: string, capturePath: string) {
  await fs.writeFile(
    binPath,
    `#!/usr/bin/env node\n` +
      `const fs = require('fs');\n` +
      `const record = {\n` +
      `  argv: process.argv.slice(2),\n` +
      `  BRAVO_PI_BALANCED: process.env.BRAVO_PI_BALANCED,\n` +
      `  CODEX_AUTH_BALANCER_HOME: process.env.CODEX_AUTH_BALANCER_HOME,\n` +
      `};\n` +
      `fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(record) + '\\n');\n` +
      `process.exit(0);\n`,
    { mode: 0o755 },
  );
}

const launcher = new URL('../src/pi-balanced.js', import.meta.url).pathname;

// Recursively check that no isolated auth files (the copy path's footprint) exist anywhere
// under the given roots.
async function findAuthFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(p: string) {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name === 'auth.json') out.push(child);
    }
  }
  await walk(root);
  return out;
}

test('pi-balanced launcher passes BRAVO_PI_BALANCED + state home + verbatim argv to pi, copies nothing', async () => {
  const home = await tmp();
  const binDir = await tmp();
  const capturePath = path.join(await tmp(), 'capture.jsonl');
  const stateRoot = path.join(home, 'state-root');
  await writeFakePiBin(path.join(binDir, 'fake-pi'), capturePath);

  const passthrough = ['--model', 'bravo-codex-balanced/gpt-5.5', '-p', 'hello world', '--flag'];
  const result = await exec(process.execPath, [launcher, ...passthrough], {
    env: { ...process.env, CODEX_AUTH_BALANCER_HOME: stateRoot, PI_BALANCED_PI_BIN: path.join(binDir, 'fake-pi') },
    timeout: 5000,
  });

  // (a) the fake pi saw the marker, the state home, and the verbatim passthrough args.
  const lines = (await fs.readFile(capturePath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const captured = JSON.parse(lines[0]);
  assert.equal(captured.BRAVO_PI_BALANCED, '1');
  assert.equal(captured.CODEX_AUTH_BALANCER_HOME, stateRoot);
  assert.deepEqual(captured.argv, passthrough);
  assert.match(result.stderr, /routing through bravo-codex-balanced provider/);

  // (b) no isolated auth files anywhere under home/state-root/tmp capture dir => prepareLaunch
  //     never ran, i.e. the copied-credential path is gone.
  assert.deepEqual(await findAuthFiles(home), []);
  assert.deepEqual(await findAuthFiles(binDir), []);
  assert.deepEqual(await findAuthFiles(path.dirname(capturePath)), []);
});

test('pi-balanced launcher falls back to resolveStateRoot when CODEX_AUTH_BALANCER_HOME is unset', async () => {
  const binDir = await tmp();
  const fakeHome = await tmp();
  const capturePath = path.join(await tmp(), 'capture.jsonl');
  await writeFakePiBin(path.join(binDir, 'fake-pi'), capturePath);

  const env = { ...process.env, PI_BALANCED_PI_BIN: path.join(binDir, 'fake-pi'), HOME: fakeHome, USERPROFILE: fakeHome };
  delete (env as Record<string, string | undefined>).CODEX_AUTH_BALANCER_HOME;
  await exec(process.execPath, [launcher], { env, timeout: 5000 });

  const captured = JSON.parse((await fs.readFile(capturePath, 'utf8')).trim());
  assert.equal(captured.BRAVO_PI_BALANCED, '1');
  // resolveStateRoot default lives under <home>/.bravo/codex-auth-balancer.
  assert.equal(captured.CODEX_AUTH_BALANCER_HOME, path.resolve(fakeHome, '.bravo', 'codex-auth-balancer'));
});

test('pi-balanced launcher refuses a nested launch when BRAVO_PI_BALANCED is already set', async () => {
  const binDir = await tmp();
  const capturePath = path.join(await tmp(), 'capture.jsonl');
  await writeFakePiBin(path.join(binDir, 'fake-pi'), capturePath);

  await assert.rejects(
    exec(process.execPath, [launcher, '--version'], {
      env: { ...process.env, BRAVO_PI_BALANCED: '1', PI_BALANCED_PI_BIN: path.join(binDir, 'fake-pi') },
      timeout: 5000,
    }),
    (error: unknown) => {
      const e = error as { code?: number; stderr?: string };
      assert.ok((e.code ?? 0) !== 0, 'nested launch must exit non-zero');
      assert.match(String(e.stderr), /refusing nested pi-balanced launch/);
      return true;
    },
  );
  // The guard fired before spawning pi: nothing was captured.
  await assert.rejects(fs.stat(capturePath), /ENOENT/);
});
