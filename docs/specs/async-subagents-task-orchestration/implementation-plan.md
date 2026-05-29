# Async Subagents Task Orchestration Implementation Plan

Date: 2026-05-28
Status: Reviewed draft
Spec: `docs/specs/async-subagents-task-orchestration/design.md`

## Review Feedback Incorporated

This draft incorporates reviewer feedback from two independent review lanes. Major changes from the first draft:

- Removed the proposed `task_start_subagent` tool; `subagent_start({ taskId })` remains the canonical launch surface.
- Added root-session env resolution for child processes so child task tools use the parent task list.
- Added parent-only tool guards and child env token validation.
- Added task wakeup handled-state rules to prevent repeat wakeup loops.
- Added task/run reconciliation for child exits without task receipts.
- Added duplicate run/task wakeup suppression policy for task-owned runs.
- Added lock retry behavior, downstream reopen invalidation rules, progress/blocker tools, and narrow-width widget layout rules.

## Objective

Implement a lightweight, session-scoped task orchestration layer inside `@bravo/async-subagents` so the parent Pi session can create dependent task plans, start child subagents only when tasks are ready, receive compact task-result wakeups, and see task ownership/status in the existing async-subagents TUI widget.

## Implementation Methodology Requirement

Implementation agents must use the Harness Engineering methodology described in `/home/joe/Documents/Quantiiv/Optimized-Development-Tooling/plugins/harness-engineering/README.md`. This is not optional checklist material; this feature changes native tools, prompt assembly, context handoffs, behavior steering, and TUI surfaces.

Required skill lenses by workstream:

- `tool-design`: native task/subagent tool boundaries, return shapes, error semantics, authority checks, and avoiding overlapping tools such as task-specific spawn wrappers.
- `prompt-design`: parent and child prompt rules, hard-rule placement, output contracts, and avoiding brittle prompt patches.
- `prompt-composition`: conditional child prompt assembly for task-owned versus non-task child runs, shared runtime contracts, and tool-coupled prompt fragments.
- `context-presentation`: wakeup envelopes, `task_get` progressive-disclosure views, receipt/artifact pointers, and push-versus-pull context decisions.
- `behavior-shaping`: harness-first attribution for any observed agent misbehavior, principle-level interventions, and eval/test-driven verification instead of adding rules from vibes.
- `tui-design`: async widget/task rendering, placement, glyphs, ANSI-aware width math, and avoiding footer/widget duplication.

A worker implementing any phase that touches these surfaces should explicitly load the relevant skills before editing and should cite the applied lens in its handoff/receipt. Reviewers should reject changes that add overlapping native tools, dump large context by default, duplicate prompt rules into the wrong layer, or bypass the documented TUI constraints.

Terminal UI implementation lane: all frontend/TUI work for the async-subagents task widget should be assigned to a Gemini-backed worker lane. This includes visual mockups, renderer changes, live widget layout, glyph/color choices, responsive width behavior, and any editor-adjacent widget integration. Backend storage, task state, wakeup delivery, and authority logic should remain separate from that UI lane. The Gemini UI implementation must still be reviewed by both a GPT-backed reviewer and a Gemini-backed reviewer before acceptance.

The implementation should copy the useful shape of Claude Code Task V2 — per-task JSON files, dependency arrays, ownership, wakeups, and near-input task rendering — while keeping Pi's stricter authority model:

- children submit results for owned tasks;
- parent/scheduler accepts completion;
- blocked tasks do not spawn model processes by default;
- task state lives in durable files, not in model memory.

## Existing Surfaces to Extend

### Core package

- `packages/async-subagents/src/types.ts`
  - Add task, task-event, task-result, and task-attempt types.
  - Add optional task metadata to run status/index summaries only where needed.
- `packages/async-subagents/src/schemas.ts`
  - Add task status/event validation helpers.
  - Keep dependency validation pure and reusable.
- `packages/async-subagents/src/runStore.ts`
  - Keep run storage contracts intact.
  - Add task-store path helpers or delegate to a new `TaskStore` class.
- `packages/async-subagents/src/readModels.ts`
  - Add task summary read models only if needed for UI speed; avoid premature cache complexity.
- `packages/async-subagents/src/start.ts`
  - Accept optional task assignment metadata and propagate it into child env/prompt inputs.
- `packages/async-subagents/src/status.ts`
  - Preserve existing run-status behavior; optionally expose task assignment in run status.

### Pi extension

- `packages/async-subagents/extensions/pi/schema.ts`
  - Add schemas for narrow task tools.
- `packages/async-subagents/extensions/pi/tools.ts`
  - Register task tools beside existing subagent tools.
  - Use existing `rootFor`, `storeFor`, `afterMutation`, and `renderShell: "self"` conventions.
- `packages/async-subagents/extensions/pi/wakeups.ts`
  - Project task events into once-only parent wakeups using existing delivery state/claim semantics.
- `packages/async-subagents/extensions/pi/liveWidget.ts`
  - Enrich the async-subagents widget with task assignments and a compact task section.
- `packages/async-subagents/extensions/pi/renderers.ts`
  - Add task row rendering using existing ANSI-aware helpers and identity palette.
- `packages/async-subagents/extensions/pi/compactionReminder.ts`
  - Include active/result-ready task counts in compaction reminders.
- `packages/async-subagents/extensions/pi/promptModule.ts`
  - Add task orchestration principles after the core async-subagent sequencing guidance.

### Tests

- `packages/async-subagents/test/runStore.test.ts`
- `packages/async-subagents/test/piTools.test.ts`
- `packages/async-subagents/test/wakeups.test.ts`
- `packages/async-subagents/test/liveWidget.test.ts`
- `packages/async-subagents/test/renderers.test.ts`
- new `packages/async-subagents/test/taskStore.test.ts`

Follow existing `node:test` style: temp workspaces via `mkdtempSync`, no static state dependencies, compile TS to `dist/test`, run with `npm test --workspace @bravo/async-subagents`.

## Architecture Decision: New `TaskStore`

Add a dedicated core module instead of overloading `RunStore` directly:

```text
packages/async-subagents/src/taskStore.ts
```

`RunStore` remains the run lifecycle API. `TaskStore` owns task paths, locking, task mutation, dependency derivation, receipts, and task events. It may accept a `RunStore` or equivalent `{ cwd, runRoot, env }` for path compatibility.

Rationale:

- avoids bloating `RunStore` with a second lifecycle domain;
- keeps task tests small and direct;
- gives Pi tools a clean, narrow core API;
- leaves room to reuse task store from non-Pi contexts later.


## Root Session Identity in Parent and Child Processes

Task storage is keyed by `rootSessionId`, so parent and child Pi processes must resolve the same root identity. Existing parent tools use an in-memory root map in the Pi extension; a child process starts with an empty module-local map.

Before task tools ship, update root identity resolution in `packages/async-subagents/extensions/pi/index.ts` / tool runtime setup so child contexts honor harness-injected env:

```ts
const envRootSessionId = process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID;
createRootSession({ cwd, rootSessionId: envRootSessionId });
```

Also inject `ASYNC_SUBAGENTS_RUN_ID`, `ASYNC_SUBAGENTS_TASK_ID`, and `ASYNC_SUBAGENTS_TASK_TOKEN` into task-owned child launches. Without this, child-owned task submission can target an isolated child-created task list instead of the parent task list.

## Storage Layout

Use root-session-scoped task lists under the same project-level async-subagents store:

```text
<runRoot>/../session-tasks/<rootSessionId>/
  highwatermark
  events.jsonl
  lock/
  tasks/
    T-0001.json
    T-0002.json
  receipts/
    T-0001-run_abc123.json
  artifacts/
    T-0001/
```

Where `<runRoot>/..` matches existing delivery/index cache sibling layout used by `wakeups.ts`.

### Path API

`TaskStore.pathsFor(rootSessionId)` should return:

```ts
{
  taskRoot: string;
  highwatermarkPath: string;
  eventsPath: string;
  lockDir: string;
  tasksDir: string;
  receiptsDir: string;
  artifactsDir: string;
}
```

Create directories lazily on mutation and safely on read where necessary.

## Locking and Atomicity

Implement a conservative list-level lock for v1:

```text
<taskRoot>/lock/held.json
```

Before acquiring the lock, create `<taskRoot>` with `mkdirSync(taskRoot, { recursive: true })`. Then acquire by atomically creating `<taskRoot>/lock` with `mkdirSync(lockDir, { recursive: false })`, write metadata `{ pid, host, ownerId, command, createdAt }` into `held.json`, and release by removing the directory. Include stale-lock detection for same-host dead PIDs and TTL-based emergency recovery.

Lock acquisition should retry for short transient contention before failing. Use a bounded loop, for example 50–100ms sleep intervals up to 5 seconds, then return a clear lock contention error. This prevents parallel child completions from failing merely because two owned tasks submitted results at the same time.

All task mutation APIs run under the task-list lock. This is simpler than per-task locks and sufficient for small in-session task lists.

Use existing `atomicWriteJson` for task and receipt writes. Append events with existing `appendJsonl`.

## Types

Add to `src/types.ts`:

```ts
export type TaskStatus = "pending" | "running" | "result_ready" | "completed" | "failed" | "cancelled";
export type TaskResultState = "submitted" | "accepted" | "rejected" | "superseded";
export type DerivedTaskState = "ready" | "blocked" | TaskStatus;

export interface TaskOwner {
  runId: string;
  agent: string;
  displayName: string;
  assignedAt: string;
  tokenHash: string; // hash of harness-generated task assignment token
}

export interface TaskResultReceipt {
  state: TaskResultState;
  summary: string;
  receiptPath?: string;
  artifactPaths?: string[];
  evidence?: string[];
  commandsRun?: string[];
  notes?: string;
  submittedAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
}

export interface TaskAttempt {
  runId: string;
  agent: string;
  displayName: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "result_ready" | "failed" | "cancelled";
}

export interface TaskRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependsOn: string[];
  blocks?: string[];
  owner?: TaskOwner;
  activeForm?: string;
  result?: TaskResultReceipt;
  attempts: TaskAttempt[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  eventId: string;
  sequence: number;
  rootSessionId: string;
  parentRunId: string; // route task wakeups to the owning parent session
  taskId: string;
  type: TaskEventType;
  summary: string;
  actor?: string;
  runId?: string;
  wake?: boolean;
  data?: Record<string, unknown>;
  createdAt: string;
}
```

Add task assignment metadata to `RunStatus` and/or `RunIndexRecord` only after confirming UI needs it. Minimum useful field:

```ts
task?: { taskId: string; title: string };
```

Prefer deriving run-task association from task owner where possible to avoid duplication.

## Derived Task State

Implement pure helpers in `taskStore.ts` or `taskState.ts`:

```ts
deriveTaskState(task, allTasks): DerivedTaskState
isTaskReady(task, allTasks): boolean
unresolvedDependencies(task, allTasks): TaskRecord[]
```

Rules:

- `pending` + all dependencies `completed` + no owner → `ready`
- `pending` + any dependency not `completed` → `blocked`
- all other stored statuses display as themselves

Only accepted parent completion counts as dependency satisfaction. `result_ready` does not unblock dependents.

## Dependency Validation

`task_create` should support batch creation so the parent can define a small plan at once.

Input shape should allow local aliases:

```ts
{
  tasks: [
    { alias: "impl", title: "Implement task store", description: "..." },
    { alias: "review", title: "Review task store", description: "...", dependsOn: ["impl"] }
  ]
}
```

The handler resolves aliases to allocated IDs before writing. Validate:

- aliases unique within the call;
- dependency references exist as aliases or existing task IDs;
- no self-dependencies;
- no cycles across existing tasks plus new tasks;
- no dependency on cancelled/failed tasks unless explicitly allowed later.

Use a pure cycle detector with a stable error code such as `CIRCULAR_DEPENDENCY_DETECTED`.

## Core `TaskStore` API

Implement these methods first:

```ts
class TaskStore {
  pathsFor(rootSessionId: string): TaskPaths;
  listTasks(rootSessionId: string): TaskRecord[];
  readTask(rootSessionId: string, taskId: string): TaskRecord;
  createTasks(rootSessionId: string, input: CreateTasksInput): CreateTasksResult;
  claimTask(rootSessionId: string, taskId: string, owner: TaskOwner): TaskRecord;
  releaseClaim(rootSessionId: string, taskId: string, input: ReleaseTaskClaimInput): TaskRecord;
  reconcileOwnedRun(rootSessionId: string, runId: string, input: ReconcileOwnedRunInput): TaskRecord | undefined;
  submitResult(rootSessionId: string, taskId: string, input: SubmitTaskResultInput): TaskRecord;
  updateProgress(rootSessionId: string, taskId: string, input: UpdateTaskProgressInput): TaskRecord;
  reportBlocked(rootSessionId: string, taskId: string, input: ReportTaskBlockedInput): TaskRecord;
  acceptResult(rootSessionId: string, taskId: string, input: AcceptTaskResultInput): TaskRecord;
  reopenTask(rootSessionId: string, taskId: string, input: ReopenTaskInput): TaskRecord;
  failTask(rootSessionId: string, taskId: string, input: FailTaskInput): TaskRecord;
  cancelTask(rootSessionId: string, taskId: string, input: CancelTaskInput): TaskRecord;
  appendEvent(rootSessionId: string, event: TaskEvent): void;
  readEvents(rootSessionId: string): TaskEvent[];
}
```

### Claim rules

`claimTask` must reject when:

- task does not exist;
- task is not derived `ready`;
- task already has owner;
- task status is not `pending`;
- optional future busy-check says owner already has running work.

On success:

- status → `running`
- owner set with `runId` and `tokenHash`
- attempt appended
- `task.claimed` event appended

### Result submission rules

`submitResult` must reject when:

- task does not exist;
- task is not `running`;
- `owner.runId !== input.runId`;
- submitted task token does not match `owner.tokenHash`;
- summary is empty;
- receipt or artifact paths escape the allowed roots.

On success:

- status → `result_ready`
- result.state → `submitted`
- receipt written under `receipts/` from a bounded inline receipt payload
- current attempt ended with `result_ready`
- `task.result_submitted` event appended with `wake: true`

### Acceptance rules

`acceptResult` is parent/scheduler-only in the Pi tool layer.

On success:

- status → `completed`
- result.state → `accepted`
- owner may be retained for audit or cleared only in display; keep it in v1 for traceability
- `task.result_accepted` event appended
- newly-ready dependents are computed and may emit `task.ready` events if auto-scheduling is not active

### Reopen rules

`reopenTask` is parent/scheduler-only.

On success:

- previous result.state → `rejected` or `superseded`
- status → `pending`
- owner cleared
- activeForm optionally updated
- `task.reopened` event appended with `wake: false` unless parent requested notification

Reopening a completed prerequisite must not silently leave downstream work valid. Default v1 behavior should reject reopening a completed task when any dependent task is `running`, `result_ready`, or `completed`, unless the caller passes an explicit `force` flag. With `force`, running/result-ready dependents are reopened and active owned runs are cancelled or surfaced with explicit next actions; completed dependents are marked `reopened` or require manual parent confirmation. The tool response must list affected dependents.

## Tool Surface

Add schemas in `extensions/pi/schema.ts` and register tools in `extensions/pi/tools.ts`.

Tool responsibility rule: one model-facing tool owns one intent. Do not add task-specific aliases for existing async-subagents actions. `subagent_start` owns child spawning whether or not a task is assigned; task tools own task state/query/result transitions only.

### Parent-facing tools

#### `task_create`

Create one or more tasks with optional dependencies.

- Native tool because it mutates orchestration-plane state.
- Returns compact rows with IDs, derived state, and dependency mapping.
- Calls `runtime.afterMutation` so widget/wakeups refresh.

#### `task_list`

List tasks with derived states.

Arguments:

- `states?: string[]`
- `includeCompleted?: boolean`
- `limit?: number`

Return compact rows plus counts. Do not include full descriptions by default.

#### `task_get`

Read full task detail, result metadata, receipt pointers, and dependency status.

#### `task_accept_result`

Accept a `result_ready` task as completed. Parent/scheduler only.

#### `task_reopen`

Reject/reopen a task with reason and optional follow-up instructions.

#### `task_cancel`

Cancel a task. If the task has an active owner run, optionally call existing interrupt/control path or return a suggested `subagent_interrupt` next action.

### Child-facing / owner-scoped tools

Child-owned task tools must be exposed through a context that can reliably identify the current child run and assigned task. Prefer adding them to the child-control extension or a child-runtime-only task extension that reads harness-injected environment variables directly. Do not rely on model-provided `runId` as authority.

Required child identity inputs:

- `ASYNC_SUBAGENTS_ROOT_SESSION_ID`
- `ASYNC_SUBAGENTS_PARENT_RUN_ID`
- `ASYNC_SUBAGENTS_RUN_ID`
- `ASYNC_SUBAGENTS_TASK_ID`
- `ASYNC_SUBAGENTS_TASK_TOKEN`

The parent launch path generates a cryptographically random task token, stores only a hash on `TaskRecord.owner.tokenHash`, and injects the raw token into the child environment. Child-owned task tools validate the env token against the stored hash before mutating task state.

#### `task_submit_result`

Submit a bounded receipt/result for the child-owned task. This is the only child tool that transitions `running → result_ready`.

`SubmitTaskResultInput` should be explicit:

```ts
{
  summary: string;              // required, 1..2000 chars
  receipt?: Record<string, unknown>; // optional bounded JSON, max ~32KB serialized
  artifactPaths?: string[];     // optional, must be under run artifacts/task artifacts/workspace-allowed roots
  evidence?: string[];          // optional compact strings
  commandsRun?: string[];       // optional compact strings
  notes?: string;               // optional, bounded
}
```

#### `task_update_progress`

Owner-scoped non-terminal progress update. Allows updating `activeForm` and appending a compact progress note. It never changes final task status and should not wake the parent by default.

#### `task_report_blocked`

Owner-scoped blocker/input report. Appends `task.needs_input` with `wake: true` and keeps the task owned/running unless the parent reopens or cancels it.

If child identity cannot be made reliable in the first implementation slice, defer all child-facing task tools and use the existing `subagent_result` collection path plus parent-side task submission as an interim manual workflow.

### Parent-only tool guards

Parent-only task tools (`task_create`, `task_accept_result`, `task_reopen`, `task_cancel`, dependency mutation, and task assignment via `subagent_start`) must reject execution in child contexts. A child context is indicated by `ASYNC_SUBAGENTS_RUN_ID` or equivalent child-runtime identity.

### Avoid in v1

- Generic `task_update`.
- Child-facing `task_accept_result`.
- Child-facing dependency mutation.
- Blocking `task_wait`.

## Subagent Start Integration

Do not add a separate `task_start_subagent`, `task_assign_subagent`, or any other task-specific spawn wrapper. That would violate tool responsibility separation by giving the model two plausible tools for the same intent: spawning a child agent. `subagent_start` remains the single canonical way to launch child agents.

A child may still be spawned without a task. Task assignment is optional metadata/validation on the canonical spawn action, not a separate action.

Extend `subagent_start` with optional task assignment fields:

```ts
subagent_start({
  agent: "worker",
  task: "...",
  taskId: "T-0004"
})
```

When `taskId` is present, `subagent_start` becomes a claim-and-launch operation:

1. resolve the parent root identity;
2. reject if the current process is a child context;
3. validate the task exists and is derived `ready`;
4. generate a task assignment token;
5. reserve/claim the task in a launch-pending form that records the token hash but can be rolled back;
6. start the child with assignment context prepended to the task prompt and env containing root/session/run/task identity plus the raw task token;
7. finalize the claim with the returned `runId`, agent name, and display name;
8. write a delivery subscription for non-result child attention events;
9. call `afterMutation`;
10. return both `taskId` and `runId`.

Because current `startSubagent` allocates `runId` internally, the implementation must avoid unowned-running-child races. Acceptable implementation choices:

- extend `StartSubagentInput` to accept a caller-provided `runId`, generated before task claim; or
- split launch into `prepareSubagentRun` / `startPreparedSubagent`; or
- add `TaskStore.reserveClaim` / `finalizeClaim` / `rollbackClaim` around the existing launcher and ensure rollback on every launch failure path.

Do not ship task assignment until this race is solved and tested.

### Task-owned run subscription policy

Task-owned runs should not produce duplicate terminal/result wakeups once `task_submit_result` is available. For task-owned runs:

- keep `question`, `blocked`, timeout/paused, failed/cancelled/expired attention wakeups;
- suppress or auto-handle normal successful `result` wakeups when the child submitted `task.result_submitted`;
- if the child terminates without task submission, emit a task failure/needs-input wakeup through reconciliation.

This keeps the task result receipt as the parent-facing contract while preserving safety signals for abnormal runs.


## Run/Task Reconciliation

Task-owned runs must not leave tasks permanently `running` when the child exits without submitting a task result. Add reconciliation before widget/wakeup phases.

Preferred hook: update the terminal run finalization path in `packages/async-subagents/src/lifecycle.ts` / supervisor flow so when a run reaches terminal state, the task store can locate `owner.runId` and reconcile the task. If coupling core lifecycle to task store is too invasive in v1, add lazy reconciliation in `TaskStore.listTasks`, `TaskStore.readTask`, and task wakeup polling.

Reconciliation policy:

- If task is `running`, owner matches terminal `runId`, and no `result_ready` exists:
  - terminal run `completed` without task receipt → `task.needs_input` or `failed` per policy; default to `needs_input`/parent wakeup so the parent can inspect `subagent_result`;
  - terminal run `failed`, `cancelled`, or `expired` → task `failed` or reopened to `pending` according to retry policy; default to `failed` with parent wakeup;
  - clear owner only when the task is reopened/retryable; retain owner for audit when failed.
- Append `task.failed` or `task.needs_input` with `wake: true`.
- Suppress duplicate normal run result wakeups for task-owned successful runs when a task result was already submitted.

## Wakeup Integration

Extend `wakeups.ts` without weakening run wakeup semantics.

Add task delivery keys:

```ts
taskEventDeliveryKey(event) = `task:${event.rootSessionId}:${event.taskId}:${event.eventId}`
```

Project only parent-relevant events by default:

- `task.result_submitted` → model wakeup
- `task.failed` → model wakeup
- `task.needs_input` → model wakeup
- `task.ready` → model wakeup only when auto-start is disabled

Use the existing delivery state file keyed by parent run ID. Keep task wakeups idempotent through the same delivered/handled/claim pattern. Every `TaskEvent` must carry `parentRunId`; `pollWakeups(input)` must only deliver task events where `event.parentRunId === input.parentRunId`.

Discovery model for v1:

- `pollWakeups` reads task events for `input.rootSessionId` through `TaskStore.readEvents`.
- It filters to `event.wake === true` and known parent-relevant types.
- It skips keys already in delivered/handled state.
- It uses the existing claim file mechanism before delivering.
- It bounds scanning to recent events or introduces a per-parent cursor if event logs grow beyond a small threshold. The first implementation may scan the JSONL because task logs are session-scoped and small, but the code should isolate this behind `pendingTaskWakeups(...)` so a cursor can be added later.

Handled-state rules:

- `task_get` marks the latest delivered wakeup for that task as handled when it returns the event/result that woke the parent.
- `task_accept_result`, `task_reopen`, and `task_cancel` mark relevant delivered task wakeups handled as part of mutation.
- `markWakeupHandled` should continue to handle run wakeups; add a task-specific helper such as `markTaskWakeupHandled(store, parentRunId, taskId, eventId?)`.

Wakeup message should be a compact envelope:

```md
[TASK RESULT READY — NOT USER INPUT]

Task: T-004 Implement lifecycle
Owner: @Rex / run_abc123
Summary: ...
Receipt: ...
Next: task_get({ taskId: "T-004" })
```

Do not include full receipt body unless explicitly requested through `task_get`.

## Widget Integration

Modify `liveWidget.ts` snapshot building to include task data:

- Read current run summaries as today.
- Read active tasks for the root session, if `rootSessionId` exists.
- Build a map `owner.runId → task`.
- Pass task metadata into `widgetRowFromSummary` or a new `widgetRowFromRunAndTask`.
- Render a compact task section below run rows when useful.

Rendering priorities:

1. result_ready
2. running
3. ready
4. blocked / needs input
5. recently completed
6. older completed hidden

Use existing `renderWidgetCard`, `visWidth`, `truncAnsi`, `padRow`, and identity palette. Add tests at widths 96, 72, 56, 44, and 32.

Width-adaptive task row policy:

- `>= 72`: glyph, task ID, title, owner/display name, status/age.
- `54..71`: glyph, task ID, title, compact owner or compact status, not both.
- `36..53`: glyph, task ID, truncated title only.
- `< 36`: glyph, task ID, highly truncated title or count-only summary.

Never let task rows wrap or corrupt card chrome. At narrow widths, drop metadata before truncating the task title below readability.

Avoid footer/status duplication. The async-subagents widget remains canonical.

## Prompt and Compaction Integration

### Parent prompt module

Add concise guidance to `extensions/pi/promptModule.ts`:

- Tasks are durable coordination state; subagent runs are execution attempts.
- Start child runs only for ready tasks.
- A child-submitted task result is not accepted completion.
- Downstream children consume task receipts/artifacts, not sibling chat.
- Do not use task tools to bypass ownership/dependency constraints.
- Use `subagent_result` for raw run output/diagnostics; use `task_list`/`task_get` for durable task state.

Keep this principle-level; do not dump the full state machine into the parent prompt.

### Universal child prompt assembly

Conditional task-owned child prompting belongs in `packages/async-subagents/src/promptAssembly.ts`, not in `packages/async-subagents/agents/*.md`. The built-in agent markdown files are role definitions; the generalized child runtime contract is assembled into `system.md` and `task.md` for every child run.

Current child launches in `packages/async-subagents/src/piHarness.ts` intentionally isolate ambient Pi context:

```text
--no-context-files
--no-skills
--no-prompt-templates
--no-extensions
--append-system-prompt ""
--system-prompt <runDir>/artifacts/system.md
```

Therefore task-aware child behavior must be injected through prompt assembly and child runtime tool snippets, not through global Pi prompts.

For non-task child runs, preserve the existing runtime contract: “Report completion through your normal final answer.”

For task-owned child runs, add a conditional runtime contract such as:

```md
# Task-Owned Result Contract

You are assigned to task T-004.
Your durable handoff is the task result receipt, not a large final answer.

When done:
1. Call task_submit_result with a concise summary and receipt/artifact pointers.
2. Keep your final answer brief: “Submitted result for T-004.”
3. Do not duplicate the full receipt or artifact content in your final answer.

Use task_update_progress for non-terminal progress and task_report_blocked if you need parent input.
```

### Child assignment context

When a child is started for a task, prepend a compact assignment block:

```md
## Assigned Task

Task ID: T-004
Title: Implement task lifecycle
Allowed task mutation: submit result/progress only for T-004.
Result contract: attach a concise receipt/artifacts; do not mark parent acceptance.
Dependencies accepted:
- T-001: ...
```

### Compaction reminder

Add counts and high-signal task IDs:

```text
Tasks: 1 result_ready (T-004), 2 running, 1 ready, 1 blocked.
```

Do not include full task descriptions unless no other recovery path exists.

## Implementation Phases

### Phase 1 — Task store and pure state logic

Files:

- add `src/taskStore.ts`
- add `src/taskState.ts` if helpers warrant separation
- edit `src/types.ts`
- edit `src/schemas.ts`
- add `test/taskStore.test.ts`

Deliverables:

- storage layout creation
- task ID highwatermark
- batch create with aliases
- list/read
- derived `ready` / `blocked`
- dependency cycle detection
- list-level lock with retry/stale handling
- append task events including `parentRunId`
- claim/release/reconcile core APIs

Target tests:

- creates task root layout lazily
- monotonic IDs survive deletion/reset
- alias dependencies resolve
- cycle detection rejects bad DAGs
- derived state changes after dependency completion
- concurrent lock serializes mutations or returns deterministic contention errors after retry
- reopening completed prerequisites rejects or lists affected dependents

### Phase 2 — Parent task tools

Files:

- edit `extensions/pi/schema.ts`
- edit `extensions/pi/tools.ts`
- edit `extensions/pi/renderers.ts` for tool cards if needed
- edit `test/piTools.test.ts`

Deliverables:

- `task_create`
- `task_list`
- `task_get`
- `task_accept_result`
- `task_reopen`
- `task_cancel`
- all tools use `renderShell: "self"`
- compact return shapes with paths/IDs, not full artifacts
- parent-only guards reject child contexts
- `task_get` can mark delivered task wakeups handled

Validation:

- tool schemas reject malformed states/deps
- tool responses include actionable `next`
- parent-only tools reject when `ASYNC_SUBAGENTS_RUN_ID` is present

### Phase 3 — Extend `subagent_start` for task assignment

Files:

- edit `extensions/pi/schema.ts`
- edit `extensions/pi/tools.ts`
- edit `src/start.ts` if caller-provided run IDs or prepared launch are needed
- edit `src/supervisor.ts` launch env if task identity must be injected lower in the stack
- edit `test/piTools.test.ts`

Deliverables:

- optional `taskId` on `subagent_start`
- no separate `task_start_subagent` tool
- ready-state validation before launch
- task assignment env/prompt block
- task token generation and token hash storage
- task owner/attempt recorded with run ID
- rollback if launch fails before a run is usable
- task-owned run subscription policy that avoids duplicate successful result wakeups

Validation:

- blocked task cannot start child
- ready task starts child and records owner
- launch failure rolls back owner/status
- child env includes root/run/task/token identity
- task-owned run does not produce duplicate normal result wakeups once task result is submitted

### Phase 4 — Child-owned task tools

Files:

- prefer `extensions/child-control/index.ts` or a child-runtime-only task extension
- edit `extensions/pi/schema.ts` / `tools.ts` only for parent-visible registration if safe gating exists
- edit `test/childControl.test.ts` and `test/piTools.test.ts`

Deliverables:

- `task_submit_result`
- `task_update_progress`
- `task_report_blocked`
- strict owner and token validation from env identity
- bounded receipt write
- status `running → result_ready`
- attempt end recorded
- event `task.result_submitted` with `wake: true`

Validation:

- owner run with valid token can submit
- non-owner or wrong token cannot submit
- child cannot call parent-only tools
- unowned task cannot be result-submitted by child
- empty summary rejected
- receipt/artifact path traversal rejected

### Phase 5 — Run/task reconciliation

Files:

- edit `src/lifecycle.ts` and/or `src/supervisor.ts` if eager reconciliation is practical
- otherwise add lazy reconciliation in `src/taskStore.ts` and wakeup polling
- edit `test/supervisor.test.ts`, `test/taskStore.test.ts`, and/or `test/wakeups.test.ts`

Deliverables:

- terminal task-owned child runs reconcile their owned task if no task result was submitted
- failed/cancelled/expired runs generate task failure or needs-input events
- completed-without-task-result is surfaced to parent instead of silently accepted
- owner clearing/retention follows retry policy

Validation:

- child terminal result without `task_submit_result` does not leave task running forever
- failed child produces task wakeup
- cancelled child produces retryable or failed task state per policy

### Phase 6 — Task wakeups

Files:

- edit `extensions/pi/wakeups.ts`
- edit `extensions/pi/renderers.ts` if wakeup card rendering needs task kind
- edit `test/wakeups.test.ts`
- edit `test/piWakeupDelivery.test.ts`

Deliverables:

- task event projection from `session-tasks/<rootSessionId>/events.jsonl`
- parentRunId filtering
- task delivery keys
- delivered/handled idempotency
- compact NOT USER INPUT envelopes
- `task_get` suggested next action
- handled-state helpers for task events

Validation:

- result_ready wakes parent once
- handled task wakeup is not redelivered
- modelFollowUpOnly filters non-actionable task events
- stale claimed task wakeups do not duplicate
- task events for another parentRunId are not delivered

### Phase 7 — Widget and compaction

Files:

- edit `extensions/pi/liveWidget.ts`
- edit `extensions/pi/renderers.ts`
- edit `extensions/pi/compactionReminder.ts`
- edit `test/liveWidget.test.ts`
- edit `test/renderers.test.ts`

Deliverables:

- run rows show assigned task ID/title/status
- compact task section
- width-adaptive task rows
- overflow summary
- completed grace/hide behavior
- compaction reminder task counts

Validation:

- widget holds width at 96/72/56/44/32
- result_ready/running/ready task priorities correct
- no footer/status duplication
- ANSI truncation preserves colors and chrome

### Phase 8 — Prompt docs and package docs

Files:

- edit `extensions/pi/promptModule.ts`
- edit `src/promptAssembly.ts`
- edit `packages/async-subagents/README.md`
- update `docs/specs/async-subagents-task-orchestration/design.md` if implementation differs

Deliverables:

- concise parent guidance
- conditional task-owned child runtime contract in prompt assembly
- child assignment/result contract docs
- README task tool summary

Validation:

- prompt module stays principle-level and does not duplicate full docs
- task-owned child prompt is assembled from `promptAssembly.ts`, not duplicated into individual agent markdown files
- task-owned child final answers remain brief and do not duplicate task receipts
- package docs describe current behavior, not aspirational future phases

## Minimal Vertical Slice

If implementation must be split, the first shippable slice should be:

1. `TaskStore` create/list/get/claim/submit/accept/reconcile.
2. Parent tools: `task_create`, `task_list`, `task_get`, `task_accept_result`.
3. Extend `subagent_start({ taskId })` for ready-task assignment.
4. Child-owned `task_submit_result` using env run/task/token identity.
5. Reconciliation for task-owned child terminal runs without task receipts.
6. `task.result_submitted` parent wakeup with handled-state clearing.
7. Widget row annotation with task ID/title for owned runs.

Defer:

- automatic scheduler loop beyond parent-triggered `subagent_start({ taskId })`;
- child-side waiting;
- keyboard task toggles;
- complex artifact browsing;
- cross-session task lists;
- task summary read-model cache.

## Risk Register

### R1 — Child identity spoofing

If `task_submit_result` trusts model-provided `runId`, a child could submit for another task. Mitigation: use harness-injected current run/task identity plus a cryptographic task token; store only token hash; reject parent-only tools in child contexts.

### R2 — Lock contention or stale locks

A crashed process could leave the task list locked. Mitigation: lock metadata, same-host PID checks, TTL, and explicit stale-lock error messages.

### R3 — Dependency cycles

Cycles would create permanently blocked task sets. Mitigation: validate full graph on every dependency mutation; avoid child-facing dependency mutation in v1.

### R4 — Prompt/tool ambiguity

A generic task update tool would blur progress, result, dependency, and acceptance responsibilities. Mitigation: narrow tools with clear names and descriptions.

### R5 — Widget clutter

Combining run and task state can overwhelm the editor-adjacent UI. Mitigation: show task annotations on run rows first, compact task section second, strict max rows and overflow summary.

### R6 — Wakeup spam

Emitting wakeups for every ready/progress event would interrupt the lead too often. Mitigation: only wake for result_ready/failed/needs_input by default; make ready wakeups conditional.

### R7 — Storage drift between task owner and run state

Duplicating task assignment in both task file and run status can diverge. Mitigation: make task file authoritative; only cache task metadata in run status if performance requires it.


### R8 — Child resolves a different root session

A child Pi process has a fresh extension module map and may create a new root session unless env root identity is honored. Mitigation: `ensureRoot` must pass `ASYNC_SUBAGENTS_ROOT_SESSION_ID` into `createRootSession`; tests must cover child env-root resolution.

### R9 — Task remains running after child terminal exit

If the child exits without `task_submit_result`, the task could stay `running` forever. Mitigation: terminal lifecycle or lazy read-path reconciliation must transition/surface the task.

### R10 — Duplicate task/run wakeups

Task-owned runs can produce both normal subagent result wakeups and task result wakeups. Mitigation: define task-owned subscription policy and suppress/handle normal successful result wakeups after task result submission.

### R11 — Reopened prerequisites invalidate downstream work

Reopening a completed prerequisite can make downstream running/completed tasks stale. Mitigation: block reopen by default when dependents are active/completed, or require explicit force and list/cancel/reopen affected dependents.

## Validation Commands

Routine package validation:

```sh
npm run check --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
```

Full repo validation before merge if changes touch shared build/types:

```sh
npm run check
npm run build
```

Manual TUI validation should be done in an interactive Pi terminal after widget changes; headless tests can validate width/chrome but not final terminal ergonomics.
