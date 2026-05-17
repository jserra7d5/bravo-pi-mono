# Bravo Goals v1 Design

Status: draft
Date: 2026-05-17
Scope: Pi-first long-running goal workspaces under a workspace-level `.bravo/` control directory.

## Summary

Bravo Goals v1 is a Pi-native goal execution system for long-running agent work.

A goal is not just a prompt. It is a named, durable workspace under `.bravo/goals/` containing the goal definition, startup context, structured state, resume checkpoints, receipts, and artifacts. A Pi slash command attaches the current session to one goal workspace, injects the active work prompt, and keeps the loop moving until the goal is paused, blocked, completed, or archived.

The main Pi session is the worker by default. The Judge is separate: an isolated Bravo-owned verifier with broad inspection powers, including command execution and bounded inspection helpers when needed. Completion is evidence-based, not based on the worker deciding that it feels done.

The core design position is:

> Workspace owns orchestration; repos own code. The worker is replaceable; the goal state and receipts are durable.

## Goals

- Provide first-class Pi support for durable `/goal` work.
- Store goals above individual repositories, typically at a multi-repo workspace root such as `~/Documents/Quantiiv/.bravo/`.
- Support multiple named goals without forcing goal files into any one repo.
- Create goal workspaces through an explicit prep flow that defines the problem, context, success criteria, initial task queue, and verification strategy.
- Attach a fresh or existing Pi session to a goal workspace.
- Keep the main Pi session as the normal worker, using appended goal/task instructions rather than replacing Pi's system prompt.
- Add an isolated Bravo-owned Judge loop with enough power to inspect real evidence, run commands, and delegate bounded verification helpers.
- Require receipts for meaningful work and Judge decisions.
- Support pause/resume through durable resume packets.
- Show live goal status in the terminal UI.
- Archive completed and user-verified goals without deleting their history.

## Non-goals

- Do not build a runtime-agnostic goal system first. v1 is Pi-first.
- Do not replace Pi's system prompt for normal worker execution.
- Do not require goals to live inside application repositories.
- Do not make `.goal/` the top-level namespace.
- Do not make the terminal UI a source of truth.
- Do not let the Judge silently become another implementation worker.
- Do not require a server for correctness.
- Do not build a general DAG/workflow engine in v1.

## Design Inputs

This design borrows specific ideas from local research:

- Hermes Agent: auxiliary Judge loop and conservative done criteria.
- GoalBuddy: board-backed state, task queue, receipts, final audit, and local status view.
- Codex `/goal`: native runtime integration, thread goal state, budgets, and narrow completion tool.
- `pi-goal`: small Pi-native continuation loop, status bar, pause/resume/clear controls, and session-backed persistence.
- Ralph: hard story-state loop, one focused unit per iteration, and verification before marking complete.

## Core Concepts

### Bravo Workspace

The Bravo workspace is a hidden control directory at the human workspace root:

```txt
~/Documents/Quantiiv/
  .bravo/
    config.yaml
    goals/
    archived/
    runtime/
    runs/
    logs/

  repo-a/
  repo-b/
  repo-c/
```

The workspace root is intentionally above repos. Many goals are cross-repo, operational, or specification-heavy. Putting goal state in one repo creates false ownership and awkward coupling.

### Goal Workspace

Each goal has a stable slug:

```txt
.bravo/goals/<goal-id>/
  goal.md
  context.md
  state.yaml
  resume.md
  receipts/
  artifacts/
```

Scaffolded files:

| File | Meaning |
| --- | --- |
| `goal.md` | Durable problem statement, desired outcome, success criteria, non-goals, verification plan, and final acceptance criteria. |
| `context.md` | Stable startup context: files to read, repos involved, commands, background, constraints, and gotchas. |
| `state.yaml` | Machine-readable goal state, task queue, active task, verification status, lifecycle, and audit state. |
| `resume.md` | Current resume packet. It may start as "no checkpoint yet", but must exist before pause or fresh-session handoff. |

Scaffolded directories:

| Path | Meaning |
| --- | --- |
| `receipts/` | Worker and Judge evidence records. |
| `artifacts/` | Screenshots, logs, generated reports, or other supporting files. |

### Main Worker

The main attached Pi session is the worker by default.

Worker mode means the goal runtime appends a compact task prompt to the normal Pi session. It does not overwrite the system prompt or impersonate a separate agent identity.

The worker prompt tells the main session:

- which goal is active;
- which files to read;
- which task is active;
- what receipt is required;
- what verification is expected;
- when to stop and hand off to Judge.

### Judge

The Judge is an isolated verifier.

Unlike the worker, the Judge runs as its own Bravo-managed Pi execution, not as the attached worker session and not as the async-subagents package's normal child-agent primitive. It should not inherit the worker's conversation state by default. Its job is to inspect evidence and decide whether the task or final goal is actually complete.

The Judge may:

- read `goal.md`, `context.md`, `state.yaml`, receipts, artifacts, and relevant repo files;
- run commands, tests, typechecks, linters, build steps, and targeted verification;
- inspect runtime artifacts and logs;
- spawn bounded inspection helpers for read-only or focused verification work through Bravo's Judge runtime;
- write a Judge receipt.

The Judge should not implement fixes in ordinary Judge mode. If remediation is needed, the Judge fails the task and the runtime creates or requeues work for the main session. This separation is important; if Judge can freely fix and approve its own fix, the design collapses back into self-judgment.

### Runtime Controller

The runtime controller is not a visible agent role. It is the Pi extension/package logic that:

- loads and validates goal state;
- attaches a Pi session to a goal;
- picks or renders the active task;
- queues worker continuations;
- starts Judge runs;
- updates terminal UI state;
- writes runtime indexes;
- enforces lifecycle transitions.

## Directory Layout

Recommended v1 layout:

```txt
.bravo/
  config.yaml
  goals/
    durable-resume-loop/
      goal.md
      context.md
      state.yaml
      resume.md
      receipts/
        001-worker-implement-checkpoint.md
        002-judge-checkpoint.md
        final-audit.md
      artifacts/
  archived/
    goals/
      2026-05-17-durable-resume-loop/
        archive.md
        goal.md
        context.md
        state.yaml
        resume.md
        receipts/
        artifacts/
  runtime/
    active-goals.yaml
  runs/
  logs/
```

`state.yaml` is authoritative for a goal. `runtime/active-goals.yaml` is an index/cache for Pi sessions and UI discovery.

## Goal Files

### `goal.md`

`goal.md` should be written for both humans and agents.

Recommended sections:

```md
# Goal: Durable Resume Loop

## Problem

## Desired Outcome

## Success Criteria

## Non-goals

## Verification Plan

## Final Acceptance

## Risks and Constraints
```

The success criteria must be concrete enough for the Judge to verify. Vague goals can exist during prep, but activation should require a usable definition.

### `context.md`

`context.md` is stable startup context, not a rolling log.

Recommended sections:

```md
# Context

## Workspace

## Repositories

## Read First

## Commands

## Background

## Known Constraints

## Gotchas
```

As the goal progresses, `context.md` can be amended when durable onboarding context changes, but routine current-state updates should go into `resume.md`, `state.yaml`, receipts, or artifacts.

### `resume.md`

`resume.md` is the current checkpoint for restarting cleanly.

It should answer:

- what the active goal is;
- what is complete;
- what task was active when paused;
- what should be read first on resume;
- what verification is fresh vs stale;
- what decisions were made;
- what not to redo;
- the recommended next action.

`resume.md` is rewritten on pause and may be refreshed by explicit checkpoint commands.

## State Schema

Draft `state.yaml` shape:

```yaml
schema_version: 1

goal:
  id: durable-resume-loop
  title: "Implement durable resume loop"
  status: active # draft | active | paused | judging | blocked | done | archived
  created_at: "2026-05-17T10:00:00-07:00"
  updated_at: "2026-05-17T12:00:00-07:00"

repos:
  - path: packages/bravo-goals
    role: primary
  - path: packages/caveman
    role: related

session:
  attached_pi_session_id: null
  current_worker_turn_id: null
  current_judge_run_id: null

active_task: implement-resume-checkpoint

tasks:
  - id: implement-resume-checkpoint
    title: "Implement resume checkpoint writer"
    kind: work
    status: active # queued | active | awaiting_judge | judging | blocked | done | failed
    boundary_after_pass: fresh_session # inherit | carry | compact | fresh_session
    context_switch_severity: high # low | medium | high
    receipt: null
    judge_receipt: null
    verify:
      - "npm run check --workspace @bravo/goals"
    expected_output:
      - "Pause command writes resume.md"
      - "Resume command loads goal.md, context.md, resume.md, and state.yaml"

judge:
  last_verdict: pass # pass | fail | needs_more_evidence | blocked | none
  last_receipt: receipts/002-judge-checkpoint.md
  active: false

progress:
  completed_tasks: 4
  total_tasks: 9

pause:
  paused_at: null
  pause_reason: null
  resume_context: resume.md

phase_boundary:
  default_after_judge_pass: fresh_session # carry | compact | fresh_session
  after_judge_fail: carry
  before_final_audit: fresh_session
  experimental_flags:
    allow_per_task_boundary: true
    allow_runtime_override: true
    auto_select_from_context_switch_severity: false
  compact_custom_instructions: null
  last_boundary_at: null
  last_boundary_mode: null
  last_boundary_reason: null

final_audit:
  status: pending # pending | passed | failed
  receipt: null
  judge_run_id: null

user_verification:
  status: pending # pending | verified
  verified_at: null
  verified_by: null
  note: null

archive:
  archived_at: null
  archived_path: null
  forced: false
  reason: null
```

The progress fields may be computed from tasks. If cached, the checker must validate them.

## Receipts

Receipts are Markdown with required YAML frontmatter.

Worker receipt:

```md
---
schema_version: 1
type: worker
task_id: implement-resume-checkpoint
status: complete
created_at: "2026-05-17T12:15:00-07:00"
files_changed:
  - packages/bravo-goals/extensions/pi/tools.ts
commands:
  - "npm run check --workspace @bravo/goals"
---

# Worker Receipt: Implement Resume Checkpoint Writer

## Summary

## Evidence

## Commands

## Remaining Risk
```

Judge receipt:

```md
---
schema_version: 1
type: judge
task_id: implement-resume-checkpoint
verdict: pass # pass | fail | needs_more_evidence | blocked
created_at: "2026-05-17T12:20:00-07:00"
commands:
  - "npm run check --workspace @bravo/goals"
inspection_helpers:
  - run_01HX...
---

# Judge Receipt: Implement Resume Checkpoint Writer

## Verdict

## Evidence Checked

## Commands Run

## Missing or Weak Evidence

## Recommendation
```

Receipts should cite concrete evidence: file paths, command outputs, screenshots, logs, or artifacts. A receipt that only says "done" is not sufficient.

## Lifecycle

Goal statuses:

| Status | Meaning |
| --- | --- |
| `draft` | Goal workspace exists but is not active. |
| `active` | A Pi session may work the goal. |
| `judging` | Judge is verifying a task or final audit. |
| `paused` | Runtime loop is stopped and resume context is written. |
| `blocked` | Goal needs user input or external action. |
| `final_audit` | All worker tasks are done and the final Judge audit is pending or running. |
| `done` | Final audit passed, but goal is not archived. |
| `archived` | Goal was moved to `.bravo/archived/goals/`. |

Worker tasks are the only entries in `tasks`. Judge runs and final audits are
modeled under `judge` and `final_audit`, not as `kind: judge` tasks. After a
worker receipt validates, the active task moves to `awaiting_judge`; once the
Judge run starts, it moves to `judging`; a passing verdict moves it to `done`.
When every task is done, `active_task` becomes `null` and `/goal judge --final`
runs the final audit. A passing final audit moves `goal.status` to `done`.

### Prep

Prep creates a draft goal workspace.

Expected command:

```txt
/goal prep durable-resume-loop
```

The prep flow may inspect the workspace and ask clarifying questions. It writes `goal.md`, `context.md`, and initial `state.yaml`. Activation should require user approval or an explicit `/goal start`.

### Start

Expected command:

```txt
/goal start durable-resume-loop
```

Start behavior:

1. Resolve `.bravo/goals/durable-resume-loop`.
2. Validate required files and schema.
3. Bind current Pi session to the goal in `runtime/active-goals.yaml`.
4. Set goal status to `active`.
5. Render the goal HUD.
6. Inject the active worker prompt.

### Worker Step

The worker performs the active work task and writes a receipt. The worker does not mark the final goal complete directly.

After a worker receipt is present, the runtime transitions to Judge.

### Judge Step

The Judge verifies the worker receipt against the task, goal criteria, and actual evidence.

Judge verdicts:

| Verdict | Runtime behavior |
| --- | --- |
| `pass` | Mark task done and select next task. |
| `fail` | Requeue task or create a follow-up work task. |
| `needs_more_evidence` | Ask worker for a stronger receipt or more verification. |
| `blocked` | Mark goal blocked and surface required input/action. |

### Phase Boundary

After a task passes Judge, the runtime may cross a phase boundary before starting the next task. This is configurable because different goals need different context behavior.

Supported modes:

| Mode | Meaning | Use when |
| --- | --- | --- |
| `carry` | Keep the same Pi session and continue without compaction or replacement. | The next task is tightly coupled to the current one, context is small, or the user wants maximum continuity. |
| `compact` | Trigger Pi compaction with goal-aware custom instructions, then continue in the same session. | Context is useful but too large/noisy, and preserving a summarized version of the current conversation is preferable to a hard reset. |
| `fresh_session` | Write/refresh `resume.md`, create a replacement Pi session, and inject a restart prompt that points at `goal.md`, `context.md`, `state.yaml`, and `resume.md`. | A task is complete and verified, the next task should start with clean attention, or before final audit. |

Recommended v1 defaults:

```yaml
phase_boundary:
  default_after_judge_pass: fresh_session
  after_judge_fail: carry
  before_final_audit: fresh_session
  experimental_flags:
    allow_per_task_boundary: true
    allow_runtime_override: true
    auto_select_from_context_switch_severity: false
```

`fresh_session` is the preferred default because it gives the useful part of Ralph's fresh-context loop while keeping Bravo's durable state and receipts as the source of truth. The replacement session should receive a small navigational prompt, not a pasted copy of every goal file:

```txt
You are resuming a Bravo goal in a fresh Pi session.

Read these files before acting:
1. .bravo/goals/<goal-id>/goal.md
2. .bravo/goals/<goal-id>/context.md
3. .bravo/goals/<goal-id>/state.yaml
4. .bravo/goals/<goal-id>/resume.md

Then continue the active task from state.yaml. Do not redo completed tasks unless the state or Judge receipt says evidence is weak.
```

`compact` is an explicit supported mode, but it should not be mixed with `fresh_session` for the same boundary. Compaction creates an in-session summary. `fresh_session` uses `resume.md` as the durable handoff. Doing both by default creates two summaries that can drift. Compact continuation must wait for Pi's compaction completion; the runtime must not call `compact()` and immediately inject the next worker prompt.

If the Judge fails a task, the default should be `carry`. The worker often benefits from the immediate failure context while remediating the same task.

Goal prep may set a per-task boundary hint when it creates the initial task queue:

```yaml
tasks:
  - id: scout-runtime-hooks
    title: "Map Pi session replacement hooks"
    boundary_after_pass: fresh_session
    context_switch_severity: high
  - id: fix-render-label
    title: "Fix compact HUD label"
    boundary_after_pass: carry
    context_switch_severity: low
```

Boundary selection precedence:

1. explicit runtime command flag, such as `/goal next --compact`;
2. task `boundary_after_pass`, when enabled;
3. goal-level `phase_boundary.default_after_judge_pass`;
4. package default.

`context_switch_severity` is advisory in v1. It records why the prep agent thought a boundary was needed. If `auto_select_from_context_switch_severity` is enabled experimentally, the runtime may map `low -> carry`, `medium -> compact`, and `high -> fresh_session`, but this should be off by default until the behavior is proven.

### Pause

Expected command:

```txt
/goal pause durable-resume-loop
```

Pause is not merely "stop continuation." It is a checkpoint transition:

1. Stop new worker continuations.
2. Write a controller-known `resume.md` snapshot, or queue an agent-authored checkpoint and wait for an explicit checkpoint receipt before treating the pause as fully checkpointed.
3. Update `state.yaml` with pause metadata.
4. Detach the active Pi session binding.
5. Update the HUD to paused.

If a task is partially complete, state should say so honestly. The next resume should not trust partial work without evidence.

### Resume

Expected command:

```txt
/goal resume durable-resume-loop
```

Resume behavior:

1. Read `goal.md`, `context.md`, `resume.md`, and `state.yaml`.
2. Rebind the current Pi session.
3. Validate whether the active task has a usable receipt.
4. If needed, Judge current evidence before continuing.
5. Continue from active task or select the next task.

### Verify

Expected command:

```txt
/goal verify durable-resume-loop
```

Verify records explicit user verification after final audit passes:

```yaml
user_verification:
  status: verified
  verified_at: "2026-05-17T12:30:00-07:00"
  verified_by: "joe"
  note: "Confirmed behavior in local Pi session."
```

### Archive

Expected command:

```txt
/goal archive durable-resume-loop
```

Archive requires by default:

- `goal.status: done`;
- final audit passed;
- user verification recorded;
- no active attached Pi session;
- state validates;
- receipts exist for completed tasks.

Archive moves:

```txt
.bravo/goals/durable-resume-loop
```

to:

```txt
.bravo/archived/goals/2026-05-17-durable-resume-loop
```

and writes `archive.md`:

```md
# Archived Goal: Durable Resume Loop

Archived: 2026-05-17T12:45:00-07:00
Original path: .bravo/goals/durable-resume-loop
Final status: done
Final audit: receipts/final-audit.md
User verified: yes

## Outcome

## Key Receipts
```

`/goal archive --force` may exist, but it must record `archive.forced: true` and a reason.

The archived copy should record `goal.status: archived` while preserving the
pre-archive done/final-audit/user-verification fields. Archive must not delete
receipts, artifacts, Judge run pointers, or `resume.md`.

## Slash Commands

Draft command surface:

```txt
/goal prep <goal-id>
/goal start <goal-id-or-path>
/goal status [goal-id]
/goal pause [goal-id]
/goal resume <goal-id-or-path>
/goal judge [goal-id] [--final]
/goal next [goal-id] [--carry | --compact | --fresh]
/goal checkpoint [goal-id]
/goal compact [goal-id]
/goal verify <goal-id> [--note "..."]
/goal archive <goal-id> [--force --reason "..."]
```

`handoff` and `clear-session` are deferred from v1. `checkpoint`, `pause`,
`compact`, and `fresh_session` already cover the durable handoff cases, and Pi
does not expose a public in-place transcript clear API.

## Pi Runtime Integration

### Worker Prompt Injection

Worker mode appends a compact control prompt as ordinary runtime input. It does not replace Pi's system prompt.

The prompt should include:

- goal id/title;
- required files to read;
- active task;
- expected receipt path;
- verification commands;
- stop condition: write receipt and stop for Judge.

The worker's completion tool, if exposed, should be narrow. It may signal that the work receipt is ready. It should not be able to mark the final goal done.

### Judge Execution

The Judge should run isolated from the worker context. Preferred v1 implementation:

- start a Bravo-managed Judge run in an isolated Pi execution context;
- pass the goal path, task id, receipt path, and allowed inspection scope;
- allow command execution according to Pi/runtime permissions;
- optionally allow bounded read-only inspection helpers for evidence gathering;
- require a Judge receipt path.

Judge-spawned inspection helpers must be scoped. Default helper mode should be read-only unless the runtime explicitly creates a remediation work task.

Judge command execution must be policy-bound. V1 should use Bravo-owned
`judge_bash` or controller-run verification commands. Raw Pi `bash` is an unsafe
experimental mode only; prompt-only "do not edit" guidance is not enough for an
independent verifier.

### Phase Boundary Execution

Phase-boundary execution uses Pi's session primitives:

- `carry`: queue the next worker prompt in the current session.
- `compact`: call Pi compaction with goal-aware custom instructions and queue the next worker prompt when compaction completes.
- `fresh_session`: write/refresh `resume.md`, call Pi replacement-session APIs, then seed the replacement session with a restart prompt from the replacement-session context.

`fresh_session` should use the replacement-session context after the switch. The old command context is stale after session replacement.

### Runtime Index

`.bravo/runtime/active-goals.yaml` is a convenience index:

```yaml
schema_version: 1
active_goals:
  - goal_id: durable-resume-loop
    path: .bravo/goals/durable-resume-loop
    pi_session_id: pi_abc123
    status: active
    active_task: implement-resume-checkpoint
```

The index must be recoverable from per-goal `state.yaml` files if missing or stale.

## Terminal UI

The terminal UI should provide a compact goal HUD while a Pi session is attached to a goal.

Collapsed example:

```txt
Goal: Durable resume loop | Task: checkpoint writer | 4/9 [######----] | Judge: pass
```

Expanded status example:

```txt
GOAL  Implement durable resume loop
STATE active
TASK  Implement resume checkpoint writer
DONE  4/9  [########--------] 44%
JUDGE last: pass  next: queued
```

The HUD should render:

- goal title;
- lifecycle status;
- active task title;
- completed/total tasks;
- progress bar;
- last Judge verdict;
- budget if configured;
- pause/resume hints when useful.

The HUD is read-only. It renders `state.yaml` and runtime index data. It must not own hidden state.

Event names for responsive updates:

```txt
goal.started
task.started
task.receipt_ready
judge.started
judge.completed
goal.paused
goal.resumed
goal.blocked
goal.completed
goal.archived
```

Events improve responsiveness, but files remain the source of truth.

## Validation

v1 should include a goal checker command or library that validates:

- required files exist;
- `state.yaml` schema is valid;
- active task exists;
- task progress counts match tasks;
- done tasks have receipts;
- Judge-passed tasks have Judge receipts;
- final audit requirements are met before `done`;
- user verification exists before archive;
- runtime index does not contradict per-goal state.

The checker should be runnable from Pi commands and directly from CLI/tests.

## Open Questions

- Exact Pi extension/package boundary: one package with slash commands plus extension UI, or separate CLI plus Pi extension wrapper?
- Exact implementation shape for Bravo-managed Judge runs and Judge-spawned inspection helpers.
- Whether v1 should include token/time budgets or defer budget accounting until the loop is stable.
- Whether `context.md` updates should be user-approved, Judge-approved, or freely written by the worker when durable context changes.
- Whether archived goals should be compressed or left as plain directories.

## Architectural Risks

- **Judge drift into implementation.** If Judge starts fixing work by default, the system loses independent verification. Keep Judge write behavior off by default.
- **Stale context.** If `context.md` becomes a rolling log, startup quality will degrade. Use `resume.md`, receipts, and artifacts for evolving state.
- **Hidden UI state.** If the HUD stores its own progress, it will eventually lie. Render durable files.
- **Weak receipts.** If receipts do not cite concrete evidence, the Judge loop becomes ceremony.
- **Overbuilt task taxonomy.** v1 should keep visible task kinds small: `work` and `judge`. Prep is a flow, and controller behavior is runtime logic.
