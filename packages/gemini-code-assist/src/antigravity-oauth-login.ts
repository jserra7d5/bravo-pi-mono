#!/usr/bin/env node
import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { ANTIGRAVITY_CLIENT_ID, antigravityClientSecret, ANTIGRAVITY_SCOPES, defaultAntigravityCredentialsPath } from './antigravity-client.js';

const out = process.env.ANTIGRAVITY_CREDS_PATH ?? defaultAntigravityCredentialsPath();
const port = process.env.PORT ? Number(process.env.PORT) : 17177;
const redirectUri = `http://localhost:${port}/oauth-callback`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  if (url.pathname !== '/oauth-callback') {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400);
    res.end('missing code');
    return;
  }

  try {
    const body = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: antigravityClientSecret(),
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Token exchange failed: HTTP ${response.status}: ${text}`);
    const json = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string };
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify({ ...json, expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000 }, null, 2)}\n`, { mode: 0o600 });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`Antigravity OAuth saved to ${out}. You can close this tab.\n`);
    console.log(`saved ${out} access_token=<redacted> refresh_token=${json.refresh_token ? '<redacted>' : '<none>'}`);
    setTimeout(() => server.close(() => process.exit(0)), 250);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, '127.0.0.1', () => {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  console.log(`Open this URL to authorize Antigravity OAuth:\n${authUrl.toString()}\n`);
  if (process.env.NO_OPEN !== '1') execFile('xdg-open', [authUrl.toString()], () => {});
});
