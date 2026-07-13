# Notification Contract

> **Superseded:** `docs/specs/unified-task-plane/` is the current contract. This document is retained as historical record, not current instructions.

Status: implemented
Applies to: `notifications.ts`, `BackgroundRunner` notifier callback, Pi `sendMessage`

## Delivery mechanism

Model wakeups are delivered as Pi custom messages, subject to the session-routing contract in [`session-routing-contract.md`](session-routing-contract.md):

```ts
const result = await notifier.send({
  customType: "background-bash-notification",
  content: notificationText,
  display: true,
  details: notificationDetails,
  options: { triggerTurn: true, deliverAs: "followUp" },
});
```

The notifier contract is async unless Phase 0 proves the concrete Pi API is synchronous and cannot fail after the call returns:

```ts
type BackgroundWakeSendResult = {
  acceptedAt: string;
  deliverySemantics: "accepted" | "delivered";
};

type BackgroundWakeNotifier = {
  send(message: BackgroundBashWakeMessage): Promise<BackgroundWakeSendResult>;
};
```

Rationale:

- `triggerTurn: true` wakes the model when idle.
- `deliverAs: "followUp"` avoids interrupting an active tool loop and schedules the notification after the current agent work finishes.
- A custom message keeps the event distinct from a real user request. The content must include a `NOT USER INPUT` marker.

Phase 0 must document whether Pi `sendMessage` means only "accepted/enqueued" or true "delivered to model turn". Until Pi exposes a true delivery acknowledgement, the persisted success field is `modelWakeAcceptedAt`, not `modelWakeDeliveredAt`.

If Pi's `sendMessage` API changes, cannot be called safely from the background callback, cannot be awaited/handled correctly, or cannot be proven to target the owning session, implementation must stop and replan.

## Wake event envelope

The model-visible message content is XML-like and bounded:

```xml
<background_bash_notification not_user_input="true">
  <task_id>bg_20260630_abcdef</task_id>
  <status>failed</status>
  <exit_code>7</exit_code>
  <signal>null</signal>
  <stop_reason>null</stop_reason>
  <command truncated="false">npm test --workspace @bravo/foo</command>
  <output_path>/home/user/.pi/background-bash/bg_20260630_abcdef/output.log</output_path>
  <started_at>2026-06-30T12:00:00.000Z</started_at>
  <completed_at>2026-06-30T12:03:25.000Z</completed_at>
  <summary>Background command failed with exit code 7.</summary>
  <output_tail truncated="true" bytes="4096" lines="80" encoding="xml-text-escaped">...
  </output_tail>
</background_bash_notification>
```

Required content fields:

- `task_id`
- `status`
- `exit_code` (`null` when unavailable)
- `signal` (`null` when unavailable)
- `stop_reason` (`null` when unavailable)
- bounded `command`
- `output_path`
- `started_at`
- `completed_at`
- `summary`
- bounded `output_tail`

Details metadata may include the same fields as structured JSON, but the model must not need hidden details to understand the event.

## Summary semantics

- `exited` + `exitCode === 0`: `Background command completed successfully.`
- `failed` + non-zero exit: `Background command failed with exit code N.`
- `timed_out`: `Background command timed out after <duration> and was stopped.`
- `killed` + `stopReason === "user"`: `Background command was stopped by request.`
- `killed` + `stopReason === "output_cap"`: `Background command was stopped after reaching the output cap.`
- `killed` + shutdown: no model wake in v1; write metadata/log sentinels only.

## Tail bounds

Default notification tail bounds:

- maximum bytes: 4 KiB
- maximum lines: 80
- use the smaller result after applying both constraints

Hard maximum:

- implementation may expose config for tail bytes, but must cap it at 16 KiB.

Tail requirements:

- Read from the durable output log path.
- Preserve valid UTF-8 boundaries.
- Strip ANSI escape sequences from the notification tail; the durable log may keep raw output.
- Replace C0/C1 control characters other than `\n`, `\r`, and `\t` with visible escaped placeholders.
- XML-escape all text-node values (`&`, `<`, `>`, `"`, `'`) and do not use CDATA.
- Mark `truncated="true"` when earlier output was omitted or the read was capped.
- Never include continuous output chunks or the full log by default.
- If the output log cannot be read, include a bounded explanation and keep the output path.
- Test tail content containing `]]>`, nested `<background_bash_notification>` text, ANSI control sequences, and multi-byte UTF-8 at truncation boundaries.

Security note: tail bounds reduce volume, not sensitivity. Commands can still print secrets. The prompt must tell agents to prefer reading the output path when more detail is needed instead of increasing wake payload size.

## Duplicate prevention

A task record must persist disambiguated notification state:

```ts
type ModelWakeState =
  | "not_requested"
  | "claim_acquired"
  | "routing_failed"
  | "send_attempted"
  | "accepted"
  | "send_failed";

interface ModelWakeRecordFields {
  modelWakeState?: ModelWakeState;
  modelWakeNotificationId?: string;
  modelWakeClaimedAt?: string;
  modelWakeAttemptedAt?: string;
  modelWakeAcceptedAt?: string;
  modelWakeDeliverySemantics?: "accepted" | "delivered";
  modelWakeCanonicalTerminal?: {
    status: "exited" | "failed" | "timed_out" | "killed";
    exitCode?: number | null;
    signal?: string | null;
    stopReason?: string;
    endedAt: string;
  };
  modelWakeErrorCode?: string;
  modelWakeError?: string;
}
```

Rules:

- Generate one stable `modelWakeNotificationId` per task terminal transition.
- Acquire a durable per-task notification claim before validating routing or sending.
- Persist `modelWakeState: "claim_acquired"`, `modelWakeClaimedAt`, and `modelWakeCanonicalTerminal` as part of that claim.
- Persist `modelWakeState: "routing_failed"` with `modelWakeErrorCode` if owner-session validation fails; do not send.
- Persist `modelWakeState: "send_attempted"` and `modelWakeAttemptedAt` immediately before calling the notifier.
- Await the notifier result when it is promise-returning.
- Persist `modelWakeState: "accepted"`, `modelWakeAcceptedAt`, and `modelWakeDeliverySemantics` after the delivery API accepts the message.
- Persist `modelWakeState: "send_failed"`, `modelWakeErrorCode`, and `modelWakeError` if dispatch rejects or throws.
- Any existing claim/attempt/accepted/send-failed/routing-failed state suppresses future model wake attempts for the same task.
- Wake payload fields must be built from `modelWakeCanonicalTerminal`, and later process callbacks must not mutate wake-visible terminal facts away from that canonical value.

This favors at-most-once model wake over duplicate wake loops. A failed or suppressed delivery remains observable in metadata/logs but is not auto-retried in v1.

The durable claim must be atomic across concurrent finalizers/runtimes, for example with an exclusive per-task claim file, lock directory creation, or atomic rename/CAS operation. Ordinary read-then-`upsert()` is not sufficient for exactly-once delivery.

## UI notification separation

Distinguish three surfaces:

1. **Task metadata/log markers** — always updated for lifecycle.
2. **UI/task widget awareness** — controlled by existing UI behavior and `notifyUiOnCompletion` if implemented.
3. **Model wake event** — only when effective wake policy is enabled.

Do not use `ctx.ui.notify()` as a substitute for model wake. Do not treat model wake as required for UI display. Do not use a global model-wake broadcaster that can deliver a task notification to a non-owner active Pi session.

## Renderer optionality

A custom message renderer for `background-bash-notification` is allowed but not required for v1. If added, it must render a compact card and keep full details behind expansion/output-path reads. Renderer behavior must not be required for the model to process the event.
