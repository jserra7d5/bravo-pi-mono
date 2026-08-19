import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOAuthRefreshError, redactSecretsInText } from '../src/oauth-error.js';

test('classifyOAuthRefreshError maps durable credential failures to invalid_grant', () => {
  const invalidGrant = [
    'OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}',
    'OpenAI Codex token refresh failed (401): unauthorized',
    'OpenAI Codex token refresh failed (403): forbidden',
    'token refresh response invalid_grant',
    'refresh token already used',
    'OpenAI Codex token refresh response missing fields: {}',
    'Failed to extract accountId from token',
  ];
  for (const message of invalidGrant) {
    assert.equal(classifyOAuthRefreshError(message), 'invalid_grant', message);
  }
});

test('classifyOAuthRefreshError maps retryable failures to transient', () => {
  const transient = [
    'OpenAI Codex token refresh failed (408): request timeout',
    'OpenAI Codex token refresh failed (429): rate limited',
    'OpenAI Codex token refresh failed (500): server error',
    'OpenAI Codex token refresh failed (503): unavailable',
    'OpenAI Codex token refresh error: fetch failed',
  ];
  for (const message of transient) {
    assert.equal(classifyOAuthRefreshError(message), 'transient', message);
  }
});

test('classifyOAuthRefreshError returns unknown for unclassifiable text', () => {
  assert.equal(classifyOAuthRefreshError('something completely unexpected happened'), 'unknown');
});

test('redactSecretsInText scrubs JWTs and Bearer headers', () => {
  assert.equal(redactSecretsInText('token=eyJabc.eyJdef.sigghi end'), 'token=[REDACTED_TOKEN] end');
  assert.equal(redactSecretsInText('auth: Bearer sk-xyz123'), 'auth: Bearer [REDACTED]');
});

test('redactSecretsInText leaves hostnames and dotted identifiers intact', () => {
  // Regression: the JWT pattern was unanchored, so any three dot-separated alphanumeric
  // runs matched. Real error text from an upstream prompt-flag lost its hostname.
  const flagged = 'Invalid prompt: your prompt was flagged. See https://platform.openai.com/docs/guides/reasoning#advice-on-prompting';
  assert.equal(redactSecretsInText(flagged), flagged);
  assert.equal(redactSecretsInText('at src.index.ts:42'), 'at src.index.ts:42');
  assert.equal(redactSecretsInText('host auth.openai.com refused'), 'host auth.openai.com refused');
  // Still redacts an actual JWT, including one embedded in a sentence with a URL.
  assert.equal(
    redactSecretsInText('token eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig at https://auth.openai.com/oauth/token'),
    'token [REDACTED_TOKEN] at https://auth.openai.com/oauth/token',
  );
});
