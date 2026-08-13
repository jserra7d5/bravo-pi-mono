// Claude Code OAuth refresh-token exchange.
//
// The endpoint, client id, and scope set were recovered from the shipped Claude
// Code binary (2.1.231) rather than guessed. The refresh call is `Bke`:
//
//   let a = { grant_type:"refresh_token", refresh_token:e,
//             client_id: n ?? va().CLIENT_ID,
//             scope: (Array.isArray(t)&&t.length ? t : E3e).join(" ") };
//   if (r !== void 0) a.expires_in = r;
//   let l = await Xo.post(va().TOKEN_URL, a,
//           { headers:{"Content-Type":"application/json"}, timeout:30000 });
//   if (l.status !== 200) throw Error(`Token refresh failed: ${l.statusText}`);
//   let c = l.data, { access_token:u, refresh_token:d = e, expires_in:p } = c;
//
// Two details differ from the Codex flow in ../codex-auth-balancer, and both
// matter:
//
//   1. The body is JSON, not form-urlencoded. Sending form data here is not a
//      lenient-server situation to rely on.
//   2. `refresh_token: d = e` — the response MAY omit the refresh token, and
//      Claude Code then keeps using the old one. So rotation is optional here,
//      unlike OpenAI's always-rotate. We mirror that: absent means unchanged.
//
// Rotation being optional does not make replay safe. When the server DOES
// return a new refresh token we must persist it before issuing another refresh,
// and must never retry a failure with a different refresh token. ./refresh.ts
// owns that ordering and the lock; this file is only the wire call.

/** From the binary: `BHc.TOKEN_URL`. Note: platform.claude.com, not the API host. */
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/** From the binary: `BHc.CLIENT_ID`. A public PKCE client — there is no secret. */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * From the binary: `E3e`, the default refresh scope set. These are exactly the
 * five scopes already present in the stored credential files, so a refresh
 * never silently narrows what the token can do.
 */
export const DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const;

export const REFRESH_TIMEOUT_MS = 30_000;

/** A refreshed Claude credential. `expiresAt` is an absolute epoch-ms deadline. */
export type ClaudeTokenSet = {
  accessToken: string;
  /** The token to store going forward — the rotated one, or the input if unrotated. */
  refreshToken: string;
  /** True when the server actually issued a new refresh token. */
  rotated: boolean;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
};

/**
 * Why a refresh failed.
 *
 * `transient` must never brick a slot: the stored credential stays untouched
 * and the next attempt retries the SAME refresh token. `terminal` means the
 * grant is dead and only a human re-auth fixes it.
 */
export type RefreshErrorKind = 'transient' | 'terminal';

export class OAuthRefreshError extends Error {
  readonly kind: RefreshErrorKind;
  readonly status?: number;

  constructor(message: string, kind: RefreshErrorKind, status?: number) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Classify an HTTP failure.
 *
 * 400 and 401 are the OAuth "this grant is over" codes (`invalid_grant`,
 * `invalid_client`). 403 likewise — the client is not allowed to mint this.
 * Everything else, including 429 and all 5xx, is the server having a bad time
 * and says nothing about the token's validity.
 */
export function classifyStatus(status: number): RefreshErrorKind {
  if (status === 400 || status === 401 || status === 403) return 'terminal';
  return 'transient';
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Exchange a refresh token for a fresh credential.
 *
 * Throws {@link OAuthRefreshError} on every failure path so callers can branch
 * on `kind` instead of pattern-matching message text.
 */
export async function refreshClaudeToken(
  refreshToken: string,
  options: {
    nowMs: number;
    scopes?: readonly string[];
    signal?: AbortSignal;
    tokenUrl?: string;
    clientId?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<ClaudeTokenSet> {
  const doFetch = options.fetchImpl ?? fetch;
  const scopes = options.scopes?.length ? options.scopes : DEFAULT_SCOPES;

  let response: Response;
  try {
    response = await doFetch(options.tokenUrl ?? TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: options.clientId ?? CLIENT_ID,
        scope: scopes.join(' '),
      }),
      signal: options.signal ?? AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    // Network, DNS, TLS, timeout, abort. Never terminal — the token is fine.
    throw new OAuthRefreshError(
      `Claude token refresh error: ${error instanceof Error ? error.message : String(error)}`,
      'transient',
    );
  }

  if (response.status !== 200) {
    const kind = classifyStatus(response.status);
    // Read the body for the diagnostic, but never let a huge or hung body
    // convert a clean status classification into a hang.
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* the status is the signal; a missing body changes nothing */
    }
    throw new OAuthRefreshError(
      `Claude token refresh failed (${response.status}): ${detail || response.statusText}`,
      kind,
      response.status,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw new OAuthRefreshError(
      `Claude token refresh returned unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      'transient',
    );
  }

  const accessToken = asString(payload['access_token']);
  const expiresIn = payload['expires_in'];
  if (!accessToken || typeof expiresIn !== 'number') {
    // A 200 with no usable credential is a contract break, not a dead grant.
    throw new OAuthRefreshError(
      'Claude token refresh returned 200 without access_token/expires_in',
      'transient',
      200,
    );
  }

  const rotatedToken = asString(payload['refresh_token']);
  const refreshExpiresIn = payload['refresh_token_expires_in'];
  const scope = asString(payload['scope']);

  return {
    accessToken,
    refreshToken: rotatedToken ?? refreshToken,
    rotated: rotatedToken !== undefined && rotatedToken !== refreshToken,
    expiresAt: options.nowMs + expiresIn * 1000,
    refreshTokenExpiresAt:
      typeof refreshExpiresIn === 'number' ? options.nowMs + refreshExpiresIn * 1000 : undefined,
    scopes: scope ? scope.split(' ').filter(Boolean) : undefined,
  };
}
