# Pi Message API Contract Evidence

> **Superseded:** `docs/specs/unified-task-plane/` is the current contract. This document is retained as historical record, not current instructions.

Status: Phase 0 evidence checked
Date: 2026-06-30
Applies to: real Pi `sendMessage` / session binding behavior

## Verdict

Owner-session-bound wakeups are safe only with guards:

- capture the owner session identity at task start via `ctx.sessionManager.getSessionId()`;
- optionally persist `ctx.sessionManager.getSessionFile()` when available;
- capture the session-runtime-bound `pi.sendMessage` handle for live owned tasks;
- immediately before dispatch, verify current/owner session identity still matches;
- catch synchronous stale-runtime errors from the captured Pi handle;
- fail closed with `modelWakeState: "routing_failed"` / `modelWakeErrorCode: "NO_SESSION_BOUND_DELIVERY"` or `"SESSION_MISMATCH"` rather than guessing.

The installed Pi API does not expose a durable global session-addressed message bus for arbitrary later sessions. A captured `pi` runtime is session-bound but becomes stale after session replacement/reload. That satisfies the no-global-broadcast constraint only if background-bash never reuses a handle across session mismatch/stale-runtime cases.

## Evidence

### ExtensionAPI `pi.sendMessage` signature

`/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` exposes `ExtensionAPI.sendMessage` as synchronous `void`:

```ts
sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
}): void;
```

### ReplacedSessionContext sendMessage signature

The replacement-session context variant is async:

```ts
sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
}): Promise<void>;
```

Background-bash v1 uses the extension `pi` handle captured at extension activation, so notifier code must still expose an async interface and normalize both sync and promise-like send handles.

### Delivery semantics

`/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` `sendCustomMessage()` documents and implements:

- `deliverAs: "nextTurn"` pushes to `_pendingNextTurnMessages`;
- streaming sessions queue `followUp` or `steer` on the agent;
- non-streaming sessions with `triggerTurn: true` call `await this._runAgentPrompt(appMessage)`;
- non-streaming sessions without trigger append state and persist a custom message entry only.

Therefore v1 metadata must record API acceptance/enqueueing as `modelWakeAcceptedAt`; it must not claim true model delivery acknowledgement.

### Error behavior

`agent-session.js` binds extension-runtime `sendMessage` as a sync wrapper around async delivery:

```js
sendMessage: (message, options) => {
    this.sendCustomMessage(message, options).catch((err) => {
        runner.emitError({
            extensionPath: "<runtime>",
            event: "send_message",
            error: err instanceof Error ? err.message : String(err),
        });
    });
}
```

Async delivery errors are emitted through the extension runner rather than thrown to the caller. However stale runtime access can throw synchronously.

### Stale/runtime binding behavior

`/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js` uses `assertActive()` for action methods:

```js
const assertActive = () => {
    if (state.staleMessage) {
        throw new Error(state.staleMessage);
    }
};
```

`/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` invalidates the extension runner on session replacement/disposal with a stale-context message. This means a captured `pi` handle is not a global broadcaster; it is bound to an active session runtime and can become unusable.

### Session identity APIs

`/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` exposes:

```ts
getSessionId(): string;
getSessionFile(): string | undefined;
```

Use `getSessionId()` as the hard routing key. `getSessionFile()` is useful diagnostic context but may be absent for ephemeral sessions.

## Implementation consequences

- `BackgroundWakeNotifier.send(...)` remains `Promise<BackgroundWakeSendResult>` even when wrapping sync `pi.sendMessage`.
- Successful sync return means `deliverySemantics: "accepted"` only.
- Same-session reload cannot reconstruct a safe notifier from metadata alone; v1 must persist explicit wake-lost/routing failure for wake-enabled running tasks that reload without a live captured handle.
- Cross-session reconcile must never claim or send wake for another session's tasks.
- If `ownerSessionId` is missing, mismatched, or stale at terminal dispatch time, do not send; persist routing failure metadata/logs.
