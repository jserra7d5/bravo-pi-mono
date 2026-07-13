# Implementation Plan

> **Superseded:** `docs/specs/unified-task-plane/` is the current contract. This document is retained as historical record, not current instructions.

Status: implemented
Target package: `packages/pi-extension-background-bash`

## Phase 0 — API and ownership spike

1. Confirm Pi `sendMessage` works from the extension-owned background callback path:
   - custom message;
   - `triggerTurn: true`;
   - `deliverAs: "followUp"`;
   - no active agent turn required.
2. Document concrete `sendMessage` semantics in a checked-in API contract note or test:
   - synchronous vs promise-returning;
   - accepted/enqueued vs truly delivered to a model turn;
   - failure/rejection behavior.
3. Confirm the delivery handle is session-safe using real Pi API behavior, not only synthetic sinks:
   - determine whether `pi.sendMessage` is bound to the current session runtime or global extension instance;
   - identify available session identity fields (`sessionManager.getSessionId()`, `getSessionFile()`);
   - prove owner-session routing with two active sessions or an official equivalent harness/transcript.
4. Decide the exact async session-bound notifier shape.
5. Stop if a wake cannot be targeted to the owning session without cross-session drift.

## Phase 1 — Types and notification builder

1. Extend `BackgroundTaskRecord` with disambiguated notification marker fields:
   - `modelWakeState?`
   - `modelWakeNotificationId?`
   - `modelWakeClaimedAt?`
   - `modelWakeAttemptedAt?`
   - `modelWakeAcceptedAt?`
   - `modelWakeDeliverySemantics?`
   - `modelWakeErrorCode?`
   - `modelWakeError?`
2. Add wake-policy source and session ownership fields where missing:
   - persist `wakePolicyVersion: 1` and `wakePolicySource: "tool_arg_v1"` only for new v1 per-call opt-in tasks;
   - require the v1 marker for wake eligibility;
   - require `ownerSessionId` for waking tasks;
   - persist owner session file if available;
   - keep `ownerRuntimeId`.
3. Replace `notifications.ts` stub with pure helpers:
   - summarize terminal status;
   - build XML-like model-visible content;
   - build structured details;
   - read bounded UTF-8-safe output tail;
   - escape/normalize envelope content.
4. Unit-test notification formatting and tail bounds.

## Phase 2 — Session-bound wake notifier

1. Introduce a small notifier interface instead of passing raw Pi APIs deep into process logic:

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

2. Build the notifier at task start from tool execution context and extension API.
3. Store notifier in memory for live owned children; persist ownership fields in metadata.
4. Define same-session reload behavior: reconstruct a safe notifier/watcher or persist explicit wake-lost routing/liveness failure. Silent loss is forbidden.
5. Validate session ownership immediately before dispatch.
6. Persist routing failure instead of dispatching if validation fails.

## Phase 3 — Terminal finalization

1. Add one idempotent terminal finalization helper in `BackgroundRunner` or an adjacent module.
2. Route process `exit`, timeout, output cap, and manual stop terminal writes through it where practical. Shutdown persists terminal metadata/logs but does not model-wake in v1.
3. Ensure terminal metadata is durable before notification dispatch.
4. Add in-memory duplicate guard for one runtime.
5. Add an atomic durable notification-claim operation before dispatch; ordinary read/check/upsert is insufficient.
6. Freeze wake-visible terminal facts into `modelWakeCanonicalTerminal` at claim acquisition and build the payload from that canonical value.
7. Prevent later stop/exit callbacks from mutating canonical wake-visible fields after claim; allow only supplemental diagnostics.
8. Check persisted notification state before dispatch.

Important manual-stop decision:

- Prefer waking from the eventual child `exit` callback after `background_task_stop` requests termination.
- If keeping immediate `killed` persistence for compatibility, the finalizer must prevent the later `exit` callback from sending a duplicate wake or changing the canonical wake-visible terminal facts.

## Phase 4 — Tool and prompt updates

1. Compute effective wake policy at task start:

```ts
const wakeOnCompletion = params.wake_on_completion === true;
```

2. Pass effective wake policy and notifier to `BackgroundRunner.start()`.
3. Update background start result to display `Wake on completion: enabled|disabled`.
4. Update `bash` schema/description only if needed; existing `wake_on_completion` name stays stable.
5. Replace system prompt warning after end-to-end tests pass.
6. Update README to document opt-in wake behavior, session isolation, and tail bounds.

## Phase 5 — Validation and hardening

1. Add integration-style tests in `test/core.test.ts` or split into focused files.
2. Cover:
   - success wake;
   - failure wake;
   - disabled quiet behavior;
   - timeout;
   - manual stop;
   - output tail bounds and XML-breaking/control-sequence escaping;
   - output-cap kill terminal wake path;
   - delayed async send acceptance and send rejection;
   - delivery/routing failure;
   - reload duplicate suppression;
   - same-session reload preserves wake or records explicit wake-lost failure;
   - two active sessions sharing a data dir with no drift;
   - legacy `notifyModelOnCompletion: true` and legacy running/orphaned/unknown/terminal `wakeOnCompletion: true` metadata ignored in v1 unless the task has `wakePolicyVersion: 1` / `wakePolicySource: "tool_arg_v1"`;
   - timeout validation for omitted, zero, one-second, fractional, negative, and too-large values.
3. Run package check/test commands.
4. Only after tests pass, update prompt text and README language that currently says wakeups are unimplemented.

## Phase 6 — Optional UI polish

A custom message renderer may be added after the core contract is green. It is not required for model correctness.

If added, follow TUI constraints:

- render compact status/task id/output path;
- keep width-stable output;
- avoid large tail dumps in the card;
- no render loops or per-output-chunk repainting.

## Stop/replan triggers

Stop implementation and replan if any of these are true:

- Pi has no stable API to trigger a model turn from an extension background callback.
- `sendMessage` semantics cannot be documented as accepted/delivered or safely awaited/handled.
- `sendMessage` cannot be targeted or validated against the owning session.
- Wake delivery would require a global broadcaster that can wake the wrong active Pi session.
- Exactly-once delivery cannot be persisted without duplicate wake risk.
- Tail payload cannot be bounded before entering conversation context.
- Manual stop semantics require breaking existing task-control contracts.
- Tests can only pass by mocking above the lifecycle owner instead of running real background processes.
