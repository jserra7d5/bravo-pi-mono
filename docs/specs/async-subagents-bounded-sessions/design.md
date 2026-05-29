# Async Subagents Bounded Sessions Design

Date: 2026-05-17
Status: Historical design, amended by async wakeups/timeouts

> Amendment: this bounded-session design predates the wakeup-first tool cleanup. Current async-subagents no longer exposes model-facing `subagent_wait` or sync start/continue modes, and public runtime budgets are `maxRunSeconds` / `defaultMaxRunSeconds`. Timeout expiry is a resumable pause with bounded `subagent_continue({ additionalRunSeconds })`; see `docs/specs/async-subagents-async-wakeups-timeouts/design.md` and `packages/async-subagents/README.md`.

## Problem

The current async-subagents package has the right small primitive: parent Pi sessions start durable child runs, wait for child events, collect results, and receive wake-ups. The weak spot is execution/session architecture.

Today, child runs are bounded `pi -p` processes launched with `--no-session`. That keeps completion semantics clean, but it throws away Pi-native session durability, makes repeated runs less observable, and blocks future session-fork semantics. Separately, fully interactive child agents are tempting, but making every child a live Pi session would blur completion, cleanup, cost, and result boundaries.

The design target is therefore:

> Keep bounded agents as the default, but make every bounded child run Pi-session-backed.

This gives us simple completion semantics plus durable Pi-native traces. Interactive children remain an explicit higher-cost mode, not the default.

## Design Position

Async subagents should curate toward bounded agents:

- a child gets a narrow task;
- the child runs to a terminal result;
- the parent can wait, inspect, interrupt, continue while live, and collect output;
- the run stores both async-subagents runtime files and Pi-native session files.

`pi-subagents` is useful design input here. It also launches child work as fresh `pi -p` subprocesses, but it does not blindly use `--no-session`. It chooses `--session <file>`, `--session-dir <dir>`, or `--no-session` based on policy, and its `context: "fork"` path branches a persisted parent Pi session rather than replaying a summary.

This spec adopts those system ideas while keeping async-subagents smaller and file-backed.

## Core Model

There are two layers of durability.

```text
.subagents/runs/<runId>/
  status.json
  events.jsonl
  inbox.jsonl
  result.json
  artifacts/
  logs/
  pi-session/
    session.jsonl
```

The async-subagents layer owns orchestration state:

- run status;
- child events;
- parent-to-child inbox;
- terminal result;
- wake-up delivery metadata;
- parent root/session leases.

The Pi session layer owns the actual Pi conversation:

- model turns;
- tool calls;
- stdout/stderr traces as Pi records them;
- session branch identity when context is forked;
- future replay/export/debugging.

The two layers should reference each other but not collapse into one format.

## Execution Modes

### Bounded Oneshot

Bounded oneshot remains the default mode.

Launch shape:

```bash
pi --session <runDir>/pi-session/session.jsonl \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --no-extensions \
  --system-prompt <runDir>/artifacts/system.md \
  --tools <allowlist> \
  -e <child-control-extension> \
  --mode text \
  -p @<runDir>/artifacts/task.md
```

Key properties:

- process exit is the completion boundary;
- exit `0` means `completed`;
- nonzero means `failed`;
- parent cancellation writes `cancelled`;
- max runtime expiry writes `expired`;
- `result.json` is written once and terminal writes are idempotent.

This mode is best for scouts, reviewers, bounded workers, audits, and verification passes.

### Interactive

Interactive agents are explicit and exceptional.

Interactive mode is for children that are expected to stay alive across parent steering turns. It should not be the default for normal delegation.

Interactive mode requires:

- a real Pi session file;
- a PTY or other supported Pi interactive harness if plain stdio is insufficient;
- explicit states: `running`, `idle`, `waiting_for_input`, `paused`, `blocked`, terminal states;
- heartbeat/status events;
- parent idle notices with dedupe and batching;
- explicit result/task-turn events because process exit is no longer the normal completion boundary.

Until that full protocol exists, `mode: interactive` should be treated as experimental or limited to long-running children that can still produce clear terminal results.

## Context Policy

Agent definitions should support explicit context policy.

```yaml
context: fresh | fork
```

### Fresh

`fresh` is the default.

The child receives only:

- its agent system prompt;
- the runtime contract;
- explicit includes;
- the assigned task;
- selected file hints or attachments;
- allowed tools, skills, and extensions.

Fresh agents are more cache-friendly, easier to reason about, and less likely to inherit irrelevant parent state.

### Fork

`fork` branches the parent Pi session at the current leaf and uses that branched session file for the child.

The child inherits real parent conversation context, but as a reference branch. It is not the same live conversation as the parent and should not answer as if it is continuing the parent thread.

Fork requires:

- parent session persistence is enabled;
- the parent runtime can identify the current Pi session file;
- the parent runtime can identify the current leaf/message id;
- Pi exposes or supports a branch/fork operation for session files.

If fork cannot be created, the runtime should fail clearly unless the caller explicitly permits fallback to `fresh`.

## Session Policy

Child launches should stop using `--no-session` by default.

Recommended policy:

```yaml
session: record | none
context: fresh | fork
```

Defaults:

- `session: record`;
- `context: fresh`;
- `mode: oneshot`.

For `session: record`, create a per-run session file under the run directory and pass it to Pi with `--session`.

For `context: fork`, create the child session file by branching the parent session first, then pass the branched file with `--session`.

For `session: none`, pass `--no-session`. This should be an opt-out for disposable or security-sensitive runs, not the normal path.

## Prompt Stability And Cache Friendliness

Bounded agents should keep stable prompt content stable across runs.

Stable prefix:

- agent prompt body;
- runtime contract;
- explicit include bodies in deterministic order;
- child-control instructions.

Volatile task content:

- assigned task;
- run id;
- parent run id;
- cwd;
- allowed file list;
- result format;
- timestamps only if absolutely needed.

Do not put volatile metadata in the system prompt when it can live in the task prompt. Avoid generated timestamps in prompts. Keep include ordering deterministic. Keep built-in agent definitions byte-stable.

This does not guarantee provider cache hits, but it gives Pi and the provider the best chance to reuse stable prefixes.

## Parent Control Surface

The parent tool surface should remain explicit.

### `subagent_start`

Starts a child run.

Important inputs:

- `agent`;
- `task`;
- `mode`;
- `context`;
- `session`;
- `cwd`;
- `files`;
- `wait`;
- `notifyOn`.

### `subagent_wait`

Waits for child events/results.

The default should remain race-style: return when any selected child has an interesting event or result.

### `subagent_status`

Reads compact state for direct children or selected runs.

Status should include:

- run id;
- agent name;
- state;
- result readiness;
- pid/process health when known;
- Pi session path when available;
- last activity age;
- current tool if available.

### `subagent_result`

Reads terminal `result.json`.

It may include pointers to:

- Pi session file;
- logs;
- artifacts;
- output tail;
- share/export target if implemented later.

### `subagent_message`

Normal parent-to-child input only.

Allowed message types:

- `instruction`;
- `answer`;
- `context`.

Lifecycle messages do not belong here.

### `subagent_interrupt`

Lifecycle interruption.

Actions:

- `pause`;
- `cancel`.

`pause` should use real process control where possible, such as `SIGSTOP`, and write `paused` state.

`cancel` should terminate the child process where possible, write `cancelled` result/status/events, and make later supervisor process-exit observation idempotent.

### `subagent_continue`

Continues an active child.

For paused children, it should use real process control where possible, such as `SIGCONT`, then write `running`.

It may also deliver a normal instruction/answer/context message.

## TUI Integration

The Pi TUI integration should be a projection over durable run files and event streams, not a separate source of truth.

### Status Line

The status line should show a compact aggregate:

```text
subagents: 2 running, 1 waiting, 1 result
```

It should be driven by direct children of the current root session.

### Live Widget

The live widget should show rows for active and recent children:

```text
~ scout running      run_abc  reading package graph
? reviewer waiting   run_def  needs parent answer
| worker paused      run_ghi  paused by parent
* reviewer result    run_jkl  3 findings
```

Rows should include:

- state glyph;
- agent name;
- run id;
- summary/needs/result summary;
- age since last activity;
- current tool or process hint if known.

### Expanded View

An expanded view should expose:

- stdout/stderr tail;
- recent structured events;
- inbox messages;
- result summary/body;
- Pi session path;
- artifact links;
- suggested next actions.

### Wake-Ups

Wake-ups should be delivered to the owning parent session via lease-guarded delivery.

Wake-up-worthy events:

- question;
- blocked;
- result;
- completed;
- failed;
- cancelled;
- expired.

Idle interactive agents may produce batched notices, not one follow-up per child.

Example notice:

```text
3 interactive subagents have been idle for more than 5 minutes.
Suggested actions: subagent_status, subagent_continue, subagent_interrupt.
```

Do not send stale-idle notices for bounded oneshot agents unless they exceed a clear timeout or health policy.

## Process And State Semantics

Run states:

- `created`;
- `queued`;
- `running`;
- `idle`;
- `waiting_for_input`;
- `paused`;
- `blocked`;
- `stalled`;
- `completed`;
- `failed`;
- `cancelled`;
- `expired`.

Terminal states:

- `completed`;
- `failed`;
- `cancelled`;
- `expired`.

Terminal result writes must be idempotent. Once a terminal result exists, later process-close handlers must not overwrite it.

Process health is advisory. The durable state is the contract, but the runtime should reconcile obvious mismatches:

- status says running but PID is gone;
- status says paused but PID is gone;
- status says cancelled but PID still exists.

Reconciliation should emit events rather than silently rewriting history.

## Observability

Each run should persist enough information for postmortem debugging:

- launch command with secrets redacted;
- Pi session path;
- child pid;
- model;
- tools/skills/extensions;
- context policy;
- session policy;
- parent/root run ids;
- stdout/stderr logs;
- structured events;
- final result;
- usage metrics if Pi exposes them.

Runtime metadata is for tracing. It should not be confused with model cache state.

## Non-Goals

- Do not make every child a long-lived interactive session.
- Do not add chains, DAGs, worktree orchestration, or peer intercom.
- Do not preserve Tango compatibility.
- Do not preserve `pi-subagents` data format compatibility.
- Do not use Pi `--continue` or `--resume` as the primary design primitive.
- Do not use lifecycle inbox messages as fake process control.
- Do not auto-close idle interactive agents without explicit policy.

## Architecture Smells To Avoid

- `--no-session` as the default for child runs. This throws away Pi-native observability and future forkability.
- Lifecycle controls hidden inside `subagent_message`. Pause/cancel/continue are runtime actions, not generic chat messages.
- Interactive-by-default children. That creates ambiguous completion, zombie-session risk, and cost leakage.
- Fork fallback without disclosure. If a child requested `context: fork`, silently running fresh is bullshit unless the caller explicitly allowed it.
- Prompt volatility in the system prompt. Run ids, timestamps, and cwd churn should not poison the stable prefix.
- TUI as source of truth. UI should render files/events; it should not own state.

## Implementation From Current Code

Current implementation already has:

- durable run directories;
- child-control extension;
- parent tools;
- wake-up polling;
- `subagent_interrupt`;
- `subagent_continue`;
- terminal idempotence for parent cancellation.

The main implementation steps are:

1. Add `context` and `session` fields to agent definitions and start parameters.
2. Change bounded child launch from `--no-session` to per-run `--session`.
3. Store `piSessionPath` in status/result metadata.
4. Add parent Pi session discovery and fork-session creation.
5. Implement `context: fork` with clear failure behavior.
6. Expand status/live widget rows to include session/process/activity hints.
7. Add idle policy only for real interactive children.

## Open Questions

- What exact Pi API should async-subagents use to branch a session at the current leaf?
- Can interactive children run reliably without a PTY, or do they need a PTY-backed harness?
- Should `session: record` be forced for all `context: fork` children? Probably yes.
- Should `subagent_continue` be allowed for completed bounded runs by creating a new run from prior session context, or should that be a separate `subagent_restart`/`subagent_followup` tool?
- How much Pi usage/model metadata is accessible from session files without parsing unstable internals?
- What retention policy should apply to Pi session files under `.subagents/runs/`?
