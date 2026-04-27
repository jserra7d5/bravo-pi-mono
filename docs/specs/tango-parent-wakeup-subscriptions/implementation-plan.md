# Tango Parent Wake-up Subscriptions Implementation Plan

Date: 2026-04-27
Status: Draft
Design: `docs/specs/tango-parent-wakeup-subscriptions/design.md`

## Objective

Implement reliable asynchronous parent wake-ups for Tango agents by replacing ambient event-log matching as the correctness path with explicit parent subscriptions keyed by child `runId` / `runDir`.

The implementation is successful only when a root Pi session can start an async child, stop interacting with Tango entirely, and later be woken by the child reaching a subscribed state.

## Scope

In scope:

- Durable subscription store.
- Root Pi owner lease.
- Pi `tango_start` async subscription registration.
- Pi extension subscription poller.
- Wake-up delivery via `pi.sendUserMessage`.
- Handling/acknowledgement from `tango_result` / `tango_activity` wrappers.
- Removal of the broken Pi wake-up stack: direct watcher delivery, same-cwd fallback, global event backfill, global event polling, and attention `delivered`/`seen` as wake-up truth.
- Tests for subscription state, leases, and delivery logic.
- Manual hand tests for oneshot and interactive async children.

Out of scope for the first implementation:

- Dashboard subscription UI.
- Perfect cross-machine synchronization.
- Full server-side pub/sub or websocket delivery.

## Current Failure Mode to Eliminate

The current path fails because child completion delivery depends on:

- `tango watch --json` child process still being alive;
- CLI-side watch lineage filter matching current env;
- child metadata root/workstream matching the live parent;
- no stale watcher claiming attention first;
- backfill not flooding historical completions;
- attention state accurately implying parent wake-up.

The new path must not depend on any of those for correctness.

## Self-audit Amendments

This plan was reviewed against the failures observed during live testing. The following clarifications are mandatory:

1. **No temporary dual wake-up path.** Do not keep the broken watcher/backfill/same-cwd/attention delivery stack as a fallback. It has already caused silent missed wake-ups and historical floods.
2. **Subscriptions must not be owned by a transient extension instance.** `ownerId` is a delivery lease, not part of the durable subscription identity. A reload creates a new owner that must be able to adopt active subscriptions for the same root session/workstream/cwd.
3. **The subscription recipient key is stable root identity + cwd, not owner ID.** Use `ownerId` only for `lastNotifiedOwnerId` / delivery lease checks.
4. **The poller must read exact target runs directly.** It must not depend on `tango watch`, event lineage, or same-cwd global fallback for correctness.
5. **`notified` means wake-up was enqueued, not handled.** If `sendUserMessage` throws, keep the subscription active with `lastDeliveryError`. If it succeeds, mark notified; final suppression requires `handled` after result/activity inspection.
6. **Reload adoption is mandatory.** On startup, the current lease owner must pick up unhandled active/notified subscriptions for the same recipient key without replaying unrelated historical events.

## Phase 1 — Subscription Store

### Files

Create:

- `packages/tango/src/subscriptions.ts`
- `packages/tango/src/subscriptions.test.ts`

May update:

- `packages/tango/src/paths.ts` if a helper is useful.

### Store Path

Use a JSONL append-only store under Tango home:

- `~/.tango/subscriptions.jsonl`

Read should compact by stable subscription key. Writes append records.

### Types

Implement types equivalent to:

```ts
export type SubscriptionState = "active" | "notified" | "handled" | "dismissed" | "expired" | "orphaned";

export interface SubscriptionRecord {
  schemaVersion: 1;
  subscriptionId: string;
  recipient: {
    rootSessionId?: string;
    workstreamId?: string;
    cwd: string;
    sessionKind: "pi" | "cli" | "dashboard" | "unknown";
  };
  target: {
    runId?: string;
    runDir: string;
    agentName: string;
  };
  notifyOn: Array<"blocked" | "error" | "done" | "result-ready" | "checkpoint">;
  state: SubscriptionState;
  lastObservedStatus?: string;
  lastObservedResultFinalizedAt?: string;
  lastDeliveredKey?: string;
  lastNotifiedOwnerId?: string;
  lastDeliveryError?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
```

### Required Functions

Implement:

- `subscriptionStorePath(): string`
- `createSubscription(input): SubscriptionRecord`
- `upsertSubscription(record): SubscriptionRecord`
- `readAllSubscriptions(): SubscriptionRecord[]`
- `listActiveSubscriptions(filter): SubscriptionRecord[]`
- `markSubscriptionNotified(subscriptionId, deliveryKey): SubscriptionRecord | undefined`
- `markSubscriptionHandledByRun(runIdOrRunDir): SubscriptionRecord[]`
- `markSubscriptionDismissed(subscriptionId): SubscriptionRecord | undefined`
- `expireSubscriptions(now): SubscriptionRecord[]`

### De-duplication Key

De-dupe active subscriptions by:

```text
recipient.rootSessionId | recipient.workstreamId | recipient.cwd | target.runId/runDir
```

If an existing subscription for the same recipient+target exists and is not terminal (`handled`, `dismissed`, `expired`, `orphaned`), update it instead of creating a duplicate.

### Tests

Add tests covering:

- create/read round trip;
- de-dupe by stable recipient + target, independent of transient owner ID;
- notified state records `lastDeliveredKey`;
- handled by run ID and by runDir;
- expiration by `expiresAt`;
- corrupt JSONL lines are ignored;
- stable compaction returns latest record per subscription ID.

### Success Criteria

- `node --test dist/subscriptions.test.js` passes as part of workspace tests.
- Subscription store can be read safely when file does not exist.
- Duplicate starts do not create duplicate active subscriptions for the same parent+child.
- Reloaded extension owners can adopt existing active/notified subscriptions for the same stable recipient key.

## Phase 2 — Owner Lease

### Files

Create:

- `packages/tango/src/leases.ts`
- `packages/tango/src/leases.test.ts`

### Store Path

Use:

- `~/.tango/root-session-leases.jsonl`

### Types

```ts
export interface RootSessionLease {
  schemaVersion: 1;
  ownerId: string;
  rootSessionId?: string;
  workstreamId?: string;
  cwd: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
}
```

### Required Functions

- `createLease(input): RootSessionLease`
- `heartbeatLease(ownerId, ttlMs): RootSessionLease | undefined`
- `currentLease(filter, now): RootSessionLease | undefined`
- `isCurrentLease(ownerId, filter, now): boolean`
- `expireLeases(now): RootSessionLease[]`

### Lease Rules

- Current lease is latest non-expired lease for `(cwd, rootSessionId, workstreamId)`.
- A new extension instance creates a new lease and becomes owner.
- Old extension instances must stop delivery if `isCurrentLease(ownerId, ...)` is false.
- Heartbeat interval: 2s–5s.
- TTL: 15s–30s.

### Tests

- latest lease wins;
- expired lease is ignored;
- heartbeat extends expiry;
- old owner loses after new lease;
- different cwd/root/workstream leases do not conflict.

### Success Criteria

- Stale extension instances cannot mark subscriptions notified.
- Owner election does not rely on killing processes.

## Phase 3 — Delivery Key and Notify State Evaluation

### Files

May add to `subscriptions.ts` or create:

- `packages/tango/src/subscriptionDelivery.ts`
- `packages/tango/src/subscriptionDelivery.test.ts`

### Required Function

Implement:

```ts
computeSubscriptionDelivery(subscription, runStateOrMetadata):
  | undefined
  | {
      key: string;
      status: "blocked" | "error" | "done" | "result-ready" | "checkpoint";
      message: string;
      action: string;
    }
```

### Delivery Key Rules

- If run is `blocked`: `blocked:<lastReportAt|updatedAt>:<needs|summary>`.
- If run is `error`: `error:<lastReportAt|updatedAt>:<summary|resultIssue>`.
- If run is `done` and result is ready/finalized: `done:<resultFinalizedAt>`.
- If run is `done` with result issue and no ready result: `done-issue:<resultIssue>`.
- If explicit checkpoint exists later: `checkpoint:<checkpointId|lastReportAt>`.

Do not deliver if:

- subscription state is `handled`, `dismissed`, `expired`, or `orphaned`;
- delivery key equals `lastDeliveredKey`;
- status is not in `notifyOn`.

### Tests

- done without result-ready does not notify for oneshot unless result issue exists;
- done with result-ready notifies once;
- blocked notifies once per distinct report/update;
- error notifies once per distinct report/update;
- repeated poll does not duplicate;
- handled subscriptions do not notify.

### Success Criteria

- Delivery decisions are deterministic and independent of global event log lineage.

## Phase 4 — Pi Extension Subscription Poller

### File

Update:

- `packages/tango/extensions/pi/index.ts`

### Behavior

On `session_start`:

1. Ensure root session record as today.
2. Create a root owner lease and store `ownerId` in module state.
3. Start heartbeat timer.
4. Start subscription poller.
5. Do not start or use the legacy watcher/backfill/attention wake-up path.

On `session_shutdown`:

- stop heartbeat timer;
- stop subscription poller;
- do not mark active subscriptions handled.

### Poller

Every 2s–5s:

1. Verify this extension owns current lease.
2. Load active subscriptions for this recipient/root/cwd.
3. For each subscription, read target metadata/run state by `runDir` or `runId`.
4. Compute delivery.
5. If deliverable, call `pi.sendUserMessage(wakeup, { deliverAs: "followUp" })`.
6. Mark subscription `notified` only after the send call returns synchronously without error; record `lastNotifiedOwnerId`.
7. Record `lastDeliveryError` and do not mark notified if sending throws.
8. If the subscription is already `notified` for the same delivery key, do not send again unless an explicit retry/reminder policy is later added.

### Wake-up Message

Keep concise. Example:

```text
Tango wake-up (not a user request):

agent-name is done and result is ready.
Run: run_abc
Next: tango_result --run-id run_abc

Instructions:
- Inspect the result if relevant to the active task.
- Continue the active workstream.
- Do not summarize this notification unless the original task is complete, blocked, or needs a decision.
```

### Important Constraint

Do not batch arbitrary historical agents. Only deliver active subscriptions owned/adopted by this session.

### Tests

Pure unit testing of the Pi extension is difficult. Add extractable pure helpers where possible and test them separately.

### Success Criteria

- A subscribed run can wake the parent without `tango watch` emitting any event.
- Global event backfill is not required for correctness.
- Existing monitor noise does not cause subscription delivery.

## Phase 5 — Register Subscriptions from Pi `tango_start`

### File

Update:

- `packages/tango/extensions/pi/index.ts`

### Tool Schema Changes

Add optional parameters:

```ts
wait?: "none" | "terminal" | "result-resolved" | "checkpoint";
detached?: boolean;
notifyOn?: Array<"blocked" | "error" | "done" | "result-ready" | "checkpoint">;
subscriptionTtlMs?: number;
```

### Defaults

Recommended defaults for first implementation:

- Keep `tango_start` immediate-return and make async subscription registration the default behavior, not a blocking follow.
- If `detached: true` or `wait: "none"`, register subscription and return immediately.
- If `wait` is specified as `terminal` or `result-resolved`, use existing `tango_follow`/state polling behavior inside the tool and optionally do not register a subscription unless timeout occurs.

Alternative stricter default can be considered later.

### Registration Timing

For async starts:

1. Call Tango start.
2. Extract `runId`, `runDir`, `agentName` from the returned run state, even if the returned metadata has stale root/workstream identity.
3. Build the subscription recipient from the current Pi extension/root context, not from the child metadata.
4. Create subscription before returning tool result.
5. Include subscription summary in tool output details.

### Success Criteria

- Every async `tango_start` from Pi creates exactly one active subscription for the started run.
- Subscription exists even if child completes quickly after start.
- Subscription targets exact `runId` / `runDir`, not just root/workstream.

## Phase 6 — Handling/Ack from Pi Tools

### File

Update:

- `packages/tango/extensions/pi/index.ts`

### Behavior

After successful tool calls:

- `tango_result` marks subscriptions for that `runId`/`runDir` handled if result is ready/safe to read.
- `tango_activity` marks blocked/error subscriptions handled only if the target is still blocked/error and the activity was read successfully.
- `tango_stop` marks subscriptions dismissed/handled for the stopped run.

### Success Criteria

- After a wake-up and `tango_result`, repeated poll does not wake for the same done result.
- If the agent later produces a new distinct checkpoint/blocker, a new notification can still be delivered if appropriate.

## Phase 7 — Server and CLI Identity Hardening

### Files

Already partially changed, but review and harden:

- `packages/tango/src/cli.ts`
- `packages/tango/src/server.ts`
- `packages/tango/src/start.ts`
- `packages/tango/src/types.ts`

### Requirements

- CLI start includes caller identity in server request.
- Server start uses request identity over server `process.env`.
- Add tests proving stale server env does not override explicit request identity.

### Tests

In `rollout-compat.test.ts` or a new server/start test:

- Start server with env `root=A`.
- Send `/api/v1/runs/start` with request `root=B`.
- Assert created metadata has `root=B`.

### Success Criteria

- Child metadata lineage is correct when caller identity is explicit.
- Even if this fails in some live stale-code scenario, subscription delivery still works by exact run target.

## Phase 8 — Delete Legacy Pi Wake-up Paths

### Code to Remove from Parent Wake-up Correctness

In `packages/tango/extensions/pi/index.ts`, remove or disable these from the Pi parent wake-up path:

- direct `tango watch` event delivery;
- `handleTangoEvent` / `flushTangoEvents` wake-up delivery;
- same-cwd global fallback for root sessions;
- global recent event backfill;
- global event polling safety net;
- attention `delivered` / `seen` claiming as a parent wake-up signal;
- stale watcher reaping as a correctness mechanism.

The event log, dashboard attention, and CLI `tango watch` can continue to exist elsewhere for observability. They must not wake the Pi parent unless tied to an explicit active subscription.

### Target State

- Pi parent wake-up is driven only by active subscriptions.
- The subscription poller reads exact target run state by `runId` / `runDir`.
- No global event scan can deliver a parent wake-up.
- No same-cwd fallback can deliver a parent wake-up.
- No attention record can mark a parent wake-up as delivered/seen.

### Success Criteria

- No startup flood of old done agents.
- No wake-up for agents this parent did not explicitly subscribe to.
- The source contains no active Pi wake-up call from global event watcher/backfill/poller code.

## Phase 9 — Automated Validation

Run after implementation:

```bash
npm run check --workspace @bravo/tango
npm test --workspace @bravo/tango
```

Expected:

- Typecheck passes.
- All existing tests pass.
- New subscription/lease/delivery tests pass.

## Phase 10 — Manual Hand Testing

Manual tests are mandatory. Do not consider the implementation complete until these pass.

### Test A — Async oneshot wake-up, true forget

1. Reload Pi extension or start fresh Pi session with new code.
2. Start oneshot async child:

```ts
tango_start({
  name: "sub-oneshot-proof",
  role: "scout",
  mode: "oneshot",
  wait: "none",
  task: "Wait 10 seconds, then finish with SUB_ONESHOT_PROOF_DONE. Do not ask for input."
})
```

3. Do not call `ps`, `follow`, `activity`, `result`, shell tail, or monitor tools.
4. Wait up to 45 seconds.

Success criteria:

- Parent receives a `Tango wake-up` turn without manual polling.
- Wake-up names `sub-oneshot-proof` and includes its `runId`.
- Wake-up is not a historical batch.
- After wake-up, `tango_result --run-id <id>` returns `SUB_ONESHOT_PROOF_DONE`.
- After reading result, no duplicate wake-up occurs for that same result within 60 seconds.

### Test B — Async interactive done wake-up

1. Start interactive child:

```ts
tango_start({
  name: "sub-interactive-proof",
  role: "fast-worker",
  mode: "interactive",
  wait: "none",
  task: "Wait 10 seconds, write /tmp/sub-interactive-proof.md containing SUB_INTERACTIVE_PROOF_DONE, then call tango_report done with resultFile set to that path."
})
```

2. Do not poll.
3. Wait up to 60 seconds.

Success criteria:

- Parent receives wake-up.
- `tango_result --run-id <id>` returns `SUB_INTERACTIVE_PROOF_DONE`.
- Subscription is marked handled after result read.

### Test C — Async interactive blocked wake-up

1. Start interactive child:

```ts
tango_start({
  name: "sub-blocked-proof",
  role: "fast-worker",
  mode: "interactive",
  wait: "none",
  task: "Wait 5 seconds, then call tango_report blocked with message 'BLOCKED_PROOF_NEEDS_INPUT' and needs='input'."
})
```

2. Do not poll.
3. Wait up to 45 seconds.

Success criteria:

- Parent receives wake-up for blocked state.
- Wake-up includes `needs: input` or equivalent.
- `tango_activity --run-id <id>` shows blocker context.
- After reading activity, no duplicate blocked wake-up occurs unless child reports a new blocker.

### Test D — Parent reload recovery

1. Start async child that waits 30 seconds before done.
2. Immediately reload Pi extension/session while child runs.
3. Do not poll.
4. Wait for completion.

Success criteria:

- New owner lease adopts active subscription or otherwise continues delivery.
- Parent receives exactly one wake-up.
- No historical flood occurs.

### Test E — Stale server identity

1. Ensure a Tango server is running with stale env if possible.
2. Start async child through normal Pi `tango_start`.
3. Confirm subscription targets exact `runId`.
4. Do not poll.

Success criteria:

- Parent receives wake-up even if child metadata root/workstream differs from current Pi root/workstream.
- Wake-up is due to subscription target, not same-cwd global fallback.

### Test F — Multiple same-cwd sessions isolation

If practical:

1. Open two Pi sessions in the same repository.
2. Session A starts async child A.
3. Session B starts async child B.
4. Do not poll in either.

Success criteria:

- Session A wakes only for child A.
- Session B wakes only for child B.
- No cross-session notification based only on cwd.

## Final Acceptance Criteria

Implementation is accepted only if all are true:

- `npm run check --workspace @bravo/tango` passes.
- `npm test --workspace @bravo/tango` passes.
- Async oneshot true-forget test wakes parent.
- Async interactive done true-forget test wakes parent.
- Async interactive blocked true-forget test wakes parent.
- Reload recovery test wakes parent once without historical flood.
- Reading result/activity handles the subscription and prevents duplicate wake-ups.
- Wake-up correctness does not depend on `tango watch` emitting matching events.
- Wake-ups target explicit subscribed runs, not arbitrary same-cwd historical agents.
- The legacy Pi wake-up stack has been removed from the active delivery path, not retained as a compatibility fallback.

## Rollback Plan

If subscription delivery causes regressions:

1. Fix subscription delivery directly.
2. Do not fall back to the old attention/watch/same-cwd wake-up stack.
3. Subscription records are append-only and can be inspected or ignored during debugging.
4. If an emergency disable is needed, disable async wake-ups explicitly and surface that state to the user rather than silently using the old broken path.

## Implementation Notes

- Keep messages concise to avoid model-context flooding.
- Avoid marking anything delivered/handled before the actual delivery/inspection action.
- Prefer direct run state reads over global event scans.
- Do not add compatibility shims for the old wake-up stack.
- Treat stale root/workstream metadata as an observability issue, not a wake-up blocker.
