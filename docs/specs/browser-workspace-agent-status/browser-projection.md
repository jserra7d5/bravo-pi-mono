# Browser Registry and First Projection

## Service integration

Extend `runServe()` in `packages/browser-workspace/src/serve.ts` so the status socket/registry is owned by the same launcher as `WorkspaceUiServer` and ttyd:

```text
start ttyd -> start status socket -> start HTTP UI -> ready
shutdown HTTP -> status socket -> ttyd
```

If the status socket cannot be securely established, service startup fails. Do not run an unadvertised degraded mode that invites clients to assume reporting works.

Likely implementation areas:

- new `packages/browser-workspace/src/agent-status-protocol.ts`: exact schema/framing types and validation;
- new `packages/browser-workspace/src/agent-status-registry.ts`: lease, sequence, takeover, monotonic expiry;
- new `packages/browser-workspace/src/agent-status-server.ts`: socket lifecycle, peer auth, exact tmux binding;
- `packages/browser-workspace/src/contracts.ts` and `src/config.ts`: versioned socket configuration if default-only is insufficient;
- `packages/browser-workspace/src/serve.ts`: lifecycle wiring;
- `packages/browser-workspace/src/workspace-ui.ts`: read projection and card rendering;
- focused tests under `packages/browser-workspace/test/`.

Keep components separable; do not grow the already inline `workspaceHtml` with registry/protocol logic.

## HTTP projection

Extend the existing exact endpoint rather than adding a browser mutation path:

```http
GET /api/session/:workspaceId
```

Response while live and lease valid:

```json
{"live":true,"async":{"runningCount":2}}
```

Response for zero, unknown, expired, invalid, or no report:

```json
{"live":true}
```

A stale tmux session remains:

```json
{"live":false}
```

Do not expose `piSessionId`, `rootSessionId`, reporter instance, sequence, TTL timestamps, socket path, or reason-for-unknown to the browser. Set `Cache-Control: no-store` on session projection responses.

The registry lookup must first verify the card's exact live tmux session ID still equals the lease's bound session ID. If the tmux session died or was recreated, evict/ignore the lease immediately rather than waiting for TTL.

## Card rendering

In the existing `workspaceHtml` `render()` path:

- read `status.data.async?.runningCount` with strict finite positive-integer handling;
- render a small muted count element inside the primary workspace button, separate from `textContent` used for the name;
- omit it for zero/missing/invalid data;
- preserve `(stale)` behavior and existing rename/forget controls;
- add an accessible label/title such as `2 running async subagents` without adding taxonomy or alert styling.

The API is already fetched once per workspace during `render()`, including positive counts for inactive cards. Add bounded periodic status refresh (recommended 2 seconds, one timer for the page, no overlapping renders) so heartbeat transitions appear without user interaction. Reuse/update existing DOM rows where practical so refreshing counts does not recreate iframes or disturb terminal focus. If a clean incremental render cannot be achieved in the current inline UI, first extract a testable status-refresh/card renderer rather than layering reentrant `render()` calls.

On HTTP failure, keep terminal iframe/transport behavior unchanged and remove/omit the count. Never retain the previous positive count after a failed or malformed status read.

## Quietness and accessibility

- Positive count: muted, compact, no animation, no red/amber urgency.
- Zero/unknown: no placeholder and no layout-reserved badge.
- Stale workspace: stale text remains the primary state; async count is absent.
- Count is descriptive only, not clickable and not a control.

## Configuration

Prefer a deterministic default socket path derived from `XDG_RUNTIME_DIR`. If configuration is added, bump browser-workspace config schema rather than accepting a silent unknown v1 key; update strict `TOP` parsing in `src/config.ts`. Do not expose the socket through Tailscale or browser HTTP.

The async-subagents client discovers the default path from the same documented convention or an explicit process environment override for host deployment. It must not read browser-workspace config as a coupling shortcut.