# Position B - Shared Affinity and Attempt-State Kernel

## Round 1

### Thesis

Extract a small shared state-machine kernel, not a shared balancer runtime. The current systems already share the hard parts conceptually: affinity lookup/publication, "has content reached the client?" retry gates, per-attempt outcomes, redacted telemetry, reservation finalization, and warm-session versus fresh-session placement. Keeping those rules duplicated is how the two balancers drift into subtly different safety behavior.

The honest boundary is: shared kernel owns sequencing and vocabulary; provider adapters own transport, quota interpretation, credentials, storage mechanics, and wire behavior.

### Concrete Interfaces and Ownership Boundaries

The shared package should be a pure TypeScript library, likely something like `@bravo/auth-balancer-kernel`, with no Node HTTP, no Pi imports, no SQLite dependency, no credential parsing, and no OAuth logic.

It should define:

```ts
type AttemptOutcome =
  | 'succeeded'
  | 'rate_limited_pre_content'
  | 'auth_rejected_pre_content'
  | 'credential_unavailable'
  | 'retryable_transport_pre_header'
  | 'non_retryable_pre_content'
  | 'content_started_then_failed'
  | 'aborted'
  | 'exhausted';

type RetryEligibility =
  | 'same_slot_only'
  | 'rotate_slot'
  | 'wait_same_slot'
  | 'terminal';

interface KernelAdapter<Req, Slot, Prepared, WireResult> {
  now(): number;

  readAffinity(req: Req): Promise<AffinityLease<Slot> | undefined>;
  reserveOrPublishAffinity(input: AffinityPublishInput<Slot>): Promise<AffinityFence>;

  selectSlot(input: SelectionInput<Slot>): Promise<Selection<Slot>>;
  prepareCredential(input: PrepareInput<Slot>): Promise<Prepared>;

  runWireAttempt(input: WireAttemptInput<Req, Prepared>): Promise<WireResult>;
  classifyWireResult(result: WireResult): ClassifiedAttempt;

  recordAttempt(record: RedactedAttemptRecord<Slot>): Promise<void>;
  finish(input: FinishInput<Slot>): Promise<void>;
}
```

Kernel owns:

- Request attempt lifecycle.
- Affinity first, fresh placement second.
- When affinity must be published relative to async work.
- Retry eligibility based on "content has reached client" and provider-declared idempotence.
- Outcome names and redacted attempt telemetry shape.
- Fencing/attempt ids so storage adapters can make publication atomic.

Adapters own:

- Codex Pi provider invocation and SSE/WebSocket policy.
- Claude HTTP proxy forwarding, body buffering, header rules, TLS agent policy.
- OpenAI versus Anthropic credential refresh.
- SQLite versus file-backed persistence.
- Quota claims and selection scoring.
- Provider-specific security controls.

This is not a shared account selector, not a shared credential refresher, not a shared proxy, and not a shared persistence layer.

### Required Decision Areas

1. Shared behavioral contract versus shared runtime code

   Position B says shared behavioral contract is necessary but insufficient. The contract should be executable as a shared kernel for the state transitions most likely to create duplicate execution or wrong attribution. Runtime IO remains provider-native.

2. Warm-session affinity versus fresh-session quota placement

   Kernel should make this an explicit branch: warm affinity wins if still eligible; fresh sessions call adapter quota placement. Provider policy decides whether an affinity is serviceable, but the kernel ensures both balancers publish the chosen slot before awaits that can allow concurrent first requests to split.

3. Codex account-aware WebSocket continuity and safe SSE fallback

   Codex adapter must declare whether a transport mode can prove account continuity. Current Codex defaults balanced calls to SSE because only SSE exposes response headers for usage and 429 detection at `packages/codex-auth-balancer/extensions/pi/index.ts:610`. Kernel should encode "transport identity proven" as a precondition for reusable warm transport. WebSocket is allowed only when Codex can key the cache by account plus session, or otherwise prove the socket's credential matches the selected slot.

4. Codex replay metadata normalization without changing public saved-session identity

   Kernel should not touch persisted messages. Codex adapter should own normalization between public `bravo-codex-balanced` identity and upstream `openai-codex` replay checks. The kernel only records provider/public/upstream identifiers in attempt metadata so observability can explain the translation.

5. Claude connection reuse/TLS diagnosis and rollback-safe transport policy

   Claude adapter owns HTTPS agent policy. Today it disables keep-alive and TLS session caching at `packages/claude-auth-balancer/src/proxy.ts:466`, after observed TLS failures. Kernel should make this a transport policy version recorded per attempt, so a rollout can compare fresh-handshake versus reuse behavior without changing retry semantics.

6. Claude non-idempotent retry policy and bounded 429 handling

   Kernel should enforce the universal invariant: never rotate or replay after content. Claude adapter classifies pre-header transport failures using `isRetryableTransportError` at `packages/claude-auth-balancer/src/proxy.ts:83`. 429 handling at `packages/claude-auth-balancer/src/proxy.ts:762` becomes a kernel decision: wait same slot if bounded and affinity is valuable; otherwise rotate only before response content. The current unbounded `drain()` at `packages/claude-auth-balancer/src/proxy.ts:451` should become an adapter primitive with deadline and byte cap.

7. First-request concurrency and affinity publication

   Claude already learned to touch affinity at selection time before forwarding at `packages/claude-auth-balancer/src/proxy.ts:692`. Codex currently reads affinity before selection and writes after token preparation at `packages/codex-auth-balancer/src/index.ts:1732` and `packages/codex-auth-balancer/src/index.ts:1889`. Kernel should require reserve/publish-before-long-await with a provider-backed fence. Codex can implement that additively in SQLite; Claude can implement it in the daemon's file store or move affinity into its daemon-owned atomic section.

8. Durable, redacted per-attempt observability

   Codex already has reservations and launch events in SQLite at `packages/codex-auth-balancer/src/index.ts:595`. Claude has request metrics at `packages/claude-auth-balancer/src/metrics.ts:38`, but retry and hidden latency are partly log-only. Kernel should emit a durable `AttemptRecord` for every attempt: slot, session hash, model, endpoint, outcome, retry eligibility, transport policy version, duration, status, redacted reason, and whether content started.

9. Security limits for local proxy access and request buffering

   Kernel can define `body_buffered_bytes`, `body_truncated`, and `local_access_policy` fields, but Claude adapter owns enforcement. The proxy already buffers with `readBody(req)` at `packages/claude-auth-balancer/src/proxy.ts:566`; Position B requires a configured cap and a metric/outcome when exceeded.

10. Additive migration, staged rollout, rollback, validation

   The kernel should first run in shadow mode, computing decisions beside existing code and recording mismatches. Then enable only attempt telemetry vocabulary. Then move retry gating. Then move affinity publication sequencing. Codex SQLite changes must be additive because old and new processes share `balancer.sqlite3`; Claude can roll back by daemon restart and feature flag because it remains one daemon per state root.

### Repo Evidence

Codex already has an isolated pure rotation policy with `AttemptOutcome` and `runWithRotation` at `packages/codex-auth-balancer/extensions/pi/rotation-policy.ts:9` and `packages/codex-auth-balancer/extensions/pi/rotation-policy.ts:95`. That is a prototype of the kernel, but too narrow.

Codex lease/reservation state is durable and transactional with `BEGIN IMMEDIATE` and reservation tables at `packages/codex-auth-balancer/src/index.ts:595` and `packages/codex-auth-balancer/src/index.ts:1237`.

Claude has analogous affinity and attempt concepts, but embedded in proxy flow: session leases at `packages/claude-auth-balancer/src/affinity.ts:18`, affinity lookup at `packages/claude-auth-balancer/src/proxy.ts:587`, pre-header retry classification at `packages/claude-auth-balancer/src/proxy.ts:712`, and durable request metrics at `packages/claude-auth-balancer/src/proxy.ts:802`.

### Tradeoffs

Position B adds an abstraction boundary and requires careful adapter design. Done badly, it becomes the exact dishonest shared runtime the brief forbids. The line has to be policed hard: no shared transport, no shared credential code, no shared storage implementation, no shared quota scorer.

The payoff is that the most dangerous invariants become one tested mechanism instead of two hand-maintained interpretations. That matters because the failure modes are expensive: wrong account attribution, duplicated upstream generations, cache destruction, and missing observability.

### Migration and Rollback

Start with a no-op kernel in both packages that only classifies existing attempts and records normalized shadow telemetry. Add Codex tables/columns additively; do not change existing reservation semantics in the first stage. For Claude, add a new metrics table or additive columns rather than rewriting the current `requests` table.

Next, move retry eligibility decisions into the kernel while adapters still perform the same wire actions. Then move affinity publication sequencing behind provider-specific fences. Finally, enable Codex account-aware WebSocket only after the adapter can prove transport identity; until then SSE remains the safe default.

Rollback is straightforward if each stage is feature-flagged: disable kernel-driven decisions and leave shadow telemetry in place. Additive storage remains readable by old code.

### Strongest Objection to Position B

The strongest objection is that "shared state machine" may be a polite name for shared runtime gravity. The two balancers are genuinely unlike: Codex is an in-process Pi provider with SQLite fleet state; Claude is a daemonized HTTP gateway preserving request bodies. A kernel that starts needing provider exceptions in every transition will become worse than duplication: it will hide provider-specific truth behind abstract names.

My answer is that Position B only wins if the kernel is small, pure, and ruthless about adapter ownership. If the implementation cannot keep that line, Position A is safer.

## Round 2

### Rebuttal to Position A

Position A's strongest claim is correct about one thing: a common lifecycle kernel that pretends SQLite fleet coordination and a singleton HTTP proxy are the same thing would lie. Codex has shared SQLite state across long-lived resident processes. Claude has one daemon per state root and can rely on in-process atomicity for parts of the routing path. A shared lock manager, shared lease store, shared selector, or shared account runtime would be the wrong abstraction.

But that is not an argument against a shared state machine. It is an argument against putting storage and provider mechanics inside the state machine.

The concrete drift already exists. Codex has an isolated `AttemptOutcome` and rotation runner; Claude has similar concepts embedded in proxy code. Claude publishes affinity before forwarding because concurrent first requests split cache placement if lease publication waits. Codex still reads affinity before reservation and writes it after token preparation. Contract tests can catch a known divergence after someone writes the test; they do not force both implementations through the same sequencing when a new path appears.

The high-risk rules are not provider-specific:

- Do not switch accounts after content reaches the client.
- Do not treat credential acquisition failure as quota exhaustion.
- Do not cooldown an account for auth rejection.
- Do not publish affinity after a long async gap on first request.
- Do not record only the final request when hidden attempts happened.
- Do not let a short retry wait become an unbounded client hang.

Those are state-transition rules. They deserve executable ownership. The provider adapters can still decide what "content started" means, what "pre-header" means, how a reservation is fenced, whether 429 claims are trustworthy, and how durable telemetry is persisted.

Position A's contract-test strategy should be accepted, but as a guardrail around the kernel and adapters, not as the only mechanism. Contract tests are excellent for provider-native scenarios: Codex SSE fallback, Codex WebSocket identity proof, Claude header/body preservation, Claude local proxy limits, and provider refresh behavior. They are weaker as the primary defense against duplicated lifecycle code because they ask two separate implementations to remember the same dangerous ordering forever.

### Rebuttal to Position C

Position C is right to be hostile to ambiguous replay. The brief's non-negotiable invariant is absolute: never switch accounts or replay after response content has reached the client. It is also right that visible failure beats hidden duplicate execution or false attribution.

Where Position C overcorrects is treating all retry and rotation classification as suspect. Some failures are not ambiguous in the way that matters:

- A 429 before response content can be handled without duplicating streamed content.
- A same-account pre-header connection break can be retried without changing attribution, provided the provider adapter classifies it narrowly and excludes header timeout.
- A credential preparation failure before wire send can rotate without upstream execution.
- An auth rejection before content can quarantine or skip a slot without charging a second generation.

The current Claude code already makes these distinctions with `isRetryableTransportError`, `TRANSPORT_RETRY_LIMIT`, and 429 rotation/wait logic. The current Codex code already distinguishes `rate-limited`, `lease-failed`, `auth-rejected`, `streamed-error`, and `other-error`. Position C would throw away valid, operationally important recovery paths because the abstraction might be abused.

The better answer is to make ambiguity terminal inside the kernel. The kernel should not encode optimistic retry categories; it should encode conservative gates:

- `content_started = true` always means terminal.
- `wire_started_but_no_headers` is terminal unless the adapter proves same-slot retry safety.
- Header timeout is terminal by default.
- Account rotation is allowed only for pre-content outcomes explicitly classified as non-executing or pre-content rate limit.
- Any missing classifier field falls to terminal visible failure.

That hybrid keeps Position C's safety bias while preserving useful recovery for cases with evidence.

### Concessions and Hybrid Elements

I would accept three Position A constraints:

- The shared kernel must be pure and must not own persistence, credential refresh, quota scoring, HTTP proxying, Pi provider calls, or transport selection.
- Provider contract tests are mandatory and should be more numerous than kernel unit tests.
- If the kernel starts accumulating provider-specific branches, it should be deleted or split before it becomes a dishonest abstraction.

I would accept three Position C constraints:

- Ambiguous replay is terminal by default.
- Rotation after any client-visible content is impossible, not configurable.
- Transport retry classifications must be provider adapter evidence, not generic string matching.

I would also accept a staged version of Position B where the first extracted shared code is narrower than the full lifecycle: outcome vocabulary, retry gate, attempt record schema, and affinity publication ordering. Slot selection and credential preparation can remain callback-only indefinitely.

### Final Recommendation

Adopt Position B with hard boundaries: extract a shared affinity and attempt-state kernel, but keep every provider-specific runtime surface in adapters. Do not extract account selection, credential refresh, persistence, proxying, request forwarding, quota parsing, or transport code.

The kernel should own only the invariants that must not drift:

- warm affinity versus fresh placement sequencing;
- fenced first-request affinity publication;
- attempt lifecycle;
- retry/rotation eligibility;
- "content started means terminal";
- bounded wait decisions;
- normalized redacted per-attempt telemetry.

Implement it in stages:

1. Add shared types and shadow classification only.
2. Add durable attempt telemetry through provider adapters.
3. Move retry/rotation gating into the kernel.
4. Move affinity publication sequencing into the kernel via provider fences.
5. Re-evaluate Codex WebSocket only after account-aware transport identity is proven.

This accepts Position A's warning against runtime gravity and Position C's bias toward visible failure on ambiguous replay. But it rejects duplicating the dangerous state machine in two places. The shared code should be small enough to audit in one sitting and boring enough that provider-specific code never has to pretend it is something else.
