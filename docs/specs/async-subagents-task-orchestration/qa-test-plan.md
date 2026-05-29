# Async Subagents Task Orchestration QA Test Plan

## Purpose

Verify the async-subagents task orchestration feature works end-to-end across durable task state, parent tools, task-owned child runs, child result receipts, wakeups, reconciliation, prompt behavior, and TUI rendering.

## Preconditions

- Workspace: `/home/joe/Documents/projects/bravo-pi-mono`
- Package builds successfully:
  - `npm run check --workspace @bravo/async-subagents`
- Test suite passes:
  - `npm test --workspace @bravo/async-subagents`
- Run tests in a clean Pi session with async-subagents extension enabled.
- Use a disposable repo/worktree or temp project for manual mutation tests.

## Automated Regression Suite

Run before and after manual QA:

```bash
npm run check --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
```

Expected:

- Typecheck passes.
- All async-subagents tests pass.
- No `git diff --check` whitespace errors.

## Manual QA Scenarios

### 1. Basic task creation and listing

Steps:

1. Call `task_create` with two tasks:
   - `T-0001` no dependencies
   - `T-0002` depends on `T-0001`
2. Call `task_list`.
3. Call `task_get({ taskId: "T-0001" })`.

Expected:

- `T-0001` derived state is `ready`.
- `T-0002` derived state is `blocked`.
- `task_get` default view returns compact status/pointers only, not full bodies.

### 2. Canonical task-owned launch

Steps:

1. Start a child with `subagent_start({ agent: "worker", task: "...", taskId: "T-0001" })`.
2. Inspect `task_get({ taskId: "T-0001" })`.
3. Verify no separate task-specific spawn tool is exposed.

Expected:

- `subagent_start` returns both `runId` and `taskId`.
- Task status becomes `running`.
- Task owner records run ID, agent, display name, and token hash.
- No `task_start_subagent` / `task_assign_subagent` tool exists.

### 3. Blocked task launch rejection

Steps:

1. Attempt `subagent_start({ agent: "worker", task: "...", taskId: "T-0002" })` while dependency is incomplete.

Expected:

- Tool returns structured `TASK_NOT_READY` error.
- Task remains unowned and not running.
- No child run is launched.

### 4. Child task result submission

Steps:

1. Let the task-owned child complete using `task_submit_result`.
2. Wait for parent wakeup.
3. Call `task_get({ taskId: "T-0001" })`.
4. Call `task_get({ taskId: "T-0001", view: "receipt" })`.

Expected:

- Parent receives `[TASK RESULT READY — NOT USER INPUT]` wakeup.
- Task status is `result_ready`.
- Default `task_get` shows summary and receipt/artifact pointers only.
- `receipt` view shows bounded receipt details.
- Child final answer is brief and does not duplicate the full receipt.

### 5. Parent acceptance unlocks dependents

Steps:

1. Call `task_accept_result({ taskId: "T-0001" })`.
2. Call `task_list`.

Expected:

- `T-0001` status becomes `completed`.
- `T-0002` derived state becomes `ready`.
- Relevant wakeups are marked handled.

### 6. Child progress and blocker tools

Steps:

1. Start a task-owned child.
2. Have it call `task_update_progress`.
3. Have it call `task_report_blocked`.

Expected:

- Progress updates append events but do not wake parent by default.
- Blocker report emits actionable parent wakeup.
- Task remains owned/running unless parent reopens/cancels.

### 7. Run/task reconciliation

Steps:

1. Start a task-owned child that exits normally without calling `task_submit_result`.
2. Trigger task listing or wakeup polling.

Expected:

- Task does not remain silently `running` forever.
- Parent receives needs-input/failure style task wakeup.
- Reconciliation is idempotent; repeated `task_list` / `task_get` does not append duplicate events for the same terminal run.

### 8. Failed/cancelled child reconciliation

Steps:

1. Start a task-owned child.
2. Cancel or force a failure.
3. Inspect task state and wakeups.

Expected:

- Task transitions to failed/cancelled policy state or emits parent-actionable event.
- Parent sees compact wakeup.
- Owner/attempt history is retained consistently.

### 9. Reopen without force protects downstream work

Steps:

1. Complete a dependency chain `T-0001 -> T-0002`.
2. Call `task_reopen({ taskId: "T-0001", reason: "..." })` without `force`.

Expected:

- Tool rejects with affected dependents listed.
- No downstream task is silently invalidated.

### 10. Force reopen invalidates transitive dependents

Steps:

1. Complete chain `T-0001 -> T-0002 -> T-0003`.
2. Call `task_reopen({ taskId: "T-0001", reason: "...", force: true })`.
3. Inspect all three tasks.

Expected:

- `T-0001` is pending/reopened.
- `T-0002` and `T-0003` are also pending.
- Downstream results are marked `superseded`.
- Active downstream owners are cleared and attempts ended/cancelled.
- Tool response lists affected dependents and `subagent_interrupt` next actions for any active owned runs.

### 11. Cancellation behavior

Steps:

1. Start a task-owned child.
2. Call `task_cancel({ taskId, reason })`.

Expected:

- Task status becomes `cancelled`.
- If owner run is active, response suggests `subagent_interrupt` next action.
- Relevant wakeup is marked handled.

### 12. Child authority and token validation

Steps:

1. Attempt child task tools without task env.
2. Attempt task submission with wrong token/run ID.
3. Attempt child-owned submission for another task.

Expected:

- All unauthorized mutations fail with structured authority/owner errors.
- Parent-only task tools reject in child context.
- Read-only task tools behavior matches documented policy.

### 13. Different child cwd

Steps:

1. Create a task in parent session cwd.
2. Start child with `subagent_start({ cwd: <different directory>, taskId })`.
3. Child submits task result.

Expected:

- Child task tools resolve the parent task store through injected run root, not `process.cwd()`.
- Submission succeeds and parent task becomes `result_ready`.

### 14. Wakeup delivery and handled state

Steps:

1. Produce `task.result_submitted` wakeup.
2. Call `task_get`.
3. Poll wakeups again.
4. Repeat with direct `task_accept_result`, `task_reopen`, and `task_cancel` paths.

Expected:

- Wakeup is delivered once.
- Retrieval or action marks relevant delivery keys handled.
- Stale delivered/claim files do not permanently suppress future wakeups after TTL.

### 15. Prompt behavior

Steps:

1. Start a non-task child.
2. Start a task-owned child.
3. Inspect generated `artifacts/system.md` and `artifacts/task.md` for both runs.

Expected:

- Non-task child retains normal final-answer contract.
- Task-owned child receives `Task-Owned Result Contract`.
- Task assignment block includes task ID/title/dependencies.
- Task-owned prompt tells child to use `task_submit_result` and keep final answer brief.
- Prompt changes are in universal prompt assembly, not duplicated into `agents/*.md`.

### 16. TUI widget rendering

Steps:

1. Run a mix of:
   - task-owned running child
   - result-ready task
   - ready task
   - blocked task
2. Observe async-subagents widget at terminal widths around 96, 72, 56, 44, and 32 columns.

Expected:

- Existing async-subagents widget is enriched; no duplicate footer/status surface.
- Run rows show assigned task ID/title/status when present.
- Task section prioritizes `result_ready`, `running`, `ready`, `blocked`.
- Narrow widths do not wrap/corrupt chrome.
- ANSI colors reset correctly.
- Completed tasks hide after grace period.

### 17. Compaction reminder

Steps:

1. Create active/result-ready/ready/blocked tasks.
2. Trigger session compaction reminder.

Expected:

- Reminder includes compact task counts and high-signal task IDs.
- No full task descriptions or receipts are dumped.

### 18. Persistence across Pi restart

Steps:

1. Create tasks and start a task-owned child.
2. Restart/reopen Pi session.
3. Call `task_list`, inspect widget/wakeups.

Expected:

- Task state persists under root session.
- Run/task ownership is recoverable.
- Wakeups and handled state are durable and not duplicated unnecessarily.

### 19. Bulk task clearing (task_clear)

Steps:

1. Create a mix of tasks:
   - T-0001 (completed/accepted)
   - T-0002 (running/pending)
   - T-0003 (ready/blocked)
2. Call `task_clear({ reason: "iterative cleanup" })`.
3. Call `task_list`.

Expected:

- T-0001 (already completed) remains status `completed`.
- T-0002 and T-0003 status become `cancelled`.
- Tool returns count of cancelled tasks (2) and list of affected task IDs (`["T-0002", "T-0003"]`).
- Tool response explicitly states that cancelled tasks are preserved in history and new tasks will continue numbering.
- Creating subsequent tasks continues numbering (e.g. `T-0004`) to prevent ID collisions.

## Negative / Edge Cases

- Duplicate task aliases are rejected.
- Unknown dependencies are rejected.
- Dependency cycles are rejected.
- Empty result summary is rejected.
- Oversized receipt is rejected.
- Artifact paths outside allowed roots are rejected.
- Launch failure rolls back task owner and closes attempt.
- Lock contention either serializes mutation or returns deterministic contention error.

## Acceptance Criteria

Feature is QA-ready when:

- Automated suite passes.
- Manual scenarios 1-18 pass in a real Pi session.
- No duplicate spawn tool exists.
- No default context dumps from `task_get` or wakeups.
- Task-owned child output is not duplicated between task receipt and final answer.
- TUI remains stable at narrow widths.
- Reopen/force-reopen preserves dependency invariants.
- All discovered defects have either fixes or explicit documented follow-up issues.
