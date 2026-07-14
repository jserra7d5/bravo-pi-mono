# Lifecycle Contract

> **Superseded:** `docs/specs/unified-task-plane/` is the current contract. This document is retained as historical record, not current instructions.

Status: implemented
Applies to: `BackgroundRunner`, `TaskRegistry`, `background_task_stop`, session reload/shutdown handlers

## Ownership rule

`BackgroundRunner` remains the semantic owner of background task lifecycle. Wakeups are emitted from the same lifecycle path that records terminal state.

Forbidden alternatives:

- Monitor-based workload wrappers.
- Agent polling loops.
- A second filesystem watcher that infers completion from metadata after the fact.
- A task-control tool that both queries and emits wakeups.

## Lifecycle states

Existing task states remain:

```ts
type TaskStatus =
  | "starting"
  | "running"
  | "blocked"
  | "exited"
  | "failed"
  | "timed_out"
  | "killed"
  | "orphaned"
  | "unknown";
```

Terminal states for wakeup v1:

- `exited`
- `failed`
- `timed_out`
- `killed`

Non-waking attention states:

- `blocked` is not terminal. It may update UI/metadata, but does not emit the terminal wake event.
- `orphaned` and `unknown` are reconciliation attention states, not normal task completion. They must not trigger model wakeups in v1 unless a later contract explicitly adds reconciliation alerts.

## Terminal finalization helper

Implement one idempotent terminal-finalization path used by exit, timeout, output-cap kill, stop, and spawn-error-after-record where applicable. Session shutdown writes terminal metadata/log sentinels but does not model-wake in v1.

Conceptual shape:

```ts
type FinalizeTaskInput = {
  task: BackgroundTaskRecord;
  status: "exited" | "failed" | "timed_out" | "killed";
  exitCode?: number | null;
  signal?: string | null;
  stopReason?: StopReason;
  endedAt: string;
};
```

The helper must:

1. Merge terminal facts into the task record.
2. Append a lifecycle sentinel to the output log.
3. Persist the terminal record with `TaskRegistry.upsert()`.
4. If wake is enabled and the terminal cause is not session shutdown, acquire the durable notification claim and freeze the wake-visible terminal facts as `modelWakeCanonicalTerminal`.
5. Only after durable terminal persistence and successful claim acquisition, invoke the wake notification path using the canonical terminal facts.
6. Return the persisted terminal record.

## Exactly-once transition invariant

For each task id, at most one model wake is attempted for the first normal terminal transition.

Required safeguards:

- In-memory idempotence guard for races within one runtime process.
- A durable per-task notification claim that is atomic across finalizers/runtimes. Acceptable mechanisms include exclusive lock-file creation, lock-directory creation, atomic rename, or a real compare-and-swap primitive. Ordinary read-then-`TaskRegistry.upsert()` is not sufficient.
- Persisted notification marker to survive reload/reconcile.
- Terminal helper must re-read or receive the latest persisted record before dispatch if races are possible.
- Stop/exit/reconcile race must choose one winning notification claimant; the first claimant's wake-visible terminal facts are canonical.
- After any `modelWakeState` reaches `claim_acquired`, `send_attempted`, `accepted`, `send_failed`, or `routing_failed`, later finalizers must not mutate wake-visible fields (`status`, `exitCode`, `signal`, `stopReason`, `endedAt`) away from `modelWakeCanonicalTerminal`.
- Later finalizers may append non-conflicting supplemental diagnostics only, such as `lateExitObservedAt` or `lateExitSignal`, and those fields must not be used in wake payloads.
- Tests must deliberately race stop/exit/finalize attempts and prove only one dispatch can acquire the claim and that post-wake `background_task_status` still agrees with the wake payload.

## Stop semantics

Current implementation can mark a task `killed` from `stop()` before the child process `exit` callback runs. Wakeup implementation must make this safe.

Acceptable v1 approaches:

### Preferred: wake on actual process exit

- `stop()` records stop requested / `stopReason: "user"` and sends termination signal.
- The child `exit` callback finalizes `killed` with actual signal/exit facts and emits wake if enabled.
- If no live child handle is owned by the runtime, `stop()` must not claim successful terminal completion; it keeps existing orphan-safety behavior.

### Compatible fallback: wake on stop-request terminal write

- `stop()` may continue to persist `killed` immediately.
- It must set enough facts for the wake event: `stopReason: "user"`, requested signal, ended/terminal timestamp, output path.
- The later `exit` callback must detect that notification was already claimed/attempted and must not re-wake or alter canonical wake-visible terminal facts.

The preferred approach produces better evidence and should be used unless it would break existing control semantics.

## Timeout/output-cap semantics

- Timeout uses configured process maximum runtime and must terminate the owned process tree.
- Output-cap kill remains `killed` with `stopReason: "output_cap"`.
- Timeout wake summary must include the runtime limit.
- Output-cap wake summary must say the task was stopped due to output cap and that the full log may itself be capped.

## Reload/reconcile semantics

- A task that is already terminal and has any notification marker must not wake during reload/reconcile.
- Same-session reload of a wake-enabled running task must be explicit: either reconstruct a safe owner-session notifier/watcher and preserve wake eligibility, or persist a routing/liveness failure explaining that wake delivery is impossible after reload.
- Silent loss of wake eligibility after same-session reload is forbidden.
- A live running task after reload that cannot be safely reattached remains `orphaned`/`unknown`; v1 does not emit model wake for that classification, but wake-enabled tasks must record why no future terminal wake can be delivered.
- Reconcile in a different session must not acquire notification claims for tasks owned by another session.
- If a future implementation supports reattached live children, the reattached exit path must use the same terminal-finalization helper.

## Session shutdown semantics

Session shutdown is a teardown path, not an agent-resume path.

- Default v1 behavior: shutdown may kill non-persistent owned tasks and persist `killed` / `stopReason: "shutdown"`, but it must not trigger a model wake.
- Shutdown output logs should include a sentinel explaining that wake was suppressed due to session shutdown.
- A later release may add shutdown wakeups only if Pi guarantees delivery before teardown and a dedicated validation case proves the session remains a valid target.

## Registry ordering

The task registry and metadata must be updated before the model wake is emitted. When the agent receives the wake and calls `background_task_status`, it must see status/exit/output facts that agree with the wake payload. Once a wake claim freezes `modelWakeCanonicalTerminal`, status reads must continue to reflect those canonical wake-visible facts even if later process callbacks observe additional exit details.
