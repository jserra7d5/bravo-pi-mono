import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, arch, platform } from 'node:os';
import { extractTextFromSse, parseSseEvents, type SseEvent } from './sse.js';
import { errorMessageForResponse } from './code-assist-client.js';

export const ANTIGRAVITY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3-flash-agent';
export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const ANTIGRAVITY_CLIENT_SECRET = '***REMOVED***';
export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type AntigravityCredentials = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
};

export type AntigravityGenerateOptions = {
  prompt: string;
  timeoutMs?: number;
  credentialsPath?: string;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  model?: string;
  requestType?: string;
  fetchImpl?: typeof fetch;
};

export type AntigravityGenerateResult = {
  text: string;
  modelVersions: string[];
  thoughtSignatures: number;
  usageMetadata: unknown[];
  events: SseEvent[];
  raw: string;
};

export function defaultAntigravityCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_CODE_ASSIST_CREDENTIALS_PATH ?? join(homedir(), '.gemini', 'antigravity_oauth_creds.json');
}

export function antigravityMethodUrl(method: string, env: NodeJS.ProcessEnv = process.env): string {
  const endpoint = env.ANTIGRAVITY_CODE_ASSIST_ENDPOINT ?? ANTIGRAVITY_ENDPOINT;
  const version = env.ANTIGRAVITY_CODE_ASSIST_API_VERSION ?? 'v1internal';
  return `${endpoint.replace(/\/$/, '')}/${version}:${method}`;
}

export function antigravityStreamUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${antigravityMethodUrl('streamGenerateContent', env)}?alt=sse`;
}

function antigravityUserAgent(): string {
  return `antigravity/cli/1.0.0 ${platform()}/${arch()}`;
}

function buildHeaders(accessToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': antigravityUserAgent(),
    Authorization: `Bearer ${accessToken}`,
  };
}

async function loadCredentials(path: string): Promise<AntigravityCredentials> {
  return JSON.parse(await readFile(path, 'utf8')) as AntigravityCredentials;
}

async function saveCredentials(path: string, creds: AntigravityCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}

function isFresh(creds: AntigravityCredentials, now = Date.now()): boolean {
  const expiry = creds.expiry_date ?? creds.expires_at;
  return Boolean(creds.access_token && expiry && expiry - now > REFRESH_SKEW_MS);
}

export async function refreshAntigravityCredentials(creds: AntigravityCredentials, path: string, fetchImpl: typeof fetch = fetch): Promise<AntigravityCredentials> {
  if (!creds.refresh_token) throw new Error('Antigravity credentials have no refresh_token; rerun OAuth login.');
  const body = new URLSearchParams({
    client_id: process.env.ANTIGRAVITY_CODE_ASSIST_CLIENT_ID ?? ANTIGRAVITY_CLIENT_ID,
    client_secret: process.env.ANTIGRAVITY_CODE_ASSIST_CLIENT_SECRET ?? ANTIGRAVITY_CLIENT_SECRET,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
    scope: ANTIGRAVITY_SCOPES.join(' '),
  });
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Antigravity token refresh failed: HTTP ${response.status}`);
  const json = await response.json() as { access_token?: string; expires_in?: number; token_type?: string; scope?: string };
  if (!json.access_token) throw new Error('Antigravity token refresh response did not include an access_token.');
  const refreshed: AntigravityCredentials = {
    ...creds,
    access_token: json.access_token,
    token_type: json.token_type ?? creds.token_type,
    scope: json.scope ?? creds.scope,
    expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  await saveCredentials(path, refreshed);
  return refreshed;
}

export async function getAntigravityAccessToken(path = defaultAntigravityCredentialsPath(), fetchImpl: typeof fetch = fetch): Promise<string> {
  const creds = await loadCredentials(path);
  const fresh = isFresh(creds) ? creds : await refreshAntigravityCredentials(creds, path, fetchImpl);
  if (!fresh.access_token) throw new Error('Antigravity credentials have no access_token.');
  return fresh.access_token;
}

export async function resolveAntigravityProject(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(antigravityMethodUrl('loadCodeAssist'), {
    method: 'POST',
    headers: buildHeaders(accessToken),
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
  });
  if (!response.ok) throw new Error(await errorMessageForResponse(response, 'Antigravity Code Assist setup'));
  const json = await response.json() as { cloudaicompanionProject?: string };
  if (!json.cloudaicompanionProject) throw new Error('Antigravity setup response did not include cloudaicompanionProject.');
  return json.cloudaicompanionProject;
}

export function buildAntigravityAgentRequest(prompt: string, project: string, options: Pick<AntigravityGenerateOptions, 'thinkingBudget' | 'includeThoughts' | 'thinkingLevel' | 'model' | 'requestType'> = {}): unknown {
  const generationConfig: Record<string, unknown> = {};
  if (options.thinkingBudget !== undefined || options.includeThoughts !== undefined) {
    generationConfig.thinkingConfig = {
      ...(options.includeThoughts !== undefined ? { includeThoughts: options.includeThoughts } : {}),
      ...(options.thinkingBudget !== undefined ? { thinkingBudget: options.thinkingBudget } : {}),
      ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    };
  }

  return {
    project,
    requestId: `agent/pi/${Date.now()}/${randomUUID()}/1`,
    request: {
      contents: [{ role: 'user', parts: [{ text: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>` }] }],
      systemInstruction: {
        role: 'user',
        parts: [{ text: 'You are Antigravity, a coding assistant. Prioritize the USER_REQUEST.' }],
      },
      generationConfig,
      sessionId: String(Date.now()),
    },
    model: options.model ?? ANTIGRAVITY_DEFAULT_MODEL,
    userAgent: 'antigravity',
    requestType: options.requestType ?? 'agent',
  };
}

export async function generateAntigravityText(options: AntigravityGenerateOptions): Promise<AntigravityGenerateResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const accessToken = await getAntigravityAccessToken(options.credentialsPath, fetchImpl);
  const project = await resolveAntigravityProject(accessToken, fetchImpl);
  const controller = new AbortController();
  const timeout = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  try {
    const response = await fetchImpl(antigravityStreamUrl(), {
      method: 'POST',
      headers: buildHeaders(accessToken),
      body: JSON.stringify(buildAntigravityAgentRequest(options.prompt, project, options)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await errorMessageForResponse(response, 'Antigravity generation'));
    const raw = await response.text();
    const events = parseSseEvents(raw);
    const parsed = events.flatMap((event) => {
      try { return [JSON.parse(event.data) as Record<string, unknown>]; } catch { return []; }
    });
    const modelVersions = [...new Set(parsed.map((item) => (item.response as { modelVersion?: string } | undefined)?.modelVersion).filter((value): value is string => Boolean(value)))];
    const usageMetadata = parsed.map((item) => (item.response as { usageMetadata?: unknown } | undefined)?.usageMetadata).filter(Boolean);
    return {
      text: extractTextFromSse(events),
      modelVersions,
      thoughtSignatures: (raw.match(/"thoughtSignature"/g) ?? []).length,
      usageMetadata,
      events,
      raw,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
