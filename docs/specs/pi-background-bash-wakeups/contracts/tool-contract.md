# Tool Contract

Status: implemented
Applies to: `packages/pi-extension-background-bash/src/bash-tool.ts`

## `bash` input

The overridden `bash` tool keeps the built-in foreground subset and adds managed background fields:

```ts
type BashInput = {
  command: string;
  timeout?: number;
  run_in_background?: boolean;
  wake_on_completion?: boolean;
};
```

`wake_on_completion` is tri-state in the parsed input:

- `true` means request a model wake for this task's terminal transition.
- `false` means explicitly suppress model wake for this task, even if a future config-level default exists.
- `undefined` means use the package default policy for the current release.

## Foreground behavior

When `run_in_background` is omitted or false:

- Delegate to the existing foreground implementation.
- Preserve built-in-compatible timeout, cwd, abort, output, and error behavior.
- Ignore `wake_on_completion`; it has no meaning for foreground calls.

## Background behavior

When `run_in_background: true`:

- Start exactly one managed background task owned by the extension.
- Return immediately with a normal Pi tool result containing:
  - task id;
  - initial status;
  - durable output path;
  - wake policy status;
  - lifecycle-control guidance.
- Interpret `timeout` as maximum process runtime, in positive integer seconds, not as a tool-call wait timeout.
- Accept omitted `timeout` and use `defaultMaxRuntimeMs`.
- Reject fractional, zero, negative, too-large, and too-small background timeouts.
- The v1 minimum background `timeout` is 30 seconds and the maximum is 86,400 seconds, matching the current tool schema cap.
- Do not use shell `&` or job-control backgrounding.

Recommended start response shape:

```txt
Background command started.
Task: bg_20260630_abcdef
Status: running
Output: /home/user/.pi/background-bash/bg_20260630_abcdef/output.log
Wake on completion: enabled

Use read on the output path or background_task_status/list/stop for lifecycle control.
```

If wake is disabled:

```txt
Wake on completion: disabled
Completion will be recorded in task metadata/UI only; use background_task_status or read the output path when you need results.
```

## Effective wake policy

The effective wake policy for a task is computed once at task start and persisted in the task record.

V1 effective wake policy is per-call opt-in only:

```ts
effectiveWakeOnCompletion = input.wake_on_completion === true;
wakePolicyVersion = effectiveWakeOnCompletion ? 1 : undefined;
wakePolicySource = effectiveWakeOnCompletion ? "tool_arg_v1" : undefined;
```

A persisted task is wake-eligible only when `wakeOnCompletion === true`, `wakePolicyVersion === 1`, and `wakePolicySource === "tool_arg_v1"`. Pre-existing task metadata that lacks the v1 source marker is not wake-eligible, even if it contains `wakeOnCompletion: true`.

Constraints:

- Default config remains `notifyModelOnCompletion: false`.
- V1 implementation must not honor pre-existing `notifyModelOnCompletion: true` as an automatic wake default. That field is reserved until a versioned config contract can prove safe rollout and per-call opt-out.
- No migration or prompt update may silently enable config-level default wakeups.
- If a later release enables config defaults, explicit `wake_on_completion: false` must suppress that default:

```ts
effectiveWakeOnCompletion =
  input.wake_on_completion === true ||
  (input.wake_on_completion !== false && versionedConfig.notifyModelOnCompletion === true);
```

- If wake was enabled by any future config default, the start response must say so explicitly (`Wake on completion: enabled by config`).

## Auxiliary tools

Existing task tools keep their responsibilities:

- `background_task_list({ includeCompleted?: boolean })` lists task summaries for the current session.
- `background_task_status({ taskId })` inspects one current-session task.
- `background_task_stop({ taskId, signal?, killAfterMs? })` requests termination of one current-session live task.

Wakeup requirements:

- Listing, status reads, cleanup, and metadata inspection must never emit model wakeups.
- `background_task_stop` may cause a wake only through the task's actual terminal transition and only when the task's persisted wake policy is enabled.
- Stop on an already terminal task must not re-add it to the active registry and must not wake.

## Error semantics

- Invalid input returns a normal tool error result and creates no background task.
- Spawn failure before a durable task process exists returns a failed task result if a record was created, but should not require a delayed wake.
- Wake delivery failure must not corrupt task terminal state. It must be recorded as notification metadata/log evidence.

## Compatibility

- Existing calls that omit `run_in_background` remain valid.
- Existing background calls that omit `wake_on_completion` remain quiet by default.
- Existing `background_task_*` contracts remain session-scoped.
