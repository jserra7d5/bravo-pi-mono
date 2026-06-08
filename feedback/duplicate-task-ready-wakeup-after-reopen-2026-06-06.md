# Duplicate Task Ready Wakeup After Reopen / Restart

Date: 2026-06-06

## Issue

Pi frequently emits a stale `[TASK READY — NOT USER INPUT]` wakeup immediately after the parent has already reopened a task and started a new owner run with `subagent_start({ taskId })`.

Observed pattern:

1. Parent receives `TASK RESULT READY` or `TASK NEEDS INPUT`.
2. Parent reopens the task because the result is insufficient or the child was blocked.
3. Parent immediately starts a new task-owned subagent run.
4. Pi then emits a `TASK READY` wakeup for the same task, using the previous receipt path / stale task state, even though a new owner is already running.

## Why this hurts UX

- It looks like the parent failed to follow the required task orchestration rule: “Task ready means start it now.”
- The parent has to explain “duplicate ready wakeup is stale” to the user repeatedly.
- It creates uncertainty about whether there are two owners, whether the task is actually unowned, or whether the prior start failed.
- It adds noise during already complex reopen/review/remediation loops.

## Expected behavior

After a task is reopened and then claimed by a new `subagent_start({ taskId })`, any pending/stale ready notification for that task should be suppressed, coalesced, or rendered as non-actionable state-change telemetry.

Possible acceptable alternatives:

- Do not emit `TASK READY` if the task has an owner by the time the wakeup is delivered.
- Include current task ownership in the wakeup and mark it stale/non-actionable.
- Deduplicate ready wakeups by task version / attempt generation.
- If a ready event races with `subagent_start`, automatically convert it to `TASK CLAIMED` or suppress it.

## Concrete example from this session

Repeated during T-0015 remediation in Quantiiv-Agent-Gateway:

- Parent reopened T-0015.
- Parent started a new worker owner run.
- Pi emitted `[TASK READY — NOT USER INPUT]` for T-0015 with an older receipt path.
- Parent had to respond that the duplicate ready wakeup was stale.

This happened multiple times in the same remediation loop and is becoming a recurring operator-facing UX issue.
