# Persistence Contract

> **Superseded:** `docs/specs/unified-task-plane/` is the current contract. This document is retained as historical record, not current instructions.

Status: implemented
Applies to: `task-types.ts`, `task-registry.ts`, task metadata files

## Record schema extension

Extend `BackgroundTaskRecord` without changing existing field meanings:

```ts
interface BackgroundTaskRecord {
  schemaVersion: 1;
  taskId: string;
  command: string;
  cwd: string;
  ownerSessionId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  pid?: number;
  pgid?: number;
  processStartTime?: number;
  processCommandLine?: string;
  ownerRuntimeId?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  outputPath: string;
  metadataPath: string;
  outputBytes: number;
  maxOutputBytes: number;
  maxRuntimeMs?: number;
  blockedReason?: string;
  stopReason?: StopReason;
  wakeOnCompletion: boolean;
  wakePolicyVersion?: 1;
  wakePolicySource?: "tool_arg_v1";

  modelWakeState?: "not_requested" | "claim_acquired" | "routing_failed" | "send_attempted" | "accepted" | "send_failed";
  modelWakeNotificationId?: string;
  modelWakeClaimedAt?: string;
  modelWakeAttemptedAt?: string;
  modelWakeAcceptedAt?: string;
  modelWakeDeliverySemantics?: "accepted" | "delivered";
  modelWakeCanonicalTerminal?: {
    status: "exited" | "failed" | "timed_out" | "killed";
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    stopReason?: StopReason;
    endedAt: string;
  };
  modelWakeErrorCode?: string;
  modelWakeError?: string;
}
```

## Wake policy and ownership persistence

`wakeOnCompletion` is the effective per-task policy, not merely the raw tool argument. In v1 it must be computed once at task creation from `wake_on_completion: true` only, then persisted with a durable source marker:

```ts
wakeOnCompletion: true;
wakePolicyVersion: 1;
wakePolicySource: "tool_arg_v1";
```

A task is wake-eligible in v1 only when all three are present:

```ts
record.wakeOnCompletion === true &&
record.wakePolicyVersion === 1 &&
record.wakePolicySource === "tool_arg_v1"
```

Wake-enabled tasks must also persist owner-session routing fields defined in [`session-routing-contract.md`](session-routing-contract.md). A task that requests wake but lacks `ownerSessionId` is not deliverable and must record a routing failure instead of waking.

This ensures:

- reload/reconcile does not forget that a running task intended to wake;
- config changes after task start do not alter the task's wake behavior;
- task status tools can explain whether wake was enabled for that task;
- another active Pi session sharing the same global data directory cannot claim delivery authority.

## Notification claim and marker persistence

Notification marker ordering:

1. Persist terminal task facts.
2. Acquire a durable per-task notification claim atomically. This writes `modelWakeNotificationId`, `modelWakeState: "claim_acquired"`, `modelWakeClaimedAt`, and `modelWakeCanonicalTerminal` copied from the terminal facts that will appear in the wake payload.
3. If routing validation fails, persist `modelWakeState: "routing_failed"`, `modelWakeErrorCode`, and `modelWakeError`; do not send.
4. Persist `modelWakeState: "send_attempted"` and `modelWakeAttemptedAt` immediately before calling the notifier.
5. Await the notifier if it returns a Promise.
6. Persist `modelWakeState: "accepted"`, `modelWakeAcceptedAt`, and `modelWakeDeliverySemantics` if the API accepts/enqueues the wake.
7. Persist `modelWakeState: "send_failed"`, `modelWakeErrorCode`, and `modelWakeError` if dispatch throws/rejects.

The durable claim must be atomic across concurrent finalizers/runtimes. A plain load/check/`TaskRegistry.upsert()` sequence is forbidden for claim acquisition.

If process crash occurs after claim/attempt but before acceptance, v1 does not retry. That is acceptable because duplicate model turns are the higher-risk failure mode.

## Registry behavior

Existing registry semantics remain:

- active lifecycle index tracks active/attention states only;
- terminal task metadata remains inspectable from `<taskDir>/metadata.json`;
- `includeCompleted` may scan per-task metadata;
- terminal tasks are not re-added to the active registry merely because status/stop/list reads occur.

Notification metadata must be written to the per-task `metadata.json` even when the task is terminal and no longer appears in active `registry.json`.

## Metadata compatibility

- Existing metadata files that lack new notification fields must still load.
- Missing notification fields mean no wake has been attempted.
- Existing metadata with `wakeOnCompletion: true` but no `wakePolicyVersion: 1` / `wakePolicySource: "tool_arg_v1"` is not wake-eligible, regardless of whether it is running, orphaned, unknown, or terminal.
- Pre-feature running/orphaned records with `wakeOnCompletion: true` must not emit wakeups during reload/reconcile; they may record an ignored-legacy-wake diagnostic.
- Existing config with `notifyModelOnCompletion: true` from before this feature must not become an automatic wake default in v1; implementation should log/notify that the legacy field is ignored until a versioned config contract enables it.
- Do not bump `schemaVersion` solely for optional fields unless the implementation introduces incompatible parsing requirements.
- If `schemaVersion` is bumped, add migration/load compatibility tests.
- Add rollout tests for legacy metadata/config containing true wake fields.

## Output log requirements

The output log remains the durable detailed evidence. Wake notifications only contain a bounded tail.

Required lifecycle sentinels:

- task started;
- timeout/output-cap/stop request when applicable;
- final exit code/signal;
- model wake claim/acquire/routing-failed/send-attempted/accepted/send-failed when applicable.

Sentinels must not be the source of truth for task state; metadata is authoritative.

## Session scoping

Session ownership remains unchanged:

- model wake dispatch should target the session that owns the task runtime.
- task-control tools remain session-scoped.
- stale tasks from other sessions must not wake a new unrelated session during reconciliation.

If the extension cannot identify or reach the owning session's message delivery API, it must not guess. Record notification failure metadata instead.
