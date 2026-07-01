# Session Routing Contract

Status: implemented
Applies to: all model wake dispatch paths, session lifecycle hooks, task reconciliation

## Hard rule

A background bash wakeup must be delivered only to the Pi session that started the task. It must never drift to another active Pi session, another cwd, another resumed/forked session, or a later session that happens to share the same global background-bash data directory.

If the extension cannot prove the owning session is still the delivery target, it must not wake. It should record a notification routing failure in task metadata and the output log.

## Ownership fields

Every task that can wake must persist enough ownership data to route safely:

```ts
type BackgroundWakeOwnership = {
  ownerSessionId: string;
  ownerRuntimeId: string;
  ownerCwd: string;
  ownerSessionFile?: string;
};
```

Minimum requirement for v1:

- `ownerSessionId` must exist for any task with `wakeOnCompletion: true`.
- `ownerRuntimeId` must match the live runtime attempting dispatch.
- `ownerCwd` should be persisted as the task `cwd` and used as an additional diagnostic guard.
- `ownerSessionFile` should be persisted when Pi exposes it through `ctx.sessionManager.getSessionFile()`.

A task with wake enabled but no `ownerSessionId` is misconfigured and must not model-wake.

## Session-bound notifier

Wake dispatch must use a session-bound notifier captured from the tool/session context that started the task, not a global unqualified broadcaster.

Conceptual shape:

```ts
type BackgroundWakeNotifier = {
  ownerSessionId: string;
  ownerRuntimeId: string;
  ownerSessionFile?: string;
  currentSessionId(): string | undefined;
  currentSessionFile(): string | undefined;
  send(message: BackgroundBashWakeMessage): Promise<BackgroundWakeSendResult>;
};
```

Before dispatch, the notifier must validate:

- task `ownerSessionId` equals notifier `ownerSessionId`;
- task `ownerRuntimeId` equals notifier `ownerRuntimeId` when the runtime owns the live child handle;
- if current session id is readable, it still equals task `ownerSessionId`;
- if current session file is readable and task recorded one, it still matches.

If any check fails, suppress wake and persist routing failure.

## Multi-session global data-dir rule

The default data directory is global (`~/.pi/background-bash`). Therefore metadata visibility is not delivery authorization.

- Any Pi session may be able to inspect metadata by exact path or include-completed scan.
- Only the owner session may receive model wake messages.
- Reconcile in session B must not wake tasks owned by session A.
- Session B status/list tools must continue to filter by session ownership.

## Session switch/fork/reload behavior

- Same-session reload must either reconstruct a safe session-bound notifier/watcher and preserve wake eligibility, or persist a routing/liveness failure explaining that wake delivery is impossible after reload.
- Silent loss of wake eligibility after same-session reload is forbidden.
- New/resume/fork session replacement must not inherit outstanding wake delivery rights for the previous session unless Pi explicitly preserves the same `ownerSessionId` and session file identity.
- Session shutdown kills may update metadata/logs but must not model-wake in v1; teardown is not an agent-resume path.
- If `shutdownPolicy: "leave-running"`, a later orphan/reconcile classification in another session must not model-wake.

## Delivery failure semantics

Routing failures are notification failures, not task lifecycle failures.

Persist fields such as:

```ts
modelWakeState: "routing_failed"
modelWakeErrorCode: "SESSION_MISMATCH"
modelWakeError: "expected <owner>, got <current>"
```

Do not retry from a different session. Do not fall back to `sendUserMessage()`. Do not emit a user-looking message.

## Tests required

- Phase 0 must produce a recorded API contract note or integration test proving how real Pi `sendMessage` binds to a session. Synthetic sinks are not enough for the no-drift claim.
- If real owner-targeted delivery cannot be proven, implementation must refuse model wake when no session-bound message handle is available and record routing failure.
- Two synthetic session contexts share the same `dataDir`; task owned by session A completes while session B has active tools. Only A's fake `sendMessage` is called.
- Session B `reconcile()` sees session A task metadata and does not wake.
- Missing `ownerSessionId` with `wakeOnCompletion: true` records routing failure and does not wake.
- Changed session id/session file before terminal dispatch suppresses wake.
- `background_task_status` in non-owner session still returns `TASK_NOT_FOUND` and does not wake.
- Same-owner reload while a wake-enabled task is running either preserves later wake delivery or records explicit wake-lost routing/liveness failure; it never fails silently.
