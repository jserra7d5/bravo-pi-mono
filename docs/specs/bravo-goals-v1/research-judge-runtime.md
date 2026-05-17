# Judge Runtime Research

Status: draft  
Date: 2026-05-17  
Scope: Bravo-owned Judge execution, separate from the main worker session and not built on async-subagents as the primary abstraction.

## Summary

The v1 Judge should be a Bravo-owned Pi process runner:

- isolated Pi execution;
- separate run directory;
- separate session file;
- separate HOME / Pi agent config;
- prompt files;
- status/events/result files;
- machine-authoritative `verdict.json`;
- Markdown Judge receipt.

Do not launch Judge through async-subagents as the abstraction. Borrow durable run-file and process-supervision patterns only.

## Why Process-Based Judge

The Judge is part of the goal completion protocol, not an ordinary child task delegated by the worker. It needs independent context, evidence contracts, verdict semantics, and UI/status integration.

The attached worker session should not own Judge lifecycle.

## Implementation References

### Pi Invocation

Async-subagents shows how to launch Pi with:

- explicit session path;
- disabled ambient context/skills/templates/extensions;
- explicit system/task files;
- tools;
- skills;
- extensions;
- model;
- text prompt mode.

Evidence:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/src/piHarness.ts:55`

Tango shows isolated HOME / Pi agent home setup:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/src/harnesses/pi.ts:40`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/src/harnesses/pi.ts:61`

Pi CLI relevant args:

- `--mode json|rpc`
- `--system-prompt`
- `--append-system-prompt`
- `--session`
- `--session-dir`
- `--no-session`
- `--tools`
- `-e`
- `--no-context-files`

Evidence:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/cli/args.ts:74`
- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/cli/args.ts:216`

### Run Files

Async-subagents run-store pattern:

- `status.json`
- `result.json`
- `events.jsonl`
- `inbox.jsonl`
- `artifacts/`
- `logs/`
- `pi-session/session.jsonl`

Evidence:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/src/runStore.ts:48`

Supervisor/result references:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/src/supervisor.ts:66`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/src/supervisor.ts:150`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/src/lifecycle.ts:24`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/src/start.ts:234`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/src/result.ts:28`

## Recommended Run Directory Contract

```txt
.bravo/
  runs/
    judge_<run-id>/
      run.json
      status.json
      events.jsonl
      verdict.json
      receipt.md -> ../../goals/<goal-id>/receipts/<receipt-name>.md
      prompt/
        system.md
        task.md
      pi-session/
        session.jsonl
      home/
        .pi/agent/
      logs/
        launch.json
        stdout.log
        stderr.log
        supervisor.log
      artifacts/
  goals/<goal-id>/
    judge/
      current.json
      runs/
        judge_<run-id>.json
```

`.bravo/runs` should be canonical. Goal-local `judge/` files are pointers/summaries.

## Judge Input Contract

`run.json` should include:

```json
{
  "schema_version": 1,
  "run_id": "judge_...",
  "goal_id": "durable-resume-loop",
  "goal_path": ".bravo/goals/durable-resume-loop",
  "task_id": "implement-resume-checkpoint",
  "final_audit": false,
  "worker_receipt_path": ".bravo/goals/durable-resume-loop/receipts/001-worker.md",
  "judge_receipt_path": ".bravo/goals/durable-resume-loop/receipts/002-judge.md",
  "workspace_root": "/home/joe/Documents/Quantiiv",
  "cwd": "/home/joe/Documents/Quantiiv",
  "allowed_scope": [],
  "allowed_tools": [],
  "allowed_commands": [],
  "verification_commands": [],
  "timeout_ms": 900000,
  "helper_policy": {
    "enabled": false,
    "max_helpers": 0
  },
  "model": null,
  "thinking": null,
  "created_at": "2026-05-17T12:20:00-07:00"
}
```

## Verdict Contract

`verdict.json` is machine-authoritative:

```json
{
  "schema_version": 1,
  "run_id": "judge_...",
  "goal_id": "durable-resume-loop",
  "task_id": "implement-resume-checkpoint",
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

Allowed verdicts:

- `pass`
- `fail`
- `needs_more_evidence`
- `blocked`

Judge completion is accepted only if:

- `verdict.json` exists and validates;
- Judge receipt exists;
- `verdict.json.receipt_path` points at the Judge receipt;
- verdict and receipt agree;
- run reached a terminal status.

## Judge Control Extension

The isolated Judge Pi process should load a small Bravo Judge control extension.

Needed tools:

- `judge_event`: append structured progress/status events.
- `judge_finish`: write/validate `verdict.json`, ensure receipt exists, emit `judge.completed`, and request shutdown.

Pi supports extension-triggered shutdown:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/examples/extensions/shutdown-command.ts:21`

Do not rely on parsing final assistant prose as the authority. Final text is supplemental only.

## Tool and Command Policy

The Judge likely needs command execution, but `bash` is dangerous.

Pi's `--tools` is a tool allowlist, not a shell-command allowlist:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/cli/args.ts:232`

V1 recommendation:

- Main Judge may have `bash`, but the prompt must prohibit edits.
- Every command must be captured in `verdict.json` and the receipt.
- Inspection helpers default to read-only tools.
- Add an implementation spike for a Bravo `judge_bash` wrapper or command policy extension.

This is a real risk. Prompt-only "do not edit" is not a hard boundary.

## Open Spikes

- Prove `pi --mode json` plus `judge_finish` plus `ctx.shutdown()` exits cleanly.
- Confirm `--system-prompt` and `--append-system-prompt` file/text semantics.
- Decide Judge cwd: workspace root is recommended, with explicit allowed repo paths.
- Define cancellation and timeout behavior.
- Define inspection-helper run contract.
- Implement receipt/verdict atomicity.
- Build or defer command policy beyond prompt-only restrictions.

