# Async-subagents Reporter Semantics

## Producer

The reporter lives in the Pi extension because only that runtime has all required context together:

- current Pi session ID (`piSessionIdOf(ctx)` in `extensions/pi/index.ts`);
- exact async root (`ensureRoot`);
- canonical aggregate/run reconciliation (`extensions/pi/liveWidget.ts` and watcher/read models);
- heartbeat cadence (`tickAsyncTasksPoll`, currently 2 seconds);
- session start/shutdown hooks.

Do not put this reporter in child-control extensions or individual subagent processes. The lead Pi report is one authoritative composite snapshot.

## Count derivation

Introduce a dedicated projection in async-subagents:

```ts
readRunningSubagentCount({
  store,
  parentRunId: identity.parentRunId,
  rootSessionId: identity.rootSessionId,
  records,
}): number
```

It must use the same canonical scoped records and reconciliation path as the current live widget, then count exactly `row.state === "running"`. The function must not derive from rendered widget rows or `AsyncSubagentsActivityState.activeCount`.

Property: for any reconciled row set, the reported number equals the cardinality of rows with exact state `running`; changes to blocked/result-ready presentation cannot affect it.

## Reporting schedule

- On `session_start`: resolve identity, send immediately after normal root initialization.
- On each existing 2-second async task poll: send a heartbeat even when count is unchanged, including zero.
- After any extension-owned mutation: schedule an immediate report, while preserving one-in-flight/latest-pending coalescing.
- On `session_shutdown`: best-effort explicit clear; correctness still relies on TTL.
- On socket errors/timeouts: do not block Pi, mutate lifecycle state, or retry in a tight loop. The next normal heartbeat retries.

Reuse the scheduler shape in `extensions/pi/index.ts` (`reportHerdrMetadataState` / latest-pending drain), but create a browser-workspace-specific reporter and protocol. Do not route through Herdr or couple the two deliveries. Reporter I/O timeout target: 500 ms, below the 2-second poll cadence.

## Identity and instance fields

Every heartbeat includes:

- exact `workspace.name` (`bw-*`);
- exact tmux server socket identity and immutable tmux session ID;
- `lead.piSessionId` (required);
- `lead.rootSessionId` (required);
- per-reporter random `reporterInstanceId` generated on Pi session extension start;
- strictly increasing `sequence` within that reporter instance;
- `runningCount`;
- bounded requested `ttlMs`.

Do not infer lead identity from cwd. Do not permit a lead Pi with no stable Pi session ID to publish; fail quiet and log/diagnose locally.

## Sequence/restart behavior

Sequence orders reports only within one `reporterInstanceId`. A new instance for the same exact `(workspace, piSessionId, rootSessionId)` may supersede the old instance; after takeover, late reports from the old instance are rejected while the replacement lease is unexpired. This prevents delayed clears/counts from rolling back a restarted reporter.

If a different lead identity reports for a workspace with an unexpired lease, reject it as a conflict and keep the existing projection. This prevents two lead Pi sessions in one tmux workspace from silently replacing each other. The operational fix is to stop one lead or wait for expiry.

## Observability

Reporter diagnostics should be rate-limited and local:

- socket unavailable/timeout;
- not running in an exact `bw-*` tmux workspace;
- rejected report with stable error code;
- identity conflict.

Do not put task bodies, run IDs, child names, cwd, summaries, result content, or terminal output in this protocol or logs.