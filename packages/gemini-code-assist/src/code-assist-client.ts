import { randomUUID } from 'node:crypto';
import { getAccessToken } from './credentials.js';
import { buildHeaders } from './headers.js';
import { extractTextFromSse, readSse } from './sse.js';

export const VERIFIED_SPIKE_MODEL = 'gemini-3.5-flash';

export type GenerateTextOptions = {
  prompt: string;
  model: string;
  timeoutMs?: number;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
};

export function codeAssistMethodUrl(method: string, env: NodeJS.ProcessEnv = process.env): string {
  const endpoint = env.GEMINI_CODE_ASSIST_ENDPOINT ?? 'https://cloudcode-pa.googleapis.com';
  const version = env.GEMINI_CODE_ASSIST_API_VERSION ?? 'v1internal';
  return `${endpoint.replace(/\/$/, '')}/${version}:${method}`;
}

export function codeAssistUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${codeAssistMethodUrl('streamGenerateContent', env)}?alt=sse`;
}

function resolveProject(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GEMINI_CODE_ASSIST_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT_ID;
}

export function buildTextOnlyRequest(prompt: string, model: string, env: NodeJS.ProcessEnv = process.env, projectOverride?: string): unknown {
  const project = projectOverride ?? resolveProject(env);
  return {
    model,
    ...(project ? { project } : {}),
    user_prompt_id: randomUUID(),
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {},
      session_id: randomUUID(),
    },
  };
}

export async function errorMessageForResponse(response: Response, operation = 'Code Assist request'): Promise<string> {
  const body = await response.text().catch(() => '');
  const detail = body ? `: ${body.slice(0, 2000)}` : '';
  return `${operation} failed: HTTP ${response.status}${detail}`;
}

type LoadCodeAssistResponse = {
  cloudaicompanionProject?: string;
  currentTier?: { id?: string; name?: string };
  paidTier?: { id?: string; name?: string };
  ineligibleTiers?: Array<{ reasonMessage?: string }>;
};

export async function resolveCodeAssistProject(accessToken: string, model: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const configuredProject = resolveProject();
  const metadata = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
    ...(configuredProject ? { duetProject: configuredProject } : {}),
  };
  const response = await fetchImpl(codeAssistMethodUrl('loadCodeAssist'), {
    method: 'POST',
    headers: buildHeaders(accessToken, model),
    body: JSON.stringify({
      ...(configuredProject ? { cloudaicompanionProject: configuredProject } : {}),
      metadata,
    }),
  });
  if (!response.ok) throw new Error(await errorMessageForResponse(response, 'Code Assist setup'));

  const json = (await response.json()) as LoadCodeAssistResponse;
  if (json.cloudaicompanionProject) return json.cloudaicompanionProject;
  if (configuredProject && json.currentTier) return configuredProject;
  if (json.ineligibleTiers?.length) {
    const reasons = json.ineligibleTiers.map((tier) => tier.reasonMessage).filter(Boolean).join(', ');
    throw new Error(`Code Assist setup returned ineligible tiers${reasons ? `: ${reasons}` : ''}`);
  }
  return configuredProject;
}

export function assertSupportedSpikeModel(model: string, env: NodeJS.ProcessEnv = process.env): void {
  if (model === VERIFIED_SPIKE_MODEL) return;
  if (env.GEMINI_CODE_ASSIST_ALLOW_UNVERIFIED_MODEL === '1') return;
  throw new Error(`Unsupported spike model "${model}". V1 only targets "${VERIFIED_SPIKE_MODEL}". Set GEMINI_CODE_ASSIST_ALLOW_UNVERIFIED_MODEL=1 for explicit diagnostics.`);
}

export async function generateCodeAssistText(options: GenerateTextOptions): Promise<string> {
  assertSupportedSpikeModel(options.model);
  const fetchImpl = options.fetchImpl ?? fetch;
  const accessToken = await getAccessToken(options.credentialsPath, fetchImpl);
  const project = await resolveCodeAssistProject(accessToken, options.model, fetchImpl);
  const controller = new AbortController();
  const timeout = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  try {
    const response = await fetchImpl(codeAssistUrl(), {
      method: 'POST',
      headers: buildHeaders(accessToken, options.model),
      body: JSON.stringify(buildTextOnlyRequest(options.prompt, options.model, process.env, project)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await errorMessageForResponse(response));
    return extractTextFromSse(await readSse(response));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
