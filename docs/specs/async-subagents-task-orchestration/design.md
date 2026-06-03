# Async Subagents Task Orchestration Design

Date: 2026-05-28
Status: Draft

## Problem

Async subagents can run independently and wake the lead Pi session when a child result is ready, but there is no lightweight task layer for sequencing dependent work inside one session. The current prompt guidance correctly says not to pre-launch dependent children, because sibling subagents cannot wait on each other. That avoids the failure mode, but it leaves orchestration state in the lead agent's working memory.

Loom already provides a durable filesystem-backed work graph, but it is intentionally broader than this problem: markdown nodes, typed graph edges, indexing, inboxes, subscriptions, and cross-agent planning workflows. For in-session async-subagent orchestration, that is overkill. The needed primitive is closer to Claude Code's Task V2 model: a small durable task list, explicit dependencies, ownership claims, result receipts, and a terminal UI that shows what each subagent is working on.

## Methodology

This design is an agent-harness change, not just a storage feature. Implementation should follow the Harness Engineering methodology from `/home/joe/Documents/Quantiiv/Optimized-Development-Tooling/plugins/harness-engineering/README.md`:

- use `tool-design` for native tool responsibility boundaries and return shapes;
- use `prompt-design` and `prompt-composition` for parent/child prompt changes and conditional task-owned prompt assembly;
- use `context-presentation` for wakeup envelopes, progressive disclosure, and receipt/artifact pointers;
- use `behavior-shaping` for prompt intervention discipline and verification;
- use `tui-design` for the async-subagents task widget.

Terminal UI implementation should be handled by a Gemini-backed worker lane. That lane owns visual mockups, renderer/widget changes, responsive layout, glyph/color choices, and editor-adjacent placement. Backend task orchestration remains separate. The UI lane still requires independent GPT-backed and Gemini-backed review before acceptance.

## Goals

- Add a lightweight in-session task system owned by `@bravo/async-subagents`.
- Let the lead create dependent task plans without spawning blocked model processes.
- Let child subagents attach structured results and artifacts to their owned task.
- Wake the lead session when parent-relevant task events occur.
- Keep task state durable, inspectable, and recoverable through filesystem-backed state.
- Integrate task state into the existing async-subagents terminal widget.
- Preserve parent-owned scheduling and acceptance semantics.

## Non-Goals

- Replace Loom or implement a general durable work graph.
- Add cross-session or multi-day project planning semantics in v1.
- Let child subagents freely mutate arbitrary tasks or dependencies.
- Start model processes for tasks that are still dependency-blocked by default.
- Add a foreground blocking `wait` flow as the normal orchestration path.
- Replace Pi's footer or duplicate task status in both footer and widget.

## Prior Art

### Claude Code Task V2

Claude Code's task system uses per-task JSON files under a shared task-list directory, a high-watermark file for monotonic IDs, file locks for concurrent updates, `blocks` / `blockedBy` dependency arrays, ownership claims, and a task UI rendered near the prompt input.

Useful pieces to copy:

- Per-task JSON files rather than a heavy graph database.
- Monotonic task IDs.
- Explicit dependencies.
- Owner/claim semantics.
- File watching plus polling fallback for UI updates.
- Compact terminal task list with state glyphs, owner labels, blocker text, and overflow summaries.
- Completion notifications that wake/feed the main loop through a runtime queue rather than a blocking wait tool.

Pieces to tighten for Pi:

- Claude permits broad task mutation by any agent sharing a task-list directory. Pi should scope child writes to owned tasks by default.
- Claude's direct `TaskUpdateTool` can bypass claim checks. Pi should expose narrower tools with clearer responsibilities.
- Claude's `completed` can mean agent-finished. Pi should split child-submitted result from parent-accepted completion.

### Loom

Loom proves that filesystem-backed durable coordination state is viable, but its graph/node/inbox/subscription machinery is larger than the in-session async-subagents need. The async-subagents task layer should reuse Loom's durable-state instincts, not Loom's full machinery.

## Core Principle

Tasks are durable coordination state. Wakeups are delivery hints. Results are artifacts.

The parent/lead session owns scheduling and acceptance. Child subagents own execution and result submission for the task they were assigned.

## Storage Model

Task state should live alongside async-subagent project/run state, scoped to the root Pi session or parent session that owns orchestration.

Example layout:

```text
~/.async-subagents/projects/<project-hash>/session-tasks/<rootSessionId>/
  highwatermark
  events.jsonl
  tasks/
    T-0001.json
    T-0002.json
  receipts/
    T-0001-run_abcd.json
  artifacts/
    T-0001/
```

The exact root can follow existing async-subagents run-store conventions. The important contract is that task state is durable, local, and inspectable without replaying model chat.

## Task Schema

Minimum task shape:

```ts
type TaskStatus =
  | "pending"
  | "running"
  | "result_ready"
  | "completed"
  | "failed"
  | "cancelled";

type Task = {
  id: string;              // T-0001
  title: string;
  description: string;
  status: TaskStatus;

  dependsOn: string[];
  blocks?: string[];       // optional denormalized convenience

  owner?: {
    runId: string;
    agent: string;
    displayName: string;
    assignedAt: string;
  };

  createdBy: string;
  createdAt: string;
  updatedAt: string;

  activeForm?: string;     // e.g. "Reviewing task lifecycle"

  result?: {
    state: "submitted" | "accepted" | "rejected" | "superseded";
    summary: string;
    receiptPath?: string;
    artifactPaths?: string[];
    evidence?: string[];
    commandsRun?: string[];
    notes?: string;
  };

  attempts: Array<{
    runId: string;
    agent: string;
    displayName: string;
    startedAt: string;
    endedAt?: string;
    status: "running" | "result_ready" | "failed" | "cancelled";
  }>;
};
```

## Task State Machine

Canonical stored states:

```text
pending
running
result_ready
completed
failed
cancelled
```

Derived display states:

```text
ready   = pending + dependencies satisfied + no owner
blocked = pending + unresolved dependencies
```

Do not store dependency-derived `blocked` in v1. Derive it from `dependsOn` to avoid drift.

Transitions:

```text
pending/ready → running        parent/scheduler assigns to child
running → result_ready         child submits receipt/artifacts
result_ready → completed       parent/scheduler accepts result
result_ready → pending         parent/scheduler reopens/remediates
running → failed               child fails or reports failure
any active → cancelled         parent/user cancels
```

The load-bearing split is `result_ready` versus `completed`:

- `result_ready` means the assigned child says its work is done and has attached a result.
- `completed` means the parent/scheduler accepts the task as done for dependency progression.

This avoids overloading `completed` to mean both child-submitted and parent-accepted.

## Result Lifecycle

Task result state is distinct from task status:

```text
none
submitted
accepted
rejected
superseded
```

A child may submit a result for its owned task. The parent/scheduler accepts or rejects it.

Child-owned result submission should include a compact summary and pointers, not a giant prose dump. Receipts and artifacts should be stored on disk and referenced from the task.

## Authority Model

### Parent / scheduler may

- Create tasks.
- Define dependencies.
- Assign/claim ready tasks.
- Start child subagents for ready tasks.
- Accept `result_ready → completed`.
- Reject/reopen `result_ready → pending`.
- Cancel or fail tasks.
- Start dependent tasks after prerequisites are accepted.

### Child subagents may

Only for their owned task:

- Append progress notes.
- Attach artifacts or receipts.
- Transition `running → result_ready`.
- Transition `running → failed`.
- Ask for input or report a blocker.

### Child subagents may not by default

- Complete final acceptance.
- Alter dependencies.
- Claim arbitrary tasks.
- Mark sibling tasks complete.
- Start dependent sibling tasks early.

This is stricter than Claude Code's shared-directory authority model and should reduce accidental task corruption.

## Scheduling Semantics

Default behavior: do not spawn children for blocked tasks.

The parent/scheduler should start a child only when the assigned task's required inputs already exist:

```text
task.status === "pending"
all dependencies are completed
no owner exists
```

When a child result is accepted and dependent tasks become ready, the scheduler may immediately start the next ready child lane without waiting for unrelated sibling lanes. This preserves pipelining without pre-launching dependent children.

## Waiting Semantics

A blocking `task_wait` primitive is not the normal path.

Preferred model:

1. Task mutation is written durably.
2. An event is appended to `events.jsonl`.
3. The async-subagents extension projects parent-relevant events.
4. Pi wakes the lead session with a compact runtime envelope.
5. The lead pulls details through tools when needed.

A future `task_wait` tool may be useful for explicit parent/scheduler inspection or noninteractive scripts. It should not be the primary model-facing workflow. Child-side waiting should be advanced/rare, and if added, should suspend cheaply rather than keeping an active model run alive.

## Parent Wakeup Semantics

Wakeups are not user messages and are not task state. They are delivery events.

Flow:

```text
task mutation
→ append event
→ wakeup projector decides event is parent-relevant
→ enqueue Pi wakeup
→ parent receives NOT USER INPUT envelope
→ parent calls task/subagent result tools
→ wakeup marked handled
```

Important wakeup types:

- `task.result_ready`
- `task.failed`
- `task.cancelled`
- `task.ready`
- `task.needs_input`
- `task.reopened`

`task.ready` should be used sparingly to avoid spam. It is most useful when the scheduler is not auto-starting ready work.

Example model-facing wakeup:

```md
[TASK RESULT READY — NOT USER INPUT]

Task: T-004 Implement task lifecycle
Owner: @Rex / run_abc123
State: result_ready
Summary: Implemented task state files and task result receipt writing.
Receipt: receipts/T-004-run_abc123.json
Eligible dependents: T-005 Review task lifecycle

Call task_result({ taskId: "T-004" }) before acting on this result.
```

Wakeups should not include full result bodies. They should include a compact summary plus paths/IDs for pull-based detail.

## Downstream Context Semantics

Downstream agents should read durable task state and artifacts, not sibling chat transcripts.

A downstream assignment should look like:

```md
You are assigned T-007 Review task lifecycle.

Dependencies accepted:
- T-004 Implement task lifecycle

Read prerequisite task receipts/artifacts:
- receipts/T-004-run_abc123.json
- artifacts/T-004/...

Attach your review result to T-007 with a receipt and concise summary.
```

This makes task files and receipts the handoff contract between agents.

## Tool Surface

Use one canonical tool for each user intent. Do not create a task-specific clone of an existing async-subagents action.

Most importantly, `subagent_start` remains the only model-facing tool for spawning a child agent. A child can be spawned with no task assigned, or with an optional `taskId` when the parent wants the run tied to a ready task. Do not add a separate `task_start_subagent`, `task_assign_subagent`, or other spawn wrapper; that would create overlapping tool responsibilities and confuse tool selection.

Prefer narrow task tools with crisp responsibilities over a generic `task_update`.

Candidate native tools:

- `subagent_start`: spawn a child agent, optionally claiming/assigning a ready task via `taskId`.
- `task_create`: create one or more tasks with dependencies.
- `task_list`: list tasks with derived status and compact metadata.
- `task_get`: read full task detail and result pointers.
- `task_submit_result`: child-owned result submission for the assigned task.
- `task_update_progress`: child-owned non-terminal progress update for the assigned task.
- `task_report_blocked`: child-owned blocker/input report for the assigned task.
- `task_accept_result`: parent/scheduler acceptance.
- `task_reopen`: parent/scheduler rejection or remediation routing.
- `task_cancel`: parent/user cancellation.

Tool responsibility boundaries:

- `subagent_start` owns spawning; task assignment is optional metadata and validation on that spawn.
- Progress tools report non-terminal information.
- Result tools submit or accept work.
- Query tools retrieve state.
- Mutation tools change task state.

Avoid making one tool partially do a sibling tool's primary job.

## Prompt Guidance

The async-subagents parent prompt should teach these principles, not enumerate every transition:

- Tasks are durable coordination state; subagent runs are execution attempts.
- Start children only for ready tasks.
- Do not pre-launch dependent children; dependencies are sequenced by the parent/scheduler.
- Child result submission is not parent acceptance.
- Downstream children should consume task receipts/artifacts, not sibling chat.
- Use `subagent_result` for raw run output/diagnostics; use task tools for durable task contract state.

Child task prompting belongs in the generalized async-subagents prompt assembly, not in individual hard-coded agent definitions. Child Pi launches are isolated with `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-extensions`, `--append-system-prompt ""`, and `--system-prompt <runDir>/artifacts/system.md`; therefore the universal child behavior is the assembled system/task prompt plus runtime tool snippets.

For non-task child runs, keep the current default contract: report completion through the normal final answer.

For task-owned child runs, prompt assembly should inject a task-specific runtime contract:

- the durable handoff is the task receipt/result, not a large final answer;
- when done, call `task_submit_result` with concise summary and receipt/artifact pointers;
- keep the final answer brief, e.g. “Submitted result for T-004”; 
- do not duplicate the same large content in both the task receipt and final answer;
- progress/blocker updates should use task progress/blocker tools when available.

Child task prompts should include the assigned task ID, allowed mutation scope, result submission contract, and artifact/receipt expectations.

## Terminal UI Design

The existing async-subagents widget should become the canonical task + subagent surface. Do not add a separate footer status segment for the same information.

### Placement

Initial implementation should enrich the current async-subagents widget rather than introducing a second task widget. The widget currently uses Pi `setWidget` and owns live child status. Task ownership and child run state are coupled, so they should render together.

The widget can remain in its current placement initially. Placement may become configurable later, including an `aboveEditor` mode to more closely match Claude Code's task list above the input.

Use Pi widget factory form so rendering receives Pi's actual width. Do not use `process.stdout.columns`.

### Row-level subagent/task integration

Each live subagent row should show assigned task context when present:

```text
◐ @Rex    worker    T-004 Implement task lifecycle      2m
★ @Casey  reviewer  T-005 Review T-004                  result ready
? @Blair  scout     T-006 Clarify blocker               needs input
```

If a child has no task, render the existing run status without task fields.

### Optional task summary section

When task state exists and there are ready/running/result-ready/blocked items worth surfacing, render a compact task section below the live runs:

```text
Tasks  1 ready · 2 running · 1 result ready
  ★ T-004 Implement lifecycle              @Rex       result ready
  ◐ T-005 Review lifecycle                  @Casey     running
  ▫ T-006 Update docs                       ready
  ⚠ T-008 Add task widget                   blocked by T-004
```

### Glyphs

Use the repo's existing terminal design language:

| State | Glyph | Meaning |
|---|---:|---|
| pending/ready | `▫` | open work |
| running | `◐` | active work |
| result_ready | `★` | child result awaiting acceptance |
| completed | `✓` | accepted/done |
| blocked/needs input | `⚠` or `?` | blocked or parent input needed |
| failed | `✗` | failed |

Use one-cell glyphs and ANSI-aware width math.

### Visibility and ordering

Prioritize visible task rows in this order:

1. `result_ready`
2. `running`
3. `ready`
4. dependency-blocked or needs-input tasks
5. recently completed tasks
6. older completed tasks

If rows exceed available height/line budget, append an overflow summary:

```text
… +2 ready, 1 blocked, 3 completed
```

Completed tasks may remain visible briefly, then auto-hide after a grace period once all tasks are completed. Claude Code uses a 5 second grace period; Pi should choose a similarly short but non-jarring delay.

### Chrome

Use the existing async-subagents container chrome and identity palette. Do not introduce a new palette. Avoid duplicating telemetry already present in Pi's footer.

## Events

Append task lifecycle events to an events log for recovery, wakeup projection, and debugging.

Candidate event types:

- `task.created`
- `task.claimed`
- `task.progress`
- `task.result_submitted`
- `task.result_accepted`
- `task.reopened`
- `task.failed`
- `task.cancelled`
- `task.ready`
- `task.needs_input`

Events should include `taskId`, timestamp, actor, optional `runId`, and a short summary.

## Recovery and Failure Handling

If a child run exits without submitting a result:

- mark the attempt failed or cancelled based on run terminal state;
- clear owner if retry is allowed;
- leave task `pending` or transition to `failed` depending on parent/scheduler policy;
- wake the parent if action is needed.

If a child submits `result_ready` but parent never handles it, the task remains durable and visible in the widget. Wakeup delivery should be idempotent and recoverable, following existing async-subagents wakeup lease/handled semantics.

## Open Questions

- Should task storage be scoped by root session ID, parent session ID, or an explicit task-list ID?
- Should parent acceptance be manual only, or can low-risk tasks be auto-accepted by policy?
- Should `task.ready` wakeups be emitted when auto-scheduling is enabled?
- Should the task widget support a Claude-like keyboard toggle/collapse, or rely on existing Pi widget visibility behavior?
- What is the exact receipt schema for result submissions?
- Should task creation support batch creation with dependency references by local aliases before IDs exist?

## Initial Implementation Sequence

1. Add durable task store and schemas under `packages/async-subagents`.
2. Add narrow task tools for create/list/get/submit/accept/reopen/cancel.
3. Attach optional task metadata to `subagent_start` and run summaries.
4. Emit task lifecycle events and parent wakeups.
5. Extend the async-subagents widget to show task context per run and a compact task section.
6. Add prompt module guidance for task orchestration semantics.
7. Add validation for ownership-scoped child result submission.

## Implementation Addendum (2026-06-02): closing the forward-progress loop

An audit found the v1 task layer reliably stalled: the parent created tasks and then did nothing, leaving tasks at `ready` indefinitely. Root cause was structural rather than a prompt weakness — the two transitions that move a graph *forward* had no runtime signal:

- `task.created` and `task.ready` were both emitted with `wake: false`, so the 2-second wakeup poller (which is the only thing that re-engages an idle parent) never fired for them. Only child-originated events (`result_submitted`, `failed`, `needs_input`) could wake the parent, and those require a child to already be running.
- The design handed forward scheduling to "the parent/scheduler," but no scheduler component existed and the model was given no nudge to act as one. The prompt's "go idle and await wakeups" reflex actively reinforced the stall for the create→start edge.
- `reconcileOwnedRun` existed but was only invoked lazily on `task_list`/`task_get`, so a child that died without submitting left its task stuck at `running`.

Decisions taken (the minimum structural change, not auto-spawn):

- **Forward-progress wakeups, not an auto-scheduler.** `task.ready` is now emitted with `wake: true` — at creation for immediately-ready tasks and at acceptance for newly-unblocked dependents. The parent still chooses *which agent* runs each task via `subagent_start({ taskId })`; the runtime only nudges. This resolves the open question "should `task.ready` wakeups be emitted" with: yes, scoped to readiness transitions, because there is no auto-scheduler to make them redundant.
- **One-shot, staleness-checked ready nudges.** A `task.ready` wakeup is delivered at most once per readiness transition and is skipped at delivery time if the task is no longer an unowned `pending` task (i.e. the parent already started it in-turn). This keeps the good path silent and only re-engages a parent that actually went idle with ready work. Re-readiness after `task_reopen` generates a fresh event and nudges again.
- **Type-appropriate next actions.** Task wakeups now suggest the concrete next action (`subagent_start` for ready, `task_accept_result` for a submitted result, `task_get` for failures/blockers) instead of always pointing at `task_get`. `task_create` likewise points its `next` at `subagent_start` for each ready task rather than back at `task_list`.
- **Reconcile on every tick.** The parent extension reconciles task-owned runs on each poll tick (UI and headless), so a dead owner transitions off `running` and wakes the parent without waiting for a manual inspection. This is done in the parent extension, not the supervisor, because the supervisor process does not carry `rootSessionId`/`taskId`.
- **Prompt teaches the loop, not just the concepts.** The prompt module now contains an explicit create→start→accept→start-next loop, a worked (agent-neutral) example, and a hard rule that ready tasks are parent-driven and must be started rather than idled on.
- **Tool descriptions carry the decision boundary.** Parent task tools gained use-when/avoid-when guidance inline in their descriptions (e.g. `task_create` is for multi-step dependency plans; a single delegation should use `subagent_start` directly).

Deliberately *not* changed: the task tool set was kept intact (no merging `task_clear` into `task_cancel`); child auto-spawn was rejected as out of scope and ill-defined (tasks do not carry an agent assignment); and `task.created` stays `wake: false` (creation needs no feedback).
