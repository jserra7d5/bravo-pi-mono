export const AUTH_BALANCER_ATTEMPT_SCHEMA_VERSION = 1 as const;

/** Shared relogin policy thresholds. Keep every provider surface on one clock. */
export const WARN_MS = 7 * 24 * 60 * 60 * 1000;
export const RED_MS = 2 * 24 * 60 * 60 * 1000;
export const CLUSTER_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
export const DEVICE_AUTH_TIMEOUT_MS = 16 * 60 * 1000;
export const CLAUDE_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const AUTH_BALANCER_PROVIDERS = ["codex", "claude"] as const;
export type AuthBalancerProvider = (typeof AUTH_BALANCER_PROVIDERS)[number];

export const ATTEMPT_PHASES = [
  "admission",
  "selection",
  "credential",
  "connect",
  "request",
  "headers",
  "content",
  "terminal",
] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

export const ATTEMPT_OUTCOMES = [
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
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const COMMON_SCENARIOS = [
  "fresh-session-converges",
  "warm-affinity-wins",
  "credential-fails-before-wire",
  "rate-limit-before-content",
  "content-prohibits-replay",
  "attempts-are-durable",
  "telemetry-is-redacted",
  "status-is-read-only",
  "security-rejects-before-auth",
] as const;
export type CommonScenarioName = (typeof COMMON_SCENARIOS)[number];

export const PROVIDER_ONLY_SCENARIOS = {
  codex: [
    "codex-websocket-session-cache-cross-slot-rejected",
    "codex-websocket-account-identity-mismatch-bypassed",
    "codex-replay-normalization-preserves-native-metadata",
    "codex-mixed-version-additive-state-compatible",
    "codex-independent-lifetimes-enforced",
  ],
  claude: [
    "claude-control-body-deadline-bounds-429",
    "claude-body-limit-rejects-before-upstream",
    "claude-concurrent-openers-singleflight",
    "claude-after-wire-failure-does-not-replay",
    "claude-tls-policy-records-reuse",
    "claude-invalid-local-nonce-rejects-before-auth",
  ],
} as const;
export type ProviderOnlyScenarioName<P extends AuthBalancerProvider = AuthBalancerProvider> =
  (typeof PROVIDER_ONLY_SCENARIOS)[P][number];
export type AuthBalancerScenarioName = CommonScenarioName | ProviderOnlyScenarioName;

export const EVIDENCE_CODES = [
  "local_security_validated",
  "global_auth_fallback_blocked",
  "selected_slot_credential_used",
  "account_connection_attributed",
  "session_hash_state_root_scoped",
  "sessionless_request",
  "affinity_read_before_selection",
  "affinity_published_before_async_work",
  "affinity_generation_matched",
  "affinity_generation_conflict",
  "old_slot_unusable",
  "upstream_state_absent",
  "upstream_state_transfer_proven",
  "no_application_bytes_written",
  "request_bytes_written",
  "response_headers_received",
  "content_not_started",
  "content_started_observed",
  "explicit_429_rejection",
  "retry_after_short_wait",
  "control_body_bounded",
  "control_body_deadline_reached",
  "control_body_byte_limit_reached",
  "endpoint_idempotent",
  "provider_idempotency_key",
  "transport_failure_pre_wire",
  "transport_failure_after_wire",
  "transport_policy_recorded",
  "degraded_transport_recorded",
  "socket_reuse_recorded",
  "tls_session_reuse_recorded",
  "usage_probe_skipped_for_warm_affinity",
  "credential_refresh_attempted",
  "credential_refresh_transient",
  "credential_refresh_terminal",
  "credential_unusable_before_wire",
  "auth_rejected_before_content",
  "rate_limit_cooldown_recorded",
  "attempt_record_durable",
  "wait_recorded",
  "rotation_recorded",
  "same_slot_retry_recorded",
  "terminal_outcome_recorded",
  "read_only_status_no_mutation",
  "redaction_applied",
  "body_size_observed",
  "body_limit_enforced",
] as const;
export type EvidenceCode = (typeof EVIDENCE_CODES)[number];

export interface AuthBalancerAttemptV1 {
  schema_version: typeof AUTH_BALANCER_ATTEMPT_SCHEMA_VERSION;
  attempt_id: string;
  request_id: string;
  parent_attempt_id?: string;
  provider: AuthBalancerProvider;
  session_hash?: string;
  public_model_id: string;
  endpoint_class: string;
  slot_id?: string;
  account_hash?: string;
  affinity_generation?: number;
  phase: AttemptPhase;
  outcome: AttemptOutcome;
  reason_code?: string;
  transport_mode?: string;
  transport_policy_version?: string;
  connection_phase?: string;
  socket_reused?: boolean;
  tls_session_reused?: boolean;
  request_bytes_written?: number;
  response_headers_received?: boolean;
  handshake_duration_ms?: number;
  error_code?: string;
  evidence_codes: EvidenceCode[];
  upstream_status?: number;
  wire_started: boolean;
  content_started: boolean;
  retry_eligible: boolean;
  rotation_eligible: boolean;
  wait_ms?: number;
  duration_ms: number;
  created_at: string;
}

export type AttemptValidationError = {
  path: string;
  message: string;
};

export type AttemptValidationResult =
  | { ok: true; value: AuthBalancerAttemptV1 }
  | { ok: false; errors: AttemptValidationError[] };

const PHASE_SET = new Set<string>(ATTEMPT_PHASES);
const OUTCOME_SET = new Set<string>(ATTEMPT_OUTCOMES);
const PROVIDER_SET = new Set<string>(AUTH_BALANCER_PROVIDERS);
const EVIDENCE_SET = new Set<string>(EVIDENCE_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function pushRequiredString(errors: AttemptValidationError[], input: Record<string, unknown>, key: string): void {
  if (!isString(input[key])) errors.push({ path: key, message: "must be a non-empty string" });
}

function pushOptionalString(errors: AttemptValidationError[], input: Record<string, unknown>, key: string): void {
  if (input[key] !== undefined && !isString(input[key])) errors.push({ path: key, message: "must be a non-empty string when present" });
}

function pushRequiredBoolean(errors: AttemptValidationError[], input: Record<string, unknown>, key: string): void {
  if (!isBoolean(input[key])) errors.push({ path: key, message: "must be a boolean" });
}

function pushOptionalBoolean(errors: AttemptValidationError[], input: Record<string, unknown>, key: string): void {
  if (input[key] !== undefined && !isBoolean(input[key])) errors.push({ path: key, message: "must be a boolean when present" });
}

function pushOptionalNonNegativeNumber(errors: AttemptValidationError[], input: Record<string, unknown>, key: string): void {
  if (input[key] !== undefined && !isFiniteNonNegative(input[key])) errors.push({ path: key, message: "must be a finite non-negative number when present" });
}

function pushOptionalNonNegativeInteger(errors: AttemptValidationError[], input: Record<string, unknown>, key: string): void {
  if (input[key] !== undefined && !isSafeNonNegativeInteger(input[key])) errors.push({ path: key, message: "must be a safe non-negative integer when present" });
}

function validateCreatedAt(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

export function isAttemptPhase(value: unknown): value is AttemptPhase {
  return typeof value === "string" && PHASE_SET.has(value);
}

export function isAttemptOutcome(value: unknown): value is AttemptOutcome {
  return typeof value === "string" && OUTCOME_SET.has(value);
}

export function isEvidenceCode(value: unknown): value is EvidenceCode {
  return typeof value === "string" && EVIDENCE_SET.has(value);
}

export function isAuthBalancerProvider(value: unknown): value is AuthBalancerProvider {
  return typeof value === "string" && PROVIDER_SET.has(value);
}

export function validateAuthBalancerAttemptV1(value: unknown): AttemptValidationResult {
  const errors: AttemptValidationError[] = [];
  if (!isRecord(value)) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };

  if (value.schema_version !== AUTH_BALANCER_ATTEMPT_SCHEMA_VERSION) {
    errors.push({ path: "schema_version", message: "must be 1" });
  }

  pushRequiredString(errors, value, "attempt_id");
  pushRequiredString(errors, value, "request_id");
  pushOptionalString(errors, value, "parent_attempt_id");
  if (!isAuthBalancerProvider(value.provider)) errors.push({ path: "provider", message: "must be codex or claude" });
  pushOptionalString(errors, value, "session_hash");
  pushRequiredString(errors, value, "public_model_id");
  pushRequiredString(errors, value, "endpoint_class");
  pushOptionalString(errors, value, "slot_id");
  pushOptionalString(errors, value, "account_hash");
  pushOptionalNonNegativeInteger(errors, value, "affinity_generation");
  if (!isAttemptPhase(value.phase)) errors.push({ path: "phase", message: "must be a shared attempt phase" });
  if (!isAttemptOutcome(value.outcome)) errors.push({ path: "outcome", message: "must be a shared attempt outcome" });
  pushOptionalString(errors, value, "reason_code");
  pushOptionalString(errors, value, "transport_mode");
  pushOptionalString(errors, value, "transport_policy_version");
  pushOptionalString(errors, value, "connection_phase");
  pushOptionalBoolean(errors, value, "socket_reused");
  pushOptionalBoolean(errors, value, "tls_session_reused");
  pushOptionalNonNegativeInteger(errors, value, "request_bytes_written");
  pushOptionalBoolean(errors, value, "response_headers_received");
  pushOptionalNonNegativeNumber(errors, value, "handshake_duration_ms");
  pushOptionalString(errors, value, "error_code");
  pushOptionalNonNegativeInteger(errors, value, "upstream_status");
  pushRequiredBoolean(errors, value, "wire_started");
  pushRequiredBoolean(errors, value, "content_started");
  pushRequiredBoolean(errors, value, "retry_eligible");
  pushRequiredBoolean(errors, value, "rotation_eligible");
  pushOptionalNonNegativeInteger(errors, value, "wait_ms");
  if (!isFiniteNonNegative(value.duration_ms)) errors.push({ path: "duration_ms", message: "must be a finite non-negative number" });
  if (!validateCreatedAt(value.created_at)) errors.push({ path: "created_at", message: "must be a parseable timestamp string" });

  if (!Array.isArray(value.evidence_codes)) {
    errors.push({ path: "evidence_codes", message: "must be an array" });
  } else {
    for (const [index, code] of value.evidence_codes.entries()) {
      if (!isEvidenceCode(code)) {
        errors.push({ path: `evidence_codes.${index}`, message: "must be a shared evidence code" });
      }
    }
  }

  return errors.length === 0
    ? { ok: true, value: value as unknown as AuthBalancerAttemptV1 }
    : { ok: false, errors };
}

export function assertAuthBalancerAttemptV1(value: unknown): AuthBalancerAttemptV1 {
  const result = validateAuthBalancerAttemptV1(value);
  if (result.ok) return result.value;
  throw new Error(`invalid auth balancer attempt v1: ${result.errors.map(e => `${e.path} ${e.message}`).join("; ")}`);
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_RE = /Bearer\s+\S+/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]+/g;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]+/g;
const AUTH_HEADER_RE = /\b(authorization|proxy-authorization|anthropic-auth-token|x-api-key)(\s*[:=]\s*)([^\r\n,;]*)/gi;
const KEY_VALUE_SECRET_RE = /\b(refresh[_-]?token|access[_-]?token|refreshToken|accessToken|client[_-]?secret|secret|credential)(\s*[:=]\s*)([^\s,;]+)/gi;
const JSON_SECRET_FIELD_RE = /(["'])(refresh_token|access_token|refreshToken|accessToken|client_secret|clientSecret|secret|credential)\1(\s*:\s*)(["'])((?:\\.|(?!\4)[\s\S])*?)\4/gi;

function redactQuotedSecretField(match: string, keyQuote: string, key: string, separator: string, valueQuote: string): string {
  return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
}

export function redactSecretsInText(text: string): string {
  return text
    .replace(JSON_SECRET_FIELD_RE, redactQuotedSecretField)
    .replace(AUTH_HEADER_RE, (_match, key: string, separator: string, value: string) =>
      value.trim().length === 0 ? `${key}${separator}` : `${key}${separator}[REDACTED]`)
    .replace(KEY_VALUE_SECRET_RE, "$1$2[REDACTED]")
    .replace(JWT_RE, "[REDACTED_TOKEN]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(ANTHROPIC_KEY_RE, "sk-ant-[REDACTED]")
    .replace(OPENAI_KEY_RE, "sk-[REDACTED]");
}

function redactJsonValue(key: string, value: unknown): unknown {
  if (/token|secret|authorization|api[_-]?key|auth[_-]?header|credential|nonce|raw[_-]?body|request[_-]?body/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return redactSecretsInText(value);
  return value;
}

export function redactSecretsForJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, redactJsonValue)) as T;
}

export type ScenarioProvider<P extends AuthBalancerProvider = AuthBalancerProvider> = P | "both";

export type ScenarioDefinition<Name extends string = AuthBalancerScenarioName> = {
  name: Name;
  provider: ScenarioProvider;
  description: string;
  required_outcomes: AttemptOutcome[];
  required_evidence_codes: EvidenceCode[];
};

export type ScenarioFixture<Name extends string = AuthBalancerScenarioName> = {
  scenario: Name;
  provider: AuthBalancerProvider;
  attempts: AuthBalancerAttemptV1[];
};

export const COMMON_SCENARIO_DEFINITIONS: readonly ScenarioDefinition<CommonScenarioName>[] = [
  {
    name: "fresh-session-converges",
    provider: "both",
    description: "Concurrent first requests with one stable session key converge on one published opening selection.",
    required_outcomes: ["fresh_placed"],
    required_evidence_codes: ["affinity_published_before_async_work", "attempt_record_durable"],
  },
  {
    name: "warm-affinity-wins",
    provider: "both",
    description: "A usable warm binding is preserved ahead of ordinary fresh quota placement.",
    required_outcomes: ["affinity_preserved"],
    required_evidence_codes: ["affinity_read_before_selection", "attempt_record_durable"],
  },
  {
    name: "credential-fails-before-wire",
    provider: "both",
    description: "Credential preparation failure is recorded before application bytes reach upstream.",
    required_outcomes: ["credential_unavailable"],
    required_evidence_codes: ["credential_unusable_before_wire", "no_application_bytes_written", "attempt_record_durable"],
  },
  {
    name: "rate-limit-before-content",
    provider: "both",
    description: "Explicit pre-content rate-limit handling is reconstructable as wait or safe rotation.",
    required_outcomes: ["rate_limited_pre_content"],
    required_evidence_codes: ["explicit_429_rejection", "content_not_started", "attempt_record_durable"],
  },
  {
    name: "content-prohibits-replay",
    provider: "both",
    description: "No retry or account switch follows content delivery.",
    required_outcomes: ["content_started", "terminal_failure"],
    required_evidence_codes: ["content_started_observed", "terminal_outcome_recorded", "attempt_record_durable"],
  },
  {
    name: "attempts-are-durable",
    provider: "both",
    description: "Every hidden and visible upstream attempt can be queried without relying on logs.",
    required_outcomes: ["completed"],
    required_evidence_codes: ["attempt_record_durable", "terminal_outcome_recorded"],
  },
  {
    name: "telemetry-is-redacted",
    provider: "both",
    description: "Telemetry stores only redacted evidence and never token, body, account, or session plaintext.",
    required_outcomes: ["completed"],
    required_evidence_codes: ["redaction_applied", "attempt_record_durable"],
  },
  {
    name: "status-is-read-only",
    provider: "both",
    description: "Read-only status paths do not mutate routing, affinity, cooldown, metrics, or credential state.",
    required_outcomes: ["completed"],
    required_evidence_codes: ["read_only_status_no_mutation"],
  },
  {
    name: "security-rejects-before-auth",
    provider: "both",
    description: "Local security rejection happens before slot selection or credential access.",
    required_outcomes: ["security_rejected"],
    required_evidence_codes: ["local_security_validated", "no_application_bytes_written", "global_auth_fallback_blocked"],
  },
];

export function createScenarioRegistry<T extends readonly ScenarioDefinition<string>[]>(
  definitions: T,
): ReadonlyMap<T[number]["name"], T[number]> {
  const registry = new Map<T[number]["name"], T[number]>();
  for (const definition of definitions) {
    if (registry.has(definition.name)) throw new Error(`duplicate auth balancer scenario: ${definition.name}`);
    registry.set(definition.name, definition as T[number]);
  }
  return registry;
}

export const COMMON_SCENARIO_REGISTRY = createScenarioRegistry(COMMON_SCENARIO_DEFINITIONS);

export function createAttemptFixture(
  input: Partial<AuthBalancerAttemptV1> & Pick<AuthBalancerAttemptV1, "attempt_id" | "request_id" | "provider" | "public_model_id" | "endpoint_class" | "phase" | "outcome">,
): AuthBalancerAttemptV1 {
  return assertAuthBalancerAttemptV1({
    schema_version: AUTH_BALANCER_ATTEMPT_SCHEMA_VERSION,
    evidence_codes: [],
    wire_started: false,
    content_started: false,
    retry_eligible: false,
    rotation_eligible: false,
    duration_ms: 0,
    created_at: new Date(0).toISOString(),
    ...input,
  });
}

export function createScenarioFixture<Name extends AuthBalancerScenarioName>(
  scenario: Name,
  provider: AuthBalancerProvider,
  attempts: AuthBalancerAttemptV1[],
): ScenarioFixture<Name> {
  for (const [index, attempt] of attempts.entries()) {
    const result = validateAuthBalancerAttemptV1(attempt);
    if (!result.ok) {
      throw new Error(`invalid attempt fixture at index ${index}: ${result.errors.map(e => `${e.path} ${e.message}`).join("; ")}`);
    }
    if (attempt.provider !== provider) {
      throw new Error(`attempt fixture provider mismatch at index ${index}: ${attempt.provider} !== ${provider}`);
    }
  }
  return { scenario, provider, attempts };
}
