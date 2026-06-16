# Async Subagents Milestone Tasks Design

Date: 2026-06-16
Status: Implemented active contract for async-subagents task orchestration

## Summary

Simplify async-subagents tasks into a parent-owned milestone board. Subagents remain execution attempts that report through the existing async-subagent result/event channels. Tasks become durable external memory for the parent: coarse milestones, dependencies, notes, and acceptance status. The parent updates tasks with `task_update`; `task_update` returns `newly_ready` synchronously so the parent can schedule follow-up work in the same turn. There are no task-owned child lifecycles, child task tools, task tokens, `task.ready` wakeups, `task_accept_result`, `task_reopen`, or `result_ready` task state.

This replaces the heavier task lifecycle described in `docs/specs/async-subagents-task-orchestration/design.md`, especially the result submission/acceptance loop and ready wakeup nudges. It incorporates the feedback that tasks should be used for lane-level milestones and hard dependency gates, not every review/fix attempt.

## Goals

- Reduce task-management ceremony in heavy pipelined remediation workflows.
- Preserve durable, inspectable dependency state for coarse milestones.
- Keep scheduling authority with the parent session.
- Make task readiness deterministic and synchronously visible after parent mutations.
- Keep child runs simple: direct `subagent_start`, direct terminal result/event wakeups, optional parent-authored task references in prompts.
- Avoid duplicating lifecycle concepts between async-subagent runs and tasks.

## Non-goals

- No child-owned task mutations.
- No task-specific child result submission protocol.
- No task-owned run claiming, task ownership tokens, or task-specific child tools.
- No task state named `result_ready`.
- No `task.ready` wakeups.
- No exposure of both `status` and `state` for a task. The stored field is `status`; derived scheduling/display information is `readiness`.
- No `next` field in `task_update` returns.
- No auto-spawning scheduler. The parent still chooses which subagent to start and what prompt to send.

## Semantic ownership

Current implementation ownership is split across:

- `TaskStore` for durable task files, dependency derivation, locks, events, task-owned run reconciliation, and task result transitions.
- `subagent_start` for spawning child runs, currently with optional task claiming.
- Child-control/task prompt assembly for task tokens and task result contracts.
- Existing async-subagent run/result/event channels for actual child execution outcomes.

The simplified design **moves scheduling memory into parent-owned task records** and **removes duplicated child lifecycle ownership from tasks**. Execution attempt state remains owned by the async-subagents run store and normal child result/event channels. Task dependency/readiness derivation remains owned by the task store, but only over parent-authored milestone records.

## Core model

A task is a parent-owned milestone:

- It records what the parent believes about a lane or gate.
- It may depend on other milestones.
- It may store parent notes, receipt/artifact pointers, and last attempt references.
- It is updated only by parent tools.
- It does not own, claim, or accept child runs.

A subagent run is an execution attempt:

- It is started with `subagent_start` as today.
- It may be given task IDs as context in its prompt, but the runtime does not bind the run to the task.
- It reports via normal async-subagent final result and child event channels.
- The parent reads the result and decides whether/how to update milestone tasks.

Recommended workflow:

1. Parent creates coarse milestone tasks such as `Email Q0 green`, `Workbench Q0 green`, `Prompt contract green`, and `Final combined Q0`.
2. Parent starts direct child attempts for ready lanes.
3. Child result/event wakes the parent through normal async-subagent delivery.
4. Parent updates the relevant task notes/status with `task_update`.
5. `task_update` returns `newly_ready`; parent starts newly unblocked follow-up work immediately if desired.

## Task schema

Stored task record:

```ts
type TaskStatus =
  | "open"       // not done yet; actionable when dependencies are done
  | "active"     // parent says attempts are in flight for this milestone
  | "blocked"    // parent records a blocker not captured by dependencies
  | "done"       // parent accepted the milestone as complete; dependencies may unblock
  | "failed"     // parent records the milestone as failed/stopped
  | "cancelled"; // parent intentionally abandoned it

type TaskRecord = {
  schemaVersion: number;
  id: string;                 // e.g. T-0001
  title: string;
  description: string;
  status: TaskStatus;         // stored canonical lifecycle field; do not expose a separate state
  dependsOn: string[];

  // Parent-owned external memory, not child-owned result protocol.
  notes?: string;
  activeForm?: string;
  lastAttemptRunIds?: string[];
  receiptPaths?: string[];
  artifactPaths?: string[];
  evidence?: string[];

  parentRunId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
```

Derived read model:

```ts
type TaskReadiness =
  | "ready"   // status open and all dependencies are done
  | "waiting" // status open and at least one dependency is not done
  | null;     // status is active, blocked, done, failed, or cancelled

type TaskView = TaskRecord & {
  readiness: TaskReadiness;
  blockedBy: string[];
};
```

Rules:

- Store only `status`; compute `readiness` on reads/returns.
- `blockedBy` is derived from `dependsOn` where dependency `status !== "done"`.
- A task with `status: "open"` and no unresolved dependencies has `readiness: "ready"`.
- A task with `status: "open"` and unresolved dependencies has `readiness: "waiting"`.
- A task with any other status has `readiness: null`; `status` itself carries the meaning.
- Done dependencies mean parent-accepted milestone completion, not child result availability.

## Tool contracts

### `task_create`

Creates one or more parent-owned tasks. Batch creation should support aliases for intra-batch dependencies.

Return shape:

```ts
type TaskCreateResult = {
  tasks: TaskView[];
  aliasToId: Record<string, string>;
  newly_ready: TaskView[];
};
```

`newly_ready` contains tasks in this mutation that transitioned from nonexistent/not-ready to `readiness: "ready"`. It is synchronous feedback only; it does not imply wakeup delivery.

### `task_list`

Lists compact parent-owned task views with derived `readiness` and `blockedBy`. It does not reconcile child run state because tasks do not own runs.

### `task_get`

Returns full task detail plus derived `readiness` and `blockedBy`.

### `task_update`

The canonical parent mutation tool for milestone progress, notes, status changes, dependency edits where allowed, and receipt/artifact pointer updates.

Input shape:

```ts
type TaskUpdateInput = {
  taskId: string;
  status?: TaskStatus;
  title?: string;
  description?: string;
  dependsOn?: string[];
  notes?: string;
  appendNotes?: string;
  activeForm?: string | null;
  addAttemptRunIds?: string[];
  addReceiptPaths?: string[];
  addArtifactPaths?: string[];
  addEvidence?: string[];
  force?: boolean; // required for dependency/status edits that invalidate downstream done/active milestones
};
```

Return shape:

```ts
type TaskUpdateResult = {
  task: TaskView;
  changed: boolean;
  newly_ready: TaskView[];
  invalidated?: TaskView[];
};
```

Constraints:

- Do not include a `next` field.
- Do not expose a task `state` field; use stored `status` plus derived `readiness`.
- `newly_ready` is computed inside the same lock/transaction after the update.
- `newly_ready` includes downstream tasks whose `readiness` changed to `ready` because this update marked dependencies `done` or edited dependencies.
- If a task is changed from `done` to any non-done status, active/done dependents are invalidated only with `force: true`; otherwise reject with an affected-dependents error.
- When forced invalidation is used, downstream invalidated tasks return to `open` unless explicitly terminal, and appear in `invalidated`.

## Wakeup policy

- Normal async-subagent terminal results, child events, questions, blocked reports, pauses, and failures continue to wake the parent through existing run/event delivery.
- Task mutations do not generate parent wakeups.
- No `task.ready` wakeups exist. Readiness is returned synchronously by `task_create` and `task_update` as `newly_ready`.
- If the parent goes idle with ready tasks, that is a prompt/orchestration concern, not a runtime wakeup concern. The prompt should teach the parent to act on `newly_ready` before idling.

## Prompt contracts

Parent prompt guidance:

- Tasks are parent-owned milestone board entries and external memory.
- Use tasks for coarse durable lanes and hard gates, not every small review/fix attempt.
- Start subagents directly for execution attempts; do not wait for task wakeups.
- After reading a child result, update the milestone with `task_update`.
- Treat `task_update.newly_ready` as the synchronous scheduling signal.
- Do not pre-launch dependent children before their required inputs exist.
- Keep attempt history in task notes/receipts or lane status artifacts.

Child prompt guidance:

- A child may be told that its work relates to a task ID, but the task remains parent-owned.
- The child reports completion through normal final answer and child event tools.
- The child does not receive task tokens and does not call task-specific tools.
- If the child produces artifacts or receipts, it reports their paths in its normal result so the parent can attach them with `task_update`.

## Removal list

Remove or retire from the model-facing task system:

- Task-owned child lifecycle and task claims.
- Child task tools: `task_submit_result`, `task_update_progress`, `task_report_blocked`.
- Task tokens and token hash validation.
- `task_accept_result`.
- `task_reopen` as a separate tool; parent rework is `task_update({ status: "open", ... })`.
- `result_ready` task status/readiness and result acceptance split.
- `task.ready` events/wakeups and ready-wakeup projector logic.
- Task-owned run reconciliation.
- `subagent_start({ taskId })` claiming semantics. If a task ID is retained on `subagent_start`, it must be prompt metadata only and must not claim/mutate the task.
- Any `next` field in task tool returns.

## Compatibility and removal policy

This is a breaking simplification of the current task orchestration surface. Recommended policy:

1. Ship behind a clearly named task schema version bump.
2. Migrate or ignore old session task lists rather than silently interpreting `result_ready`, owners, task tokens, or submitted task receipts as the new model.
3. Keep normal async-subagent run/result APIs compatible.
4. For one release window, reject removed task tools with explicit migration errors pointing to `task_update` and normal `subagent_start`/`subagent_result`.
5. Remove prompt references and tool descriptions for old child-owned task lifecycle in the same release as the tool removal to avoid mixed contracts.

## Storage and events

Storage can keep the existing `session-tasks/<rootSessionId>/tasks/T-0001.json` shape and file-locking approach, but the record schema is reduced. Task events, if retained for audit/debug, are not scheduling wakeups. Useful event types:

- `task.created`
- `task.updated`
- `task.done`
- `task.failed`
- `task.cancelled`
- `task.invalidated`

Events should not include child-owned result submission semantics.
