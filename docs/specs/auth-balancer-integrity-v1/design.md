# Auth Balancer Integrity v1

Status: proposed

Owners: `@bravo/codex-auth-balancer`, `@bravo/claude-auth-balancer`

Decision record: [`debate/synthesis.md`](./debate/synthesis.md)

## Summary

The Codex and Claude auth balancers will obey one behavioral integrity contract while retaining separate provider-native implementations.

The contract makes session continuity, account attribution, retry safety, transport fidelity, redaction, and attempt observability explicit. It does not create a shared selection or retry runtime. Codex remains an in-process Pi provider backed by live SQLite coordination. Claude remains a single local HTTP gateway unless Claude Code exposes a verified credential-selection seam.

The governing rule is:

> Balance fresh work opportunistically. Preserve warm account-bound work. When account identity, replay safety, or metadata fidelity is ambiguous, fail visibly or select an explicitly recorded degraded path.

This project will not spoof official-client fingerprints, hide balancing through synthetic headers, or tune around fraud controls. The goal is to make legitimate single-user account selection correct, attributable, and diagnosable while leaving provider-native networking intact wherever it can be proven safe.

## Problem

The packages currently solve different halves of the problem well:

- Codex keeps model traffic inside Pi's native provider implementation, but changes transport defaults, can lose native replay semantics through provider rebadging, publishes affinity too late, and cannot safely enable Pi's current session-keyed WebSocket cache across accounts.
- Claude has a stronger cache-affinity-first routing policy and preserves request-body bytes, but re-originates HTTP/TLS traffic, disables all connection and TLS-session reuse, overstates header and retry fidelity, publishes first affinity after asynchronous work, and lacks durable attempt-level evidence.

The existing “auth balancer” label obscures different correctness domains. A shared runtime abstraction would paper over those differences instead of fixing them.

## Goals

- Make selected-account attribution agree with the account and connection that actually carried every request.
- Separate fresh-session placement from warm-session routing.
- Prevent concurrent first requests for one session and model from splitting across accounts.
- Preserve provider-native session, reasoning, tool-call, prompt-cache, and transport behavior when safe.
- Prohibit replay or account switching after content begins.
- Permit hidden recovery only when the provider implementation can record evidence that it is safe.
- Record every attempt, wait, retry, rotation, degraded transport, and terminal outcome durably without secrets.
- Preserve Codex mixed-version SQLite safety and give both packages staged rollout and configuration-first rollback.
- Define equivalent black-box contract scenarios without forcing equivalent internal machinery.

## Non-goals

- Pooling subscriptions across users, generating third-party API keys, billing, metering customers, or exposing either balancer as a remote service.
- Evading provider fraud prevention, copying fingerprints, or disguising local routing.
- A shared account selector, quota scorer, credential refresher, persistence layer, lease manager, proxy, transport wrapper, or retry state machine.
- A Codex HTTP proxy.
- Replacing the Claude gateway without a verified Claude Code credential-selection interface.
- Guaranteeing zero provider-visible difference when a local proxy is inherently required.

## Architecture

```text
                       shared integrity contract
                 outcomes · phases · schema · fixtures
                              │
               ┌──────────────┴──────────────┐
               │                             │
       Codex native implementation    Claude native implementation
       Pi provider wrapper             singleton loopback gateway
       shared live SQLite              daemon-local affinity control
       Pi Codex transport              Node HTTP/TLS forwarding
       OpenAI OAuth semantics          Anthropic OAuth semantics
```

The common surface may contain only:

- literal phase and outcome names;
- a versioned redacted attempt-record schema and validator;
- secret-redaction helpers;
- black-box scenario names and fixture builders;
- documentation.

It must not make routing or retry decisions. If a proposed shared helper needs a provider branch for transport, credentials, quota, storage, or affinity, it belongs in the provider package instead.

Phase 1 creates a deliberately small `@bravo/auth-balancer-contract` package containing exactly these artifacts. It has no provider dependencies and no policy callbacks. Any further extraction is deferred until both implementations independently pass the contract and the candidate code is actually identical.

## Terminology

- **Session key**: a non-secret hash of stable client session identity plus public model identity. Some requests have no stable session key and are explicitly sessionless.
- **Fresh session**: no unexpired, usable account-bound affinity or upstream state exists.
- **Warm session**: an affinity exists or upstream state may be bound to an account, connection, prompt cache, response id, or credential context.
- **Slot**: one locally configured authenticated account entry.
- **Attempt**: one upstream wire execution using one selected slot and one transport policy.
- **Content started**: any model response content or tool/thinking event has been delivered to the client.
- **Wire started**: application request bytes may have reached the upstream connection. This is stricter than “no response headers received.”
- **Degraded transport**: a deliberately non-native transport chosen for a stronger correctness property, recorded as such.
- **Proven safe**: the provider implementation can emit specific evidence for the relevant identity, phase, or non-execution claim. Absence of client-visible output is not proof.

## Normative integrity contract

The words MUST, MUST NOT, SHOULD, and MAY are normative.

### Authentication and secrecy

1. A balanced request MUST use the selected slot's credential and MUST NOT fall back to global or default client authentication.
2. Credential selection MUST complete only after local security validation succeeds.
3. Access tokens, refresh tokens, authorization headers, and full sensitive request bodies MUST NOT be logged or persisted. A local gateway nonce MAY exist only in a mode-`0600` runtime credential file for the lifetime of its daemon; it MUST NOT enter logs, metrics, databases, or durable configuration.
4. OpenAI refresh-token rotation and Anthropic refresh semantics MUST remain provider-specific.

### Session and account continuity

5. A warm session MUST prefer its bound slot over quota balancing while that slot is usable.
6. Fresh-session quota placement MAY select any usable slot.
7. Affinity replacement is allowed only when the old slot is unusable or the provider can prove account-bound upstream state does not exist or is safely transferable.
8. First-request selection MUST be published or fenced before asynchronous refresh, usage probes, or transport setup can allow a concurrent request for the same session key to choose independently. Sessionless requests do not receive affinity and are placed independently.
9. The recorded selected slot MUST match the credential and connection that carried the attempt.

### Retry and rotation

10. Account switching and replay are prohibited after content starts.
11. “No response reached the client” MUST NOT be treated as proof that upstream did no work.
12. A wire-started generation attempt is terminal unless the provider implementation records explicit evidence that retry is safe.
13. A retry MAY remain on the same slot when no application request bytes were written, the endpoint is proven idempotent, or a provider idempotency mechanism covers the request.
14. Rotation MAY occur before content for credential-unavailable, auth-unusable, explicit pre-content rate-limit rejection, or another provider-specific outcome proven not to be executing.
15. Response-control bodies that will not be delivered to the client MUST have a bounded read time and byte limit.

### Observability

16. Every upstream attempt MUST produce one durable, redacted attempt record, including hidden retries and failed attempts.
17. Every wait, rotation, degraded transport choice, security rejection, and affinity break MUST be reconstructable from durable records.
18. Read-only status and diagnostics MUST NOT mutate selection, affinity, cooldown, or credential state.

### Persistence and process model

19. Codex schema changes MUST be additive and safe while old and new resident processes share the database.
20. Claude MUST enforce one daemon per state root until a future design replaces its process-local atomicity guarantees.
21. Rollback MUST be possible by configuration and process restart without a schema downgrade.

## Shared attempt vocabulary

### Phases

`admission`, `selection`, `credential`, `connect`, `request`, `headers`, `content`, `terminal`

### Outcomes

- `fresh_placed`
- `affinity_preserved`
- `affinity_replaced`
- `security_rejected`
- `body_limit_rejected`
- `credential_unavailable`
- `auth_unusable`
- `transport_failed_before_wire`
- `transport_failed_after_wire`
- `rate_limited_pre_content`
- `waited_same_slot`
- `retried_same_slot`
- `rotated_pre_content`
- `degraded_transport_selected`
- `content_started`
- `completed`
- `aborted`
- `terminal_failure`
- `exhausted`

Provider-specific detail belongs in a bounded `reason_code`, not in an unbounded error string used as policy input.

### Attempt record

Each provider stores this logical schema using provider-native persistence:

```ts
interface AuthBalancerAttemptV1 {
  schema_version: 1;
  attempt_id: string;
  request_id: string;
  parent_attempt_id?: string;
  provider: "codex" | "claude";
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
  evidence_codes: string[];
  upstream_status?: number;
  wire_started: boolean;
  content_started: boolean;
  retry_eligible: boolean;
  rotation_eligible: boolean;
  wait_ms?: number;
  duration_ms: number;
  created_at: string;
}
```

When present, `session_hash` and `account_hash` MUST use a state-root-scoped keyed hash so records correlate locally without exposing raw account or session identifiers. A sessionless attempt leaves `session_hash` absent, cannot claim `affinity_preserved`, and remains correlated through `request_id`. Error details MUST pass existing provider-specific redaction before storage.

`evidence_codes` is a bounded, versioned list from the shared contract package. Retry or rotation eligibility that depends on wire state MUST cite concrete evidence such as `no_application_bytes_written`, `explicit_429_rejection`, `content_not_started`, or `endpoint_idempotent`. Provider packages MAY add structured extension fields, but fields required to prove a normative invariant must be promoted into the shared schema rather than hidden in an opaque payload.

## Codex target design

### Keep the native provider boundary

`bravo-codex-balanced` remains an in-process Pi provider wrapper. It selects a slot, obtains a token lease, and calls Pi's installed `openai-codex-responses` implementation. It does not proxy HTTP and does not synthesize an official-client fingerprint.

The public saved-session provider/model identity remains `bravo-codex-balanced/<model>`. Only the ephemeral outbound view presented to Pi's native Codex converter is normalized to `openai-codex/<model>`.

### Transport identity

Balanced multi-account traffic defaults to SSE until Pi exposes an account-aware WebSocket seam.

Explicit `auto`, `websocket`, or `websocket-cached` requests MUST fail closed or resolve to a clearly reported SSE degradation; they must never enter a session-only WebSocket cache whose authorization was established under another slot.

WebSocket is eligible only when all of the following are true:

- the cache partition includes a non-secret balancer transport identity;
- that identity includes slot, account hash, and credential epoch, not a raw token;
- the connection reports the identity under which its fixed auth headers were opened;
- lease attribution is checked against that connection identity before send;
- a mismatch closes or bypasses the connection instead of silently reusing it;
- response/usage observability remains sufficient to update shared routing state.

`credential_epoch` increments when a slot is rebound to another account or a terminal auth event invalidates its credential lineage. Routine access-token refresh for the same account need not evict a healthy connection unless the upstream requires it.

SSE MUST be recorded as `degraded_transport_selected` when the caller asked for native automatic transport. It is a correctness-preserving fallback, not claimed wire equivalence.

### Replay normalization

Before invoking the native Codex converter, the wrapper creates an ephemeral outbound context in which balanced messages for the same public model are represented as native `openai-codex` messages. Persisted messages are not mutated. The exact field map is a Phase 5 evidence gate and must be derived from the pinned Pi converter and replay checks before implementation is enabled.

The normalization MUST preserve:

- encrypted/signed reasoning metadata;
- tool-call and tool-result item identifiers;
- message ordering and content bytes;
- model identity;
- all fields used by Pi's same-provider/model replay checks.

Returned events and final assistant messages are restored to the public balanced identity before persistence. If an old transcript cannot be normalized without invalidating reasoning or tool metadata, the request fails with a targeted migration error; it does not silently hash, discard, or reinterpret native metadata.

### Transactional affinity

Codex adds an additive SQLite `session_affinity` table keyed by the session hash and public model id. It records slot id, generation, created time, last-used time, expiry, and last transition reason.

The existing `BEGIN IMMEDIATE` selection transaction MUST:

1. read usable affinity;
2. select a fresh slot only when no usable affinity exists;
3. reserve capacity;
4. insert or update affinity with compare-and-update generation semantics;
5. commit before token preparation and transport setup.

If token preparation fails, the failure is recorded and the provisional affinity is invalidated or advanced in a second transaction before another slot is considered. Concurrent first leases converge on the published affinity or observe an explicit generation conflict.

During the mixed-version rollout, new processes read SQLite first and temporarily publish the legacy affinity file for old resident processes. The compatibility write is removed after one release boundary and after operators have drained processes older than the SQLite-affinity release. Strong first-request convergence is declared available only after the old-process drain gate.

### Lifetimes and fleet cooldown

The lease API gains distinct additive fields:

- `reservation_expires_at`
- `token_expires_at`
- `affinity_expires_at`

The legacy `expires_at` remains a temporary alias for reservation expiry for existing consumers and is removed only after all in-repo consumers migrate.

Short rate-limit cooldowns that influence selection move from a process-local map into additive shared SQLite state. A cooldown records slot, source attempt, reason, observed time, and expiry. Expired cooldown rows are ignored and pruned. Response-header usage remains evidence, not the only way another process learns that a slot just returned 429.

### Codex observability

Codex adds an additive attempt-events table related to reservations. It records each transport attempt, selected slot, transport identity/mode, status, usage-ingestion result, retry/rotation reason, and final lease disposition.

The table must make this sequence reconstructable without logs:

```text
slot 1 selected → SSE 429 before content → cooldown published
→ slot 2 selected → SSE completed → usage claims ingested
```

No record may contain bearer tokens, raw account ids, authorization headers, or request bodies.

## Claude target design

### Keep and accurately describe the gateway

Claude remains a loopback gateway selected through `ANTHROPIC_BASE_URL`. Request body bytes are preserved. Headers are semantically forwarded under an explicit strip-and-replace policy; the implementation MUST NOT claim raw HTTP-message or header byte fidelity.

Cross-origin and non-origin-form rejection remains before credential selection. The proxy injects credentials only for the configured Anthropic origin.

### Local admission and buffering

The daemon generates a cryptographically random nonce at startup and atomically writes it to a daemon-runtime credential file with mode `0600`. The file is replaced on every daemon start, removed on clean shutdown, and treated as invalid whenever its daemon instance is not running. A stale file never authenticates to a restarted daemon.

The launcher reads the active daemon credential and passes it to Claude Code through the existing API-key channel without logging it. The proxy validates it with a timing-safe comparison before request buffering, account selection, or credential access, then strips it before forwarding. A missing or unreadable runtime credential is a launch error, not a fallback to the fixed sentinel.

Manual clients must read the same permission-restricted runtime credential or use the launcher. The file path, ownership check, daemon-instance binding, cleanup, and systemd lifecycle are part of the daemon contract. The fixed sentinel is removed after the launcher and documented manual workflow migrate together.

Request buffering gains an explicit limit. Rollout begins in report-only mode, then defaults to 64 MiB unless observed legitimate payloads require a documented adjustment. Over-limit requests return a local 413 and record `body_limit_rejected`; they are never partially forwarded. The configured maximum is bounded to prevent an accidental unlimited value.

### First-request singleflight

The singleton daemon owns a keyed opening-session gate for `(session_hash, model)`.

One leader performs usage probing, selection, credential refresh, and first affinity publication. Concurrent followers await that result and re-read the published lease; they do not independently probe or select. The gate is released on success or failure and cannot retain bearer tokens.

Existing requests for an already warm lease bypass the opening gate and touch affinity through the normal atomic path.

### Retry and 429 policy

For non-idempotent generation endpoints, the proxy tracks whether application request bytes may have been written upstream.

- Failure before any application bytes are written MAY retry on the same slot.
- Failure after bytes may have been written is terminal by default, even if no response headers reached the client.
- Header timeout and unknown socket phase are terminal.
- No retry or rotation occurs after content starts.
- A future provider idempotency key may relax these rules only under a separate design amendment.

An explicit upstream 429 before content is treated as a rejected, non-executing attempt. A warm session waits on the same slot when `Retry-After` is valid and at or below the configured short-wait ceiling. Longer or missing waits may rotate before content according to affinity exhaustion policy.

The 429 response-control body is consumed or abandoned with both a byte cap and a deadline. Reaching either bound destroys the upstream response and continues the already-decided wait/rotation path; it does not hang the client.

Operators may enable a stricter fidelity policy that disables all hidden generation retries and cross-account 429 rotation.

### TLS and connection policy

`keepAlive: false` and `maxCachedSessions: 0` become the named `fresh_tls_quarantine` policy, not an undocumented permanent approximation of direct Claude Code networking.

The package adds independently switchable experimental policies:

- `keepalive_no_tls_cache`
- `keepalive_with_tls_cache`

Every attempt records policy, socket reuse, connection/TLS phase, error code, handshake duration when available, and outcome. Experiments are opt-in until local soak evidence shows no recurrence of the observed TLS failures and no change in response integrity.

Promotion proceeds one dimension at a time: keep-alive without TLS-session caching first, then TLS-session caching. Rollback is a daemon restart under `fresh_tls_quarantine`.

Usage probes and OAuth refresh keep their provider-appropriate transports, but documentation and telemetry must not imply the inference quarantine applies globally.

### Claude observability

Claude adds durable attempt records separate from final usage rows. Attempt records include hidden same-slot retry, 429 wait/drain outcome, rotation, connection policy, local rejection, and terminal 502/429 behavior.

Final token usage remains request-level accounting. Attempt metrics explain reliability and latency; they must not double-count model usage across retries.

## Contract-test matrix

Both packages implement scenarios with the same names through provider-specific fixtures.

| Scenario | Codex assertion | Claude assertion |
| --- | --- | --- |
| `fresh-session-converges` | concurrent first leases commit one SQLite affinity generation | concurrent openers share one singleflight selection |
| `warm-affinity-wins` | quota scoring does not move a usable bound session | usage probes do not move a usable warm lease |
| `credential-fails-before-wire` | failed slot is recorded and safe fallback is pre-wire | failed refresh is recorded and no body is forwarded |
| `rate-limit-before-content` | fleet cooldown is published before safe rotation | bounded drain/wait or safe rotation is recorded |
| `content-prohibits-replay` | no later lease attempt after streamed content failure | no retry or rotation after streamed content failure |
| `attempts-are-durable` | every reservation transport attempt is queryable | retry/wait attempts exist independently of final usage |
| `telemetry-is-redacted` | SQLite and logs contain no token/account/session plaintext | metrics and logs contain no nonce/token/body plaintext |
| `status-is-read-only` | status does not create reservations or affinity | status does not touch lease, probe, or metrics state |
| `security-rejects-before-auth` | placeholder/global auth never reaches upstream | bad target/nonce rejects before slot or token access |

Provider-only scenarios are also required.

Codex:

- session-only WebSocket cache reuse across two slots is rejected;
- account-aware WebSocket identity mismatch closes or bypasses the connection;
- old balanced transcripts preserve native reasoning and tool-call metadata under ephemeral normalization;
- mixed old/new processes tolerate additive tables and fields;
- `reservation_expires_at`, `token_expires_at`, and `affinity_expires_at` are independently enforced.

Claude:

- a never-ending 429 body cannot exceed the control-body deadline;
- a body over the configured limit receives local 413 without upstream bytes;
- concurrent openers remain on one slot while probe and refresh are deliberately delayed;
- a failure after request bytes are written does not replay a generation;
- each TLS policy proves expected socket and TLS-session reuse behavior;
- invalid local nonce rejects before body buffering and credential selection.

## Rollout plan

### Phase 1 — Contract and evidence, no policy change

- Land this spec and the policy-free `@bravo/auth-balancer-contract` package with literal vocabulary, schema validator, redaction helpers, and scenario fixtures. Add each package's harness adapter inside that provider package.
- Add attempt ids and shadow classification while preserving current routing.
- Establish baseline rates for retries, rotations, TLS failures, 429s, affinity breaks, body sizes, and transport modes.

### Phase 2 — Durable attempt telemetry

- Add Codex attempt/cooldown/affinity schema additively, leaving new routing reads disabled.
- Add Claude attempt storage and report-only body-size observations.
- Verify redaction and retention under realistic sessions.

### Phase 3 — Low-risk containment

- Bound Claude 429 control bodies.
- Enforce Claude local nonce and body limit after report-only validation.
- Publish Codex fleet cooldowns.
- Split Codex lifetime fields while retaining the temporary alias.

### Phase 4 — Affinity correctness

- Enable Codex transactional SQLite affinity plus temporary legacy-file publication.
- Enable Claude opening-session singleflight.
- Drain old Codex processes before declaring strong convergence and starting the compatibility removal clock.

### Phase 5 — Integrity gates

- Enforce Codex transport rejection/degradation and replay normalization checks.
- Make Claude after-wire, header-timeout, and unknown-phase generation failures terminal.
- Enforce no replay or account switch after content in both packages.

### Phase 6 — Opt-in transport experiments

- Add the Pi account-aware transport seam before enabling balanced Codex WebSocket.
- Soak Claude `keepalive_no_tls_cache`; only then test `keepalive_with_tls_cache`.
- Promote a mode only when attempt telemetry proves attribution, integrity, and failure-rate acceptance criteria.

### Phase 7 — Cleanup

- Remove Codex legacy affinity-file publication after one release boundary and verified old-process drain.
- Remove the legacy lease `expires_at` alias after all in-repo consumers migrate.
- Review independently implemented provider helpers for any further pure extraction beyond `@bravo/auth-balancer-contract`; do not extract policy machinery.

## Rollback

- Codex WebSocket and Claude connection reuse remain off unless explicitly enabled.
- Provider-local flags can restore the previous selection/retry policy while retaining evidence tables.
- Claude returns to `fresh_tls_quarantine` through configuration and daemon restart.
- Codex old processes ignore additive tables/columns; rollback never requires deleting or downgrading SQLite state.
- A security or attribution incident disables hidden retries and rotations before any attempt to preserve availability.

## Release gates

Each phase requires:

- package check and test commands;
- the relevant contract and provider-only tests;
- redaction scan of logs and local databases;
- restart/recovery tests;
- clean-clone install and extension-load verification before a release tag;
- a written rollback command/config for every newly enabled policy;
- no unexplained increase in wrong-slot attribution, affinity breaks, duplicate-attempt risk, or terminal error rate.

Codex phases that change live SQLite behavior additionally require a mixed-version test with an older resident process. Claude transport promotion requires a long-running local soak with TLS phase and reuse evidence, not merely unit tests.

## Implementation work packages

1. **Contract foundation** — create `@bravo/auth-balancer-contract` with literal types, schema validator, redaction contract, scenario registry, and no routing decisions or provider dependencies.
2. **Codex evidence layer** — additive attempt/cooldown/affinity storage and lifetime fields.
3. **Claude evidence and admission** — attempt rows, nonce validation, report-only then enforced body cap, bounded control responses.
4. **Affinity correction** — Codex transactional publication and Claude opening singleflight.
5. **Codex replay and transport integrity** — ephemeral metadata normalization, fail-closed WebSocket gate, upstream account-aware cache seam.
6. **Claude retry and transport integrity** — wire-start tracking, conservative generation retry, named TLS policies and experiments.
7. **Compatibility cleanup** — remove explicitly temporary Codex file/field bridges after their drain gates.
8. **Independent release audit** — validate invariants, cross-process behavior, redaction, rollback, and clean install.

Work packages 2 and 3 may proceed in parallel after package 1. Package 4 requires their telemetry/storage foundations. Transport experiments are last; neither is a prerequisite for shipping the correctness fixes.

## Acceptance criteria

The design is complete when:

- no request can be recorded against a different slot than the credential/connection that carried it;
- concurrent first requests with a stable session key converge for both providers; sessionless requests remain explicitly unbound;
- warm sessions are not moved by ordinary quota scoring;
- Codex restored sessions retain valid native reasoning/tool metadata or fail with a targeted migration error;
- Claude never replays an after-wire generation under the default policy;
- a malformed 429 body cannot hang the Claude gateway;
- every attempt and decision is durably reconstructable without secrets;
- old/new Codex process compatibility and Claude daemon restart rollback are proven;
- experimental native-like transports remain gated until their provider-specific proof criteria pass.

## Open decisions gated on evidence

- The precise Pi API for an account-aware Codex WebSocket cache partition and connection-identity assertion.
- The exact pinned-Pi replay field map required to preserve signed reasoning and tool-call identity across the public-balanced/native-upstream boundary.
- The final Claude body limit after report-only distribution data; 64 MiB is the initial proposed default.
- Whether Claude generation 429 rotation stays enabled by default after attempt telemetry quantifies cache loss and availability benefit.
- Telemetry retention duration and pruning thresholds for both packages.
- Whether a Unix-domain socket can replace or supplement the Claude nonce without breaking supported Claude Code launch workflows.

These questions do not block Phases 1–4. They must be resolved before the affected Phase 5 or 6 policy is enabled.

## References

- [OpenAI WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode) — persistent connection behavior, `previous_response_id`, and connection-local continuation state.
- [`../codex-balanced-provider/design.md`](../codex-balanced-provider/design.md) — existing balanced-provider contract.
- [`../codex-auth-balancer/design.md`](../codex-auth-balancer/design.md) — existing Codex account-balancer design.
- [`../../../packages/codex-auth-balancer/README.md`](../../../packages/codex-auth-balancer/README.md) — live SQLite and mixed-process compatibility contract.
- [`../../../packages/claude-auth-balancer/README.md`](../../../packages/claude-auth-balancer/README.md) — Claude affinity, proxy, and daemon operating contract.
