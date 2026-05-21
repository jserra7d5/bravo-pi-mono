import { arch, platform } from 'node:os';

export function parseCustomHeaders(input: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!input) return headers;

  // Match Gemini CLI: split on commas followed by a header-looking key, while
  // preserving commas and colons inside values.
  for (const entry of input.split(/,(?=\s*[^,:]+:)/)) {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) continue;

    const separatorIndex = trimmedEntry.indexOf(':');
    if (separatorIndex === -1) continue;

    const name = trimmedEntry.slice(0, separatorIndex).trim();
    const value = trimmedEntry.slice(separatorIndex + 1).trim();
    if (!name) continue;

    headers[name] = value;
  }
  return headers;
}

export function buildUserAgent(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const version = env.GEMINI_CODE_ASSIST_USER_AGENT_VERSION ?? '0.0.0-headless-spike';
  return `GeminiCLI/${version}/${model} (${platform()}; ${arch()})`;
}

export function buildHeaders(accessToken: string, model: string, customHeaderInput = process.env.GEMINI_CLI_CUSTOM_HEADERS): Record<string, string> {
  const customHeaders = parseCustomHeaders(customHeaderInput);
  const headers: Record<string, string> = {};
  let contentType = 'application/json';

  for (const [name, value] of Object.entries(customHeaders)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === 'authorization' || normalizedName === 'user-agent') continue;
    if (normalizedName === 'content-type') {
      contentType = value;
      continue;
    }
    headers[name] = value;
  }

  return {
    'Content-Type': contentType,
    ...headers,
    'User-Agent': buildUserAgent(model),
    Authorization: `Bearer ${accessToken}`,
  };
}
