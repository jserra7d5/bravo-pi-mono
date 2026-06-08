# Task Ready Stale Wakeup After Task Was Already Claimed

Date: 2026-06-05

## Summary

The task system emitted a `TASK READY` wakeup for a task that had already been started/claimed by a subagent in the immediately preceding parent-agent turn.

This created a stale control-plane instruction that told the parent to start a task that was no longer actually unowned.

## Concrete Instance

Parent created a three-task plan:

- `T-0044` implement
- `T-0045` review, depends on implementation
- `T-0046` push/live validate, depends on review

The task creation result correctly said one task was ready. The parent immediately started it:

```text
subagent_start({ taskId: "T-0044", agent: "worker", ... })
```

The tool returned:

```text
Subagent run_mq0jo22y_qZvmU87qvS0 started: @Jordan (worker) (running)
```

After that, the session received a control-plane wakeup:

```text
[TASK READY — NOT USER INPUT]

Task: T-0044 Implement LLM-default company clarification and Demo Burger suppression
Summary: Task ready to start: T-0044 Implement LLM-default company clarification and Demo Burger suppression

This task's dependencies are satisfied and it has no owner. Start it now: subagent_start({ taskId: "T-0044", agent: "<agent>" }).
```

At that point the wakeup was stale: T-0044 had already been claimed by the subagent run.

## Why This Is Bad

The wakeup instruction is strong and imperative:

> Start it now

A parent agent following the instruction literally may try to start the same task twice. Even if the backend rejects the duplicate claim, this causes unnecessary tool calls and confusing state. Worse, if any race allows double execution, it could produce duplicate implementation attempts in the same dirty worktree.

This also erodes trust in task wakeups: the parent has to defensively remember prior tool calls instead of trusting `TASK READY` as current state.

## Expected Behavior

A `TASK READY` wakeup should only be emitted if, at delivery/render time, the task is still:

- dependency-satisfied,
- unowned,
- not running,
- not result-ready/completed/cancelled.

If the task was claimed between ready-event creation and wakeup delivery, the wakeup should be suppressed or downgraded to a compact state-change note such as:

```text
[TASK CLAIMED — NOT USER INPUT]
T-0044 was claimed by run_mq0jo22y_qZvmU87qvS0 before this ready wakeup was delivered.
No action needed.
```

But ideally no wakeup is sent at all for already-obsolete ready state.

## Suggested Fix

Add a final freshness check before emitting/rendering `TASK READY` wakeups:

1. Load current task row by id.
2. Verify derived readiness still holds.
3. Verify `owner_run_id` / claim field is empty.
4. Verify state is still pending/ready, not running/result-ready/completed/cancelled.
5. If not fresh, drop the wakeup or emit a non-actionable diagnostic only when debugging is enabled.

Also consider making the ready wakeup idempotency key include a readiness generation/version, invalidated by claim transitions.

## UX Contract Recommendation

Control-plane wakeups that contain imperative instructions should be fresh by construction. If a wakeup may be stale, its text should avoid commands like "Start it now" and instead say "Check task_list before acting." But the better contract is to suppress stale actionable wakeups.
