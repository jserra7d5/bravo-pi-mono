# Auth Balancer Integrity v1 — Debate Brief

## Question

How should the Claude and Codex subscription-auth balancers be redesigned so that session affinity, provider-native transport behavior, retry safety, attribution, and observability are correct without forcing unlike provider systems into a dishonest shared runtime abstraction?

## Context

Both packages distribute one user's own authenticated subscription traffic across that user's configured accounts. They do not expose generated API keys, bill third parties, or pool subscriptions across users. Their runtime architectures are nevertheless very different:

- Codex is an in-process Pi provider wrapper. It leases a credential, calls Pi's native `openai-codex-responses` implementation, and shares live SQLite state across long-lived processes.
- Claude is a single local HTTP daemon selected through `ANTHROPIC_BASE_URL`. It buffers each request body, injects one account's bearer token, re-originates the HTTPS request, and persists affinity separately from request metrics.

The design must preserve those provider-specific boundaries while making both systems obey a common safety vocabulary.

## Established Evidence

### Codex

- The balanced provider defaults to SSE while normal Pi defaults to `auto` and attempts WebSocket first.
- Pi's Codex WebSocket cache is keyed by session, while authorization and account headers are fixed when the connection opens. Selecting a different slot without an account-aware transport key can make balancer attribution disagree with the account that actually carries the request.
- Persisted balanced assistant messages are branded `bravo-codex-balanced`, then replayed through `openai-codex`. Pi's same-provider/model checks can therefore treat native Codex reasoning and tool-call metadata as foreign on later turns.
- Affinity is read before selection and written to a file after reservation/token preparation. Concurrent first requests can independently select different slots.
- Rate-limit cooldown is process-local even though account selection is fleet-wide through shared SQLite.
- One `expires_at` value currently conflates reservation/lease expiry with token and affinity lifetime.

### Claude

- Request body bytes are preserved, but raw headers are semantically reconstructed by Node; the proxy is not byte-for-byte at the HTTP-message level.
- Inference forwarding deliberately disables keep-alive and TLS session caching after observed TLS failures inside the balancer. This differs from direct Claude Code networking and pays a handshake on every attempt.
- A request can be fully written upstream and then fail before response headers. Retrying such a generation may duplicate upstream work even though no response reached the client.
- Waiting or rotating after a 429 drains the response body without a deadline; a malformed or endless 429 body can hang the client.
- The first affinity lease is touched after asynchronous usage probes and credential refresh, so concurrent first requests are not serialized across the full selection path.
- Successful retries and rotations are mostly log-only; durable metrics do not reconstruct every attempt or its hidden latency.
- Loopback plus request-target validation prevents remote-origin credential exfiltration, but any same-host process that reaches the port can spend quota. Bodies are buffered without an explicit cap.

## Non-Negotiable Constraints

- Keep Codex in-process and preserve Pi's native provider implementation; do not introduce a Codex HTTP proxy.
- Keep Claude's body-preserving local gateway unless a verified client credential-selection seam removes the need for it.
- Never fall back to global/default client authentication.
- Never log or persist access tokens, refresh tokens, authorization headers, or full sensitive request bodies.
- Never switch accounts or replay after response content has reached the client.
- OpenAI refresh tokens remain single-use/rotating credentials; Anthropic refresh semantics remain provider-specific.
- Codex SQLite changes must be additive and safe while old and new resident processes share the database.
- Claude remains one daemon per state root unless the design explicitly replaces its in-process atomicity guarantees.
- Do not extract a shared account-selection, credential-refresh, persistence, proxy, or lease runtime merely to remove duplication.

## Required Decision Areas

1. Shared behavioral contract versus shared runtime code.
2. Warm-session affinity versus fresh-session quota placement.
3. Codex account-aware WebSocket continuity and safe SSE fallback.
4. Codex replay metadata normalization without changing public saved-session identity.
5. Claude connection reuse/TLS diagnosis and a rollback-safe transport policy.
6. Claude non-idempotent retry policy and bounded 429 handling.
7. First-request concurrency and affinity publication for both runtimes.
8. Durable, redacted per-attempt observability and outcome vocabulary.
9. Security limits for local proxy access and request buffering.
10. Additive migration, staged rollout, rollback, and end-to-end validation.

## Positions

### Position A — Shared contract, provider-native implementations

Define common invariants, outcome names, and contract-test scenarios. Implement them independently inside each package. Add only tiny shared pure types/helpers later if two proven implementations remain identical.

### Position B — Shared affinity and attempt-state kernel

Extract a common state machine for affinity, retry eligibility, outcomes, and attempt telemetry, with provider adapters for transport, quota, credentials, and storage.

### Position C — Maximize transport fidelity, minimize balancer intervention

Treat native network/session behavior as the primary invariant. Remove or disable any replay, rotation, or transport mode that cannot prove account identity and idempotence; accept more client-visible failures and less aggressive balancing until upstream seams exist.

## Evaluation Criteria

- Correct account attribution and session continuity
- Provider-native wire and cache fidelity
- Duplicate-execution and duplicate-billing risk
- Credential and local-security safety
- Cross-process correctness
- Operational observability and diagnosability
- Migration and rollback safety
- Complexity, testability, and long-term ownership
- Ability to distinguish legitimate personal load balancing from third-party subscription resale behavior without spoofing or evasive fingerprinting
