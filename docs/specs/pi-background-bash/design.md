# Pi Background Bash Extension Design

Status: proposed
Date: 2026-05-31
Related: `debates/pi-background-bash-2026-05-31/*`

## Summary

Add an opt-in Pi extension package that overrides the model-facing `bash` tool with a Claude-Code-like `run_in_background` mode. The extension preserves one canonical shell tool for agents while adding managed background task tracking, output files, notifications, status/stop controls, and lifecycle cleanup.

This is intentionally an extension, not Pi core behavior. The default Pi `bash` remains synchronous unless a user explicitly enables this package.

## Background

Claude Code exposes background shell execution as a mode of its Bash tool:

- `run_in_background` starts a long-running command without blocking the agent turn.
- The agent is told not to use shell `&`.
- The runtime records a background task id, redirects output to a disk file, tracks process state, emits completion notifications, allows normal file reading of output, and cleans up owned tasks on shutdown.

Pi extension constraints from the debate:

- Extensions can register custom tools and override built-ins by registering the same name.
- Built-in tool renderer inheritance is slot-based, but prompt metadata is not inherited by an override.
- Built-in `bash` schema is currently only `{ command: string, timeout?: number }`.
- Built-in `BashOperations.exec()` is synchronous and cannot itself return a background task result.
- `createBashTool(cwd, options)` and `createLocalBashOperations()` are exported and should be reused for foreground compatibility where practical.
- Built-in bash already handles synchronous spawn, streaming, timeout/abort, and process-group kill.

## Goals

- Provide Claude-Code-like background bash UX through an opt-in custom `bash` override.
- Preserve a single model-facing command execution surface:
  - foreground: `bash({ command, timeout? })`
  - background: `bash({ command, timeout?, run_in_background: true })`
- Avoid asking the model to choose between `bash` and `background_bash` for command initiation.
- Keep foreground behavior as close as possible to Pi built-in `bash`.
- Provide durable background task metadata, output logs, status, stop, and cleanup.
- Make task output readable through Pi's normal file read tool.
- Add concise prompt guidance, TUI affordances, and slash commands for user/operator control.
- Fail safely for interactive prompts, runaway logs, stalled tasks, and process leaks.

## Non-goals

- Do not change Pi core `bash` semantics for users who do not enable this extension.
- Do not implement shell job control by appending `&` to commands.
- Do not rely on terminal multiplexers such as tmux for the primary implementation.
- Do not make background tasks silently immortal across all Pi restarts.
- Do not implement a fully interactive terminal protocol for background tasks.
- Do not expose arbitrary background task output inline without bounds.
- Do not multiplex status/read/stop sub-actions into the overridden `bash` schema.

## Claude UX Parity Target

The extension should match these Claude Code UX properties:

1. `bash` has a `run_in_background` boolean.
2. Prompt guidance says to use `run_in_background` instead of shell `&` for long-running commands.
3. Background calls return immediately with a task id and output path.
4. Output is redirected to a durable file and can be read later with the normal read tool.
5. Completion produces a structured UI notification and persisted task event by default; model-waking notifications are opt-in.
6. Users can list and stop background tasks.
7. Runtime owns and cleans up non-persistent tasks on shutdown.
8. Watchdogs detect likely interactive prompts, stalled/noisy logs, excessive output, and max runtime.

Intentional differences:

- This package is opt-in because overriding Pi's core `bash` has high blast radius.
- Auxiliary task tools/commands are allowed for lifecycle operations, even though initiation stays unified through `bash`.
- Exact Claude internal notification XML does not need byte-for-byte compatibility; the semantic envelope should be stable.

## Extension Architecture

Package shape:

```txt
packages/pi-extension-background-bash/
  src/index.ts
  src/bash-tool.ts
  src/foreground.ts
  src/background-runner.ts
  src/task-registry.ts
  src/notifications.ts
  src/prompt.ts
  src/ui.ts
```

Runtime components:

- **Bash override tool**: registers tool name `bash` with extended schema.
- **Foreground delegate**: calls exported built-in bash implementation for non-background calls when possible.
- **Background runner**: spawns detached command process/process group, redirects stdout/stderr to files, and monitors exit.
- **Task registry**: persists task metadata and reconstructs task state after reload/session start.
- **Notification emitter**: sends XML-like task events through Pi messaging/UI channels.
- **Task control tools/commands**: list, status, stop, and optionally bounded output tail.
- **TUI integration**: formatted tool cards, status widget/footer, and `/tasks` command with progressive disclosure.

### Recommended direction

Implement a true `bash` override only when the extension is enabled. Do not attempt to add backgrounding through `BashOperations.exec()` alone; that contract is synchronous and insufficient. Keep auxiliary controls separate rather than overloading `bash` with task management actions.

## Tool Activation and Built-in Bash Replacement

Installing the package must make the replacement semantics explicit because the extension intentionally shadows a core built-in tool.

Activation contract:

- The extension registers a tool named exactly `bash` with schema `{ command, timeout?, run_in_background?, wake_on_completion? }`.
- Pi's active tool resolution must select the extension-provided `bash` instead of the built-in `bash` when both are present.
- The extension should verify activation using documented Pi extension APIs (`getAllTools()`, `getActiveTools()`, and source metadata where available) after registration and warn/fail closed if the active `bash` is not the override.
- The extension must not leave two model-visible tools with the same effective `bash` identity. Pi's documented override behavior says registering a tool with the same built-in name replaces that built-in; implementation must verify this against the installed Pi version.
- If active-tool mutation is needed, use documented `setActiveTools()` semantics only. Do not depend on undocumented registry internals.

CLI/config considerations:

- Document the preferred install mode as "enable this extension; do not separately expose built-in `bash`."
- If Pi supports `--exclude-tools`, document excluding the built-in `bash` only when extension override precedence is insufficient or ambiguous.
- If Pi supports `--no-builtin-tools`, document that users must re-enable all required built-ins plus this extension's `bash`; this is not the default migration path.
- If roles/configs use explicit active tool allowlists, migration must replace entries that refer to built-in `bash` with the extension `bash` entry, not add a second shell tool.
- If roles/configs use deny/exclude lists, ensure they do not accidentally exclude the extension `bash` by name.

Failure behavior:

- If the extension cannot prove that its `bash` override is active, it should surface a startup diagnostic and avoid advertising Claude-like background bash guidance.
- If foreground parity checks fail in development or CI, do not ship an override; fall back to separate background tools until fixed.

## Tool Schemas

### Overridden `bash`

```ts
type BashInput = {
  command: string;
  timeout?: number;
  run_in_background?: boolean;
  wake_on_completion?: boolean;
};
```

Foreground behavior:

```ts
bash({ command: "npm test", timeout: 120 })
```

- Delegates to built-in bash-compatible foreground execution.
- Streams and returns output according to existing Pi behavior.
- Honors timeout and abort behavior. Agent-facing `timeout` is in seconds for compatibility with Pi's built-in bash; implementations may convert to milliseconds internally.

Background behavior:

```ts
bash({
  command: "npm run dev",
  run_in_background: true,
  timeout: 300
})
```

Returns normal Pi tool content, not a raw polymorphic object. The model-visible text should be concise and structured, for example:

```txt
Background command started.
Task: bg_20260531_abcdef
Status: running
Output: .pi/background-bash/bg_20260531_abcdef/output.log

Use read on the output path or /tasks for status. Completion will be reported in the UI; model wake-up is opt-in.
```

The same fields may appear in `details` for renderers/session state, but callers must always receive a standard tool result content block.

`timeout` in background mode means maximum runtime before the extension terminates the process group, not foreground wait time.

### `background_task_list`

```ts
type BackgroundTaskListInput = {
  includeCompleted?: boolean;
};
```

Returns task ids, commands, status, exit code, elapsed time, output path, and owner session.

### `background_task_status`

```ts
type BackgroundTaskStatusInput = {
  taskId: string;
};
```

Returns one task's current state and output file metadata.

### `background_task_stop`

```ts
type BackgroundTaskStopInput = {
  taskId: string;
  signal?: "SIGTERM" | "SIGKILL";
  killAfterMs?: number;
};
```

Stops the task's process group. Default behavior is SIGTERM followed by SIGKILL after a short grace period.

### Optional `background_task_output`

Prefer normal file read for logs. Add this tool only if the normal read tool cannot safely support tail/offset access:

```ts
type BackgroundTaskOutputInput = {
  taskId: string;
  offset?: number;
  limit?: number;
  tail?: boolean;
};
```

## Foreground Delegation Strategy

Foreground calls are the compatibility risk. Use this order of preference:

1. Compose or invoke exported `createBashTool(cwd, options)` for non-background calls.
2. If direct delegation is not practical, reuse `createLocalBashOperations()` and mirror the built-in tool wrapper semantics.
3. Reimplement only as a last resort, with tests for output streaming, cwd/env handling, timeout, abort, and process-group cleanup.

The override must preserve the built-in schema subset. Existing calls without `run_in_background` must continue to work.

Prompt metadata is not inherited, so the extension must include foreground bash guidance explicitly. Prefer querying/copying the installed built-in `bash` prompt metadata at activation time and appending background-specific guidance; if static metadata is unavoidable, track upstream Pi bash prompt changes during maintenance.

## Background Process Model

For `run_in_background: true`:

1. Allocate a task id.
2. Create a task directory under a configured data root, for example:

```txt
.pi/background-bash/<taskId>/
  metadata.json
  output.log
  stderr.log        # optional; default may combine streams into output.log
  exit.json
```

3. Spawn through the platform shell with the requested cwd/env semantics.
4. On Unix, use a detached process group so the extension can terminate the whole tree with `kill(-pgid)`.
5. Redirect stdout/stderr directly to files, not through unbounded memory buffers.
6. Record pid, pgid/process handle, command, cwd, environment policy, timestamps, output paths, owner session, and configured limits.
7. Return immediately.
8. Monitor process exit and update registry status.
9. Emit one terminal notification on completion, failure, timeout, killed, or watchdog stop.

Statuses:

- `starting`
- `running`
- `exited`
- `failed`
- `timed_out`
- `killed`
- `orphaned`
- `unknown`

## Task Registry and Persistence

Persist registry state in extension-owned storage, with a file mirror in the task root for inspectability.

Task metadata fields:

```ts
type BackgroundTaskRecord = {
  taskId: string;
  command: string;
  cwd: string;
  shell: string;
  pid?: number;
  pgid?: number;
  processStartTime?: string;
  processCommandLine?: string;
  status: TaskStatus;
  exitCode?: number | null;
  signal?: string | null;
  outputPath: string;
  stderrPath?: string;
  metadataPath: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  ownerSessionId: string;
  extensionVersion: string;
  persistent: boolean;
  limits: {
    maxRuntimeMs?: number;
    maxOutputBytes: number;
    idleTimeoutMs?: number;
  };
};
```

Persistence policy:

- Default tasks are session-owned and non-persistent.
- On reload, reconcile registry with live PIDs and output files.
- On full session shutdown, terminate non-persistent running tasks.
- Persistent tasks may be added later behind an explicit schema option or config flag.
- If a process cannot be confidently reattached after restart, mark it `unknown` or `orphaned` and surface a cleanup warning.
- Never treat a PID match alone as proof of ownership. Reconciliation must validate process start time/birth time and command line where the platform exposes them; otherwise disable stop/kill controls for that record.

## Notifications XML

Use a structured XML-like message envelope for durable agent-visible events:

```xml
<background_bash_notification>
  <task_id>bg_20260531_abcdef</task_id>
  <status>exited</status>
  <exit_code>0</exit_code>
  <command>npm run dev</command>
  <output_path>.pi/background-bash/bg_20260531_abcdef/output.log</output_path>
  <started_at>2026-05-31T12:00:00.000Z</started_at>
  <completed_at>2026-05-31T12:03:25.000Z</completed_at>
  <summary>Background command completed successfully.</summary>
</background_bash_notification>
```

Notification policy:

- Emit on terminal state only by default.
- Default completion behavior is UI-only plus persisted task metadata. Do not call `sendUserMessage`, `sendMessage({ triggerTurn: true })`, or equivalent model-waking behavior by default.
- Model-visible completion notifications require explicit opt-in, for example a future `wake_on_completion: true` parameter or config setting.
- Do not emit continuous output chunks into the conversation.
- Include output path and a short tail excerpt only if bounded and useful.
- Avoid recursive wake loops; waking the agent must be configurable and default off/conservative.
- UI notifications may be richer than model-visible messages.

## Output File and Read Integration

The primary output integration is ordinary file reading:

- Return `outputPath` from background `bash` calls.
- Mention that the agent can use the normal read tool on that path.
- Prefer an extension data directory outside normal source indexing for logs when possible; if logs live under the workspace, add/document ignore entries such as `.gitignore` and source-search exclusions.
- Prefer workspace-relative paths only when they are readable by the agent and will not pollute repository search/indexing.
- Enforce maximum output bytes per task. On hard output cap overflow, stop the task by default; optional rotation must still enforce a cumulative cap.
- Write clear sentinel lines for lifecycle events:
  - task started
  - watchdog warning
  - timeout
  - killed
  - exit code/signal

Default stream policy: combine stdout and stderr into `output.log` in temporal order unless platform constraints make this unreliable. Separate `stderr.log` can be enabled by config.

## Prompt Guidance

The extension must append/replace `bash` prompt metadata with concise rules:

- Use `bash` for shell commands.
- Use `run_in_background: true` for servers, watchers, long builds, long tests, scripts that continue producing output, or commands expected to run longer than a short foreground timeout.
- Do not use shell `&` for backgrounding; use `run_in_background` so Pi can track, notify, and clean up the task.
- For foreground commands, omit `run_in_background`.
- Background commands return a task id and output path immediately; read the output path or use `/tasks`/task tools for status.
- If a command asks for input, credentials, confirmation, or an interactive TTY, stop it and ask the user.
- Stop background tasks when they are no longer needed.

## TUI, Rendering, and Commands

Add user-facing controls with concise, formatted diagnostics. The user should not see raw JSON, every tool argument, full command output, full metadata, or full log content by default.

Rendering requirements:

- Foreground `bash` should preserve Pi's existing built-in bash rendering as closely as possible.
- Background `bash` starts and task-control tools must provide custom `renderCall`/`renderResult` components.
- Use `renderShell: "self"` for custom background-task cards where Pi's default tool box chrome would produce ugly or duplicated framing.
- Use TUI skill conventions: ANSI-aware width math, no `process.stdout.columns`, stable truncation, and responsive layouts.
- Default cards show high-level diagnostics only:
  - short task id;
  - status glyph/label;
  - elapsed runtime and runtime limit when set;
  - one-line truncated command summary;
  - shortened output path;
  - exit code/signal for terminal tasks;
  - warning badges for prompt-detected, timeout, output-cap, orphaned, or failed states.
- Detail-only data belongs behind `/tasks show`, `/tasks tail`, normal `read`, or expanded tool views:
  - full command;
  - full paths;
  - pid/pgid;
  - env policy;
  - log tail;
  - raw metadata.
- TUI updates must be throttled and coalesced. Never repaint per output chunk; terminal state changes may render immediately, while log-size/running updates should be bounded to a low frequency.

Add user-facing commands:

### `/tasks`

Shows all active and recent background bash tasks:

```txt
ID                    Status     Runtime  Exit  Command
bg_...abcdef          running    02:14    -     npm run dev
bg_...123456          exited     00:38    0     npm test
```

Supported subcommands:

- `/tasks` list active/recent tasks.
- `/tasks all` include completed retained tasks.
- `/tasks show <taskId>` show metadata and output path.
- `/tasks tail <taskId> [lines]` bounded tail view.
- `/tasks stop <taskId>` terminate a task.
- `/tasks cleanup` remove completed task metadata/logs according to retention policy.

### Status/widget/footer

Display compact state such as:

```txt
BG: 2 running, 1 failed
```

The widget should not force model turns. It is an operator awareness surface.

Widget/status semantics:

- Normal compact form: `BG 2 running`.
- Attention form: `BG 1 failed` or `BG 1 blocked` with warning/error styling.
- Timeout, orphaned, failed, and prompt-detected states should visually stand out.
- The widget should avoid stealing vertical space and must truncate predictably at narrow widths.

## Lifecycle, Reload, and Shutdown Policy

### Session start

- Load persisted registry.
- Reconcile each non-terminal task:
  - if pid/process group is live and ownership is validated by pid, start time/birth time, and command line where available, mark `running`;
  - if output/exit files indicate completion, mark terminal;
  - otherwise mark `unknown` or `orphaned` and disable destructive controls.
- Surface a bounded warning for unknown/orphaned tasks.

### Extension reload

- Treat reload as a soft lifecycle event.
- Do not eagerly kill tasks on simple extension reload if they can be reconciled immediately after reload.
- Rebuild in-memory watchers from persisted task records.

### Session shutdown

- Terminate non-persistent running tasks owned by the session.
- On Unix, send SIGTERM then SIGKILL to the process group after a grace period.
- On Windows, use `taskkill /F /T /PID <pid>` or a documented equivalent process-tree strategy.
- Update registry and append lifecycle marker to output log.

### Pi process crash/restart

- Best-effort reconciliation on next start.
- Processes may continue without a live JS handle; classify as `orphaned` unless ownership can be verified.
- Never kill arbitrary PIDs solely because a stale registry record names them; validate command/cwd/start time where possible.

## Security and Interactive Prompt Watchdog

Security posture:

- This extension runs trusted local commands with the same broad power as `bash`; it does not sandbox commands.
- Make opt-in status explicit in docs and extension description.
- Store logs in a predictable extension/workspace location and avoid world-writable unsafe paths.
- Write log files with restrictive filesystem permissions where practical, while preserving normal read-tool access for the owning user.
- Sanitize task ids and never derive paths from raw commands.
- Avoid logging secrets from environment/config beyond what the command itself outputs.
- Respect Pi's existing permission model for command execution and file access.

Watchdogs:

- **Interactive prompt detection**: scan recent output for patterns such as password prompts, `Are you sure?`, `Press any key`, package manager confirmations, login prompts, MFA/device-code prompts, and TTY errors.
- **Idle timeout**: optionally warn or stop tasks with no output for a configured duration.
- **Max runtime**: stop tasks after `timeout`/configured TTL.
- **Max output size**: stop by default at a hard cap; optional rotation/truncation must enforce a cumulative cap.
- **Spawn failure**: fail fast and return a foreground-style error result.

`wake_on_completion` is optional and dangerous. It should default to false, require clear prompt guidance, and never be enabled implicitly by config migration.

When a likely interactive prompt is detected, default to marking the task `blocked` and notifying the UI with a bounded tail and guidance. Depending on config, stop the task automatically or require explicit `/tasks stop`. Do not type into the process, auto-answer `yes`, or clone Claude's permission prompt UX.

## Configuration

Initial config should be minimal:

```ts
type BackgroundBashConfig = {
  enabled: boolean;
  dataDir?: string;
  defaultMaxRuntimeMs?: number;
  defaultMaxOutputBytes?: number;
  shutdownPolicy?: "kill-session-tasks" | "leave-running";
  notifyModelOnCompletion?: boolean;
  notifyUiOnCompletion?: boolean;
};
```

Defaults:

- `enabled`: false until extension is installed/enabled.
- `defaultMaxRuntimeMs`: unset or conservative package default.
- `defaultMaxOutputBytes`: bounded.
- `shutdownPolicy`: `kill-session-tasks`.
- `notifyModelOnCompletion`: false or conservative if wake loops are a concern.
- `notifyUiOnCompletion`: true.

## Implementation Phases

### Phase 0: Compatibility spike

- Verify exact foreground delegation path using `createBashTool(cwd, options)`.
- Confirm renderer behavior for an overridden tool named `bash`.
- Capture current built-in bash prompt metadata to recreate essential guidance.

### Phase 1: Minimal override

- Register opt-in `bash` override with `{ command, timeout?, run_in_background?, wake_on_completion? }`.
- Delegate non-background calls to built-in-compatible foreground execution.
- Return a clear validation error for unsupported background mode while tests are built.

### Phase 2: Background runner and registry

- Implement detached spawn, output redirection, task ids, metadata files, and process exit monitoring.
- Add registry persistence and session-start reconciliation.
- Return task id and output path.

### Phase 3: Controls and UI

- Add task list/status/stop tools.
- Add `/tasks` command and compact status widget/footer.
- Add bounded output/tail command if normal read is insufficient.

### Phase 4: Notifications and watchdogs

- Emit XML-like completion notifications.
- Add max runtime, max output, idle, and interactive prompt watchdogs.
- Add conservative wake/noise controls.

### Phase 5: Hardening and rollout

- Add cross-platform process cleanup behavior.
- Add retention cleanup.
- Document opt-in risk and migration guidance.
- Run foreground parity and lifecycle regression tests.

### Phase 6: Async subagent migration tooling

This phase builds a standalone, manually invoked migration CLI; the extension must not bulk-edit `~/.async-subagents/*` during normal startup, reload, or tool execution.

- Inventory async subagent definitions/configs under `~/.async-subagents/*` without modifying them.
- Detect active runs and refuse or warn before touching files associated with running agents.
- Classify files that define Pi roles, tool allowlists/denylists, command-line flags, prompt fragments, or bash/background guidance.
- Produce a dry-run migration report showing proposed changes per file.
- Require explicit user confirmation before writes, ideally per profile or per change group.
- Write versioned backups and provide a rollback command/path for every modified config.
- Update role/tool configuration so subagents that should use background bash load this extension and resolve `bash` to the override.
- For explicit allowlists, replace built-in `bash` references with the extension-backed `bash` slot and add auxiliary task tools/commands where needed.
- For `--exclude-tools`/`--no-builtin-tools` usage, sequence changes so the extension `bash` remains available and the built-in is not exposed in parallel.
- Update prompt fragments to say: use `bash` with `run_in_background: true` for long-running commands; do not use `&`; use output paths and `/tasks` for monitoring.
- Run a canary subset of async subagent roles before bulk migration.

## Test Plan

Foreground parity:

- Simple command output matches built-in behavior.
- Nonzero exit surfaces correctly.
- Timeout kills command/process group.
- Abort signal cancels command.
- Large foreground output remains bounded as built-in does.
- Existing `{ command, timeout? }` calls work unchanged.

Background execution:

- `run_in_background: true` returns quickly with task id and output path.
- Long-running server/watch command keeps running after tool return.
- Output appears in log file and is readable with the normal read tool.
- Completion updates registry with exit code/signal.
- Completion notification is emitted exactly once.

Task controls:

- List shows running and completed tasks.
- Status reports accurate timestamps, pid, output path, and exit state.
- Stop kills child process trees, not just the shell parent.
- Cleanup removes completed task files according to retention policy.

Lifecycle:

- Extension reload preserves/reconciles running tasks.
- Session shutdown kills non-persistent tasks.
- Restart with stale PID does not kill unrelated processes.
- Orphaned/unknown tasks are surfaced safely.

Watchdogs/security:

- Interactive prompt patterns trigger warning/stop behavior.
- Max runtime timeout terminates task.
- Max output cap prevents unbounded disk growth.
- Task id/path handling resists path traversal.

Prompt/model behavior:

- Agent selects `run_in_background` for servers/watchers/long tests.
- Agent avoids shell `&`.
- Agent reads output file or uses `/tasks` after starting a background task.

Activation/migration behavior:

- Starting Pi with the extension enabled exposes exactly one active `bash`, the override.
- Configurations using tool allowlists still expose the override and required task controls.
- Configurations using `--exclude-tools` do not accidentally exclude extension `bash`.
- Configurations using `--no-builtin-tools` explicitly re-add needed built-ins plus extension `bash`.
- Async subagent canary roles under `~/.async-subagents/*` receive the new prompt guidance and successfully run a background command.
- Migration dry-run and rollback paths are tested before bulk config edits.

## Rollout and Compatibility

- Ship as disabled-by-default extension package.
- Activation explicitly replaces `bash`; docs must call out this blast radius.
- Keep schema backward-compatible with built-in `bash` for existing calls.
- Do not remove or rename auxiliary task tools without migration.
- Track upstream Pi built-in bash prompt/tool changes and periodically update the override.
- If foreground parity cannot be maintained, fall back to separate background tools rather than shipping a partial `bash` override.

### Install/activation rollout

1. Add the extension package and enable it only for a local canary Pi profile.
2. Confirm active tool resolution: the visible `bash` schema includes `run_in_background`, and no separate built-in `bash` remains model-visible.
3. If override precedence is ambiguous, use active-tool configuration to remove the built-in `bash` slot and insert the extension `bash` slot.
4. Use `--exclude-tools` for built-in `bash` only as a compatibility workaround; prefer native override precedence.
5. Avoid `--no-builtin-tools` unless the profile already manages a full explicit tool list. If used, enumerate all required built-ins and this extension's `bash`/task controls.
6. Roll out to more Pi profiles only after foreground parity, background lifecycle, and prompt-selection tests pass.

### Async subagent config migration

All async subagent definitions/configs under `~/.async-subagents/*` need a separate, reversible migration plan because they may pin tools, prompts, or launch flags. Migration is not part of extension startup; it is a standalone operator workflow, for example `pi-background-bash migrate`.

Migration sequence:

1. **Discover**: scan `~/.async-subagents/*` for Pi role definitions, tool allowlists, tool excludes, `--exclude-tools`, `--no-builtin-tools`, prompt snippets mentioning bash/background/tmux/monitors, and hard-coded long-running command guidance.
2. **Protect active runs**: detect running subagents and skip their mutable files unless the user explicitly confirms after stopping them.
3. **Report**: generate a dry-run diff/report before editing any file. Dry-run is the default.
4. **Confirm**: require explicit operator approval before writes, with per-profile selection where feasible.
5. **Back up**: copy each file before modification or commit changes through a versioned migration directory.
6. **Tool config update**:
   - ensure migrated roles load the background-bash extension;
   - ensure the active `bash` resolves to the override;
   - remove any parallel built-in `bash` exposure;
   - include `background_task_list`, `background_task_status`, and `background_task_stop` where the role needs task control;
   - preserve unrelated tool restrictions.
7. **Prompt update**:
   - replace "no background bash; use tmux" style guidance where appropriate;
   - add `run_in_background: true` guidance for servers/watchers/long builds;
   - tell agents not to use shell `&`;
   - tell agents to read returned output paths and use `/tasks`/task tools for status and stop.
8. **Canary**: migrate a small set of low-risk subagent profiles first and run smoke tests.
9. **Bulk migrate selected profiles**: apply the same transformation only to operator-selected profiles.
10. **Rollback**: provide a command or documented steps to restore backups and disable the extension.

Do not bulk-edit every async subagent blindly. Some roles may intentionally avoid shell access or may rely on separate durable monitor tools; those should be left unchanged unless the owner opts in.

## Risks / Unknowns

- Can foreground calls delegate cleanly to `createBashTool()` without losing renderer/session reconstruction behavior?
- What exact API should extensions use for prompt metadata replacement for an overridden built-in tool?
- What is the safest default for model-visible completion notifications versus UI-only notifications?
- Should persistent tasks be supported in v1, or deferred until ownership/restart semantics are clearer?
- What output directory is best across single-workspace and multi-root sessions?
- What Windows process-tree semantics are acceptable?
- How should this interact with user-bash (`!`) interception, if at all?
- Are existing durable monitor tools stable upstream APIs or environment-specific tooling? If stable, the background runner should wrap them; if not, implement native process management in the extension.
- What is the exact Pi precedence rule when an extension registers a tool with the same name as a built-in, and how should startup diagnostics expose misconfiguration?
- Which Pi launch surfaces support `--exclude-tools`, `--no-builtin-tools`, and active tool mutation, and how do these interact with extension-provided tools?
- Which `~/.async-subagents/*` configs are authoritative versus generated/cache files that should not be edited directly?
- Which async subagent roles should opt into background-bash versus retain existing tmux/monitor guidance or no-shell restrictions?
