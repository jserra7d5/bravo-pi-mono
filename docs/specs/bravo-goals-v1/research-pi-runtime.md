# Pi Runtime Research

Status: draft  
Date: 2026-05-17  
Scope: Pi APIs needed by Bravo Goals for slash commands, session boundaries, compaction, fresh-session handoff, and durable extension state.

## Summary

Pi supports the Bravo Goals lifecycle well enough for v1, with one important constraint: there is no public extension API to wipe transcript history in place. The correct primitives are:

- `carry`: keep the current Pi session and queue the next worker prompt.
- `compact`: call Pi compaction and continue in the same session.
- `fresh_session`: call Pi replacement-session APIs and seed the replacement session.
- `checkpoint_only`: write durable goal files and stop; do not mutate Pi history.

Session replacement APIs are command-context only. Event handlers must not try to call `newSession`, `fork`, `switchSession`, `reload`, or `waitForIdle`.

## Command Context vs Event Context

Session-control APIs live on `ExtensionCommandContext` / `ReplacedSessionContext`, not plain `ExtensionContext`.

Command-only APIs:

- `waitForIdle`
- `newSession`
- `fork`
- `navigateTree`
- `switchSession`
- `reload`

Evidence:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:333`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/docs/extensions.md:974`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:636`

Plain event-handler context includes:

- `compact`
- UI methods, including `setEditorText`

Message/session-entry APIs are on the extension-level `pi` API, not plain `ctx`:

- `pi.sendMessage`
- `pi.sendUserMessage`
- `pi.appendEntry`

Only `ReplacedSessionContext`, passed to `newSession` / `fork` / `switchSession`
`withSession`, exposes awaitable `ctx.sendMessage` and `ctx.sendUserMessage`.

Evidence:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:573`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/docs/extensions.md:852`

Implementation consequence: `/goal next`, `/goal resume`, and any operation that needs `newSession` must be slash-command handlers, not passive event hooks. Ordinary commands/events should use `pi.sendUserMessage` for queued user prompts and must not assume that call is awaitable.

## Fresh Session Handoff

Use `ctx.newSession({ parentSession, setup, withSession })` for the `fresh_session` phase boundary.

Important constraints:

- `withSession` runs after the old runtime is torn down and the new runtime is rebound.
- The old command context is stale after replacement and must not be reused.
- The replacement session can receive the restart prompt with `sendUserMessage` or editor prefill.

Evidence:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/docs/extensions.md:991`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/docs/extensions.md:1114`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:166`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:200`

Recommended restart prompt shape:

```txt
You are resuming a Bravo goal in a fresh Pi session.

Read these files before acting:
1. .bravo/goals/<goal-id>/goal.md
2. .bravo/goals/<goal-id>/context.md
3. .bravo/goals/<goal-id>/state.yaml
4. .bravo/goals/<goal-id>/resume.md

Then continue the active task from state.yaml.
```

The prompt should be navigational. Do not paste all goal files into the prompt by default.

## Compaction

`ctx.compact()` is available to extensions and can take custom instructions. It aborts the current agent operation before compaction, starts asynchronous compaction, and should be treated as a turn-boundary action. Follow-up worker prompting must be driven after compaction completes, not immediately after calling `compact()`.

Evidence:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:289`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/docs/extensions.md:942`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/agent-session.ts:1610`

Recommended v1 use:

- Expose `/goal compact`.
- Allow `/goal next --compact`.
- Do not mix compaction and `fresh_session` on the same boundary by default.

## Checkpoint-Only Pause

Pi does not provide a dedicated pause primitive for Bravo's goal lifecycle. Pause should be implemented by Bravo state:

1. write or refresh `resume.md` from controller-known state, or queue an agent-authored checkpoint and wait for an explicit later receipt/handshake;
2. update `state.yaml`;
3. detach the current Pi session from the goal index;
4. update/clear the HUD.

Optional: write a Pi custom entry with `pi.appendEntry` for in-session traceability.

`pi.sendUserMessage` is fire-and-forget in normal command/event contexts. A pause command must not queue "write resume.md" and then immediately assume the file was written.

Evidence for `appendEntry` custom state not entering LLM context:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/docs/extensions.md:1319`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/session-manager.ts:87`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/session-manager.ts:895`

## No Transcript Wipe

Direct transcript clearing is not exposed through the public extension API.

Evidence:

- Session storage is append-only and entries cannot be modified or deleted: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/session-manager.ts:1062`
- Built-in slash commands include `new`, `fork`, `compact`, `resume`, and `reload`, but not transcript clear: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/slash-commands.ts:18`
- `setEditorText` changes only the input editor buffer, not transcript history: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:205`

Implementation consequence: Bravo's "wipe between steps" mode should be named and implemented as `fresh_session`, not as in-place clearing.

## Footguns

- `pi.sendUserMessage` can require explicit delivery mode while streaming; custom `sendMessage` defaults are different and should be checked at the call site.
- `compact()` exists in event context but should not be fired casually from arbitrary hooks; continuation must wait for compaction completion.
- `shutdown()` exits Pi; it is not a goal pause primitive.
- There is no generic `after_session` hook. Use `session_start`, `session_shutdown`, and specific switch/fork/compact events.

Evidence:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/docs/extensions.md:1291`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/agent-session.ts:1317`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:512`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:551`
