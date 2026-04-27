# Tango Parent Wake-up Subscriptions

Date: 2026-04-27
Status: Draft

## Problem

Tango needs asynchronous child agents, especially interactive agents that can continue working without blocking the parent Pi session. The current detached wake-up path is unreliable because it depends on ambient lineage and global event watching:

- child agents may be stamped with stale `rootSessionId` / `workstreamId` by long-lived server or tool processes;
- stale Pi extension watcher processes can claim events and mark attention as delivered/seen;
- `tango watch` applies CLI-side lineage filtering before the Pi extension can apply its own rules;
- broad startup backfill can flood the parent with historical completed agents;
- attention state can say `seen` even when no parent LLM turn was actually triggered.

Repeated fixes have patched symptoms in watcher filtering, backfill, server lineage, and event polling. The underlying design issue is that the parent delivery contract is implicit: “some future event matching this session’s ambient lineage should wake this parent.” That contract is too fragile.

## Goal

Make asynchronous parent wake-up reliable by replacing ambient event matching with explicit parent subscriptions.

When a Pi parent starts an async Tango child, it records a durable subscription to that exact child run. Wake-up delivery then asks:

> Has subscribed run `run_...` reached a notify-worthy state?

not:

> Does this global event maybe belong to my current root/workstream/cwd?

## Non-goals

- Do not remove detached async agents.
- Do not make all Tango starts blocking.
- Do not depend on the optional Tango server for parent wake-up correctness.
- Do not make the global event log the primary delivery contract.
- Do not preserve compatibility with stale ambient-lineage behavior.

## Design Summary

Introduce a durable subscription store and a Pi-session delivery loop.

1. `tango_start` registers a subscription when starting an async child.
2. The root Pi extension periodically checks subscribed runs directly by `runId` / `runDir`.
3. If a subscribed run reaches `blocked`, `error`, or `done + result-ready`, the extension calls `pi.sendUserMessage(...)` to wake the parent.
4. The subscription is marked `notified` only after the wake-up call is attempted by the current session owner.
5. The subscription is marked `handled` when the parent inspects the result/activity or otherwise acknowledges it.
6. A session-owner lease prevents stale extension instances from delivering or claiming subscriptions.

The existing event log, CLI `tango watch`, dashboard, and attention records remain useful for observability, but they must not deliver Pi parent wake-ups.

## Subscription Model

### Subscription Record

A subscription records that one Pi parent session wants wake-ups for one child run.

```json
{
  "schemaVersion": 1,
  "subscriptionId": "sub_...",
  "recipient": {
    "ownerId": "owner_...",
    "rootSessionId": "sess_...",
    "workstreamId": "ws_...",
    "cwd": "/repo",
    "sessionKind": "pi"
  },
  "target": {
    "runId": "run_...",
    "runDir": "/home/user/.tango/runs/project/agent",
    "agentName": "agent-name"
  },
  "notifyOn": ["blocked", "error", "done", "result-ready", "checkpoint"],
  "state": "active",
  "lastObservedStatus": "running",
  "lastObservedResultFinalizedAt": null,
  "lastDeliveredKey": null,
  "createdAt": "2026-04-27T00:00:00.000Z",
  "updatedAt": "2026-04-27T00:00:00.000Z",
  "expiresAt": "2026-04-28T00:00:00.000Z"
}
```

### Subscription States

- `active`: subscription is live and should be checked.
- `notified`: wake-up was sent for the current deliverable state.
- `handled`: parent inspected or acknowledged the deliverable state.
- `dismissed`: user/parent intentionally dismissed it.
- `expired`: subscription TTL elapsed.
- `orphaned`: target run no longer exists or is unreadable.

Avoid ambiguous names such as `seen` for delivery correctness. `seen` previously meant “a watcher touched this event,” not “the parent LLM actually got a turn.”

### Delivery Key

Each notify-worthy state gets a stable delivery key to suppress duplicates:

- blocked/error: `status:<status>:<updatedAt or lastReportAt>`
- done with result: `done:<resultFinalizedAt>`
- done with result issue: `done-issue:<resultIssue>`
- checkpoint: `checkpoint:<checkpointId or lastReportAt>`

A subscription can move from `notified` back to `active` only if the target reaches a new delivery key.

## Parent Owner Lease

Stale extension instances must not claim delivery. Each root Pi extension instance creates a session-owner lease:

```json
{
  "schemaVersion": 1,
  "ownerId": "owner_...",
  "rootSessionId": "sess_...",
  "workstreamId": "ws_...",
  "cwd": "/repo",
  "pid": 12345,
  "createdAt": "...",
  "heartbeatAt": "...",
  "expiresAt": "..."
}
```

Rules:

- On extension startup, create a fresh `ownerId` and heartbeat the lease.
- Only the current live owner for `(cwd, rootSessionId, workstreamId)` may deliver subscriptions for that recipient.
- If an old extension process sees that its owner lease is no longer current, it stops delivery loops.
- Lease expiry should be short, e.g. 10–30 seconds, with heartbeat every 2–5 seconds.

This replaces best-effort process reaping as the primary stale-owner protection. Process reaping can remain as hygiene, but correctness should come from leases.

## Starting Agents

### Pi Tool API

Add explicit wait semantics to `tango_start`:

```ts
wait?: "none" | "terminal" | "result-resolved" | "checkpoint";
detached?: boolean; // optional alias for wait: "none"
notifyOn?: Array<"blocked" | "error" | "done" | "result-ready" | "checkpoint">;
subscriptionTtlMs?: number;
```

Recommended defaults:

- oneshot: `wait: "result-resolved"` unless explicitly detached;
- interactive: `wait: "none"` or `wait: "checkpoint"` depending on role/task;
- explicit `detached: true`: equivalent to `wait: "none"` and registers a subscription.

For async starts, `tango_start` must register the subscription before returning the tool result to the parent.

### Server Start Requests

The server must not stamp children using stale server-process env. `/api/v1/runs/start` should accept explicit caller identity:

```json
{
  "rootSessionId": "sess_...",
  "workstreamId": "ws_...",
  "parentRunId": "run_...",
  "parentRunDir": "..."
}
```

The CLI/Pi tools should always include available caller identity. The server should prefer request identity over `process.env`.

This remains useful for metadata and dashboard lineage, but parent wake-up should rely on subscriptions by run ID, not ambient lineage matching.

## Delivery Loop

The Pi extension runs a subscription poller:

1. Verify this extension instance owns the current lease.
2. Load active subscriptions for this owner/root/cwd.
3. For each subscription, read the target `RunState` by `runDir` or `runId`.
4. Compute the target’s notify-worthy delivery key.
5. If no new delivery key exists, continue.
6. Build a concise wake-up message.
7. Call `pi.sendUserMessage(message, { deliverAs: "followUp" })`.
8. Mark subscription `notified` with the delivery key and timestamp.

Poll interval should be short enough for good UX, e.g. 2–5 seconds. The store is local and small, so direct polling is acceptable and more robust than relying on a pipe from `tango watch`.

### Wake-up Message Format

Keep wake-up messages small and specific:

```text
Tango wake-up (not a user request):

agent-name is done and result is ready.
Run: run_...
Next: tango_result --run-id run_...

Instructions:
- Inspect the result if relevant to the active task.
- Continue the ongoing workstream.
- Do not summarize this notification unless the original task is complete, blocked, or needs a decision.
```

Avoid batching many historical agents into one message. If multiple current subscriptions become ready simultaneously, cap the batch and include only active subscriptions owned by this session.

## Handling and Acknowledgement

A subscription should be marked handled when:

- `tango_result` is called for the subscribed run and the result is ready;
- `tango_activity` is called for a blocked/error subscribed run;
- the parent explicitly acknowledges/dismisses it;
- the child is stopped/deleted and no further notification is useful.

The Pi wrappers can perform this automatically after successful result/activity reads.

## Relationship to Existing Attention Records

Attention records can be retained for dashboard visibility and cross-session status, but they should not drive parent wake-up correctness.

Recommended evolution:

- Subscription delivery writes or links to an attention record for UI visibility.
- Attention `seen` should be renamed or narrowed if retained.
- Parent wake-up state should live in subscriptions: `active`, `notified`, `handled`, etc.

## Relationship to `tango watch`

`tango watch` remains useful for:

- dashboard streaming;
- human CLI event watching;
- diagnostics;
- optional low-latency hints to trigger immediate subscription checks.

`tango watch` must not wake Pi parents. If low-latency hints are reintroduced later, they may only trigger an immediate subscription check; delivery still requires an explicit active subscription.

## Failure Modes and Recovery

### Parent Pi session exits

The owner lease expires. Subscriptions remain durable. On resume/reload, a new owner can either:

- adopt active subscriptions for the same root/cwd if still relevant; or
- show pending subscriptions in a compact recovery wake-up.

Adoption should be conservative to avoid historical floods.

### Child completes while parent is down

On next startup, recovery inspects only active subscriptions, not global historical events. This avoids flooding and ensures only children explicitly started by this parent are reported.

### Stale server stamps wrong root identity

Subscription still points to exact `runId`/`runDir`, so delivery succeeds even if metadata root/workstream is stale. Metadata lineage can be corrected separately.

### Duplicate extension instances

Only current lease owner may mark subscription `notified`. Old instances should stop when they lose lease.

### `sendUserMessage` fails

Do not mark `notified`. Record `lastDeliveryError` and retry with backoff. Surface a UI notification if available.

## Testing Plan

### Unit tests

- subscription create/update/read de-duplicates by recipient + target run;
- delivery key computation for blocked/error/done/result-ready/checkpoint;
- lease owner election and stale-owner rejection;
- handled transitions after result/activity reads;
- TTL expiry and orphaned target handling.

### Integration tests

- async oneshot start registers subscription and wakes parent when result-ready;
- async interactive start registers subscription and wakes parent on `blocked`;
- async interactive wakes parent on `done` with result file;
- stale server env does not prevent delivery because subscription targets run ID;
- stale watcher process cannot mark subscription notified without lease;
- parent reload adopts recent active subscriptions without historical flood;
- multiple same-cwd Pi sessions do not receive each other’s subscribed child wake-ups.

### Manual proof

A valid manual proof must be true fire-and-forget:

1. Start async child from Pi root.
2. Do not call `follow`, `ps`, `activity`, `result`, or shell-tail event logs.
3. Wait for child completion.
4. Confirm the parent receives a `Tango wake-up` turn.
5. Inspect result only after the wake-up.

## Migration Plan

1. Add `subscriptions.ts` store and tests.
2. Add Pi owner lease store and tests.
3. Update `tango_start` Pi wrapper to register subscriptions for async starts.
4. Add subscription poller to Pi extension.
5. Update `tango_result` / `tango_activity` wrappers to mark subscriptions handled.
6. Remove the Pi parent wake-up path based on attention/watch/global backfill/same-cwd matching.
7. Keep attention/watch only as CLI/dashboard observability, not as Pi wake-up delivery.
8. Document wait modes and async subscription semantics.

## Open Questions

- Should interactive starts default to `wait: "none"` or `wait: "checkpoint"`?
- What is the right default TTL for subscriptions: 24h, 7d, or until handled?
- Should subscriptions be per Pi session owner, per root session, or both?
- Do we need explicit child checkpoint events, or can `tango_report running --needs/checkpoint` cover this?
- How should dashboard expose active/notified/handled subscriptions?

## Recommendation

Stop patching ambient event delivery. Implement explicit parent wake-up subscriptions keyed by child `runId` / `runDir`, with a root Pi owner lease and direct polling of subscribed run state. Keep global events and watchers only for observability; subscriptions are the only Pi parent wake-up path.
