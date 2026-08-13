// The wire call, tested against a real local HTTP server.
//
// Nothing here stubs `fetch`. The point of these tests is the actual encoding
// and the actual status handling — a stub that hands back a pre-shaped object
// would skip exactly the JSON-vs-form-encoding decision that a lenient server
// would forgive and a strict one would not.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

import { OAuthRefreshError, classifyStatus, refreshClaudeToken } from '../src/oauth.js';

type Capture = { method?: string; contentType?: string; body?: unknown };

const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

/** A real HTTP token endpoint that records what it was sent. */
async function tokenServer(
  handler: (body: Record<string, unknown>) => { status: number; payload?: unknown; raw?: string },
): Promise<{ url: string; capture: Capture }> {
  const capture: Capture = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      capture.method = req.method;
      capture.contentType = req.headers['content-type'];
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { __unparseable: text };
      }
      capture.body = parsed;
      const result = handler(parsed);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(result.raw ?? JSON.stringify(result.payload ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/oauth/token`, capture };
}

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

test('the refresh request is JSON, not form-encoded, and carries the scope set', async () => {
  const { url, capture } = await tokenServer(() => ({
    status: 200,
    payload: { access_token: 'sk-ant-oat01-new', expires_in: 3600 },
  }));

  await refreshClaudeToken('sk-ant-ort01-old', { nowMs: NOW, tokenUrl: url });

  assert.equal(capture.method, 'POST');
  assert.match(String(capture.contentType), /application\/json/);
  const body = capture.body as Record<string, unknown>;
  assert.equal(body['grant_type'], 'refresh_token');
  assert.equal(body['refresh_token'], 'sk-ant-ort01-old');
  assert.equal(body['client_id'], '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(
    body['scope'],
    'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  );
});

test('an omitted refresh_token means unchanged, not lost', async () => {
  // Claude Code's own destructure is `{refresh_token: d = e}` — the old token
  // stays valid. Treating absence as "rotated to undefined" would wipe the only
  // means of ever refreshing this account again.
  const { url } = await tokenServer(() => ({
    status: 200,
    payload: { access_token: 'sk-ant-oat01-new', expires_in: 3600 },
  }));

  const tokens = await refreshClaudeToken('sk-ant-ort01-old', { nowMs: NOW, tokenUrl: url });
  assert.equal(tokens.refreshToken, 'sk-ant-ort01-old');
  assert.equal(tokens.rotated, false);
  assert.equal(tokens.accessToken, 'sk-ant-oat01-new');
  assert.equal(tokens.expiresAt, NOW + 3600_000);
});

test('a returned refresh_token rotates and is flagged as such', async () => {
  const { url } = await tokenServer(() => ({
    status: 200,
    payload: {
      access_token: 'sk-ant-oat01-new',
      refresh_token: 'sk-ant-ort01-rotated',
      expires_in: 3600,
      refresh_token_expires_in: 86_400,
      scope: 'user:profile user:inference',
    },
  }));

  const tokens = await refreshClaudeToken('sk-ant-ort01-old', { nowMs: NOW, tokenUrl: url });
  assert.equal(tokens.refreshToken, 'sk-ant-ort01-rotated');
  assert.equal(tokens.rotated, true);
  assert.equal(tokens.refreshTokenExpiresAt, NOW + 86_400_000);
  assert.deepEqual(tokens.scopes, ['user:profile', 'user:inference']);
});

test('a server echoing the same refresh token is not a rotation', async () => {
  const { url } = await tokenServer(body => ({
    status: 200,
    payload: {
      access_token: 'a',
      refresh_token: body['refresh_token'],
      expires_in: 3600,
    },
  }));
  const tokens = await refreshClaudeToken('same-token', { nowMs: NOW, tokenUrl: url });
  assert.equal(tokens.rotated, false, 'no persist-before-reuse hazard exists here');
  assert.equal(tokens.refreshToken, 'same-token');
});

test('400 and 401 are terminal — the grant is dead', async () => {
  for (const status of [400, 401, 403]) {
    const { url } = await tokenServer(() => ({
      status,
      payload: { error: 'invalid_grant', error_description: 'refresh token revoked' },
    }));
    const error = await refreshClaudeToken('dead', { nowMs: NOW, tokenUrl: url }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof OAuthRefreshError, `status ${status} threw the typed error`);
    assert.equal(error.kind, 'terminal');
    assert.equal(error.status, status);
    assert.match(error.message, /invalid_grant/);
  }
});

test('429 and 5xx are transient — they say nothing about the token', async () => {
  for (const status of [429, 500, 502, 503]) {
    const { url } = await tokenServer(() => ({ status, payload: { error: 'try later' } }));
    const error = await refreshClaudeToken('live', { nowMs: NOW, tokenUrl: url }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof OAuthRefreshError);
    assert.equal(error.kind, 'transient', `status ${status} must not brick the slot`);
  }
});

test('a dead endpoint is transient, not terminal', async () => {
  // A real closed port, so this is a genuine ECONNREFUSED rather than a
  // simulated one. Classifying this as terminal would let a laptop waking on a
  // dead network permanently disable every account.
  const dead = http.createServer();
  await new Promise<void>(r => dead.listen(0, '127.0.0.1', r));
  const { port } = dead.address() as AddressInfo;
  await new Promise<void>(r => dead.close(() => r()));

  const error = await refreshClaudeToken('live', {
    nowMs: NOW,
    tokenUrl: `http://127.0.0.1:${port}/v1/oauth/token`,
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof OAuthRefreshError);
  assert.equal(error.kind, 'transient');
});

test('a 200 with no usable credential is transient, not a silent success', async () => {
  const { url } = await tokenServer(() => ({ status: 200, payload: { hello: 'world' } }));
  const error = await refreshClaudeToken('live', { nowMs: NOW, tokenUrl: url }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof OAuthRefreshError);
  assert.equal(error.kind, 'transient');
  assert.match(error.message, /without access_token/);
});

test('a 200 with unparseable JSON does not throw a raw SyntaxError', async () => {
  const { url } = await tokenServer(() => ({ status: 200, raw: '{not json' }));
  const error = await refreshClaudeToken('live', { nowMs: NOW, tokenUrl: url }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof OAuthRefreshError, 'callers branch on kind, so every path must be typed');
  assert.equal(error.kind, 'transient');
});

test('status classification is exhaustive about which codes kill a grant', () => {
  assert.equal(classifyStatus(400), 'terminal');
  assert.equal(classifyStatus(401), 'terminal');
  assert.equal(classifyStatus(403), 'terminal');
  assert.equal(classifyStatus(404), 'transient');
  assert.equal(classifyStatus(429), 'transient');
  assert.equal(classifyStatus(500), 'transient');
});
