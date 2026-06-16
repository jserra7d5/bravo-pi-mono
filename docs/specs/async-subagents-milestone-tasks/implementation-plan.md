# Async Subagents Milestone Tasks Implementation Plan

Date: 2026-06-16
Status: Implemented

## Recommended direction

Replace the current child-owned task orchestration layer with a parent-owned milestone board. Reuse the existing durable task-store ownership for task files, locking, IDs, dependency validation, and derived readiness, but remove duplicated child lifecycle semantics. Async-subagent run/result/event channels remain the only owner of execution attempt lifecycle.

## Implementation sequence

1. **Freeze the new contract**
   - Add/update type contracts for `TaskStatus`, `TaskRecord`, `TaskReadiness`, `TaskView`, and `TaskUpdateResult`.
   - Ensure task views expose `status` and `readiness`, not both `status` and `state`.
   - Define `newly_ready` as a synchronous return from `task_create` and `task_update`.

2. **Simplify task storage**
   - Keep task IDs, filesystem layout, lock discipline, batch create, acyclic dependency validation, and derived readiness logic.
   - Remove persisted owner, attempts, task token hash, and child-submitted result fields from the new schema.
   - Add parent-owned external-memory fields: notes, activeForm, lastAttemptRunIds, receiptPaths, artifactPaths, evidence.
   - Add schema-version handling so old task lists with removed fields/statuses are not silently treated as new records.

3. **Implement `task_update` as the canonical parent mutation**
   - Support status, notes/appendNotes, activeForm, dependency, and pointer updates.
   - Compute pre/post readiness inside one lock.
   - Return `{ task, changed, newly_ready, invalidated? }` with no `next` field.
   - Reject dependency/status edits that would invalidate active/done downstream milestones unless `force: true`.

4. **Collapse/remove old task tools**
   - Remove model-facing `task_accept_result` and `task_reopen`; route those intents to `task_update`.
   - Remove child task tools: `task_submit_result`, `task_update_progress`, `task_report_blocked`.
   - Remove task token generation/validation from task tool paths.
   - Keep `task_create`, `task_list`, `task_get`, `task_update`, and cancellation/clear only if their responsibilities remain distinct; otherwise use `task_update({ status: "cancelled" })` for cancellation.

5. **Decouple `subagent_start` from task claiming**
   - Remove task claim/readiness mutation from `subagent_start({ taskId })`.
   - Prefer removing `taskId` from `subagent_start` entirely unless verified live consumers need it as prompt metadata.
   - If retained, make it non-authoritative metadata only: it may render in status and prompt text, but must not mutate the task or create ownership.

6. **Remove task wakeup scheduling path**
   - Delete `task.ready` wakeup emission and delivery guidance.
   - Stop using task events as parent re-engagement signals.
   - Preserve normal run/event wakeups for child terminal results, questions, blockers, failures, and paused runs.

7. **Update prompt contracts**
   - Parent prompt: tasks are milestone board/external memory; children are direct attempts; after child results, call `task_update`; act on `newly_ready` before idling.
   - Child prompt: no task tokens or task tools; report normally, including receipt/artifact paths for parent attachment.
   - Remove old examples that show submit/accept/reopen/result-ready loops.

8. **Update UI/read models**
   - Render tasks by derived `readiness`: result-ready disappears; `ready` means `status: "open"` with done dependencies.
   - Display `active` as parent-authored task status, not proof of a claimed child owner.
   - If showing related runs, join by parent-authored `lastAttemptRunIds` or optional non-authoritative launch metadata, not task ownership.

9. **Compatibility cleanup**
   - Add explicit migration errors for removed tools during the deprecation window.
   - Reject old `result_ready` records under the new schema with actionable guidance, or provide a one-way migration that maps them to `active`/`open` plus notes for parent review.
   - Remove documentation and README sections that describe task-owned child lifecycle once code changes land.

## Implementation areas

- `packages/async-subagents/src/taskStore.ts`: schema reduction, `task_update`, readiness/newly_ready computation, removal of owner/token/result transitions.
- Task type definitions in `packages/async-subagents/src/types.ts` or equivalent.
- Task readiness helper in `packages/async-subagents/src/taskState.ts` or equivalent.
- Pi task tools in `packages/async-subagents/extensions/pi/tools.ts`.
- Prompt assembly in `packages/async-subagents/extensions/pi/promptModule.ts`.
- README task orchestration section.
- Widget/read-model code that currently renders owners/result-ready/task-owned runs.
- Tests covering task store, tool contracts, prompt snippets, wakeup projection, and widget projections.

## Validation plan

1. **Task readiness invariant**
   - Invariant: `readiness` is fully derived from stored `status` plus dependency completion; no stored `state` or stored readiness can drift.
   - Seam: task tool/store integration using real filesystem task records and real lock path.
   - Checks: create blocked and unblocked tasks; complete a dependency with `task_update`; assert returned `newly_ready` exactly matches tasks whose derived readiness changed to ready.

2. **No task wakeup invariant**
   - Invariant: task mutations never enqueue `task.ready` or any task scheduling wakeup; normal child result wakeups still work.
   - Seam: existing wakeup projector/polling path with real task events and real run events.
   - Checks: create/update tasks and assert no parent task-ready wakeup is pending; separately complete a normal child run and assert its terminal result wakeup is still delivered.

3. **No child-owned task mutation invariant**
   - Invariant: child processes cannot mutate task records through task-specific child tools or task tokens.
   - Seam: actual child prompt/tool assembly and Pi tool registration, not an in-memory fake.
   - Checks: launch/assemble a child and assert removed task tools are absent and no task token contract is injected.

4. **Parent update failure path**
   - Invariant: changing a done prerequisite back to non-done cannot silently leave active/done dependents valid.
   - Seam: real `task_update` call over a dependency chain.
   - Fault case: mark A and B depending on A as `done`, then update A to `open` without `force`; expect affected-dependents error. Repeat with `force: true`; expect B invalidated and returned in `invalidated`.

5. **API shape compatibility guard**
   - Invariant: `task_update` returns no `next` field and task views expose no `state` field.
   - Seam: model-facing tool invocation/serialization layer.
   - Checks: inspect JSON schema and execute tool call; assert forbidden fields are absent in both schema and runtime response.

6. **Prompt contract evidence**
   - Invariant: parent prompts teach `task_update.newly_ready` scheduling; child prompts do not teach task submission/acceptance.
   - Seam: actual assembled system prompts for parent and child sessions.
   - Checks: snapshot or structured assertions for required/forbidden prompt phrases, backed by prompt assembly output.

7. **Migration/old-record edge cases**
   - Invariant: old task records with `result_ready`, owners, or task tokens are not silently treated as valid new milestone tasks.
   - Seam: real task-list loading from filesystem.
   - Fault case: seed an old-format task JSON and call `task_list`; expect explicit migration/rejection behavior or documented one-way migration output.

## Tradeoffs

- **Less automation, less ceremony:** removing ready wakeups means an idle parent will not be reawakened just because a task became ready. The compensating contract is synchronous `newly_ready` and prompt guidance to act before idling.
- **Less child structure, more parent responsibility:** children no longer submit task receipts directly. Parents must attach relevant paths/notes after reading child results.
- **Cleaner ownership:** async-subagent runs own execution lifecycle; tasks own durable milestone memory. This avoids duplicated result-ready/accepted concepts.
- **Breaking simplification:** existing sessions and prompts that rely on child task tools need migration errors or a schema gate.

## Risks / unknowns

- Whether any live consumers depend on `subagent_start({ taskId })` claiming semantics; verify before removing or downgrade to metadata-only with a compatibility warning.
- Exact migration policy for in-flight old task lists: reject, archive, or one-way transform.
- Whether `task_cancel`/`task_clear` remain separate tools or collapse into `task_update` for a smaller surface.
- UI meaning of `active`: it is parent-authored milestone status, not authoritative child process ownership.
- Documentation timing: README and prompt updates must land atomically with tool/schema changes to avoid mixed old/new contracts.
