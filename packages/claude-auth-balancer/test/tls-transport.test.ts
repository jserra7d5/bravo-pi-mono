import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { AttemptStore } from '../src/attempts.js';
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
    requireGatewayAuth: false,
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

/**
 * A TCP relay that flips one byte in the first application-data record the
 * client sends on its first connection, then passes everything through. The
 * upstream's own TLS stack detects the damage and sends bad_record_mac: the
 * failure a corrupting network path produced on the live deployment.
 */
async function corruptingRelay(targetPort: number): Promise<{ server: net.Server; port: number; connections: () => number }> {
  let connections = 0;
  const server = net.createServer(client => {
    connections += 1;
    let corrupt = connections === 1;
    let pending = Buffer.alloc(0);
    const upstream = net.connect(targetPort, '127.0.0.1');
    client.on('data', (chunk: Buffer) => {
      if (!corrupt) {
        upstream.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      // Forward whole TLS records: 5-byte header (type, version, length), then the body.
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt16BE(3)) {
        const record = Buffer.from(pending.subarray(0, 5 + pending.readUInt16BE(3)));
        pending = pending.subarray(record.length);
        if (corrupt && record[0] === 0x17) {
          record[record.length - 1]! ^= 0xff;
          corrupt = false;
        }
        upstream.write(record);
      }
      if (!corrupt && pending.length > 0) {
        upstream.write(pending);
        pending = Buffer.alloc(0);
      }
    });
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port, connections: () => connections };
}

async function runBadRecordMacProof(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cab-tls-mac-'));
  const authswapRoot = path.join(root, 'authswap');
  const stateRoot = path.join(root, 'state');
  const credentials = path.join(authswapRoot, 'providers', 'anthropic', 'credentials');
  mkdirSync(credentials, { recursive: true });
  writeFileSync(path.join(credentials, '.credentials-1-a@example.com.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-tls-mac-token',
      refreshToken: 'fake-tls-mac-refresh',
      expiresAt: Date.now() + 3_600_000,
      subscriptionType: 'max',
    },
  }));

  const completeRequests: string[] = [];
  const upstream = https.createServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certificatePath),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      completeRequests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  upstream.on('tlsClientError', () => { /* the corrupted connection */ });

  let proxy: import('node:http').Server | undefined;
  let relay: Awaited<ReturnType<typeof corruptingRelay>> | undefined;
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    relay = await corruptingRelay((upstream.address() as { port: number }).port);
    const started = await startProxy({
      port: 0,
      upstream: `https://127.0.0.1:${relay.port}`,
      authswapRoot,
      stateRoot,
      metrics: false,
      usageProbe: false,
      usageSweepIntervalMs: 0,
      requireGatewayAuth: false,
    });
    proxy = started.server;

    const body = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'x'.repeat(50_000) }] });
    const response = await fetch(`${started.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 200, 'the refused request is re-sent instead of surfacing as a 502');
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(relay.connections(), 2, 'one corrupted connection, one clean retry');
    assert.deepEqual(completeRequests, [body], 'upstream held exactly one complete request');

    const attempts = new AttemptStore(stateRoot);
    try {
      const rows = attempts.query(
        "SELECT outcome, reason_code, error_code, wire_started FROM auth_balancer_attempts WHERE outcome IN ('transport_failed_after_wire', 'retried_same_slot', 'completed') ORDER BY id",
      ) as Record<string, string | number | null>[];
      assert.deepEqual(rows.map(row => ({ ...row })), [
        { outcome: 'transport_failed_after_wire', reason_code: 'retryable_transport_failure', error_code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC', wire_started: 1 },
        { outcome: 'retried_same_slot', reason_code: 'peer_rejected_request_retry', error_code: null, wire_started: 1 },
        { outcome: 'completed', reason_code: 'upstream_completed', error_code: null, wire_started: 1 },
      ]);
    } finally {
      attempts.close();
    }
  } finally {
    if (proxy) await close(proxy);
    if (relay) await close(relay.server as unknown as import('node:http').Server);
    await close(upstream);
    rmSync(root, { recursive: true, force: true });
  }
}

const proofs: Record<string, () => Promise<void>> = {
  'fresh-tls': runTlsWireProof,
  'bad-record-mac': runBadRecordMacProof,
};

// NODE_EXTRA_CA_CERTS is read only at process startup. A child gives these
// wire tests explicit trust in their static local CA without weakening
// verification process-wide for the package test runner or production.
async function runChild(proof: string): Promise<void> {
  {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        [CHILD_MARKER]: proof,
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
  }
}

const childProof = process.env[CHILD_MARKER];
if (childProof) {
  proofs[childProof]!().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  test('dedicated HTTPS agent opens fresh TCP and TLS sessions without replay', () => runChild('fresh-tls'));
  test('a request upstream TLS refused with bad_record_mac is re-sent once, after wire', () => runChild('bad-record-mac'));
}
