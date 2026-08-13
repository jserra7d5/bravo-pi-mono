// Refresh orchestration: locking, persistence, and the failure paths.
//
// The exchange itself runs against a real local HTTP token endpoint via the
// real `refreshClaudeToken`, so these tests cover the actual encode/parse path
// rather than a hand-shaped result object. Only the host is redirected.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { Account } from '../src/accounts.js';
import { isRefreshable, loadAccountStates, readOAuth } from '../src/accounts.js';
import { OAuthRefreshError, refreshClaudeToken } from '../src/oauth.js';
import { REFRESH_SKEW_MS, TERMINAL_BACKOFF_MS, TokenRefresher, mergeCredentialFile } from '../src/refresh.js';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const HOUR = 3_600_000;

const roots: string[] = [];
const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Build an authswap-shaped credential directory with one account. */
function fixture(oauth: Record<string, unknown>, extra: Record<string, unknown> = {}): Account {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cab-refresh-'));
  roots.push(root);
  const file = path.join(root, '.credentials-1-a@x.com.json');
  writeFileSync(file, JSON.stringify({ ...extra, claudeAiOauth: oauth }, null, 2));
  return { slot: '1', email: 'a@x.com', credentialPath: file };
}

function live(expiresAt: number): Record<string, unknown> {
  return {
    accessToken: 'sk-ant-oat01-current',
    refreshToken: 'sk-ant-ort01-current',
    expiresAt,
    refreshTokenExpiresAt: NOW + 30 * 24 * HOUR,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
  };
}

/** A real token endpoint. `seen` records every refresh token it was handed. */
async function endpoint(
  reply: (n: number) => { status: number; payload?: unknown },
): Promise<{ refresh: typeof refreshClaudeToken; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
      seen.push(body['refresh_token']!);
      const result = reply(seen.length);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.payload ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/v1/oauth/token`;
  return {
    refresh: (token, options) => refreshClaudeToken(token, { ...options, tokenUrl: url }),
    seen,
  };
}

const ok = (n: number) => ({
  status: 200,
  payload: { access_token: `sk-ant-oat01-new-${n}`, refresh_token: `sk-ant-ort01-new-${n}`, expires_in: 28_800 },
});

// ---------------------------------------------------------------------------

test('merging a refreshed token preserves fields this package does not model', () => {
  const raw = JSON.stringify({
    someOtherProvider: { keep: true },
    claudeAiOauth: { accessToken: 'old', refreshToken: 'old-r', expiresAt: 1, subscriptionType: 'max', unknownField: 7 },
  });
  const merged = JSON.parse(
    mergeCredentialFile(raw, {
      accessToken: 'new',
      refreshToken: 'new-r',
      rotated: true,
      expiresAt: 999,
    }),
  ) as Record<string, Record<string, unknown>>;

  assert.deepEqual(merged['someOtherProvider'], { keep: true });
  assert.equal(merged['claudeAiOauth']!['subscriptionType'], 'max', 'authswap still needs this');
  assert.equal(merged['claudeAiOauth']!['unknownField'], 7, 'a future field survives our write');
  assert.equal(merged['claudeAiOauth']!['accessToken'], 'new');
  assert.equal(merged['claudeAiOauth']!['expiresAt'], 999);
});

test('a token comfortably inside its lifetime is never sent to the wire', async () => {
  const account = fixture(live(NOW + 8 * HOUR));
  const { refresh, seen } = await endpoint(ok);
  const r = new TokenRefresher({ now: () => NOW, refresh });

  const outcome = await r.ensureFresh(account);
  assert.equal(outcome.status, 'fresh');
  assert.equal(seen.length, 0, 'no exchange happened at all');
});

test('a token inside the skew window is refreshed before it can expire mid-request', async () => {
  const account = fixture(live(NOW + REFRESH_SKEW_MS - 60_000));
  const { refresh, seen } = await endpoint(ok);
  const r = new TokenRefresher({ now: () => NOW, refresh });

  const outcome = await r.ensureFresh(account);
  assert.equal(outcome.status, 'refreshed');
  assert.deepEqual(seen, ['sk-ant-ort01-current']);

  const stored = readOAuth(account.credentialPath)!;
  assert.equal(stored.accessToken, 'sk-ant-oat01-new-1');
  assert.equal(stored.refreshToken, 'sk-ant-ort01-new-1', 'the rotated token is persisted');
  assert.equal(stored.expiresAt, NOW + 28_800_000);
  assert.equal(stored.subscriptionType, 'max', 'unrelated fields intact on disk');
});

test('an already-expired token is still refreshed rather than written off', async () => {
  const account = fixture(live(NOW - 92 * HOUR)); // the observed real-world state
  const { refresh, seen } = await endpoint(ok);
  const r = new TokenRefresher({ now: () => NOW, refresh });

  assert.equal((await r.ensureFresh(account)).status, 'refreshed');
  assert.equal(seen.length, 1);
});

test('a transient failure leaves the credential file byte-identical', async () => {
  const account = fixture(live(NOW - HOUR));
  const before = readFileSync(account.credentialPath);
  const { refresh } = await endpoint(() => ({ status: 503, payload: { error: 'unavailable' } }));
  const r = new TokenRefresher({ now: () => NOW, refresh });

  const outcome = await r.ensureFresh(account);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.kind, 'transient');
  assert.deepEqual(readFileSync(account.credentialPath), before, 'the refresh token must survive a blip');
  assert.ok(!existsSync(`${account.credentialPath}.refresh.lock`), 'the lock is released on the failure path');
});

test('a terminal failure backs off instead of hammering a revoked grant', async () => {
  const account = fixture(live(NOW - HOUR));
  const { refresh, seen } = await endpoint(() => ({ status: 400, payload: { error: 'invalid_grant' } }));
  let now = NOW;
  const r = new TokenRefresher({ now: () => now, refresh });

  const first = await r.ensureFresh(account);
  assert.equal(first.status, 'failed');
  assert.equal(first.kind, 'terminal');

  now += 60_000;
  assert.equal((await r.ensureFresh(account)).status, 'skipped');
  assert.equal(seen.length, 1, 'the second attempt never reached the wire');

  now += TERMINAL_BACKOFF_MS + 1;
  await r.ensureFresh(account);
  assert.equal(seen.length, 2, 'it does retry once the backoff elapses');
});

test('concurrent callers share ONE exchange, so rotation cannot race itself', async () => {
  const account = fixture(live(NOW - HOUR));
  let release: (() => void) | undefined;
  const gate = new Promise<void>(r => (release = r));
  let calls = 0;

  const r = new TokenRefresher({
    now: () => NOW,
    refresh: async (token, options) => {
      calls += 1;
      await gate;
      return {
        accessToken: 'a',
        refreshToken: `${token}-rotated`,
        rotated: true,
        expiresAt: options.nowMs + 8 * HOUR,
      };
    },
  });

  const all = Promise.all([r.ensureFresh(account), r.ensureFresh(account), r.ensureFresh(account)]);
  release!();
  const outcomes = await all;

  assert.equal(calls, 1, 'three requests, one exchange');
  assert.ok(outcomes.every(o => o.status === 'refreshed'));
  assert.equal(readOAuth(account.credentialPath)!.refreshToken, 'sk-ant-ort01-current-rotated');
});

test('a lock held by another process is respected rather than broken early', async () => {
  const account = fixture(live(NOW - HOUR));
  writeFileSync(`${account.credentialPath}.refresh.lock`, '');
  const { refresh, seen } = await endpoint(ok);
  const r = new TokenRefresher({ now: () => NOW, refresh });

  const outcome = await r.ensureFresh(account);
  assert.equal(outcome.status, 'skipped');
  assert.equal(seen.length, 0, 'two processes must never exchange the same refresh token');
});

test('a lock left behind by a crashed process is broken, not honoured forever', async () => {
  const account = fixture(live(NOW - HOUR));
  const lock = `${account.credentialPath}.refresh.lock`;
  writeFileSync(lock, '');
  const age = statSync(lock).mtimeMs;
  const { refresh, seen } = await endpoint(ok);
  // Look at the lock from far enough in the future that it is unambiguously dead.
  const r = new TokenRefresher({ now: () => age + 10 * 60_000, refresh });

  assert.equal((await r.ensureFresh(account)).status, 'refreshed');
  assert.equal(seen.length, 1);
  assert.ok(!existsSync(lock));
});

test('a held lock still returns a token that is actually usable', async () => {
  // Locked-but-fresh is not a failure: another refresher already did the work.
  const account = fixture(live(NOW + 8 * HOUR));
  writeFileSync(`${account.credentialPath}.refresh.lock`, '');
  const { refresh } = await endpoint(ok);
  const r = new TokenRefresher({ now: () => NOW, refresh });
  assert.equal((await r.ensureFresh(account)).status, 'fresh');
});

test('each attempt re-reads the file, so a token rotated elsewhere is never replayed', async () => {
  const account = fixture(live(NOW - HOUR));
  const { refresh, seen } = await endpoint(n =>
    n === 1 ? { status: 503, payload: {} } : ok(n),
  );
  let now = NOW;
  const r = new TokenRefresher({ now: () => now, refresh });

  assert.equal((await r.ensureFresh(account)).status, 'failed');

  // Another writer (Claude Code, authswap) rotates the family underneath us.
  writeFileSync(
    account.credentialPath,
    JSON.stringify({ claudeAiOauth: { ...live(NOW - HOUR), refreshToken: 'sk-ant-ort01-elsewhere' } }),
  );

  now += 5 * 60_000; // clear the transient backoff
  assert.equal((await r.ensureFresh(account)).status, 'refreshed');
  assert.deepEqual(
    seen,
    ['sk-ant-ort01-current', 'sk-ant-ort01-elsewhere'],
    'the second attempt used the CURRENT token, not the one it first read',
  );
});

test('the sweep refreshes idle slots and leaves healthy ones alone', async () => {
  const stale = fixture(live(NOW - 92 * HOUR));
  const healthy = fixture(live(NOW + 8 * HOUR));
  const { refresh, seen } = await endpoint(ok);
  const r = new TokenRefresher({ now: () => NOW, refresh });

  const outcomes = await r.sweep([stale, healthy]);
  assert.equal(outcomes.length, 1, 'only the stale slot was touched');
  assert.equal(seen.length, 1);
  assert.equal(readOAuth(healthy.credentialPath)!.accessToken, 'sk-ant-oat01-current');
});

test('a credential with no refresh token is skipped, not retried forever', async () => {
  const account = fixture({ accessToken: 'a', expiresAt: NOW - HOUR });
  const { refresh, seen } = await endpoint(ok);
  const r = new TokenRefresher({ now: () => NOW, refresh });
  assert.equal((await r.ensureFresh(account)).status, 'skipped');
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------------------------
// The selection-side consequence
// ---------------------------------------------------------------------------

test('an expired-but-refreshable account stays selectable, or nothing would ever refresh it', () => {
  const account = fixture(live(NOW - 92 * HOUR));
  const { states } = loadAccountStates({
    stateRoot: path.dirname(account.credentialPath),
    authswapRoot: 'nonexistent',
    nowMs: NOW,
  });
  assert.equal(states.length, 0, 'guard: the fixture dir is not an authswap tree');

  const oauth = readOAuth(account.credentialPath)!;
  assert.equal(isRefreshable(oauth, NOW), true);
});

test('a dead refresh token is what actually means needs-reauth', () => {
  const dead = fixture({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: NOW - HOUR,
    refreshTokenExpiresAt: NOW - HOUR,
  });
  assert.equal(isRefreshable(readOAuth(dead.credentialPath), NOW), false);

  const noRefresh = fixture({ accessToken: 'a', expiresAt: NOW - HOUR });
  assert.equal(isRefreshable(readOAuth(noRefresh.credentialPath), NOW), false);
});

test('OAuthRefreshError is the only error shape callers must handle', async () => {
  const account = fixture(live(NOW - HOUR));
  const r = new TokenRefresher({
    now: () => NOW,
    refresh: () => Promise.reject(new TypeError('something unexpected')),
  });
  const outcome = await r.ensureFresh(account);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.kind, 'transient', 'an unclassified throw defaults to the safe side');
  assert.ok(!(new TypeError('x') instanceof OAuthRefreshError));
});
