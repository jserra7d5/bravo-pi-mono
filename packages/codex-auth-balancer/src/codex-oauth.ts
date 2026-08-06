// Codex (ChatGPT OAuth) refresh-token exchange, owned outright.
//
// This deliberately does NOT go through @earendil-works/pi-ai. Extensions are
// loaded by pi's own loader (core/extensions/loader.js), which aliases the
// pi-ai specifiers to the HOST pi's copy and resolves them through jiti. jiti's
// CJS interop turns a missing named export into `undefined` at the call site
// instead of an ESM link error — so when pi-ai 0.81.x emptied
// `@earendil-works/pi-ai/oauth` (the built file became literally `export {}`,
// the provider having moved to dist/auth/oauth/openai-codex.js and been renamed
// openaiCodexOAuth with refreshToken -> refresh), every refresh here started
// throwing "Cannot read properties of undefined (reading 'refreshToken')".
// It failed silently for ten days because the refresh branch only runs once a
// leased access token is close to expiry, and it type-checked clean the whole
// time because the repo dev-installs a different pi-ai than the host runs.
//
// The balancer already owns the refresh lock, the atomic credential write-back,
// and the account-id claim guard; pi-ai was only supplying the fetch. Owning
// these ~30 lines removes that entire class of breakage.
//
// Error message shapes are reproduced verbatim from the upstream implementation
// so classifyOAuthRefreshError() in ./oauth-error.ts keeps classifying them.

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** A refreshed Codex credential. `expires` is an absolute epoch-ms deadline. */
export type CodexTokenSet = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };

/**
 * Exchange a refresh token for a new credential.
 *
 * The returned refresh token is SINGLE-USE and rotated on every call: OpenAI
 * runs reuse detection and can invalidate the whole token family if an old one
 * is replayed. Callers must persist the result before issuing another refresh,
 * and must never retry with a different refresh token on failure.
 */
export async function refreshCodexToken(refreshToken: string, signal?: AbortSignal): Promise<CodexTokenSet> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal,
    });
  } catch (error) {
    // Network/timeout/abort. Classified 'transient' — never bricks the slot.
    throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`);
  }
  const json = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
  if (typeof json?.access_token !== 'string' || typeof json.refresh_token !== 'string' || typeof json.expires_in !== 'number') {
    throw new Error(`OpenAI Codex token refresh response missing fields: ${JSON.stringify(json)}`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}
