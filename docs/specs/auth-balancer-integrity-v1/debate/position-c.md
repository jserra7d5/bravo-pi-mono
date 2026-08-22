# Position C: Maximize transport fidelity, minimize balancer intervention

## Round 1

### Thesis

The redesign should treat provider-native transport identity, account binding, and non-idempotence as harder requirements than availability or quota smoothing. If the balancer cannot prove which account carried a request, whether upstream work already started, or whether replayed metadata remains semantically native, it must stop intervening and surface a visible failure.

This means fewer retries, fewer account rotations, and less balancing under ambiguity. That is the right tradeoff because the current failure modes are not merely suboptimal routing. They are identity and idempotence violations. A balancer that lies to its own metrics, replays non-idempotent generations, or changes transport semantics without proof is worse than a balancer that sometimes says no.

### Concrete design

Adopt a shared vocabulary and contract tests, but no shared runtime kernel. The shared contract should define outcomes such as:

- account identity proven
- affinity pinned
- native transport preserved
- degraded transport selected
- replay prohibited
- retry prohibited
- retry same account
- rotation prohibited
- quota exhausted
- local proxy rejected
- attribution unknown
- observability partial

Each provider implements those terms independently.

For Codex:

- Keep the in-process Pi provider wrapper.
- Use provider-native `auto` only when the transport cache key is account-aware: `(provider, model, sessionId, slot/accountIdHash)` or an upstream-supported equivalent.
- Until that exists, disable balanced WebSocket for multi-account use. Do not let a session-scoped WebSocket created under slot A carry a request attributed to slot B.
- Permit SSE only as an explicit, recorded degraded path because it makes account attribution and response headers observable, but it is not equivalent to Pi's native default.
- Never rotate accounts inside an existing Codex Responses session unless the session's upstream state is proven account-independent. Treat `previous_response_id` and related state as account-bound.
- Keep public saved-session provider identity as `bravo-codex-balanced`, but normalize outbound replay metadata only through a tested compatibility path. If Pi would treat reasoning or tool-call metadata as foreign, fail closed or require a session migration instead of silently doing lossy replay through `openai-codex`.
- Move affinity publication before any async refresh, probe, or transport setup that can race with another first request.

For Claude:

- Keep the local gateway because there is no verified Claude Code credential-selection seam.
- Make transport policy conservative by default: no cross-account retry for `/v1/messages`; no same-account retry after a request has been fully written unless there is a stronger upstream idempotency signal than "no headers reached the client."
- 429 handling should not hide the 429 by default. A short wait on the same warm account is acceptable only with bounded body drain and a clear deadline. Cross-account 429 rotation is off unless the request is verified read-only or idempotent.
- Re-enable native-like connection behavior only after TLS diagnosis proves the proxy is not causing corruption. Until then, disabled keep-alive and disabled TLS session caching are quarantine mode, not the desired design.
- Add request body caps and local access constraints. Loopback is necessary but insufficient; same-host quota spending is still real.

### Required decision areas

1. Shared behavioral contract versus shared runtime code

Position C chooses a shared behavioral contract only. A shared runtime abstraction would be dishonest because Codex is an in-process Pi provider while Claude is an HTTP gateway. The common layer should be names, invariants, and fixtures, not selection, lease, proxy, or refresh machinery.

2. Warm-session affinity versus fresh-session quota placement

Warm session affinity wins over balancing. Fresh sessions may be placed by quota, but once upstream state or prompt cache exists, movement requires proof that moving will not lose cache, break account-bound state, or duplicate work. If proof is absent, the session stays pinned or fails visibly.

3. Codex account-aware WebSocket continuity and safe SSE fallback

Balanced WebSocket is disabled until the WebSocket cache key includes account identity or Pi exposes an account-aware transport seam. SSE is allowed only as a degraded, observable fallback selected before session state exists. Do not switch a live session between WebSocket and SSE opportunistically.

4. Codex replay metadata normalization without changing public saved-session identity

Keep saved sessions branded `bravo-codex-balanced`, but normalize metadata at dispatch only when tests prove native Codex reasoning and tool-call metadata survive intact. If Pi's same-provider checks treat restored balanced messages as foreign, the answer is a hard failure plus a targeted migration or upstream metadata seam, not negative prompt guidance or a broad compatibility wrapper.

5. Claude connection reuse/TLS diagnosis and rollback-safe transport policy

The current no-keep-alive/no-TLS-cache policy is acceptable as quarantine, not as the target. Run an A/B diagnostic mode with durable attempt telemetry. Roll forward only if native-like reuse has no MAC failures; rollback by flipping the transport policy back to fresh handshakes.

6. Claude non-idempotent retry policy and bounded 429 handling

Default: no replay of `/v1/messages` after bytes are written upstream. Pre-header is not enough proof because upstream may already be generating. Same-account retry should require an idempotency key or a lower-level proof that the request was not accepted. 429 drains must be bounded by time and bytes; otherwise the balancer can hang the client.

7. First-request concurrency and affinity publication for both runtimes

Publish affinity atomically before async usage probes and refreshes can let two concurrent first requests split. Claude already has a selection-time touch in-process; Codex has SQLite `BEGIN IMMEDIATE` reservation, but its session affinity must be published as part of that reservation path, not after token prep or transport setup.

8. Durable, redacted per-attempt observability and outcome vocabulary

Record every attempt, not just final requests: selected slot, transport mode, retry eligibility reason, rotation prohibition reason, response/header timing, 429 handling, and redacted outcome. No tokens, auth headers, or bodies. Claude's current metrics are request-level; Position C needs attempt-level rows.

9. Security limits for local proxy access and request buffering

Keep origin-form validation and loopback binding, but add explicit body-size limits and consider a local launcher token or Unix socket mode. The README already says anything reaching the port can spend quota; that is not a footnote, it is a security boundary.

10. Additive migration, staged rollout, rollback, and end-to-end validation

Use additive schema only for Codex SQLite. Stage as:

- observe-only attempt telemetry
- conservative policy flags available but off
- disable unsafe replay and rotation paths
- enable account-aware WebSocket only after contract tests pass
- restore Claude connection reuse only after TLS proof

Rollback is policy-level: disable account-aware WebSocket, force Codex SSE degraded mode or fail closed, disable Claude retry and rotation, and return Claude to fresh handshakes.

### Repo evidence

Codex currently rebrands the public provider and calls upstream as `openai-codex`: `packages/codex-auth-balancer/extensions/pi/index.ts:37` and `packages/codex-auth-balancer/extensions/pi/index.ts:604`.

Codex currently defaults balanced requests to SSE because only SSE exposes response headers for usage and 429 handling: `packages/codex-auth-balancer/extensions/pi/index.ts:607`.

Codex provider registration depends on a process-global Pi override that can be dropped by reload and must be reasserted: `packages/codex-auth-balancer/extensions/pi/index.ts:788`.

The Codex design already says `previous_response_id` may be account-bound and that missing stable session affinity should stop live rollout: `docs/specs/codex-balanced-provider/design.md:115` and `docs/specs/codex-balanced-provider/implementation-plan.md:214`.

Claude currently retries selected pre-header transport failures on the same account: `packages/claude-auth-balancer/src/proxy.ts:47`.

Claude disables keep-alive and TLS session caching for every inference attempt: `packages/claude-auth-balancer/src/proxy.ts:462`.

Claude currently defaults `retryOnRateLimit` to true and can rotate on 429: `packages/claude-auth-balancer/src/proxy.ts:156`, `packages/claude-auth-balancer/src/proxy.ts:184`, and `packages/claude-auth-balancer/src/proxy.ts:760`.

Claude drains 429 response bodies without a deadline in `drain`: `packages/claude-auth-balancer/src/proxy.ts:451`.

Claude pins affinity at selection time, which is directionally right for this position: `packages/claude-auth-balancer/src/proxy.ts:685`.

Claude's README confirms the proxy is not native transport: no keep-alive/TLS cache, no body rewrites, loopback with no proxy auth: `packages/claude-auth-balancer/README.md:290`, `packages/claude-auth-balancer/README.md:310`, and `packages/claude-auth-balancer/README.md:329`.

### Tradeoffs

This position will produce more visible 429s, more 502s, and less quota smoothing. It may waste available quota on other accounts while preserving a warm session on a nearly exhausted account. Codex users may lose balanced WebSocket benefits until Pi exposes an account-aware cache seam. Claude users may see failures that the current proxy hides.

That is intentional. The alternative is a balancer that improves apparent reliability by taking actions it cannot prove are identity-preserving or idempotent.

### Migration and rollback

Migration is additive and policy-gated. Add attempt telemetry first. Then introduce conservative defaults behind config flags. Flip Codex unsafe WebSocket and replay behavior to fail closed only after the error messages and validation commands exist. Flip Claude cross-account retry off first because rollback is trivial: re-enable the old policy flag if the visible failure rate is unacceptable.

Validation needs contract tests plus local socket tests:

- Codex: same session cannot use different slots under WebSocket; SSE degradation is recorded; restored balanced sessions preserve reasoning/tool metadata or fail closed.
- Claude: no retry after upstream accept uncertainty; 429 drain has time/body bounds; local proxy rejects absolute-form targets before credential selection; every attempt has durable redacted telemetry.

### Strongest objection to Position C

The strongest objection is that it sacrifices the main practical value of the balancers: keeping long-running coding sessions alive under flaky TLS and subscription rate limits. The current Claude retry path was added because real users saw hard 502s, and the README documents a measurable failure rate. Turning those into visible failures is operationally painful.

My answer: painful visible failure is still preferable to hidden duplicate generation or false attribution. Once upstream exposes idempotency keys, account-aware Codex transport cache keys, or a Claude credential-selection seam, Position C can relax. Until then, the balancer should not fake certainty it does not have.

## Round 2

### Rebuttal to Position A

Position A's strongest claim is that strict failure undermines the practical purpose of both balancers. A balancer that refuses rotation on 429, disables ambiguous retries, and downgrades or rejects transport modes may protect theoretical integrity while users still hit the same hard stops the balancers were built to avoid. A also argues that provider-native implementations plus contract tests can keep soft affinity and narrowly classified retries without forcing Claude and Codex into a false shared runtime.

I concede two parts of that.

First, Position A is right that a shared runtime would be the wrong abstraction. Codex and Claude are unlike systems. The Codex package lives inside Pi's provider stack; the Claude package is a local HTTP gateway. The common artifact should not be a reusable credential, lease, proxy, or selection engine.

Second, A is right that some intervention is legitimate when the proof is strong enough. A same-account retry with an upstream idempotency key would be fine. A 429 wait on the same warm account is fine if the drain is bounded and no content has reached the client. A soft affinity preference for a fresh session is fine when there is no account-bound upstream state yet.

The disagreement is where the burden of proof sits. A treats narrow classification plus tests as enough to keep user-visible availability behavior. Position C says classification must prove the upstream semantic fact, not just the local observation. "No response headers reached Claude Code" does not prove Anthropic did not accept and start the generation. "SSE exposes headers" does not prove it is equivalent to Pi's native Codex transport. "Same provider API" does not prove replayed reasoning and tool-call metadata remain native after public provider rebadging.

The balancers' practical purpose is not simply "avoid user-visible failures." Their legitimate purpose is personal account selection without false attribution, duplicate execution, credential leakage, or cache/session corruption. If preserving availability requires pretending those are solved before the seams exist, then availability is being bought with hidden integrity debt.

So my A-compatible hybrid is narrow:

- Keep provider-native implementations and shared contract tests.
- Keep soft affinity only for fresh placement or already-proven warm-account continuity.
- Keep same-account waits, not rotations, for bounded 429s.
- Keep retries only for endpoints proven idempotent or protected by upstream idempotency.
- Record every suppressed intervention as a durable outcome, so the operator can see that the balancer chose fidelity over availability.

That preserves A's implementation shape, but rejects A's willingness to keep narrowly classified retries when the classification does not prove upstream idempotence.

### Rebuttal to Position B

Position B's strongest claim is that prose and tests cannot stop semantic drift. If Claude and Codex each hand-roll attempt ordering, affinity publication, retry eligibility, and telemetry, the two packages will slowly diverge. A pure executable lifecycle kernel would force the same ordering and outcome vocabulary everywhere, with provider adapters supplying transport, quota, credentials, and storage.

I concede the problem. Semantic drift is real, and attempt ordering is not documentation fluff. If one implementation records an attempt before affinity publication and the other records it after refresh, the metrics become incomparable. If one implementation names "retry" as "same account after socket failure" and the other means "different account after 429," the vocabulary is garbage.

But B's solution crosses the wrong boundary. The dangerous facts are provider-native and transport-specific:

- Codex account identity can be invalidated by a session-keyed WebSocket cache whose authorization was fixed when the connection opened.
- Claude retry safety depends on HTTP request acceptance, upstream generation semantics, response streaming, and the proxy's reconstructed headers.
- Codex replay compatibility depends on Pi's provider/API metadata conversion rules.
- Claude local security depends on request-target form, local bind mode, and request buffering.

A lifecycle kernel can standardize state transitions, but it cannot know whether a pre-header failure is idempotent, whether a WebSocket cache is account-aware, or whether rebadged Codex metadata is semantically native. If the kernel owns too much ordering, it will either encode provider-specific exceptions until it becomes a fake shared runtime, or it will hide the most important provider facts behind adapter booleans with names like `canRetry`, which is just prose in code.

The B-compatible hybrid I would accept is an executable vocabulary package, not an executable lifecycle kernel:

- shared TypeScript enums or literal types for outcomes and phases
- shared redaction helpers
- shared contract-test fixtures that each provider must run against its own implementation
- shared telemetry shape validators
- no shared account selection
- no shared retry state machine
- no shared lease publication path
- no shared proxy or credential refresh code

That gives B the anti-drift guardrails without making a common runtime responsible for facts only the provider implementation can prove.

### Final recommendation

Ship a fidelity-first redesign with Position A's provider-native implementation boundary and a small subset of Position B's executable vocabulary, but keep Position C's conservative policy defaults.

Concretely:

- Define shared outcome names, attempt phases, redaction rules, and contract fixtures.
- Implement Codex and Claude independently.
- Disable any Codex balanced WebSocket path that is not account-aware.
- Treat Codex SSE as an explicit degraded transport, not a silent equivalent.
- Preserve `bravo-codex-balanced` saved-session identity, but fail closed on replay metadata that Pi would treat as foreign.
- Disable Claude cross-account retry for non-idempotent generation requests.
- Allow bounded same-account 429 waits, not unbounded drains or hidden rotations.
- Add durable per-attempt telemetry before flipping stricter behavior on by default.
- Add explicit local proxy body limits and stronger local access posture.
- Roll out with additive migrations and policy flags so rollback is a config change, not a schema recovery.

The decision should flip away from Position C only if upstream seams appear: Codex exposes account-aware transport cache keys or credential-bound session handles, and Claude exposes idempotency or native account-selection in Claude Code. Until then, visible failure is the honest failure mode.
