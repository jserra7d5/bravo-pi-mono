# Task ready wakeup / empty receipt bug report

Date: 2026-06-02
Reporter: Pi root-session agent during Quantiiv ROGER/QAS work

## Summary

The task orchestration layer produced confusing/stale `TASK READY` wakeups after a task-owned subagent had already been started. A task-owned scout also completed with an empty/placeholder result body, and the native task/result APIs did not expose the expected receipt details, requiring reopen/retry.

## Observed sequence

1. Created a dependency-ordered plan with `task_create` for QAS scout → plan → implement → review.
2. Immediately started ready task `T-0001` with `subagent_start({ taskId: "T-0001", agent: "scout", variant: "gemini" })`.
3. After the start call returned a running subagent, the session received a `TASK READY` wakeup saying `T-0001` had no owner and should be started.
   - This appeared stale/incorrect because the task had just been claimed by the subagent.
   - Starting another scout would have duplicated the work.
4. The first scout completed, but the wakeup/result body only said `Submitted result for T-0001` instead of the actual requested findings.
5. `task_get({ taskId: "T-0001", view: "receipt" })` and `view: "full"` did not reveal the submitted receipt details; they returned only the task title/status shell.
6. `subagent_result(...)` also only returned the placeholder text.
7. I reopened the task with explicit instructions to return the actual findings and restarted it.
8. Another stale `TASK READY` wakeup arrived for `T-0001` after the restart, again implying no owner even though the replacement subagent was already running.

## Expected behavior

- Once `subagent_start({ taskId })` claims a ready task, no subsequent stale `TASK READY` wakeup should tell the parent to start the same task unless the claim failed or was released.
- Task result wakeups and `task_get(view="receipt"|"full")` should expose the child-submitted receipt body, or at least a reliable pointer to it.
- If a task-owned subagent submits an empty/placeholder receipt, the task layer should preserve enough context for the parent to diagnose whether the child failed to write the receipt or the task API failed to surface it.

## Actual behavior

- Duplicate/stale ready wakeups made the task appear unowned while a task-owned subagent was active.
- The task receipt/result surfaces exposed only placeholder text (`Submitted result for T-0001`) and not the actual deliverable.
- Parent had to infer failure, reopen, and rerun the task.

## Impact

- Risk of accidentally launching duplicate child agents for the same task.
- Parent cannot reliably review/accept task results if receipts are not surfaced.
- Breaks the intended task workflow: ready → start owner → result-ready → inspect receipt → accept/reopen.

## Suggested fixes

1. Suppress or coalesce `TASK READY` wakeups after a successful task claim, or include owner/run id in the wakeup if it races with a claim.
2. Make `task_get(view="receipt")` return the submitted receipt body and metadata unambiguously.
3. Add a diagnostic state when a child submits only placeholder text, distinguishing child-output failure from task-surface retrieval failure.
4. Consider idempotency on `subagent_start({ taskId })` so a duplicate start attempt returns the existing owner rather than risking another run.

## Addendum: repeated during generalized stream design planning

Date: 2026-06-03
Reporter: Pi root-session agent during Quantiiv generalized ROGER/QAS live event stream design planning

### Observed sequence

1. Created a four-task dependency plan with `task_create`:
   - `T-0001` design generalized Workbench live event stream architecture.
   - `T-0002` assess platform/operations risks.
   - `T-0003` draft generalized event API contract options.
   - `T-0004` synthesize the three results.
2. The `task_create` response reported `T-0001`, `T-0002`, and `T-0003` ready.
3. Immediately started all three ready tasks in one parallel tool call using `subagent_start({ taskId, agent, ... })`:
   - `T-0001` → planner subagent `run_mpyo48a0_c6PTWrsfins`.
   - `T-0002` → generalist/gemini subagent `run_mpyo48ci_dIYHjFz3Qrw`.
   - `T-0003` → generalist subagent `run_mpyo48f0_VBDg-uJVnU8`.
4. After the `subagent_start` calls returned running subagents, the session still received three `TASK READY` wakeups saying each task had no owner and should be started now.
5. To verify state, the parent called `task_list(...)` and saw only `4 task(s)` with no useful task rows, state, owner, or receipt metadata.
6. The parent called `task_get({ taskId: "T-0001", view: "status" })` and received only `Task T-0001: Design generalized Workbench live event stream architecture`, again without owner/run/status detail.

### Why this is bad

- The ready wakeups were actionable-looking but stale: following them literally would have duplicated three active subagent runs.
- The native task inspection tools did not provide enough detail to determine whether the task was actually ready, running, claimed, ownerless, or in a race state.
- This undermines the hard-rule task loop because the parent cannot safely distinguish a real unstarted ready task from a stale ready notification.

### Expected behavior

- Once `subagent_start({ taskId })` successfully returns a running owner, subsequent ready wakeups for that task should be suppressed, converted into a non-actionable stale notification, or include enough owner/run metadata to make the race obvious.
- `task_list` should show at least task id, derived state, owner/run id when claimed, and whether a result is ready.
- `task_get(view="status")` should expose enough status detail to answer: ready vs running vs result_ready, owner run id, last transition, and whether the task is startable.

### Additional suggested fixes

5. Include a monotonic task revision/transition id in ready wakeups and task-claim responses so the parent can detect stale wakeups.
6. Make ready wakeups self-invalidating: if the task has an owner by the time the wakeup is rendered/delivered, render it as informational instead of instructing the parent to start it.
7. Improve `task_list` and `task_get(view="status")` progressive disclosure; the current terse output is not sufficient for race diagnosis.
8. Add owner/run id to every task-owned subagent start response and every task wakeup involving that task.

## Addendum: result receipts still require raw file/artifact recovery

Date: 2026-06-03
Reporter: Pi root-session agent during same generalized ROGER/QAS live event stream design planning

### Observed sequence

1. `T-0001` and `T-0003` completed with task result-ready wakeups that included explicit receipt paths.
2. The paired async subagent wakeups still only said `Submitted result for T-0001` / `Submitted result for T-0003`.
3. `task_get({ taskId: "T-0001", view: "receipt" })` returned only `Task T-0001: Design generalized Workbench live event stream architecture`, with no receipt body.
4. The parent had to manually read the receipt JSON file from the path shown in the task wakeup to recover the actual deliverable.
5. `T-0002` completed with summary text saying the result was saved to `artifacts/T-0002-live-stream-risk-assessment.md`, but `task_get({ taskId: "T-0002", view: "receipt" })` again returned only the task title shell.
6. `subagent_result({ runId: "run_mpyo48ci_dIYHjFz3Qrw" })` also returned only `Submitted result for T-0002`.
7. The parent had to search the filesystem and read `/home/joe/Documents/Quantiiv/artifacts/T-0002-live-stream-risk-assessment.md` directly to recover the actual deliverable.
8. After accepting `T-0002`, the parent started dependent `T-0004` with `subagent_start({ taskId: "T-0004", ... })`; a stale `TASK READY` wakeup for `T-0004` still arrived afterward saying it had no owner and should be started.

### Expected behavior

- `task_get(view="receipt")` should surface the submitted receipt body and artifact paths, not just the task title.
- `subagent_result` for task-owned runs should either include the real task deliverable or clearly point to the task receipt/artifact path.
- If an artifact file is the actual deliverable, the task result-ready wakeup and `task_get(view="receipt")` should expose the exact absolute path and make it clear that the body is stored there.
- Stale dependent-task ready wakeups should be suppressed after the dependent task has already been claimed.

### Additional suggested fixes

9. Make task receipt retrieval canonical: parent agents should not need to read raw receipt JSON paths or search arbitrary artifact directories.
10. Include task artifact paths in `task_get(view="receipt")` and `subagent_result` for task-owned runs.
11. When a task-owned subagent returns placeholder body text, automatically attach the task receipt content or artifact manifest to the native async result.
12. Add stale-ready detection for newly unblocked dependent tasks as well as initial ready tasks.
