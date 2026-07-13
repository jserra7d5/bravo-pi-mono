# Architecture, Ownership, and Evolution

## Semantic ownership

| Concern | Current/target owner | First-slice action |
|---|---|---|
| Async child lifecycle and dead-process reconciliation | `@bravo/async-subagents`, especially `extensions/pi/liveWidget.ts` over `RunStore`/watcher read models | Reuse and extract a count projection; do not reimplement in browser-workspace. |
| Lead/root Pi identity | Pi extension `piSessionIdOf` + `ensureRoot`; persisted model in `src/rootSession.ts` | Report both `piSessionId` and `rootSessionId`. |
| Exact browser workspace identity | browser-workspace `bw-*` tmux session identity in `src/workspace-ui.ts` | Validate report binding against the live exact tmux session. |
| Lease registry and expiry | browser-workspace daemon | New in-memory registry; never persisted. |
| Workspace-card rendering | browser-workspace `workspaceHtml`/`render()` | Add quiet positive-count projection. |
| Terminal lifetime | existing tmux/ttyd paths | Unchanged. |

This change **reuses** the lifecycle owner and adds a projection. It must not copy state lists or reconstruct child meaning in browser-workspace. The only browser-side semantic operation is lease validity; the received `runningCount` is opaque except for schema/range checks.

The current `deriveAsyncSubagentsActivityState()` is not the first-slice count owner because its “active” definition includes blocked, paused, idle, queued/stalled, and unhandled result-ready rows. Add a sibling async-subagents projection (for example `readRunningSubagentCount`) backed by the same snapshot and dead-process reconciliation. If extracting shared snapshot preparation is necessary, move/reuse that logic rather than duplicate it. Keep the existing Pi widget/Herdr behavior unchanged.

## Runtime shape

```text
browser-workspace supervised launcher
  ├─ owns loopback HTTP UI
  ├─ owns internal ttyd
  ├─ owns $XDG_RUNTIME_DIR/.../status.sock (0600 access boundary)
  └─ owns in-memory Map<workspaceId, lead-session lease>

exact bw-* tmux session
  └─ lead Pi process
       └─ async-subagents Pi extension
            ├─ computes canonical running count for exact rootSessionId
            └─ heartbeats report to status.sock
```

## Why push over Unix socket

- The producer already owns lifecycle interpretation.
- Socket availability is an explicit supervised-service boundary.
- Files do not become an accidental shared protocol.
- TTL makes producer/service crashes fail quiet.
- The boundary can evolve from one count to richer semantic projections without changing terminal substrate.

Do not add HTTP loopback reporting, browser-origin mutation routes, filesystem polling, stdout markers, or pane scraping as fallback paths.

## Identity acquisition

The reporter must derive workspace identity from tmux's control context, not cwd, browser localStorage, or a user-provided label:

- require `TMUX` to identify a tmux server socket;
- query tmux for the current client/pane's exact session name and immutable session ID;
- require name to match `bw-[a-f0-9]{24}`;
- report socket identity plus session name and tmux session ID;
- include `piSessionId` from Pi's session manager and `rootSessionId` from `ensureRoot`.

The receiver validates the reported workspace name/session ID against its configured private tmux namespace. A client cannot bind by merely claiming a valid-looking `bw-*` string.

## Evolution path

First slice keeps the protocol envelope extensible but projection-specific. Later, by separate specs:

1. browser-workspace daemon can own a canonical registry of interactive terminals and reported agent sessions;
2. lifecycle reporters can publish versioned semantic state and parent/child ownership edges;
3. daemon can map semantic sessions/runs to exact tmux-backed interactive terminals;
4. browser can project management/ownership trees and then add explicit controls.

The lead Pi session remains authoritative for its composite state. A future daemon may normalize/report it but must not infer it from async-subagent storage. Keep tmux/ttyd until a separately justified substrate migration.

Herdr reference lesson: one server owns live process/session projections and integrations report metadata through a socket; clients consume server snapshots. Do not copy Herdr's five-state taxonomy into this count-only slice.