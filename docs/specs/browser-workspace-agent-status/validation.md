# Runtime Invariants and Faithful Validation

This boundary follows the Joe Method: each invariant needs the real code path, a faithful seam, and an injected failure. Pure schema tests, direct registry mutation, HTML regex checks, or fake counts alone are insufficient for the integration claim.

## Primary runtime invariant

```text
A positive number rendered on card W equals the canonical count of exact-state
`running` async-subagent rows owned by lead Pi session P in the currently live,
exact tmux session W, and disappears no later than the accepted TTL after P
stops reporting.
```

## Required lanes

| Check | Invariant proved | Faithful seam / evidence | Required fault or edge |
|---|---|---|---|
| Count property test | Reporter semantics are exactly `RunState === running`; presentation/result semantics cannot enter the count. | Real `RunStore` + watcher/reconciliation + new exported count projection, with generated/matrix rows over every current `RunState`. | Dead PID recorded as running; blocked, paused, idle, queued, stalled, and unhandled result-ready rows all count zero. |
| Protocol parser test | Only bounded, exact v1 messages enter the registry. | Real socket framing/parser, not direct object construction. | Oversize/no newline/double frame/unknown key/unsafe integer/TTL out of range/version mismatch. |
| Registry clock test | Sequence is monotonic per reporter instance and expiration is fail-quiet. | Real registry with injected monotonic clock. | Duplicate/out-of-order sequence, old instance after takeover, different lead conflict, wall-clock jump, expiry boundary. |
| Exact tmux binding test | A valid-looking report cannot affect another workspace or a recreated session. | Real temporary browser-workspace tmux namespace; server executes production exact-binding query. | Report A as B; wrong socket path; wrong immutable session ID; kill/recreate same name; prefix-like session name. |
| Unix socket test (Linux) | Only the supervised owner-restricted socket path is used and startup cleanup is safe. | Real AF_UNIX listener at a temporary uid-owned runtime directory with production permission/path checks. | Live socket collision, stale socket recovery, regular file/symlink at path, and permissive parent directory. |
| Reporter scheduling test | Fresh snapshots heartbeat and the latest state wins without blocking Pi. | Register the real Pi extension in a fake Pi context, drive `session_start`, production poll clock, mutation callback, and `session_shutdown`; connect to real production socket server. | Socket timeout/refusal, in-flight count 2 followed by zero, shutdown clear failure; verify next heartbeat recovers. |
| HTTP projection test | Browser receives only a positive fresh count for the exact still-live session. | Real `WorkspaceUiServer` endpoint backed by registry and real tmux session. | Lease expired between reports; tmux killed/recreated; malformed registry payload cannot leak identity; response is no-store. |
| Browser end-to-end lane | Exact card—not merely API JSON—shows and clears the count without disrupting ttyd iframe focus. | Extend Playwright/Chromium real local lane to run production browser service, two real `bw-*` sessions, and send reports through production Unix socket. | Cross-report identities, positive -> zero, stop heartbeat -> TTL expiry, kill/recreate session; assert card A only and terminal remains usable. |
| Service restart lane | In-memory state never survives service restart and tmux remains durable. | Start production launcher, accept positive report, restart launcher while keeping tmux, reload HTTP/browser. | Before new heartbeat count is absent; after heartbeat it returns to the exact card. |

## Self-verifying end-to-end scenario

The required integration harness should:

1. create an isolated runtime directory and real browser-workspace tmux namespace;
2. create workspace sessions A and B through the production HTTP `POST /api/session` path;
3. create canonical async-subagent run records under a temp root for lead session P: two `running`, one blocked, one result-ready terminal;
4. invoke the production async-subagents count/report path (not hand-authored JSON) from a process running inside tmux session A with Pi/root IDs P;
5. observe the report accepted by the production status socket and card A render `2`; card B must be quiet;
6. transition one canonical run to blocked and report; card A becomes `1`;
7. stop reports and advance/wait a short test TTL through injected clock where possible; card A becomes quiet;
8. send A's claim with B's session ID/name mismatch and prove neither card changes;
9. destroy/recreate A under the same name and prove the old reporter cannot repopulate it;
10. type a nonce into each ttyd terminal before/after status refresh to prove iframe/session fidelity.

Record accepted/rejected report codes, HTTP bodies, tmux identities, and browser assertions on failure. Use explicit process/tmux/browser timeouts and always clean temporary tmux namespaces/socket servers.

## Commands after implementation

```sh
timeout 120s npm run check --workspace @bravo/async-subagents
timeout 180s npm test --workspace @bravo/async-subagents
timeout 120s npm run check --workspace @bravo/browser-workspace
timeout 180s npm test --workspace @bravo/browser-workspace
```

The paid `smoke:live` is not required and must not substitute for the deterministic local socket/tmux/Chromium lane.

## Definition of done

- All lanes execute the named production seams; each has at least one failure assertion.
- No browser-workspace test fixture reads async-subagent files to produce server state.
- Tests prove properties across all current `RunState` values, not a single happy-path fixture.
- No positive count survives TTL, service restart, exact tmux identity loss, malformed response, or HTTP failure.
- Existing browser terminal identity/reload/stale/forget tests stay green.