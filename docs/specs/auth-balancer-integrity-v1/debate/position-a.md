# Position A: Shared Contract, Provider-Native Implementations

## Round 1

### Thesis

The right boundary is a shared behavioral contract and shared contract-test vocabulary, not a shared runtime. Codex and Claude have materially different correctness mechanisms:

- Codex is an in-process Pi provider that must preserve Pi's native Codex streamer while coordinating long-lived processes through SQLite.
- Claude is a singleton local HTTP gateway that owns request forwarding, TLS policy, request buffering, and process-local affinity atomicity.

Forcing those into one shared account-selection, lease, retry, or attempt-state runtime would hide provider-specific hazards behind a generic state machine and make the abstraction dishonest. The common layer should define outcomes, invariants, and test scenarios. Each package should implement those outcomes in its provider-native runtime.

### Concrete Design

Define `auth-balancer-integrity-v1` as a behavioral contract with canonical outcomes, attempt phases, and black-box test scenarios. Each package implements those outcomes in its own native code path.

Shared artifacts:

- Contract document describing invariants.
- Canonical outcome names.
- Scenario names and fixture shapes for contract tests.
- Redaction requirements.
- Later, only if both implementations converge, tiny pure TypeScript types or string helpers.

The shared vocabulary should include:

- `fresh_placed`
- `affinity_preserved`
- `affinity_unavailable_replaced`
- `pre_content_rate_limited`
- `pre_content_auth_unusable`
- `pre_header_transport_retry_same_slot`
- `header_timeout_terminal`
- `post_content_terminal_no_replay`
- `exhausted`
- `security_rejected`
- `attempt_observed_redacted`

The shared contract must say what is safe and observable. It must not prescribe one storage model, one lease implementation, one credential refresh flow, one transport policy, or one retry engine.

### Required Decision Areas

1. Shared behavioral contract versus shared runtime code

   Use shared invariants and contract tests only. Codex gets SQLite/provider-bound code. Claude gets gateway/daemon-bound code. Runtime sharing stops at tiny pure vocabulary helpers if duplication remains byte-identical after both implementations exist.

   Evidence: Codex explicitly owns SQLite compatibility for resident processes. Additive columns must not bump schema because old resident processes share the database (`packages/codex-auth-balancer/README.md:5-16`). Claude explicitly depends on exactly one daemon per state root; two daemons invalidate lease, metrics, and refresh atomicity (`packages/claude-auth-balancer/src/daemon.ts:1-14`).

2. Warm-session affinity versus fresh-session quota placement

   The contract should say warm affinity wins unless auth, identity, or quota makes it impossible; fresh sessions use health and quota placement. Claude already documents why warm-session movement is expensive: measured traffic is dominated by cache reads, and moving a live session can cost 20x on the next request (`packages/claude-auth-balancer/README.md:15-37`). Codex should keep session affinity as a soft preference, not a fail-closed hard requirement, because a stale or unavailable preferred slot must not turn a usable install into a failure. The current Codex selector already distinguishes hard explicit slot selection from soft affinity or rotation hints (`packages/codex-auth-balancer/src/index.ts:1129-1136`, `packages/codex-auth-balancer/src/index.ts:1220-1228`).

3. Codex account-aware WebSocket continuity and safe SSE fallback

   Keep SSE as the balanced default until WebSocket continuity is account-aware. Current Codex balanced streaming defaults to SSE because only SSE exposes response headers needed for live usage ingestion and 429 detection (`packages/codex-auth-balancer/extensions/pi/index.ts:604-616`). Tests enforce that WebSocket is not used by default (`packages/codex-auth-balancer/test/index.test.ts:761-786`).

   WebSocket should become available only when the transport cache key includes the selected account identity or an equivalent generation, or when the provider can prove the existing socket's authorization matches the selected slot.

4. Codex replay metadata normalization without changing public saved-session identity

   Public identity remains `bravo-codex-balanced/*`; normalization happens only at the upstream boundary and returned events are restored to public provider/model. Codex already separates public and upstream ids, maps the public model catalog, and restores returned messages to the balanced provider identity (`packages/codex-auth-balancer/extensions/pi/index.ts:292-341`, `packages/codex-auth-balancer/extensions/pi/index.ts:604-605`). The contract tests should assert that saved sessions keep balanced identity while replay metadata remains acceptable to Pi's native Codex reasoning/tool-call handling.

5. Claude connection reuse/TLS diagnosis and rollback-safe transport policy

   Keep this Claude-native. The current proxy disables keep-alive and TLS session caching for inference HTTPS, giving each attempt a fresh TCP/TLS path (`packages/claude-auth-balancer/src/proxy.ts:459-469`). A rollback-safe design should add a Claude-only staged transport flag that records `reusedSocket`, TLS code, phase, attempt number, and outcome before enabling connection reuse. Rollback should be flipping that flag, not migrating shared state.

6. Claude non-idempotent retry policy and bounded 429 handling

   The contract invariant is: never switch accounts or replay after response content has reached the client. Claude retries only classified pre-header broken connections on the same account, and excludes header timeout because upstream may still be running the inference (`packages/claude-auth-balancer/src/proxy.ts:47-90`). Tests cover that only broken pre-header connections are retried and streaming-phase failures are not (`packages/claude-auth-balancer/test/security.test.ts:589-610`). The 429 wait/rotation path is pre-body only (`packages/claude-auth-balancer/src/proxy.ts:760-797`).

   The current unbounded 429 drain should be fixed with a deadline and body-size cap. The existing unbounded drain is small but real risk (`packages/claude-auth-balancer/src/proxy.ts:451-457`).

7. First-request concurrency and affinity publication for both runtimes

   Codex should move affinity publication into additive SQLite state and publish it in the same `BEGIN IMMEDIATE` reservation transaction, instead of reading a file before selection and writing it after token preparation. Current file affinity read/write lives in `packages/codex-auth-balancer/src/index.ts:1477-1485`; the write currently happens after lease construction at `packages/codex-auth-balancer/src/index.ts:1889`.

   Claude should solve this inside the singleton daemon, either by touching a provisional lease immediately after final selection or by keeping an in-memory pending-selection promise per `(session, model)` across probe/refresh awaits. The intended behavior is already captured by the concurrent opening request test (`packages/claude-auth-balancer/test/security.test.ts:260-304`).

8. Durable, redacted per-attempt observability and outcome vocabulary

   Use shared outcome names, provider-native storage. Codex can extend `launch_events` or add nullable attempt columns/tables additively; launch events are already tied to reservations (`packages/codex-auth-balancer/src/index.ts:610-618`, `packages/codex-auth-balancer/src/index.ts:1246-1249`). Claude should add attempt rows or enrich metrics so hidden retries, waits, rotations, and terminal failures are durable, not only logs. Current Claude request metrics record a final request-oriented row with slot, session hash, status, decision, duration, usage, and claims (`packages/claude-auth-balancer/src/metrics.ts:21-33`, `packages/claude-auth-balancer/src/proxy.ts:799-815`).

   Redaction must exclude access tokens, refresh tokens, authorization headers, and full sensitive request bodies.

9. Security limits for local proxy access and request buffering

   Claude should keep loopback and request-target validation. The launcher enforces loopback HTTP (`packages/claude-auth-balancer/src/client-launch.ts:21-27`). The proxy rejects absolute-form and protocol-relative request targets before selecting credentials (`packages/claude-auth-balancer/src/proxy.ts:221-258`), with tests proving no credential reaches an attacker origin (`packages/claude-auth-balancer/test/security.test.ts:77-145`).

   Add a max buffered request-body size and a per-daemon local gateway nonce validated before stripping or replacing auth headers. The current launcher sentinel is explicitly non-secret (`packages/claude-auth-balancer/src/client-launch.ts:6-7`), so it selects the mode but does not authenticate the local caller.

10. Additive migration, staged rollout, rollback, and end-to-end validation

   Codex migrations must be additive while old/new resident processes share SQLite, per its compatibility contract (`packages/codex-auth-balancer/README.md:5-16`). Claude can add daemon-local files or tables because the singleton daemon owns live mutation.

   Rollout order:

   1. Land shared contract docs and contract-test scenario names.
   2. Add provider-native observability without changing routing.
   3. Add bounded Claude 429 drain and request-body cap.
   4. Fix first-request affinity publication in each native runtime.
   5. Add Codex WebSocket account-aware continuity behind an opt-in flag.
   6. Add Claude transport reuse experiments behind a rollback flag only after telemetry proves the failure shape.

   Rollback disables provider-local flags and leaves additive schema ignored by older readers.

### Tradeoffs

Position A accepts some duplication in selection, retry, and attempt handling. That duplication is less risky than a shared kernel parameterized by two unlike systems:

- In-process Pi stream plus SQLite reservations, token leases, and provider rebadging.
- HTTP proxy plus body buffering, header substitution, TLS agent policy, daemon singleton, and relay observation.

A shared kernel would quickly become a bag of provider-specific exceptions. That is not abstraction; it is buried coupling.

### Strongest Objection To Position A

The strongest objection is semantic drift. A shared runtime kernel would make it harder for Codex and Claude to slowly diverge on retry eligibility, affinity publication, exhaustion, and observability names.

That objection is real. The answer is shared contract tests that fail on drift, not a shared state machine. The mechanics are too different for one runtime to be honest, but the externally required behavior is common enough to test uniformly.

## Round 2

### Rebuttal To Position B

Position B argues that a small pure lifecycle kernel is the only reliable way to prevent semantic drift, and that it can be introduced in shadow mode. The useful part is the concern about drift. The faulty part is the leap from "same vocabulary" to "same lifecycle runtime."

A pure kernel still has to be fed provider-specific truth:

- Codex attempt identity comes from a token lease, reservation id, launch id, selected slot, Pi native streamer options, and possibly SSE response headers (`packages/codex-auth-balancer/extensions/pi/index.ts:555-641`).
- Claude attempt identity comes from an HTTP request body, session header, daemon-local affinity lookup, token refresh, forwarded request, response headers, relay lifecycle, and client socket behavior (`packages/claude-auth-balancer/src/proxy.ts:564-825`).

Those are not adapters around one lifecycle. They are different lifecycles. Shadow mode does not remove that mismatch; it creates a second narrative about what happened. If the shadow kernel says "retryable pre-header attempt" but the provider-native layer knows a body may already be running upstream, the provider-native layer must win. If the provider-native layer must always win, the kernel is advisory, not a safety mechanism.

The Codex/Claude refresh semantics also show why a shared lifecycle kernel is too blunt. Codex refresh tokens are documented as single-use and rotating, with reuse detection risk (`packages/codex-auth-balancer/src/codex-oauth.ts:36-43`). Claude refresh ownership is authswap-file-based and preserves unknown credential fields under a file lock (`packages/claude-auth-balancer/src/refresh.ts:9-22`, `packages/claude-auth-balancer/src/refresh.ts:87-107`). A generic "refresh lifecycle" would either omit the important parts or encode provider-specific branches.

What I would accept from Position B:

- Shared pure `AttemptOutcome` and `AttemptPhase` string unions.
- Shared JSON schema for per-attempt telemetry rows.
- A contract-test helper package that runs scenario fixtures against provider-specific harnesses.
- Optional shadow classification that compares provider-native outcome names to the shared vocabulary, as diagnostics only.

What I would reject:

- A shared account selector.
- A shared affinity manager.
- A shared retry engine.
- A shared lease or persistence runtime.
- Any kernel whose decision can override provider-native idempotence, token, or transport truth.

### Rebuttal To Position C

Position C argues that Position A is still too permissive: Codex soft affinity and Claude pre-header replay should fail visibly whenever identity or idempotence is unproven.

The safety instinct is right, but the proposed fail-visible rule is too coarse.

For Codex soft affinity, failing whenever the affinity slot is unavailable would make stale affinity a user-visible outage even when another configured account can safely serve the request. That contradicts the existing Codex policy: explicit `--slot` is hard, but session affinity and rotation hints are soft so a preference cannot turn a usable install into `slot unavailable by policy` (`packages/codex-auth-balancer/src/index.ts:1129-1136`). This is not permissiveness about identity. The selected lease still must have a usable, claim-bearing access token, or it fails before upstream (`packages/codex-auth-balancer/src/index.ts:1860-1873`). Soft affinity means "do not fail solely because the preferred account is no longer serviceable."

For Codex WebSocket identity, Position C is correct: if account identity cannot be proven for a reused WebSocket, the balanced provider should not use that WebSocket. Position A already says SSE remains the safe default until the WebSocket cache key is account-aware. Current code defaults to SSE for this reason (`packages/codex-auth-balancer/extensions/pi/index.ts:604-616`).

For Claude pre-header replay, fail-visible on every pre-header failure would throw away a recovery path that is narrowly scoped and already tested. The current policy retries only broken connections before response headers, on the same account, with a bounded retry budget (`packages/claude-auth-balancer/src/proxy.ts:47-90`, `packages/claude-auth-balancer/src/proxy.ts:694-735`). It does not rotate accounts for socket failures. It does not retry header timeout, specifically because the inference may still be running upstream (`packages/claude-auth-balancer/test/proxy.test.ts:575-585`). It does not retry once bytes have reached the client (`packages/claude-auth-balancer/test/security.test.ts:607-610`).

The unresolved risk is that "pre-header" is not identical to "upstream definitely did no work." Position C is right to force that admission. But the better control is not fail-visible always; it is narrower eligibility plus durable attempt observability:

- Retry only known broken-connection codes.
- Retry only on the same slot.
- Do not retry header timeout.
- Do not retry unknown codes.
- Bound retry count and backoff.
- Persist each hidden attempt with phase, code, slot, duration, and final outcome.

What I would accept from Position C:

- Codex WebSocket remains disabled for balanced default until selected-slot identity is cryptographically or structurally bound to transport reuse.
- Claude header timeout and unknown pre-header codes remain terminal.
- A stricter "no hidden retry" feature flag for incident response and validation.
- Contract tests that prove no replay after any downstream byte and no account switch after partial content.

What I would reject:

- Treating stale Codex soft affinity as a hard failure when another account can serve safely.
- Treating every classified pre-header broken socket as non-idempotent when retrying the same account is bounded, observable, and no response byte reached the client.

### Final Recommendation

Adopt Position A with two explicit hybrid concessions:

1. From Position B, take shared pure vocabulary and contract-test fixtures, but keep decision execution inside each provider-native runtime.
2. From Position C, take stricter proof requirements for Codex WebSocket reuse and Claude retry eligibility, plus an operator flag to disable hidden retries during investigation.

Do not build a shared runtime kernel. Do not make every uncertain transport event fail visibly. The correct design is shared behavioral law, provider-native enforcement, durable redacted per-attempt evidence, and tests that make drift obvious.
