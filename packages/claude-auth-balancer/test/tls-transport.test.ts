import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { startProxy } from '../src/proxy.js';

const CHILD_MARKER = 'CLAUDE_AUTH_BALANCER_TLS_TEST_CHILD';
const certificatePath = fileURLToPath(new URL('../../test/fixtures/localhost-cert.pem', import.meta.url));
const keyPath = fileURLToPath(new URL('../../test/fixtures/localhost-key.pem', import.meta.url));

async function close(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function runTlsWireProof(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cab-tls-transport-'));
  const authswapRoot = path.join(root, 'authswap');
  const stateRoot = path.join(root, 'state');
  const credentials = path.join(authswapRoot, 'providers', 'anthropic', 'credentials');
  mkdirSync(credentials, { recursive: true });
  writeFileSync(path.join(credentials, '.credentials-1-a@example.com.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-tls-wire-token',
      refreshToken: 'fake-tls-wire-refresh',
      expiresAt: Date.now() + 3_600_000,
      subscriptionType: 'max',
    },
  }));

  const resumed: boolean[] = [];
  let upstreamRequests = 0;
  const upstream = https.createServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certificatePath),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  }, (req, res) => {
    upstreamRequests += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  upstream.on('secureConnection', socket => resumed.push((socket as TLSSocket).isSessionReused()));

  let proxy: import('node:http').Server | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const upstreamPort = (upstream.address() as { port: number }).port;
    const started = await startProxy({
      port: 0,
      upstream: `https://127.0.0.1:${upstreamPort}`,
      authswapRoot,
      stateRoot,
      metrics: false,
      usageProbe: false,
    });
    proxy = started.server;

    for (let request = 0; request < 2; request += 1) {
      const response = await fetch(`${started.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: String(request) }] }),
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"ok":true}');
    }

    assert.equal(upstreamRequests, 2, 'each logical request reached upstream exactly once');
    assert.equal(resumed.length, 2, 'sequential requests used two TCP/TLS connections');
    assert.deepEqual(resumed, [false, false], 'neither TLS connection resumed a cached session');
  } finally {
    if (proxy) await close(proxy);
    await close(upstream);
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.env[CHILD_MARKER] === '1') {
  runTlsWireProof().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  test('dedicated HTTPS agent opens fresh TCP and TLS sessions without replay', async () => {
    // NODE_EXTRA_CA_CERTS is read only at process startup. A child gives this
    // one wire test explicit trust in its static local CA without weakening
    // verification process-wide for the package test runner or production.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        [CHILD_MARKER]: '1',
        NODE_EXTRA_CA_CERTS: certificatePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('TLS transport child timed out'));
      }, 15_000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, `TLS transport child failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });
}
