import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Gemini CLI OAuth installed-app client constants/scopes used for Code Assist auth.
export const GEMINI_CLI_OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const GEMINI_CLI_OAUTH_CLIENT_SECRET = '***REMOVED***';
export const GEMINI_CLI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type OAuthCredentials = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
};

export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_CODE_ASSIST_CREDENTIALS_PATH ?? join(homedir(), '.gemini', 'oauth_creds.json');
}

export function isAccessTokenFresh(creds: OAuthCredentials, now = Date.now()): boolean {
  const expiry = creds.expiry_date ?? creds.expires_at;
  return Boolean(creds.access_token && expiry && expiry - now > REFRESH_SKEW_MS);
}

export async function loadCredentials(path = defaultCredentialsPath()): Promise<OAuthCredentials> {
  return JSON.parse(await readFile(path, 'utf8')) as OAuthCredentials;
}

async function saveCredentials(path: string, creds: OAuthCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}

export async function refreshCredentials(creds: OAuthCredentials, path: string, fetchImpl: typeof fetch = fetch): Promise<OAuthCredentials> {
  if (!creds.refresh_token) throw new Error('Credentials file has no refresh_token; cannot refresh access token.');

  const body = new URLSearchParams({
    client_id: process.env.GEMINI_CODE_ASSIST_CLIENT_ID ?? GEMINI_CLI_OAUTH_CLIENT_ID,
    client_secret: process.env.GEMINI_CODE_ASSIST_CLIENT_SECRET ?? GEMINI_CLI_OAUTH_CLIENT_SECRET,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
    scope: GEMINI_CLI_OAUTH_SCOPES.join(' '),
  });

  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Token refresh failed: HTTP ${response.status}`);

  const json = await response.json() as { access_token?: string; expires_in?: number; token_type?: string; scope?: string };
  if (!json.access_token) throw new Error('Token refresh response did not include an access_token.');

  const refreshed: OAuthCredentials = {
    ...creds,
    access_token: json.access_token,
    token_type: json.token_type ?? creds.token_type,
    scope: json.scope ?? creds.scope,
    expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  await saveCredentials(path, refreshed);
  return refreshed;
}

export async function getAccessToken(path = defaultCredentialsPath(), fetchImpl: typeof fetch = fetch): Promise<string> {
  const creds = await loadCredentials(path);
  const fresh = isAccessTokenFresh(creds) ? creds : await refreshCredentials(creds, path, fetchImpl);
  if (!fresh.access_token) throw new Error('Credentials file has no access_token.');
  return fresh.access_token;
}
