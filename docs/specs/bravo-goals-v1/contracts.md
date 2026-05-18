# Bravo Goals v1 Contracts

Status: draft  
Date: 2026-05-17  
Scope: Implementation contracts extracted from the design and research artifacts.

## Filesystem Contract

Workspace root:

```txt
.bravo/
  config.yaml
  goals/
  archived/
  runtime/
  runs/
  logs/
```

Workspace discovery must prefer an existing ancestor `.bravo/config.yaml`.
Creating a new workspace is explicit: the caller supplies `--workspace-root`
or confirms the chosen root. The runtime must not silently create a repo-local
`.bravo/` merely because the current directory is inside a repository.

Goal workspace:

```txt
.bravo/goals/<goal-id>/
  goal.md
  context.md
  state.yaml
  receipts/
  artifacts/
  resume.md      # created by checkpoint or pause
```

Prep scaffold creates `goal.md`, `context.md`, `state.yaml`, `receipts/`, and
`artifacts/`. `resume.md` is not created during prep; it is created by the
first checkpoint or pause when there is an actual stopping point to preserve.
It must exist before a goal can enter `fresh_session` or `paused`.

Archived goal:

```txt
.bravo/archived/goals/<yyyy-mm-dd>-<goal-id>/
```

Run storage:

```txt
.bravo/runs/<run-id>/
```

## `state.yaml`

Required top-level keys:

- `schema_version`
- `goal`
- `repos`
- `session`
- `active_task`
- `tasks`
- `judge`
- `progress`
- `pause`
- `phase_boundary`
- `final_audit`
- `user_verification`
- `archive`

`active_task` is a task id while work remains. It may be `null` only when every
task is `done` and the goal is in `final_audit`, `done`, or `archived`.

Task contract:

```yaml
id: implement-resume-checkpoint
title: "Implement resume checkpoint writer"
kind: work
status: active # queued | active | awaiting_judge | judging | blocked | done | failed
boundary_after_pass: fresh_session # inherit | carry | compact | fresh_session
context_switch_severity: high # low | medium | high
receipt: null
judge_receipt: null
verify: []
expected_output: []
```

The task queue is worker-owned. Judge runs are not tasks. After a worker receipt
validates, the task moves from `active` to `awaiting_judge`; when a Judge run is
started it moves to `judging`; a passing verdict moves it to `done`. A failing
verdict moves it to `failed` or back to `active` with a follow-up note/task,
depending on the verdict recommendation.

Phase boundary contract:

```yaml
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
```

## Receipt Contract

Receipts are Markdown with YAML frontmatter. The frontmatter is the machine
contract; the body is the human rendering. Receipts must cite concrete evidence,
and each completion claim must have at least one evidence reference.

Worker receipt required frontmatter:

```yaml
schema_version: 1
type: worker
task_id: implement-resume-checkpoint
status: complete # complete | partial | blocked
created_at: "2026-05-17T12:15:00-07:00"
files_changed: []
commands:
  - command: "npm run check --workspace @bravo/goals"
    exit_code: 0
    output_path: ".bravo/goals/durable-resume-loop/artifacts/check.txt"
claims:
  - claim: "Pause command writes resume.md"
    evidence:
      - "packages/bravo-goals/src/runtime.ts"
      - ".bravo/goals/durable-resume-loop/artifacts/check.txt"
remaining_risk: []
```

Judge receipt required frontmatter:

```yaml
schema_version: 1
type: judge
run_id: judge_01HX
task_id: implement-resume-checkpoint
verdict: pass # pass | fail | needs_more_evidence | blocked
created_at: "2026-05-17T12:20:00-07:00"
verdict_path: ".bravo/runs/judge_01HX/verdict.json"
receipt_path: ".bravo/goals/durable-resume-loop/receipts/002-judge.md"
commands:
  - command: "npm run check --workspace @bravo/goals"
    exit_code: 0
    output_path: ".bravo/runs/judge_01HX/artifacts/check.txt"
inspection_helpers: []
claims_checked:
  - claim: "Pause command writes resume.md"
    result: pass
    evidence:
      - "packages/bravo-goals/src/runtime.ts"
```

A receipt with only a summary is invalid for completion. A Judge receipt is
invalid unless `run_id`, `verdict`, `verdict_path`, and `receipt_path` match
the corresponding `verdict.json`.

## Judge Run Contract

Run directory:

```txt
.bravo/runs/judge_<run-id>/
  run.json
  status.json
  events.jsonl
  verdict.json
  receipt.md
  prompt/
    system.md
    task.md
  pi-session/
    session.jsonl
  home/
  logs/
  artifacts/
```

Goal-local Judge pointers:

```txt
.bravo/goals/<goal-id>/judge/
  current.json
  runs/
    judge_<run-id>.json
```

`.bravo/runs` is canonical. Goal-local Judge files are pointers/summaries.

`run.json` is input/config:

```json
{
  "schema_version": 1,
  "run_id": "judge_01HX",
  "goal_id": "durable-resume-loop",
  "goal_path": ".bravo/goals/durable-resume-loop",
  "task_id": "implement-resume-checkpoint",
  "final_audit": false,
  "worker_receipt_path": ".bravo/goals/durable-resume-loop/receipts/001-worker.md",
  "judge_receipt_path": ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
  "workspace_root": "/home/joe/Documents/Quantiiv",
  "cwd": "/home/joe/Documents/Quantiiv",
  "allowed_scope": [],
  "allowed_tools": ["read", "grep", "ls", "judge_bash", "judge_finish"],
  "verification_commands": [],
  "timeout_ms": 900000,
  "helper_policy": {
    "enabled": false,
    "max_helpers": 0
  },
  "command_policy": {
    "mode": "judge_bash",
    "unsafe_raw_bash": false
  },
  "created_at": "2026-05-17T12:20:00-07:00"
}
```

`status.json` states:

```txt
created -> running -> succeeded | failed | blocked | timed_out | cancelled
```

Terminal statuses are `succeeded`, `failed`, `blocked`, `timed_out`, and
`cancelled`. Timeout or cancellation must finalize `status.json` and append an
event even when no verdict exists.

`verdict.json` is machine-authoritative output:

```json
{
  "schema_version": 1,
  "run_id": "judge_01HX",
  "goal_id": "durable-resume-loop",
  "task_id": "implement-resume-checkpoint",
  "final_audit": false,
  "verdict": "pass",
  "receipt_path": ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
  "evidence_checked": [],
  "commands_run": [],
  "inspection_helpers": [],
  "missing_or_weak_evidence": [],
  "recommendation": "advance_task",
  "created_at": "2026-05-17T12:20:00-07:00"
}
```

Allowed Judge verdicts:

- `pass`
- `fail`
- `needs_more_evidence`
- `blocked`

Judge completion is invalid unless the verdict and Markdown receipt both exist,
refer to the same `run_id`, `task_id`, `verdict`, and `receipt_path`, and the run
reached a terminal status.

## Judge Command Policy

V1 Judge command execution must go through Bravo-owned command policy:

- preferred: `judge_bash`, a controlled command tool that records command,
  cwd, exit code, stdout/stderr artifact paths, and blocks obvious mutation
  commands unless explicitly configured;
- allowed: explicit preconfigured verification commands run by the controller;
- unsafe experimental: raw Pi `bash`, only when `unsafe_raw_bash: true` is
  present in `run.json`.

Prompt-only "do not edit" rules are not a command policy. If raw `bash` is
enabled, the HUD/status/receipt must make the unsafe mode visible.

## Judge Helper Contract

Judge helpers are disabled by default in v1. If enabled, each helper needs:

- an assignment file with objective, allowed scope, allowed tools, no-delegation
  rule, and expected return schema;
- a result file with claims, evidence paths, commands, and residual risk;
- a pointer from `verdict.json.inspection_helpers`.

Helper summaries are not evidence unless they cite files, commands, logs, or
artifacts that the Judge can inspect.

## Runtime Index Contract

`.bravo/runtime/active-goals.yaml`:

```yaml
schema_version: 1
active_goals:
  - goal_id: durable-resume-loop
    path: .bravo/goals/durable-resume-loop
    pi_session_id: pi_abc123
    status: active
    active_task: implement-resume-checkpoint
```

This file is an index/cache. Per-goal `state.yaml` is authoritative.

## Pi Command Contract

Commands:

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

Commands that perform session replacement must be command handlers, not event handlers.

Command responsibilities:

- `prep`: scaffold a draft goal workspace, then prompt the agent to ask the
  user for goal intent before drafting content; the goal id is only a stable
  slug, and `--title` is only a working title.
- `start`: attach this Pi session, validate state, and queue the active worker prompt.
- `checkpoint`: write a controller-known `resume.md` snapshot or queue an agent
  checkpoint and leave the goal in a checkpoint-pending state until a receipt exists.
- `pause`: stop new continuations, require or create a current `resume.md`, detach
  the session, and set goal status `paused`.
- `resume`: attach a session to a paused or active goal and queue a restart prompt.
- `next`: advance after a passed Judge verdict, applying boundary precedence.
- `compact`: request compaction only; follow-up continuation occurs after compact completion.
- `judge`: start a Judge run for the active task or final audit.
- `verify`: record user verification after final audit passed.
- `archive`: move a done, user-verified goal to `.bravo/archived/goals/`.

`handoff` and `clear-session` are deferred from v1 because their responsibilities
overlap with checkpoint, pause, compact, and fresh-session boundaries.

## HUD Contract

Footer status key:

```txt
bravo-goals
```

Widget key:

```txt
bravo-goals-hud
```

The HUD must render from `state.yaml` and runtime index only. It must not own hidden progress state.
