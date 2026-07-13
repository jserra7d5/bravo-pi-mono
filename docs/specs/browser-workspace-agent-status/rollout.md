# Implementation, Rollout, Compatibility, and Stop/Replan Triggers

## Ordered implementation slices

### 1. Freeze semantics and expose the owner

1. In `packages/async-subagents/extensions/pi/liveWidget.ts` (or a focused sibling module), expose a canonical scoped snapshot/count path that reuses current watcher and dead-process reconciliation.
2. Count exact `running` only; add the all-`RunState` property/matrix and dead-PID test.
3. Do not change `AsyncSubagentsActivityState.activeCount`, Herdr metadata, widget counts, wakeups, or lifecycle schemas.

### 2. Build browser-workspace protocol and registry

1. Add exact v1 schema/framing and stable errors.
2. Add the monotonic in-memory lease registry with lead conflict, reporter takeover, and sequence rules.
3. Add bounded exact tmux identity lookup using the configured private namespace.
4. Add unit tests before service wiring.

### 3. Establish the secure socket seam

1. Implement status socket lifecycle, restrictive path handling, size/read deadlines, and owner-only directory/socket permissions.
2. Wire it into `runServe()` and service shutdown.
3. Add config schema/path only if the deterministic runtime default is insufficient.
4. Validate collision, stale socket, symlink/regular-file, and permissive-parent paths.

### 4. Add the lead Pi reporter

1. Add a browser-workspace-specific socket client/protocol module under `packages/async-subagents/extensions/pi/`.
2. Derive exact tmux session name/socket/session ID from the reporter process's tmux context.
3. Include exact Pi/root identities, random instance ID, monotonic sequence, count, and TTL.
4. Integrate immediate, 2-second heartbeat, mutation, and best-effort shutdown reporting using latest-pending/in-flight coalescing.
5. Keep failures opportunistic and rate-limited; never impact child lifecycle.

### 5. Project through HTTP and the card

1. Extend `GET /api/session/:id` with only fresh positive `async.runningCount`, `Cache-Control: no-store`, and exact bound-session revalidation.
2. Add quiet accessible card count rendering.
3. Add a single bounded non-overlapping refresh loop that does not recreate iframes or steal terminal focus.
4. Clear counts immediately on missing/malformed/failed responses.

### 6. Prove the integrated boundary

Implement the required real socket + real tmux + real HTTP + Chromium lane in [validation.md](validation.md), then run package checks/tests with explicit timeouts.

## Compatibility

- Additive HTTP response field; existing browser code ignores it.
- Existing localStorage schema remains `bravo-browser-workspaces-v1`; status is never stored.
- Existing tmux session names and ttyd URL/cookie binding remain unchanged.
- Existing config v1 remains valid if the socket path is convention-only. If a path key is required, introduce config schema v2 and an explicit migration; strict parser unknown-key behavior in `src/config.ts` must remain.
- Async-subagents without browser-workspace present continue normally; reports fail opportunistically.
- Browser-workspace without an active reporter renders exactly the current UI.
- Do not add protocol fallback or dual transport. Version mismatch is quiet in UI and diagnosable locally.

## Rollout

1. Land both package changes together; neither requires status persistence or data migration.
2. Build both packages before restarting `bravo-browser-workspace.service`.
3. Restart the browser-workspace user service; existing tmux sessions must survive.
4. Restart/reload lead Pi sessions to activate the reporter.
5. Observe locally: socket mode/owner, accepted heartbeat, exact card count, expiry after stopping Pi, and no count before fresh report after browser service restart.
6. Keep one release/slice count-only. Do not opportunistically expose blocked/result-ready labels already present in async-subagents.

Rollback is direct: revert reporter/socket/projection and restart the browser service. No persisted status cleanup is needed; tmux and browser localStorage remain compatible.

## Operational observability

Browser service logs (rate-limited):

- socket started/stopped and path (never payload identities at info level);
- accepted report counters;
- rejection counters by stable code;
- active lease count and expiry count;
- tmux identity-check failures;
- malformed/oversized request counts.

Reporter diagnostics (rate-limited/debug): report accepted, unavailable/timeout, not in exact browser workspace, and stable rejection code. Never log child/task content or full Pi/root IDs by default.

No metrics server, persistence, tracing backend, or browser diagnostics panel is added in this slice.

## Stop/replan triggers

Stop implementation and bring the decision back if any is true:

1. Owner-only runtime directory/socket permissions cannot be established reliably in the deployed user-service environment.
2. Pi's extension context cannot provide stable `piSessionId` for the lead session.
3. Reporter cannot faithfully derive and query the current exact tmux server/session identity from its process context.
4. Current async-subagents reconciliation cannot be reused without duplicating lifecycle logic; first refactor the semantic owner and prove parity.
5. Multiple lead Pi sessions in one `bw-*` workspace are a required live use case. The v1 single-unexpired-lead conflict rule then needs an explicit multi-lead product decision and card semantics.
6. A 7-second fail-quiet window is operationally unacceptable; choose heartbeat/TTL together and revalidate load/failure behavior rather than merely increasing TTL.
7. The browser UI cannot refresh card status without reentrant render races, iframe recreation, or focus loss. Extract a stateful renderer before shipping.
8. Product asks for blocked, result-ready, hierarchy, controls, persistence, non-Pi clients, or agent-to-terminal mappings in this slice. Write the next protocol/product module instead of broadening v1.

## Unresolved implementation decisions

These are intentionally explicit rather than hidden assumptions:

- **Socket caller boundary:** owner-only runtime directory and socket permissions are intentionally sufficient for this personal same-user service; no native peer-credential dependency.
- **Socket configuration:** accept the documented `XDG_RUNTIME_DIR` convention unless deployment evidence requires config v2 or an environment override in the systemd unit.
- **Card visual:** choose muted numeric badge versus muted `· N`; behavior/accessibility are fixed, pixels are not.
- **Test TTL:** production is 7 seconds; tests should inject a monotonic clock rather than slow every lane, while one real timer lane proves expiry scheduling.
- **Reporter tmux query:** choose exact command format that returns current session name, immutable session ID, and socket path without relying on locale-formatted `$TMUX` parsing alone.