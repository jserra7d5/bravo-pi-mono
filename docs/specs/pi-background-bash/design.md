# Pi Background Bash Extension Design

Status: proposed
Date: 2026-05-31
Related: `debates/pi-background-bash-2026-05-31/*`

## Summary

Add an opt-in Pi extension package that overrides the model-facing `bash` tool with a Claude-Code-like `run_in_background` mode. The extension preserves one canonical shell tool for agents while adding schema-v1 background task tracking, output files, status/stop controls, lifecycle cleanup, and explicit per-call best-effort model wake.

This is intentionally an extension, not Pi core behavior. The default Pi `bash` remains synchronous unless a user explicitly enables this package. The implementation is a session task tracker around a managed shell child, not a durable process supervisor: managed-child `close` is the terminal boundary, and detached descendants that outlive it are outside lifecycle accounting.

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
- Fail safely for the implemented interactive-prompt patterns, runaway logs, max runtime, and unverified persisted process evidence.

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
7. Runtime requests termination of verified in-memory session tasks on shutdown; it does not promise a bounded global wait.
8. Watchdogs detect the current interactive-prompt patterns, excessive output, and max runtime.

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
- **TUI integration**: formatted tool cards, status widget/footer, and `/bash-tasks` command with progressive disclosure.

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
Output: ~/.pi/background-bash/bg_20260531_abcdef/output.log

Use read on the output path or /bash-tasks for status. Completion will be reported in the UI; model wake-up is opt-in.
```

The same fields may appear in `details` for renderers/session state, but callers must always receive a standard tool result content block.

`timeout` in background mode means maximum runtime before the extension requests termination, not foreground wait time. The timeout reason is persisted immediately, but the task stays active until the managed shell child emits `close` and its output streams have drained.

### `background_task_list`

```ts
type BackgroundTaskListInput = {
  includeCompleted?: boolean;
};
```

Returns task ids, commands, status, exit code, elapsed time, output path, and owner session for the current Pi session only.

### `background_task_status`

```ts
type BackgroundTaskStatusInput = {
  taskId: string;
};
```

Returns one current-session task's current state and output file metadata.

### `background_task_stop`

```ts
type BackgroundTaskStopInput = {
  taskId: string;
  signal?: "SIGTERM" | "SIGKILL";
  killAfterMs?: number;
};
```

Stops the task's process group. Default behavior is SIGTERM followed by SIGKILL after a short grace period.

### Output access

No additional output tool or wake coalescing layer is added in this scope. Use the normal read tool with bounded `offset`/`limit` requests; `/bash-tasks tail` remains a bounded human TUI command.

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
~/.pi/background-bash/<taskId>/
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
8. Attach `spawn`, `error`, `exit`, `close`, stdout, and stderr handlers synchronously before awaiting spawn readiness or unrefing the child.
9. Timeout, output-cap, and user-stop paths record the reason and signal the process tree without writing terminal status while the managed shell child is alive.
10. Attempt finalization exactly once on managed-child `close`, after stdout/stderr drain, and optionally dispatch one wake. If terminal metadata persistence fails, the error is contained and diagnosed, but durable metadata can remain stale/active; this bounded patch does not add a retrying supervisor. Detached descendants that outlive shell close are not supervised and do not delay finalization.

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

Persist active lifecycle registry state in extension-owned storage, with a file mirror in each task root for inspectability. The registry is an active-lifecycle index for schema-v1 `starting`, `running`, `blocked`, and `orphaned` records, not the complete historical source of truth.

Task metadata fields:

```ts
type BackgroundTaskRecord = {
  schemaVersion: 1;
  taskId: string;
  command: string;
  cwd: string;
  ownerSessionId?: string;
  ownerSessionFile?: string;
  ownerRuntimeId?: string;
  pid?: number;
  pgid?: number;
  status: TaskStatus;
  exitCode?: number | null;
  signal?: string | null;
  stopReason?: "timeout" | "output_cap" | "interactive_prompt" | "user" | "shutdown";
  outputPath: string;
  metadataPath: string;
  outputBytes: number;
  maxOutputBytes: number;
  maxRuntimeMs?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  wakeOnCompletion: boolean;
  wakePolicyVersion?: 1;
  wakePolicySource?: "tool_arg_v1";
};
```

Persistence policy:

- Tasks are session-owned when the host supplies a session id; persistence is task metadata/log retention, not process supervision across reload.
- Successfully persisted terminal tasks (`exited`, `failed`, `timed_out`, and `killed`) leave the active index. A terminal persistence fault can leave stale active metadata and emits a diagnostic; `orphaned` evidence remains active/uncertain and cleanup does not delete it.
- Per-task `metadata.json` and logs remain inspectable until cleanup, even after a task leaves the active registry.
- Listing without `includeCompleted` reads only the active lifecycle index; listing with completed tasks may scan per-task metadata directories.
- Stop/status for a process-terminal task reads its metadata but must not re-add it to the active registry as orphaned or running.
- On reload, reconcile existing registry evidence conservatively; uncertain active records become orphaned and ambiguous wake claims are not replayed.
- On full session shutdown, request termination of owned non-persistent running tasks; terminal metadata still waits for managed-child close.
- There is no persistent-task mode or reattachment path in this scope.
- If a live JS child handle is unavailable after reload, mark active schema-v1 evidence `orphaned`; never infer ownership from a persisted PID or issue a destructive stop through it.
- Old schema-v2/v3 records may be read for inspection only; lifecycle control, cleanup, and wake do not migrate or act on them.

## Model wake notification

Model wake is an expensive, best-effort separate turn. It can reprocess context that preceded task completion. Use it only when the model will otherwise be idle and one terminal event warrants resuming work. Parallel jobs should omit per-task wakes or use one faithful barrier task; servers, watchers, and services should omit wake.

Admission policy:

- `wake_on_completion: true` is valid only with `run_in_background: true`.
- Admission runs in both the tool and runner before task-id/directory allocation or process spawn.
- The host `sendMessage` API must be callable; owner, notifier, and current session ids must be nonempty and equal; owner/notifier runtime ids must be nonempty and equal; session files must be absent everywhere or present everywhere and equal.
- Invalid routes return `INVALID_WAKE_ROUTE` with a specific route code and create no task/process.
- Config-level `notifyModelOnCompletion`, omission, and legacy schema-v2/v3 records never opt in or retroactively wake. Only schema-v1 `tool_arg_v1` policy markers are eligible.

Dispatch ordering is terminal metadata, atomic claim file, route revalidation, durable `dispatch_requested`, then one synchronous void `sendMessage` call with `{ triggerTurn: true, deliverAs: "followUp" }`. A normal return is followed by a best-effort write of `dispatched_to_host` and `host_api_invoked`; a synchronous throw from `sendMessage` records `dispatch_sync_failed`. If the post-send write fails, durable `dispatch_requested` remains deliberately ambiguous and is never relabeled or retried. These states do not claim accepted, enqueued, delivered, or turn-completed semantics. Ambiguous `claim_acquired` or `dispatch_requested` evidence is never replayed after reconcile/reload.

The payload is a strict metadata allowlist: task id, terminal status, output path, output byte count, and applicable exit code, signal, or stop reason. It contains no command, output/tail, summary, timestamps, or other task metadata/secrets. Continuous output is never emitted into conversation context.

## Output File and Read Integration

The primary output integration is ordinary file reading:

- Return `outputPath` from background `bash` calls.
- Mention that the agent can use the normal read tool on that path.
- Store logs and metadata outside active source worktrees by default, under Pi-owned state such as `~/.pi/background-bash`.
- Workspace/repo-local storage is an explicit opt-in only via `dataDir`; if used, add/document ignore entries such as `.gitignore` and source-search exclusions.
- Enforce maximum output bytes per task. On hard output cap overflow, stop appending and request task termination; no rotation path is added.
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
- Background commands return a task id and output path immediately; read the output path in bounded offset/limit requests or use `/bash-tasks`/task tools for status.
- Wake is an expensive best-effort separate turn that may reprocess prior context. Use it only when otherwise idle and one terminal event warrants resume; omit per-task wakes for parallel jobs (or use one faithful barrier), servers, watchers, and services.
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
- Detail-only data belongs behind `/bash-tasks show`, `/bash-tasks tail`, normal `read`, or expanded tool views:
  - full command;
  - full paths;
  - pid/pgid;
  - env policy;
  - log tail;
  - raw metadata.
- TUI updates must be throttled and coalesced. Never repaint per output chunk; terminal state changes may render immediately, while log-size/running updates should be bounded to a low frequency.

Add user-facing commands:

### `/bash-tasks`

Shows all active and recent background bash tasks:

```txt
ID                    Status     Runtime  Exit  Command
bg_...abcdef          running    02:14    -     npm run dev
bg_...123456          exited     00:38    0     npm test
```

Supported subcommands:

- `/bash-tasks` list active/recent tasks.
- `/bash-tasks all` include completed retained tasks.
- `/bash-tasks show <taskId>` show metadata and output path.
- `/bash-tasks tail <taskId> [lines]` bounded tail view.
- `/bash-tasks stop <taskId>` terminate a task.
- `/bash-tasks cleanup` remove completed task metadata/logs according to retention policy.

### Status/widget/footer

Display compact state such as:

```txt
BG: 2 running, 1 failed
```

The widget should not force model turns. It is an operator awareness surface scoped to the current Pi session, not a global cross-CWD process dashboard.

Widget/status semantics:

- Normal compact form: `BG 2 running` for tasks owned by this session.
- Attention form: `BG 1 failed` or `BG 1 blocked` with warning/error styling.
- Timeout, orphaned, failed, and prompt-detected states should visually stand out.
- The widget should avoid stealing vertical space and must truncate predictably at narrow widths.

## Lifecycle, Reload, and Shutdown Policy

### Session start and extension reload

- Load the active schema-v1 registry.
- In-process children still present in the runner map remain managed.
- Other `starting`/`running`/`blocked` records become `orphaned`; wake-enabled records additionally persist `WAKE_HANDLE_LOST_AFTER_RELOAD` and are never replayed.
- No PID reattachment, process-disappearance inference, or old-schema migration occurs.

### Session shutdown

- For session-owned active children with verified in-memory handles, record `shutdown`, append a marker, send SIGTERM, and schedule SIGKILL after the existing grace period.
- Do not wake for shutdown stops.
- Do not claim a bounded global shutdown wait: terminal metadata is written later on managed-child `close` if the runtime remains alive.
- Active records without verified handles become `orphaned`; cleanup does not delete them.

### Pi process crash/restart

- Best-effort reconciliation on next start.
- Processes may continue without a live JS handle; classify them as `orphaned`. The current minimal scope makes no process-group-disappearance or descendant-liveness claim.
- Never kill arbitrary PIDs solely because a stale registry record names them; validate command/cwd/start time where possible.

## Security and Interactive Prompt Watchdog

Security posture:

- This extension runs trusted local commands with the same broad power as `bash`; it does not sandbox commands.
- Make opt-in status explicit in docs and extension description.
- Store logs in a predictable Pi-owned extension location by default and avoid world-writable unsafe paths.
- Write log files with restrictive filesystem permissions where practical, while preserving normal read-tool access for the owning user.
- Sanitize task ids and never derive paths from raw commands.
- Avoid logging secrets from environment/config beyond what the command itself outputs.
- Respect Pi's existing permission model for command execution and file access.

Implemented watchdog/lifecycle limits:

- **Interactive prompt detection**: scan output for the current bounded pattern set and mark the task blocked without sending input.
- **Max runtime**: request stop after `timeout`/configured TTL, retaining active status until close.
- **Max output size**: stop appending at the hard cap and request stop, retaining active status until close.
- **Spawn failure**: persist failure after the managed child closes (or synchronous spawn throws).

Idle detection, output rotation, and richer prompt handling are not part of this minimal patch.

`wake_on_completion` is optional and expensive. It defaults to false, is per-call tool-argument opt-in only, and is never enabled by config or migration.

When a likely interactive prompt is detected, default to marking the task `blocked` and notifying the UI with a bounded tail and guidance. Depending on config, stop the task automatically or require explicit `/bash-tasks stop`. Do not type into the process, auto-answer `yes`, or clone Claude's permission prompt UX.

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
- `dataDir`: `~/.pi/background-bash`; relative configured values resolve against the session cwd and are therefore explicit repo-local opt-ins.
- `defaultMaxRuntimeMs`: unset or conservative package default.
- `defaultMaxOutputBytes`: bounded.
- `shutdownPolicy`: `kill-session-tasks`.
- `notifyModelOnCompletion`: legacy compatibility field only; it never enables wake.
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
- Add `/bash-tasks` command and compact status widget/footer.
- Add bounded output/tail command if normal read is insufficient.

### Phase 4: Notifications and watchdogs

- Emit metadata-only XML-like completion notifications on explicit per-call wake opt-in.
- Add max runtime, max output, and the current interactive prompt watchdog.
- Keep wake explicit, best-effort, and quiet by default.

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
- Update prompt fragments to say: use `bash` with `run_in_background: true` for long-running commands; do not use `&`; use output paths and `/bash-tasks` for monitoring.
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

- Extension reload retains verified in-memory children and marks other active records orphaned without wake replay.
- Session shutdown requests termination of verified session children; terminal metadata waits for child close.
- Restart with stale PID does not kill unrelated processes.
- Orphaned/unknown tasks are surfaced and not deleted by cleanup.

Watchdogs/security:

- Interactive prompt patterns trigger warning/stop behavior.
- Max runtime timeout terminates task.
- Max output cap prevents unbounded disk growth.
- Task id/path handling resists path traversal.

Prompt/model behavior:

- Agent selects `run_in_background` for servers/watchers/long tests.
- Agent avoids shell `&`.
- Agent reads output file or uses `/bash-tasks` after starting a background task.

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
   - tell agents to read returned output paths and use `/bash-tasks`/task tools for status and stop.
8. **Canary**: migrate a small set of low-risk subagent profiles first and run smoke tests.
9. **Bulk migrate selected profiles**: apply the same transformation only to operator-selected profiles.
10. **Rollback**: provide a command or documented steps to restore backups and disable the extension.

Do not bulk-edit every async subagent blindly. Some roles may intentionally avoid shell access or may rely on separate durable monitor tools; those should be left unchanged unless the owner opts in.

## Risks / Unknowns

- Can foreground calls delegate cleanly to `createBashTool()` without losing renderer/session reconstruction behavior?
- What exact API should extensions use for prompt metadata replacement for an overridden built-in tool?
- What is the safest default for model-visible completion notifications versus UI-only notifications?
- Should persistent tasks be supported in v1, or deferred until ownership/restart semantics are clearer?
- Should the global output directory later be namespaced by session/profile for easier retention and cleanup?
- What Windows process-tree semantics are acceptable?
- How should this interact with user-bash (`!`) interception, if at all?
- Are existing durable monitor tools stable upstream APIs or environment-specific tooling? If stable, the background runner should wrap them; if not, implement native process management in the extension.
- What is the exact Pi precedence rule when an extension registers a tool with the same name as a built-in, and how should startup diagnostics expose misconfiguration?
- Which Pi launch surfaces support `--exclude-tools`, `--no-builtin-tools`, and active tool mutation, and how do these interact with extension-provided tools?
- Which `~/.async-subagents/*` configs are authoritative versus generated/cache files that should not be edited directly?
- Which async subagent roles should opt into background-bash versus retain existing tmux/monitor guidance or no-shell restrictions?
