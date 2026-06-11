// Shared OAuth refresh error classification + secret redaction for the balanced
// Codex provider. Lives in src/ (not the pi extension) so both the core lease
// path (src/index.ts) and the provider extension (extensions/pi/index.ts) can
// import a single source of truth.
//
// Message shapes come from openaiCodexOAuthProvider.refreshToken, defined in
// @earendil-works/pi-ai (dist/utils/oauth/openai-codex.js). Notable forms:
//   "OpenAI Codex token refresh failed (400): {\"error\":\"invalid_grant\",...}"
//   "OpenAI Codex token refresh failed (500): ..."
//   "OpenAI Codex token refresh response missing fields: {...}"
//   "OpenAI Codex token refresh error: <network/timeout>"
//   "Failed to extract accountId from token"

export type OAuthErrorKind = 'invalid_grant' | 'transient' | 'unknown';

/**
 * Classify an OAuth refresh failure.
 *
 * - 'invalid_grant': durable credential failure — refresh token revoked /
 *   already-used (rotation collision) / structurally unusable response. The slot
 *   should be marked broken until re-auth.
 * - 'transient': network / timeout / 408 / 429 / 5xx — cool down and retry; do
 *   NOT mark the slot broken.
 * - 'unknown': not confidently classifiable; treated as non-durable (no broken).
 */
export function classifyOAuthRefreshError(message: string): OAuthErrorKind {
  const m = message.toLowerCase();
  // Transient first so a 5xx/429 can never be mistaken for a durable failure.
  if (/refresh failed \((408|429|5\d\d)\)/.test(m)) return 'transient';
  if (m.includes('token refresh error')) return 'transient'; // fetch/timeout catch branch
  // Durable credential failures.
  if (m.includes('invalid_grant')) return 'invalid_grant';
  if (/refresh failed \((400|401|403)\)/.test(m)) return 'invalid_grant';
  if (m.includes('refresh token') && m.includes('already used')) return 'invalid_grant';
  if (m.includes('missing fields')) return 'invalid_grant';
  if (m.includes('failed to extract accountid')) return 'invalid_grant';
  return 'unknown';
}

// JWTs (three base64url segments) and Bearer headers must never be persisted to
// the reservation event log or written to stderr.
const JWT_RE = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_RE = /Bearer\s+\S+/gi;

/** Redact JWT-shaped tokens and Bearer headers from free text before persisting/logging. */
export function redactSecretsInText(text: string): string {
  return text.replace(JWT_RE, '[REDACTED_TOKEN]').replace(BEARER_RE, 'Bearer [REDACTED]');
}
