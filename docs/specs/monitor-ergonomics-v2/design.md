# Monitor Ergonomics v2

## Status

Implemented pragmatic v2 subset in `packages/monitor` and aligned background-bash prompt guidance in `packages/pi-extension-background-bash`.

## Problem

The current Pi monitor package exposes a broad durable-watch subsystem directly to the model. That surface is powerful, but it creates the wrong selection prior:

- agents use command monitors as a replacement for background bash;
- monitor wakeups appear as user-channel pressure even when they are control-plane events;
- command monitor output can spam the conversation with repeated status blocks;
- agent-facing duration parameters are in milliseconds even though shell/tool ergonomics are in seconds;
- notification and acknowledgement controls expose internal delivery/bookkeeping decisions as model work.

This is a harness issue, not a model issue. The prompt, tool descriptions, return shapes, and unsolicited event messages currently teach conflicting concepts:

- background bash says long-running commands should run with `run_in_background`;
- monitor guidance says long-running commands/builds/deploys may be command monitors;
- command monitor output says it is a monitor event, but arrives shaped like user input.

The redesign aligns monitor ergonomics with Claude Code's simpler split:

> Use background bash for long-running work. Use Monitor for event streams and observers.

## Goals

- Make Monitor a small event-observation primitive, not a general background process runner.
- Match Claude Code ergonomics where useful:
  - one-shot "wait until done" -> `bash({ run_in_background: true })`;
  - streaming logs/events or polling external state -> Monitor;
  - output lives in a file and is read with the normal `read` tool.
- Reduce model-facing monitor tools to the minimum durable control surface.
- Remove model-facing acknowledgement/bookkeeping unless a real workflow requires it.
- Use seconds for every agent-facing duration parameter.
- Standardize all unsolicited monitor messages with explicit start tokens and `NOT USER INPUT` semantics.
- Use behavior-shaping principles: fix the harness contradiction and tool boundary, not by adding brittle one-off rules.

## Non-goals

- Preserve every existing monitor tool as model-facing.
- Support command monitors as generic background task execution.
- Add UI notification controls to the model-facing schema.
- Dump raw streaming output into the conversation by default.
- Create fake tool-call/tool-result messages for monitor events. Pi extension-originated async events are typed follow-up messages via `pi.sendMessage`.

## Current failure diagnosis

### Observed failures

The `feedback/monitor-ux-feedback-2026-06-02.md` report captured these failures:

1. duplicate output spam from `gh run watch`;
2. monitor wakeups visually indistinguishable from user input pressure;
3. stale queued output after stopping/replacing a noisy monitor;
4. confusing scheduled command semantics;
5. no first-class state-change-only output.

Additionally, the lead session agent used monitor as a background bash command substitute. With background bash installed, that behavior should be discouraged by tool shape and prompt, not patched with narrow warnings.

### Triage

- Category: tool exposure / tool responsibility issue plus prompt-vs-tool-description contradiction.
- Load-bearing source: previous monitor guidance and `monitor_start` schema described command monitors as suitable for long-running work.
- Correct intervention layer: redesign tool contract and coupled prompt modules; do not add a one-off "do not use monitor for X" behavior list without changing the tool boundary.

## North-star contract

Monitor is a durable observer of state change.

Use Monitor when waiting is about observing an external condition:

- streaming logs/events;
- polling CI/deploy status;
- watching queue depth or service health;
- waiting for a file/event condition;
- receiving a wakeup when meaningful evidence appears.

Do not use Monitor to run the workload being waited on. Use background bash for that.

### Load-bearing constraints

- **Do not wake the model for non-actionable progress.** In Pi, extension-originated wakeups become conversation messages. A woken model generally must produce a turn, so non-actionable progress wakeups create agent chatter even when the message says `NOT USER INPUT`.
- **Monitor events that use `triggerTurn: true` must be actionable or terminal.** Informational/progress events should be persisted to the output file and monitor state only.
- **Background bash completion delivery is part of this boundary.** The prompt must not promise "you will be notified" unless the background-bash extension actually sends a reliable completion wakeup. Until then, the wording should say to use returned output paths/task controls rather than sleep/poll loops.
- **Observer commands are observational by contract.** They should inspect another system's state and emit evidence. Commands whose primary purpose is to perform work belong to bash, even if they stream logs.

## Agent-facing tool surface

### Default model-facing tools

| Tool | Purpose | Model-facing? | Notes |
|---|---|---:|---|
| `monitor_start` | Start a stream/poll/file event observer | yes | Primary surface |
| `monitor_stop` | Stop a monitor permanently | yes | Required cleanup/control |
| `monitor_list` | Recover/list active monitors | yes | Compact only |

### Removed debug/helper tools

The v2 package surface is intentionally limited to `monitor_start`, `monitor_list`, and `monitor_stop`. Former helper tools are removed rather than hidden. Output is inspected through the generated `output_path` with normal file-reading tools; result, acknowledgement, and attention bookkeeping remain internal implementation details.

## `monitor_start` v2 schema

All duration values are seconds at the model boundary. Internally the package may convert to milliseconds.

Use a discriminated union, not one flat polymorphic object. Flat schemas make the model pass invalid field combinations.

```ts
type MonitorStartInput = StreamMonitorInput | PollMonitorInput | FileMonitorInput;

type CommonMonitorInput = {
  name?: string;
  description?: string;
  wake?: "never" | "on_event" | "on_failure" | "on_terminal";
  throttle_s?: number;
  monitor_lifespan_s?: number;
  labels?: Record<string, string>;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
};

type StreamMonitorInput = CommonMonitorInput & {
  kind: "stream";
  command: string;
  cwd?: string;
  shell?: boolean;
  emit?: "line" | "state_change" | "terminal";
  projection?: MonitorProjection;
  command_timeout_s?: number;
};

type PollMonitorInput = CommonMonitorInput & {
  kind: "poll";
  command: string;
  cwd?: string;
  shell?: boolean;
  interval_s: number;
  emit?: "state_change" | "terminal";
  projection?: MonitorProjection;
  command_timeout_s?: number;
};

type FileMonitorInput = CommonMonitorInput & {
  kind: "file";
  path: string;
  file_mode: "exists" | "missing" | "modified" | "contains";
  pattern?: string;
  encoding?: "utf8";
  interval_s?: number;
  emit?: "state_change" | "terminal";
};

type MonitorProjection =
  | { type: "json"; key_paths: string[] }
  | { type: "regex"; pattern: string; group_names?: string[] }
  | { type: "line" };
```

`output_path` is not accepted from the model. The harness always generates a sandboxed output path under `.pi/monitors/<monitor_id>/output.log` and returns it. This prevents overwrite/path traversal/collision problems.

### Kind semantics

| Kind | Meaning | Correct examples | Incorrect examples |
|---|---|---|---|
| `stream` | Start a long-running observer whose output lines are evidence about another system | `tail -F app.log`, `kubectl logs -f`, `gh run watch` when raw stream is desired | `npm test`, `pytest`, `npm run dev`, `npm test --watch` |
| `poll` | Re-run a finite observer command on an interval and emit only meaningful changes | `gh run view --json status,conclusion,jobs`, `kubectl get deploy -o json`, `curl /health` | `npm run build`, migrations, package installs |
| `file` | Watch filesystem state | file exists, file contains text, file modified | generic command execution |

The stream/workload boundary cannot be solved by examples alone. Implementation should enforce it with layered defenses:

- schema and prompt say `command` is an observer command;
- validation returns a clear warning/error for obvious workload commands when confidence is high;
- ambiguous cases are allowed but the return should remind the agent that Monitor is only for observation;
- behavioral evals test the selection boundary rather than hard-coding every forbidden command.

### Defaults

| Field | Default | Rationale |
|---|---:|---|
| `emit` for `stream` | `line` | Claude-like event stream |
| `emit` for `poll` | `state_change` | suppress duplicate polling output |
| `emit` for `file` | `state_change` | only wake on condition changes |
| `wake` | `on_failure` | avoid user/model spam by default |
| `throttle_s` | `5` | batch bursty output |
| `interval_s` for `poll` | no default; required | force explicit polling cadence |
| `command_timeout_s` | package default | max seconds for one observer command execution |
| `monitor_lifespan_s` | no default | total monitor lifespan before `expired` |
| `output_path` | generated | normal `read` can inspect details |

### Resource guardrails

The tool must enforce resource limits rather than relying on prompt compliance:

- `interval_s` minimum: package-defined, initially 5 seconds for external polling.
- active monitors per session: package-defined cap, initially 5.
- active monitors per workspace: package-defined cap to prevent cross-session runaway.
- output max bytes per monitor: package-defined cap with truncation marker written to the output file.
- monitor lifespan max: package-defined hard ceiling unless operator config overrides it.
- command execution timeout: package-defined default and max for `command_timeout_s`.

Validation errors should be recovery-oriented: state the violated limit and the corrected field name/value shape.

### Output path, retention, and cleanup

- The model cannot choose `output_path`.
- The generated path is always `.pi/monitors/<monitor_id>/output.log` or an equivalent harness-owned state directory.
- Writes must not follow model-provided paths, symlinks, or project file paths.
- Output files should support normal `read` offsets and `grep` workflows.
- Large output is capped and marked with a truncation notice in the file.
- If normal `read` cannot tail/offset monitor logs ergonomically enough, add a narrow `monitor_tail` later rather than reviving a broad output helper surface.
- `monitor_stop` preserves output by default. A separate operator cleanup path may delete monitor directories.
- Retention should be configurable by age/count/bytes. Defaults should prevent unbounded `.pi/monitors` growth.

Do not add `clean_up` to the default model-facing `monitor_stop`; cleanup is an operator/storage policy, not normal agent work.

### Projection semantics

Projection is the state-change key for poll and optional stream monitors.

- Prefer `key_paths` over raw `jq`; key paths avoid JSON-escaping failures in tool calls.
- `key_paths` are dot-separated paths into parsed JSON, e.g. `status`, `conclusion`, `jobs[0].status` if array indexing is supported.
- If JSON parsing fails, the poll result is an observer error. It may wake according to failure policy.
- Projection values are canonicalized before comparison: stable object key order, normalized line endings, and no timestamps unless selected by key path.
- Missing keys are represented as explicit `null` values in the projection, not omitted.
- Regex projection returns full match plus named groups when configured.
- For `stream`, projection applies per line or per parsed event chunk; otherwise line text is the event.

### Idempotency

If `idempotency_key` is supplied and an active monitor with the same key exists in the same owner scope, `monitor_start` returns the existing monitor metadata instead of starting a duplicate observer.

If the existing monitor is terminal, the tool may either return it with `state` and `output_path` or start a new monitor only when the caller supplies a different key. The default should favor no duplicate side effects.

## Return shapes

### `monitor_start` return

Return a compact status envelope. Do not include full config unless debug mode is requested.

```json
{
  "ok": true,
  "monitor_id": "mon_...",
  "state": "running",
  "kind": "poll",
  "name": "GitHub deploy watch",
  "output_path": ".pi/monitors/mon_.../output.log",
  "wake": "on_failure",
  "next_action": "Continue other work. Read output_path only if woken or if evidence is needed."
}
```

### `monitor_list` return

Compact rows only:

```json
{
  "ok": true,
  "items": [
    {
      "monitor_id": "mon_...",
      "name": "GitHub deploy watch",
      "kind": "poll",
      "state": "running",
      "last_event_summary": "smoke test in progress",
      "output_path": ".pi/monitors/mon_.../output.log"
    }
  ],
  "count": 1
}
```

### `monitor_stop` return

```json
{
  "ok": true,
  "monitor_id": "mon_...",
  "state": "stopped",
  "output_path": ".pi/monitors/mon_.../output.log"
}
```

`monitor_stop` should terminate stream command process groups with graceful SIGTERM then bounded SIGKILL escalation. The stop timeout is an implementation/operator setting unless exposed later; it is not part of the default agent-facing schema. Stopping a monitor should suppress stale queued wakeups, while preserving output and terminal metadata for recovery.

## Lifecycle

| State | Meaning | Entered by | Agent action |
|---|---|---|---|
| `running` | observer is active | `monitor_start` | continue other work |
| `event` | meaningful event occurred | stream line, poll projection changed, file condition changed | inspect only if relevant |
| `failed` | observer failed | nonzero poll/stream failure or internal error | diagnose or report blocker |
| `ended` | observer stream ended or terminal condition reached | command exit 0, file condition satisfied, poll terminal | summarize only if relevant |
| `stopped` | monitor stopped | `monitor_stop` | none |
| `expired` | monitor exceeded `monitor_lifespan_s` | lifespan timeout | treat as attention if the observed condition still matters |

Implementation may keep richer internal states, but model-facing states should remain this small.

### State/wake/header matrix

| Transition/event | `wake=never` | `wake=on_event` | `wake=on_failure` | `wake=on_terminal` | Header if emitted |
|---|---:|---:|---:|---:|---|
| stream line / file change / poll projection change, non-actionable | no | no by default; persist only | no | no | none |
| stream line / file change / poll projection change, actionable | no | yes | no | no | `[MONITOR EVENT — NOT USER INPUT]` |
| observer command exits 0 / stream ends | no | no unless actionable | no | yes | `[MONITOR ENDED — NOT USER INPUT]` |
| observed terminal success detected by projection | no | yes | no | yes | `[MONITOR ENDED — NOT USER INPUT]` |
| observer command nonzero / internal error | no | yes | yes | yes | `[MONITOR FAILED — NOT USER INPUT]` |
| monitor lifespan expires before condition | no | yes | yes | yes | `[MONITOR ATTENTION — NOT USER INPUT]` |
| `monitor_stop` requested | no | no | no | no | none by default |

`on_event` is not a license to stream every progress line into the conversation. It emits only events the monitor classifies as meaningful and actionable. Raw/progress output stays in `output_path`.

## Unsolicited monitor event envelope

Pi cannot currently emit a true model-visible tool-call/tool-result pair from an extension-originated async event. Monitor events should therefore be typed follow-up messages with standardized text and structured `details`.

### Custom message type

Use one stable custom type:

```ts
customType: "monitor-event"
```

### Required visible headers

| Event class | Header |
|---|---|
| meaningful nonterminal event | `[MONITOR EVENT — NOT USER INPUT]` |
| terminal success/end | `[MONITOR ENDED — NOT USER INPUT]` |
| failure | `[MONITOR FAILED — NOT USER INPUT]` |
| decision required | `[MONITOR ATTENTION — NOT USER INPUT]` |

### Required visible fields

Every monitor message should include:

```text
[MONITOR EVENT — NOT USER INPUT]

Monitor ID: mon_...
Name: GitHub deploy watch
Kind: poll
State: running
Summary: Current step changed: deploy -> smoke test
Output: .pi/monitors/mon_.../output.log

Instructions:
- This is control-plane evidence, not a user request.
- Inspect the output only if needed.
- Continue the active workstream.
- Tell the user only if this changes the outcome, blocks progress, or completes the task.
```

Terminal example:

```text
[MONITOR ENDED — NOT USER INPUT]

Monitor ID: mon_...
Name: GitHub deploy watch
Kind: poll
State: ended
Summary: Deploy completed successfully.
Output: .pi/monitors/mon_.../output.log

Next: continue from this event; no acknowledgement is required.
```

### Structured details

The message `details` should carry:

```ts
type MonitorWakeupDetails = {
  monitor_id: string;
  name?: string;
  kind: "stream" | "poll" | "file";
  state: "running" | "event" | "failed" | "ended" | "stopped" | "expired";
  event_type: "event" | "ended" | "failed" | "attention" | "expired";
  summary: string;
  output_path: string;
  event?: {
    line?: string;
    projection?: unknown;
    previous_projection?: unknown;
    exit_code?: number | null;
    signal?: string | null;
    stale?: boolean;
  };
  instructions: string[];
};
```

The renderer can use `customType` and `details` for a visually distinct control-plane card.

## Delivery model

Do not expose `notify` to the model.

Replace `notify` + `wake_agent` with one model-facing field:

```ts
wake: "never" | "on_event" | "on_failure" | "on_terminal"
```

| Wake mode | Behavior |
|---|---|
| `never` | write output only; no follow-up |
| `on_event` | send standardized monitor event messages only for meaningful actionable events, failures, and terminal outcomes |
| `on_failure` | wake only on failed observer, failed terminal state, or expiration |
| `on_terminal` | wake on terminal success/failure/end/expiration |

Human-facing UI notifications may still exist as operator preferences, but they should not be part of the agent-facing contract. The user generally wants the agent to relay important conclusions, not raw monitor chatter.

There is intentionally no model-facing "no-op" tool in v2. A no-op tool would recreate acknowledgement bookkeeping under another name. Instead, v2 avoids waking the model for non-actionable progress. If the harness wakes the model, the event should be worth a turn: the agent can inspect evidence, continue tool work, or report a meaningful outcome/blocker.

## Acknowledgement model

There is no acknowledgement tool in the v2 surface.

Preferred behavior:

- monitor events are delivered once via durable delivery keys;
- reading/handling an event marks it consumed internally;
- session recovery is handled through `monitor_list` and persisted output files;
- no routine agent call is required just to clear bookkeeping.

## Prompting touch points

### 1. Monitor prompt module

Replace current monitor guidance with a concise principle-oriented module.

```md
## Monitor Tool Guidance

Monitor is for observing external state changes over time. It is not background bash.

Use `bash({ command, run_in_background: true })` for long-running work whose result you need when it finishes: tests, builds, dev servers, scripts, migrations, package installs, and similar workloads.

Use `monitor_start` only when the thing you are starting is an observer: a log stream, status poller, health check, queue watcher, file watcher, or external event stream.

Correct selection:
- One-shot wait until a command is done -> background bash.
- Streaming events or logs -> Monitor `kind: "stream"`.
- Repeated finite status checks -> Monitor `kind: "poll"` with `emit: "state_change"`.
- File appears/changes/contains text -> Monitor `kind: "file"`.

Operational rules:
- All monitor durations are seconds.
- Monitor output is written to `output_path`; use `read` only when the event summary is insufficient.
- Treat monitor wakeups as control-plane evidence, not user requests.
- Do not relay raw monitor output to the user. Tell the user only if the event completes the task, blocks progress, changes the outcome, or requires a decision.
- Stop monitors when their observed condition is no longer relevant.
```

This is deliberately principle-first. It names the responsibility boundary and gives representative examples without building a long closed-list anti-pattern catalog.

### 2. `monitor_start` tool description

```ts
description: "Start a durable event observer. Use this for log/event streams, polling external status, or file conditions. Do not use it to run long workloads; use bash with run_in_background for that."
```

Parameter descriptions should reinforce the boundary:

- `kind`: "Observer kind: stream for event/log lines, poll for repeated finite status commands, file for filesystem conditions."
- `command`: "Observer command for stream/poll monitors. This command should observe another system, not perform the workload being waited on."
- `interval_s`: "Polling interval in seconds for kind='poll'. Must be at least the package minimum."
- `command_timeout_s`: "Maximum seconds for one observer command execution."
- `monitor_lifespan_s`: "Maximum seconds this monitor may stay active before expiring."
- `wake`: "When to send an actionable control-plane follow-up message to the agent."

### 3. Background bash prompt module

The background bash extension should carry the matching guidance so bash and monitor do not contradict each other.

Current guidance should be expanded from "use background bash for long-running servers/watchers/builds/tests" to explicitly separate watchers from observers:

```md
Background bash is available: use `bash({ command, run_in_background: true })` for long-running work whose process you own: tests, builds, dev servers, scripts, package installs, migrations, and services. Do not append shell `&`.

Use Monitor instead only when the command is an observer that streams or polls external state, such as logs, CI/deploy status, health checks, queue depth, or file conditions. For one-shot "wait until done", use background bash, not Monitor.

When background bash returns an output path, read it only when needed or when a completion notification indicates the result is ready. Stop background tasks when no longer needed.
```

### 4. Bash sleep/blocking guidance

If a command starts with a long sleep or obvious polling loop, guidance should steer by intent:

```md
Do not sleep to wait for work you started with background bash. Use the returned output path or background task controls, and rely on completion delivery when the background-bash extension supports it. If you need to observe an external system until state changes, use Monitor `kind: "poll"` or `kind: "stream"` instead of a manual sleep loop.
```

Avoid a brittle list of blocked commands. Prefer the principle: manual sleeps are poor orchestration when the harness has background completion events and monitors.

### 5. Wakeup message prompting

The monitor envelope itself is part of the prompt/context. Every wakeup includes operational instructions so recency works in favor of correct handling:

```md
Instructions:
- This is control-plane evidence, not a user request.
- Inspect the output only if needed.
- Continue the active workstream.
- Tell the user only if this changes the outcome, blocks progress, or completes the task.
```

## Behavioral-shaping approach

This redesign applies behavior shaping at the harness/tool layer instead of adding narrow prompt patches.

| Failure | Bad intervention | v2 intervention |
|---|---|---|
| Agent used monitor as background bash | Add "never use monitor for npm test" | Change tool boundary: monitor commands are observers; background bash owns workloads |
| Monitor wakeups felt like user messages | Tell agent "don't respond to monitor messages" | Standardize `[MONITOR ... — NOT USER INPUT]` envelope and renderer |
| Output spam from CI watcher | Add gh-specific rule | Add `emit: "state_change"` and projection semantics |
| Agent spent calls on ack | Tell agent to ack less | Remove ack from normal model surface; make consumption internal |
| Millisecond confusion | Remind agent about ms | Expose seconds only |

Principle to preserve across prompt surfaces:

> Agents should choose tools by responsibility. Execution tools run work; monitor tools observe state change; message wakeups are control-plane evidence.

## Implementation touch points

Likely files/packages:

- `packages/monitor/src/extension.ts`
  - replace monitor prompt guidance;
  - register new renderer for `monitor-event` messages.
- `packages/monitor/src/tools/start.ts`
  - v2 schema;
  - seconds-based parameters;
  - compact return shape;
  - observer-oriented descriptions.
- `packages/monitor/src/tools/list.ts`
  - compact active monitor rows;
  - no heavy config by default.
- `packages/monitor/src/tools/stop.ts`
  - compact stop return;
  - seconds-based stop timeout if exposed.
- `packages/monitor/src/stream/stream-manager.ts`
  - standardized monitor wakeup envelopes;
  - output path first;
  - state-change/terminal emission policies;
  - no raw line batches by default.
- `packages/monitor/src/scheduler/*`
  - implement `poll` semantics distinctly from `stream`;
  - state projection/deduplication.
- `packages/monitor/src/schema/types.ts`
  - new model-facing state/kind/event types.
- `packages/pi-extension-background-bash/src/index.ts`
  - update background bash prompt guidance.
- `packages/pi-extension-background-bash/src/bash-tool.ts`
  - consider bash schema/prompt description alignment if needed.

## Implementation status

The local development package is v2-only:

- `monitor_start` requires `kind: "stream" | "poll" | "file"` and seconds-based fields.
- Legacy direct start inputs using `check`/`schedule`/`attention`/`retention` without `kind` are rejected.
- Default and exported tool surface is `monitor_start`, `monitor_list`, and `monitor_stop` only.
- Former helper tools have been removed.
- Output is persisted to generated monitor output files and read through normal file tooling.
- Monitor-originated wakeups use the standardized `monitor-event` envelope.
- Poll monitors suppress unchanged state and remain running after state-change events.

### No v1 compatibility requirement

This is a local development extension, not a production compatibility surface. There is no migration/rollback contract for pre-v2 saved monitors, outdated `monitor_start` calls, or hidden operator tools. Stale pre-v2 records may be removed by deleting local monitor state.

## Validation strategy

### Unit/contract tests

- `monitor_start` accepts seconds fields and converts internally.
- `monitor_start` rejects/flags command workload patterns only if implemented as a safety heuristic; do not overfit tests to specific strings unless there is a real guard.
- `poll` with unchanged projection emits no duplicate wakeups.
- `poll` with changed projection emits one standardized event.
- `stream` wakeups use `[MONITOR EVENT — NOT USER INPUT]`.
- terminal success uses `[MONITOR ENDED — NOT USER INPUT]`.
- failure uses `[MONITOR FAILED — NOT USER INPUT]`.
- output path is returned and readable.
- no model-facing ack is required to clear delivered wakeups.

### Integration/recovery tests

- session restart with active monitors restores list/status without duplicate wakeups;
- stale queued line events after `monitor_stop` do not wake the agent;
- stopped/recreated monitor with same name but different ID does not receive old output;
- concurrent monitors preserve distinct output paths and delivery keys;
- user message arriving near a monitor wakeup is ordered so the agent can prioritize real user input;
- stale local v1 monitor state may be deleted; no v1 recovery guarantee is provided;
- output caps write truncation markers and do not exceed retention limits;
- resource guardrails reject too-small intervals and too many concurrent monitors with actionable validation errors.

### Behavioral evals

Use a small eval set with target and adjacent cases. Score tool choice, not prompt-rule compliance.

| Case | Expected choice |
|---|---|
| Run `npm test` and continue other work | `bash(run_in_background: true)` |
| Start dev server | `bash(run_in_background: true)` |
| Watch GitHub Actions with `gh run view --json` | `monitor_start(kind: "poll", emit: "state_change")` |
| Tail deploy logs for errors | `monitor_start(kind: "stream")` |
| Wait for file to appear | `monitor_start(kind: "file")` |
| Need immediate `git status` | foreground `bash`, no monitor |
| Monitor event says deploy failed | inspect evidence, report/block as appropriate |
| Monitor event says step changed but task not complete | continue work; do not update user unless material |

Run pre/post if possible. The target improvement is fewer monitor-as-background-bash choices without regressing legitimate observer use.

## Open questions

- Is key-path JSON projection sufficient for v2, or should raw `jq` remain operator/debug only?
- Should `wake` default be `on_failure` or `on_terminal` for `poll` monitors?
- Should UI alerts exist as a user/operator preference rather than a tool parameter?
- Should command workload detection be a hard validation error, a soft warning, or prompt-only?

## Decision summary

Design Monitor v2 as a small, Claude-like event observer:

- `monitor_start`, `monitor_stop`, `monitor_list` only by default;
- output path plus normal `read` for details;
- seconds at the model boundary;
- standardized `[MONITOR ... — NOT USER INPUT]` envelopes;
- no model-facing `notify` or `ack`;
- background bash owns long-running work;
- monitor owns streaming/polling/file observation.
