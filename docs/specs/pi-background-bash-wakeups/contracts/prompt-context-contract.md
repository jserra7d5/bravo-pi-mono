# Prompt and Context Contract

Status: implemented
Applies to: extension prompt injection in `index.ts`, tool descriptions, start responses, README guidance

## System prompt guidance

Implemented prompt guidance must describe current behavior, not the old unsupported state:

```txt
Background bash is available: use bash({ command, run_in_background: true }) for long-running work whose process you own: tests, builds, dev servers, scripts, package installs, migrations, and services. Do not append shell &. For background calls, timeout is the background process maximum runtime, not a return timeout; set it to the full expected workload budget or omit it when the default is appropriate. Use wake_on_completion: true when the agent should resume after the task completes, fails, times out, or is manually stopped. In v1 wakeups are per-call opt-in only. Wakeups include task id, terminal status, exit code/signal, output path, and a bounded output tail. Do not use Monitor for workloads; use Monitor only to observe external state. For servers/watchers/noisy commands with no bounded terminal condition, avoid wake_on_completion unless you intentionally want a terminal alert. Read the returned output path or use background_task_* tools when needed. Stop tasks when done.
```

## Tool description updates

`bash` description should teach the decision boundary:

- use foreground for short commands;
- use `run_in_background` for long-running workloads;
- use `wake_on_completion` only when a later model turn should be triggered by terminal completion;
- timeout in background mode is process maximum runtime.

Auxiliary task tools should keep their current responsibility and must not imply they can start tasks.

## Start response update

Every background start response must explicitly state wake policy:

- `Wake on completion: enabled`
- `Wake on completion: disabled`

If enabled, include what will wake:

```txt
A model wake will be requested when this task exits, fails, times out, or is manually stopped. Session-shutdown kills do not model-wake in v1.
```

If disabled, include what remains available:

```txt
No model wake will be requested. Completion is recorded in task metadata and the output log.
```

## Notification framing

Wake messages must begin with a clear control-plane marker, for example:

```txt
[BACKGROUND BASH NOTIFICATION — NOT USER INPUT]
```

or the XML attribute:

```xml
<background_bash_notification not_user_input="true">
```

The agent-facing instruction should treat these messages as evidence/events, not new user requests.

## Behavior-shaping stance

This feature should not be implemented as a prompt-only fix. The prompt only teaches when to opt in. The harness must enforce:

- background task ownership;
- durable terminal metadata;
- exactly-once wake gating;
- bounded payloads;
- quiet default behavior;
- owner-session-only routing.

## Evaluation cases

Prompt/context behavior should be validated with a small behavior eval or transcript-style fixture after implementation:

1. User asks agent to run a long test/build and continue when done.
   - Expected: agent uses `run_in_background: true` and `wake_on_completion: true`.
2. User asks agent to start a dev server for later manual inspection.
   - Expected: agent uses `run_in_background: true`, probably omits `wake_on_completion`, records output path.
3. User asks agent to watch external logs/CI status.
   - Expected: agent uses Monitor, not background bash, because the job is observation of external state.
4. Agent starts a short command.
   - Expected: foreground `bash`, no background/wake.
5. Background notification arrives.
   - Expected: agent treats it as control-plane evidence, reads output/status if tail is insufficient, and continues the prior workstream.

## Context-presentation rule

Keep initial prompt wording compact. Detailed event schema belongs in docs and in the actual wake payload, not as a long prompt block.
