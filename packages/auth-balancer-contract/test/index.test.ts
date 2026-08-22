import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTEMPT_OUTCOMES,
  ATTEMPT_PHASES,
  COMMON_SCENARIO_REGISTRY,
  EVIDENCE_CODES,
  assertAuthBalancerAttemptV1,
  createAttemptFixture,
  createScenarioFixture,
  createScenarioRegistry,
  isEvidenceCode,
  redactSecretsForJson,
  redactSecretsInText,
  validateAuthBalancerAttemptV1,
  type ScenarioDefinition,
} from "../src/index.js";

test("exports the exact shared phase and outcome literals from the integrity spec", () => {
  assert.deepEqual(ATTEMPT_PHASES, [
    "admission",
    "selection",
    "credential",
    "connect",
    "request",
    "headers",
    "content",
    "terminal",
  ]);
  assert.deepEqual(ATTEMPT_OUTCOMES, [
    "fresh_placed",
    "affinity_preserved",
    "affinity_replaced",
    "security_rejected",
    "body_limit_rejected",
    "credential_unavailable",
    "auth_unusable",
    "transport_failed_before_wire",
    "transport_failed_after_wire",
    "rate_limited_pre_content",
    "waited_same_slot",
    "retried_same_slot",
    "rotated_pre_content",
    "degraded_transport_selected",
    "content_started",
    "completed",
    "aborted",
    "terminal_failure",
    "exhausted",
  ]);
});

test("validates an attempt record and rejects unbounded vocabulary", () => {
  const attempt = createAttemptFixture({
    attempt_id: "attempt-1",
    request_id: "request-1",
    provider: "codex",
    public_model_id: "bravo-codex-balanced/gpt-5.6-luna",
    endpoint_class: "generation",
    slot_id: "1",
    phase: "headers",
    outcome: "rate_limited_pre_content",
    evidence_codes: ["explicit_429_rejection", "content_not_started"],
    upstream_status: 429,
    wire_started: true,
    content_started: false,
    rotation_eligible: true,
  });

  assert.equal(validateAuthBalancerAttemptV1(attempt).ok, true);
  assert.equal(assertAuthBalancerAttemptV1(attempt), attempt);

  const bad = validateAuthBalancerAttemptV1({
    ...attempt,
    outcome: "rate_limitish",
    evidence_codes: ["explicit_429_rejection", "provider-invented-code"],
    duration_ms: -1,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual([...bad.errors.map(e => e.path)].sort(), ["duration_ms", "evidence_codes.1", "outcome"]);
  }
});

test("redacts common token, auth-header, nonce, credential, and body fields", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";
  const text = redactSecretsInText(`Authorization: Bearer ${jwt} x-api-key: sk-ant-abc refresh_token=secret`);
  assert.equal(text.includes(jwt), false);
  assert.equal(text.includes("sk-ant-abc"), false);
  assert.equal(text.includes("secret"), false);
  assert.match(text, /\[REDACTED\]/);

  const redacted = redactSecretsForJson({
    nested: {
      access_token: jwt,
      credential: { ok: false },
      nonce: "daemon-nonce",
      request_body: "sensitive prompt",
      diagnostic: `Bearer ${jwt}`,
    },
  });
  assert.equal(redacted.nested.access_token, "[REDACTED]");
  assert.equal(redacted.nested.credential, "[REDACTED]");
  assert.equal(redacted.nested.nonce, "[REDACTED]");
  assert.equal(redacted.nested.request_body, "[REDACTED]");
  assert.equal(redacted.nested.diagnostic, "Bearer [REDACTED]");
});

test("redacts full auth header values including Basic and whitespace-bearing tails", () => {
  const input = [
    "Authorization: Basic abc def ghi, method=POST",
    "proxy-authorization = Bearer one two three; phase=connect",
    "anthropic-auth-token: token part with spaces\npath=/v1/messages",
    "x-api-key: sk-ant-secret-key, status=401",
  ].join("\n");

  const out = redactSecretsInText(input);
  for (const leaked of ["abc", "def", "ghi", "one", "two", "three", "token part", "sk-ant-secret-key"]) {
    assert.equal(out.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.match(out, /Authorization: \[REDACTED\], method=POST/);
  assert.match(out, /proxy-authorization = \[REDACTED\]; phase=connect/);
  assert.match(out, /anthropic-auth-token: \[REDACTED\]\npath=\/v1\/messages/);
  assert.match(out, /x-api-key: \[REDACTED\], status=401/);
});

test("redacts JSON-style quoted secret fields without leaking quoted value tails", () => {
  const input = JSON.stringify({
    refresh_token: "refresh token with spaces",
    access_token: "access-token-tail",
    client_secret: "client-secret-tail",
    credential: "credential-tail",
    diagnostic: "keep this text",
  });
  const out = redactSecretsInText(input);

  for (const leaked of ["refresh token with spaces", "access-token-tail", "client-secret-tail", "credential-tail"]) {
    assert.equal(out.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.match(out, /"refresh_token":"\[REDACTED\]"/);
  assert.match(out, /"access_token":"\[REDACTED\]"/);
  assert.match(out, /"client_secret":"\[REDACTED\]"/);
  assert.match(out, /"credential":"\[REDACTED\]"/);
  assert.match(out, /"diagnostic":"keep this text"/);
});

test("redacts common comma, newline, and assignment forms while preserving separators", () => {
  const input = "refresh_token=old-refresh, accessToken: new-access; secret = hush\nsafe detail remains";
  const out = redactSecretsInText(input);

  assert.equal(out.includes("old-refresh"), false);
  assert.equal(out.includes("new-access"), false);
  assert.equal(out.includes("hush"), false);
  assert.equal(out, "refresh_token=[REDACTED], accessToken: [REDACTED]; secret = [REDACTED]\nsafe detail remains");
});

test("redactSecretsForJson redacts secret-shaped keys and nested diagnostic strings", () => {
  const redacted = redactSecretsForJson({
    keep: "diagnostic",
    authorization: "Basic abc def",
    nested: {
      client_secret: "secret-tail",
      message: "proxy-authorization: Basic tail one two, keep=true",
    },
  });

  assert.equal(redacted.keep, "diagnostic");
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.nested.client_secret, "[REDACTED]");
  assert.equal(redacted.nested.message, "proxy-authorization: [REDACTED], keep=true");
});

test("scenario registry is immutable to provider policy and rejects duplicates", () => {
  const scenario = COMMON_SCENARIO_REGISTRY.get("rate-limit-before-content");
  assert.ok(scenario);
  assert.deepEqual(scenario.required_evidence_codes, [
    "explicit_429_rejection",
    "content_not_started",
    "attempt_record_durable",
  ]);

  const duplicate: readonly ScenarioDefinition<"x">[] = [
    { name: "x", provider: "both", description: "one", required_outcomes: ["completed"], required_evidence_codes: [] },
    { name: "x", provider: "both", description: "two", required_outcomes: ["completed"], required_evidence_codes: [] },
  ];
  assert.throws(() => createScenarioRegistry(duplicate), /duplicate auth balancer scenario: x/);
});

test("scenario fixtures validate attempts and provider ownership only", () => {
  const attempt = createAttemptFixture({
    attempt_id: "attempt-2",
    request_id: "request-2",
    provider: "claude",
    public_model_id: "claude-opus-5",
    endpoint_class: "generation",
    phase: "terminal",
    outcome: "completed",
    evidence_codes: ["attempt_record_durable"],
  });
  const fixture = createScenarioFixture("attempts-are-durable", "claude", [attempt]);
  assert.equal(fixture.scenario, "attempts-are-durable");
  assert.equal(fixture.attempts.length, 1);

  assert.throws(
    () => createScenarioFixture("attempts-are-durable", "codex", [attempt]),
    /provider mismatch/,
  );
});

test("evidence vocabulary is bounded but contains the proof codes named by the spec", () => {
  for (const code of [
    "no_application_bytes_written",
    "explicit_429_rejection",
    "content_not_started",
    "endpoint_idempotent",
    "redaction_applied",
  ]) {
    assert.equal(isEvidenceCode(code), true);
  }
  assert.equal(isEvidenceCode("provider_made_a_guess"), false);
  assert.equal(new Set(EVIDENCE_CODES).size, EVIDENCE_CODES.length);
});
