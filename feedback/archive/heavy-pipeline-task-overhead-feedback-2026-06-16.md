# Archived Feedback: Reduce task-management overhead in heavy pipelined workflows

Date: 2026-06-16
Archived: 2026-06-16
Resolution: Addressed by the async-subagents milestone-task simplification. Tasks are now parent-owned milestone board entries with `status` and derived `readiness`; child runs are normal execution attempts; `task_create`/`task_update` return `newly_ready` synchronously; task-owned child lifecycle, result-ready acceptance, and task-ready wakeups were removed.

## Problem

In heavy remediation workflows, the previous task loop could create too much ceremony:

- accept failed review result
- reopen implementation task
- receive ready wakeup
- start worker
- accept worker result
- receive review-ready wakeup
- start reviewer
- repeat for every small finding

This was useful for durable dependency gates, but it became noisy when each tiny review finding became a full task lifecycle transition. The overhead slowed down closure and made the operator experience feel like task shuffling rather than engineering progress.

## Desired behavior

Use tasks for coarse, durable lanes and hard gates, not every attempt inside a lane.

Good task granularity:

- `Email Q0 green`
- `Workbench Q0 green`
- `Prompt contract green`
- `Final combined Q0`

Poor task granularity:

- `fix stale prompt test`
- `review same fix again`
- `fix one validator edge`
- `rerun one narrow assertion`

## Recommended workflow pattern

### 1. Tasks represent lane-level milestones

A task should remain active while that lane iterates through implementation, review, fixes, and focused validation.

Only mark it done when the lane is truly green.

### 2. Use direct child agents for attempts inside a lane

Inside a lane:

1. launch worker directly for remediation
2. launch reviewer directly for review
3. if review fails, send findings to a worker directly
4. repeat until green
5. update the lane task to done once

Avoid reopening/updating the task for every attempt unless milestone status or dependency state really changed.

### 3. Track attempt history in a lane receipt

Instead of using task state transitions as the attempt log, maintain a lane receipt/status artifact, e.g.:

- `local/.../email-lane-status.md`
- `local/.../workbench-lane-status.md`
- task notes with appended attempts

The receipt should capture:

- findings
- fixes attempted
- tests run
- current blocker
- green criteria remaining

### 4. Use task dependencies only for hard gates

Examples:

- Email retest depends on email lane green.
- Workbench retest depends on Workbench lane green.
- Combined Q0 depends on email retest + Workbench retest.

Do not model every review/fix cycle as a dependency edge.

### 5. Preserve pipeline behavior at lane level

This recommendation should not serialize work. Keep coarse sibling lanes running in parallel when their write scopes are safe:

- email runtime lane
- Workbench semantic lane
- prompt consistency lane
- final smoke/retest lane

But within each lane, avoid task lifecycle churn for micro-iterations.

## Rule of thumb

If a result does not unblock a different lane or change the global dependency graph, it probably should not be a new task transition. It should be an attempt recorded inside the lane.

## Expected benefit

- Less control-plane noise
- Faster remediation loops
- Clearer operator mental model
- Same durable gates for real dependencies
- Better fit for pipelined engineering work
