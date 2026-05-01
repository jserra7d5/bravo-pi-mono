---
id: N-0011
title: Durable attention and delivery state
kind: task
state: open
parent: null
summary: Durable attention and delivery state
tags: []
created_at: "2026-04-27T00:47:15.259Z"
updated_at: "2026-04-27T02:24:55.665Z"
edges:
  - type: depends_on
    to: N-0002
---





# Summary

Durable attention and delivery state

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:47:49.752Z

## Implementation plan: durable attention and delivery state

### Objective

Prevent duplicate/stale wake-ups and make attention state consistent across direct CLI inspection, Pi notifications, dashboard views, and future server delivery.

### Required model

Create durable attention/delivery records keyed by:

- recipient scope: parent `runId`/`runDir` and/or `rootSessionId`;
- target child `runId`/`runDir`;
- event kind/status transition;
- event id or transition version.

Suggested state machine:

```ts
type AttentionState = "new" | "delivered" | "seen" | "handled" | "dismissed" | "superseded";
```

Rules:

- `done` child completion can become `handled` when the parent waits on the child, reads result, opens result in dashboard, or explicitly acknowledges notification.
- `blocked`, `error`, and `needs=*` can become `seen` but remain unresolved until status changes, explicit dismissal, or supersession.
- Pi/server/dashboard should deliver from the same attention queue/state. Do not maintain a separate Pi-only delivered-event file as the source of truth once server mode is active.
- Delivery must be per recipient/root session. A notification handled by one root/parent should not incorrectly suppress another legitimate recipient.

### API/CLI implications

- `tango wait` and `tango result` should mark relevant completion attention handled for the current parent/root context.
- Dashboard opening result or clicking acknowledgement should mark relevant item seen/handled through server API.
- Server SSE should notify clients that attention changed; clients reload view models.
- `tango watch`/Pi extension should avoid replaying handled items to the same recipient.

### Validation

- Parent waits on child before notification delivery; no later duplicate `done` wake-up for same parent/root.
- Parent reads `tango result child`; completion attention becomes handled.
- Blocked/error item remains visible after being seen until child status changes or item is dismissed.
- Two different root sessions do not suppress each other's attention state.


# Note 2026-04-27T02:00:43.341Z

## N-0011 review result: BLOCKED

Follow-up reviewer `n0011-attention-review` returned BLOCKED after targeted build/tests passed.

Blocking findings:

1. Recipient isolation is broken when recipient records have multiple identifiers. Current matching can match any shared identifier, so two agents in the same root session can suppress/handle each other's records. Fix requires canonical/exact recipient key semantics.
2. `tango wait` / `tango result` only mark an existing attention record handled. If no record exists yet, they silently do nothing. Fix requires upserting/handling from the event log or writing a handled tombstone keyed by target completion.

Significant risks:

- Attention store logic is duplicated in `packages/tango/src/attention.ts` and `packages/tango/extensions/pi/index.ts`, already causing duplicated bugs/drift risk.
- `superseded` state is defined but not used to retire older unresolved records for the same recipient/target run.
- Pi delivery path uses a direct-parent-only filter inconsistent with newer lineage-aware event matching.

Validation evidence from reviewer:

- `npm run build --workspace @bravo/tango && node --test packages/tango/dist/attention.test.js` passed, 16/16 attention tests, but coverage missed the blockers above.


# Note 2026-04-27T02:24:55.665Z

## N-0011 final re-review: PASS

Reviewer `n0011-attention-rereview2` returned PASS.

Resolved prior blocker:

- Pi batching now re-filters pending events before flush, coalesces by target `runDir`, and marks `seen` only for events actually delivered. Stale/superseded attention events are no longer delivered from the pending batch.

Validation:

```bash
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
npm test --workspace @bravo/tango
```

All passed; 103 tests passing.

Non-blocking risk: flush behavior is indirectly covered through attention-store deliverability semantics rather than a direct `flushTangoEvents()` unit test.
