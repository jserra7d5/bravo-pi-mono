# Auth Balancer Integrity v1 - Debate Synthesis

## Decision

Adopt Position A as the architecture: shared behavioral contract, provider-native implementations, and contract tests. Do not extract a shared account-selection, credential-refresh, affinity, retry, persistence, proxy, lease, or transport runtime.

Take two hybrid elements:

- From Position B: a small executable vocabulary package is acceptable for literal outcome/phase names, telemetry schema validation, redaction helpers, and reusable contract-test fixture definitions. It must not decide provider behavior.
- From Position C: ambiguity is terminal by default for transport identity, account attribution, replay metadata, and post-content execution. Retry or rotation is allowed only when the provider-native implementation can prove the relevant safety fact.

This means the common layer defines the law and the evidence required to claim compliance. Codex and Claude enforce that law in separate runtimes because their correctness mechanisms are different in kind, not just different adapters around one state machine.

## Strongest Supported Claims From Each Position

Position A is strongest on the architecture boundary. Codex is an in-process Pi provider wrapper with SQLite shared across resident processes, native Codex streaming behavior, provider rebadging, and OpenAI token leasing. Claude is a singleton local HTTP gateway with request buffering, header replacement, TLS policy, daemon-local atomicity, and Anthropic-specific credential handling. A shared runtime would either hide these facts or fill with provider branches until it became dishonest.

Position B is strongest on drift risk. Retry eligibility, content-start terminality, first-request affinity publication, attempt outcome names, and durable per-attempt telemetry must not diverge silently. Prose alone is too weak. The answer is executable shared vocabulary, schema validation, and black-box contract tests that both packages must pass.

Position C is strongest on burden of proof. "No response reached the client" is not automatically proof that upstream did no work. "SSE exposes headers" is not proof that SSE is native-equivalent to Codex WebSocket behavior. "Public provider rebadging was restored" is not proof that replayed reasoning/tool metadata remains semantically native. Where proof is absent, fail visibly or choose a recorded degraded path.

## Rejected Claims And Why

Reject Position B's shared lifecycle kernel as the primary design. Even a pure state machine would need provider-native truth to decide the dangerous transitions: whether a Claude pre-header failure is retry-safe, whether a Codex WebSocket is credential-bound to the selected account, whether replay metadata survives Pi's native checks, and whether a reservation fence is durable across old and new Codex processes. If the provider implementation must override the kernel whenever the facts matter, the kernel is advisory, not a safety mechanism.

Reject Position C's broad ban on all hidden recovery. Some interventions are safe when narrowly proven: same-slot retry for classified broken transport before response headers, credential failure before any wire send, auth rejection before content, and bounded same-account 429 wait. The design should not trade away all availability when the integrity property can be proven and recorded.

Reject Position A's softest reading of "contract tests are enough." Contract tests must be paired with shared literal outcome names, schema validators, and required telemetry fields. Otherwise observability vocabulary can still drift and become incomparable.

Reject any Codex HTTP proxy. The brief explicitly forbids it, and it would discard Pi's native provider boundary.

Reject any Claude move away from the body-preserving local gateway unless Claude Code exposes a verified credential-selection seam. There is no such seam in the brief.

## Contradictions Resolved

Shared contract versus shared kernel: the synthesis chooses shared contract plus executable vocabulary, not shared state transitions. The contract is enforced through provider-native code and contract tests.

Availability versus integrity: integrity wins under ambiguity. Availability-preserving behavior is allowed only when the provider implementation records evidence for account identity, idempotence, content phase, and retry/rotation eligibility.

Warm affinity versus quota balancing: warm affinity wins for account-bound sessions. Fresh sessions may use quota placement. Stale or unavailable affinity may be replaced only before account-bound upstream state exists or when the provider can prove replacement is safe.

Native transport versus observability: native transport is preferred only when account attribution is provable. A degraded transport such as Codex SSE is acceptable when explicitly recorded and chosen because it gives safer attribution and response-header visibility than an account-ambiguous WebSocket.

Hidden retry versus visible failure: retries are not categorically forbidden, but every retry must be same-account unless the prior attempt is proven non-executing or pre-content rate-limited. Any content delivered to the client makes replay and account switch terminally prohibited.

## Winning Design And Hybrid Elements

The winning design is provider-native enforcement under a shared safety contract.

Common artifacts:

- `AttemptPhase` and `AttemptOutcome` literal names.
- Redacted attempt telemetry schema.
- Contract-test scenario names and fixtures.
- Redaction helpers that prevent token, authorization header, and sensitive body persistence.
- Documentation of invariants and provider evidence required for each outcome.

Common artifacts must not include:

- account selection;
- credential refresh;
- lease storage;
- affinity publication logic;
- retry state machine;
- quota scorer;
- proxy code;
- transport code;
- provider-specific persistence implementation.

Provider implementations:

- Codex keeps the in-process Pi provider wrapper and additive SQLite coordination.
- Claude keeps one local daemon per state root and gateway-owned request forwarding.
- Both packages emit durable per-attempt records using the shared schema.
- Both packages run the same contract scenarios through package-specific harnesses.

Hybrid from B: shared executable vocabulary and validators are required.

Hybrid from C: ambiguous replay, account identity, or metadata compatibility is fail-closed by default.

## Exact Non-Negotiable Invariants

1. Never fall back to global or default client authentication.
2. Never log or persist access tokens, refresh tokens, authorization headers, or full sensitive request bodies.
3. Never switch accounts after response content has reached the client.
4. Never replay a generation after response content has reached the client.
5. Never treat "no client-visible response" as sufficient proof that upstream did no work.
6. Retry after a wire-started attempt is terminal unless the provider-native implementation classifies the failure as retry-safe with explicit evidence.
7. Account rotation is allowed only before content and only for outcomes proven non-executing, auth-unusable, credential-unavailable, or pre-content rate-limited according to provider rules.
8. Warm-session affinity wins over quota placement when upstream state may be account-bound.
9. Fresh-session placement may balance by quota only before account-bound state exists.
10. First-request affinity must be published or fenced before async refresh, usage probing, or transport setup can let concurrent first requests split accounts.
11. Codex SQLite migrations must be additive and safe while old and new resident processes share the database.
12. Claude remains one daemon per state root unless a future design explicitly replaces its atomicity guarantees.
13. OpenAI refresh tokens remain single-use rotating credentials; Anthropic refresh behavior remains provider-specific.
14. Every upstream attempt, hidden retry, wait, rotation, terminal failure, and degraded transport choice must have durable redacted telemetry.
15. Local proxy security rejection must happen before credential selection.
16. Request buffering must have explicit size limits and observable rejection outcomes.

## Provider-Specific Decisions For Codex And Claude

Codex:

- Keep Codex in-process and preserve Pi's native Codex provider path.
- Balanced default remains SSE until WebSocket account continuity is proven.
- WebSocket may be enabled only when the transport cache key or equivalent provider seam binds session reuse to selected account identity.
- If WebSocket account identity is not proven, do not use it for multi-account balanced traffic.
- Record SSE as the selected transport mode and, where relevant, as a degraded observable path rather than pretending it is native-equivalent.
- Preserve public saved-session identity as `bravo-codex-balanced/*`.
- Normalize replay metadata only at the upstream boundary and restore public identity on returned messages.
- If Pi's native provider/model checks would treat reasoning or tool-call metadata as foreign after normalization, fail closed or require an explicit migration path.
- Move session affinity publication into additive SQLite state and publish/fence it in the reservation transaction before token preparation or other long awaits.
- Split conflated `expires_at` semantics into separate reservation/lease, token, and affinity lifetimes through additive schema.
- Make rate-limit cooldown fleet-visible through shared SQLite, not process-local only.

Claude:

- Keep the body-preserving local gateway unless Claude Code exposes a verified credential-selection seam.
- Preserve request body bytes, but do not claim byte-for-byte HTTP-message fidelity because Node reconstructs header semantics.
- Current no-keep-alive/no-TLS-session-cache behavior remains a quarantine policy until diagnostics justify reuse.
- Add a rollback-safe transport policy flag for native-like reuse experiments, with per-attempt recording of policy version, TLS/socket evidence, and outcome.
- Do not cross-account retry non-idempotent generation requests after a request has been written upstream unless an upstream idempotency mechanism or provider-native proof exists.
- Same-account retry is allowed only for narrowly classified pre-header broken-connection failures, excluding header timeout and unknown failures.
- Header timeout is terminal by default because upstream work may still be running.
- 429 handling must drain with a byte cap and deadline.
- Bounded same-account 429 wait is allowed for warm affinity. Cross-account 429 rotation is allowed only before content and only when policy marks the request safe to rotate.
- First-request affinity must be touched or fenced at selection time inside the daemon before async probes or refreshes can split concurrent openings.
- Add explicit max buffered body size and a local access control stronger than loopback alone, such as a daemon nonce or Unix socket mode.

## Staged Rollout/Rollback

Stage 1: land the shared contract document, outcome/phase literals, telemetry schema, redaction helpers, and provider-specific contract-test fixtures. No routing behavior changes.

Stage 2: add durable redacted per-attempt telemetry to both packages. Record current behavior, including retries, waits, rotations, degraded transports, hidden latency, terminal outcomes, and security rejections.

Stage 3: add low-risk hardening: bounded Claude 429 drain, Claude request-body cap, Codex fleet-visible cooldown, split Codex lifetime fields, and no-token/no-body telemetry validation.

Stage 4: fix first-request affinity publication. Codex publishes/fences affinity in SQLite reservation state additively. Claude publishes/fences selection inside daemon atomicity before async probes or refresh.

Stage 5: enforce conservative gates. Codex WebSocket remains disabled for balanced multi-account traffic unless account-aware continuity is proven. Claude header timeout and unknown pre-header failures are terminal. No provider rotates or replays after content.

Stage 6: run opt-in experiments. Codex account-aware WebSocket and Claude native-like connection reuse can be enabled only behind flags after telemetry and contract tests prove identity and transport safety.

Rollback:

- Disable policy flags for Codex WebSocket and Claude connection reuse.
- Disable hidden retry/rotation flags if incident response requires visible failures.
- Leave additive schema and telemetry tables in place; old Codex processes must ignore them safely.
- Restart the Claude daemon to return to the prior singleton transport policy.
- Roll back by configuration first, code second, schema never as an emergency requirement.

## Unresolved Questions

- What exact Codex account identity should key WebSocket reuse: slot id, account id hash, credential generation, selected token subject, or a provider-exposed connection identity?
- Which Pi replay metadata fields must be normalized for native Codex reasoning and tool-call handling, and which must remain publicly branded for saved-session identity?
- What are the precise Claude error codes and socket phases that provide enough evidence for same-account retry safety?
- Should Claude cross-account 429 rotation remain available for any generation request, or only for endpoints explicitly classified idempotent or non-generating?
- What request-body cap should Claude use by default, and should it be endpoint-specific?
- Should Claude local access hardening use a bearer nonce, Unix domain socket, process ownership checks, or a combination?
- What is the minimum attempt telemetry retention period needed to distinguish legitimate personal load balancing from resale-like behavior without spoofing or invasive fingerprinting?
- Which end-to-end tests must run against clean installs before release, given Codex old/new resident-process database compatibility?

## Minority Report

Position B's minority report: a small shared lifecycle kernel could prevent ordering drift more strongly than contract tests. If the provider-native implementations repeatedly diverge despite shared vocabulary and fixtures, revisit a narrower kernel limited to retry gating and telemetry emission. The deletion criterion is strict: if it needs provider-specific branches for transport, credentials, storage, or quota, it is the wrong abstraction.

Position C's minority report: even same-account pre-header retry may duplicate upstream generation if the provider accepted the request before the connection failed. Operators who prefer maximum fidelity should have a policy flag that disables hidden retries and cross-account 429 rotation entirely, surfacing visible failures instead.

Position A's minority concern inside the winning design: shared executable vocabulary can grow into shared runtime gravity. Keep it intentionally boring: literals, schemas, redaction helpers, and fixtures only.
