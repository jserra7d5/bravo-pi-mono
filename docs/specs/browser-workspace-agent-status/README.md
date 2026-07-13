# Browser Workspace Agent Status Control Plane

Date: 2026-07-12  
Status: first slice implemented and deployed  
First slice: exact workspace-card projection of the lead Pi session's currently running async-subagent count

## Decision

Add a small push-based local status boundary:

```text
lead Pi async-subagents extension
  -> restrictive browser-workspace Unix socket
  -> validated in-memory lease registry
  -> existing /api/session/:bwId projection
  -> quiet count on that exact workspace card
```

`async-subagents` remains the semantic owner of child lifecycle and count derivation. `browser-workspace` owns workspace/tmux identity validation, lease expiry, and browser projection. The browser service must never inspect `.subagents` or other async-subagent files.

The first slice displays only a positive count of runs whose canonical async-subagents state is exactly `running`. Zero, unknown, stale, ambiguous, and unavailable are visually quiet. It does not display blocked, paused, queued, idle, stalled, result-ready, or terminal runs.

## Modules

1. [Product requirements and non-goals](product.md)
2. [Architecture, ownership, and evolution](architecture.md)
3. [Unix-socket protocol and exact binding](protocol.md)
4. [Async-subagents reporter semantics](reporter.md)
5. [Browser registry and first projection](browser-projection.md)
6. [Runtime invariants and faithful validation](validation.md)
7. [Implementation, rollout, compatibility, and stop/replan triggers](rollout.md)
8. [Future work handoff](future-work.md)

## Source-of-truth anchors inspected

- Browser workspace identity, HTTP routes, tmux creation, and card rendering: `packages/browser-workspace/src/workspace-ui.ts` (`ID`, `WorkspaceUiServer.live`, `GET /api/session/:id`, `POST /api/session`, and `render()`).
- Browser launcher/service ownership: `packages/browser-workspace/src/serve.ts` (`runServe`) and `packages/browser-workspace/systemd/bravo-browser-workspace.service`.
- Exact tmux namespace precedent: `packages/browser-workspace/src/tmux.ts` (`TmuxWorkspaceManager.inspectExact`) and `src/commands.ts`.
- Current aggregate derivation and reconciliation: `packages/async-subagents/extensions/pi/liveWidget.ts` (`readAsyncSubagentsActivityState`, `deriveAsyncSubagentsActivityState`, `reconcileDeadProcessOwnedLiveRow`).
- Current Pi session/root identity: `packages/async-subagents/extensions/pi/index.ts` (`piSessionIdOf`, `ensureRoot`, `tickAsyncTasksPoll`) and `packages/async-subagents/src/rootSession.ts` (`RootSessionIdentity`).
- Existing push/TTL/sequence precedent: `packages/async-subagents/extensions/pi/herdrMetadata.ts` and its scheduling in `extensions/pi/index.ts`.
- Current lifecycle vocabulary: `packages/async-subagents/src/types.ts` (`RunState`) and `src/schemas.ts` (`RUN_STATES`, `isTerminalRunState`).
- Existing browser verification seams: `packages/browser-workspace/test/workspace-ui.test.ts` and `test/browser-local-real.test.ts`.

Herdr was inspected only as a reference model: its server owns process/session projection, clients consume snapshots/events, and agent integrations report metadata over a local socket. This spec does not import Herdr protocols, taxonomy, or runtime.