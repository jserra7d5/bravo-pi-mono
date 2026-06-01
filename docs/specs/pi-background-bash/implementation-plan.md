# Pi Background Bash Extension Implementation Plan

Status: draft implementation plan  
Date: 2026-05-31  
Sources: `docs/specs/pi-background-bash/design.md`, `debates/pi-background-bash-2026-05-31/synthesis.md`, `debates/pi-background-bash-2026-05-31/initial-feasibility.md`

## Summary

Implement an opt-in `packages/pi-extension-background-bash` package that registers an override tool named exactly `bash` with the built-in-compatible foreground schema plus `run_in_background` and `wake_on_completion`. Foreground calls must delegate to the exported built-in bash implementation where possible; background calls must create managed, persisted background task records, redirect output to bounded log files, expose lifecycle/status/stop controls, and clean up owned non-persistent tasks.

This plan intentionally follows the reviewed design's flip condition: product behavior requires Claude-Code-like `bash({ run_in_background: true })`. The package must be disabled unless explicitly installed/enabled and must document how to disable or replace the built-in bash safely. It must not enable model wake-up loops by default.

## Recommended direction

- Ship as a new opt-in extension package, not Pi core behavior.
- Override `bash` only after activation verification proves that exactly one model-visible active `bash` exists and that it is the extension override.
- Preserve foreground `bash({ command, timeout? })` behavior by delegating to `createBashTool(cwd, options)` first, then `createLocalBashOperations()` only if needed.
- Keep task lifecycle controls as separate tools and `/tasks` commands instead of overloading the `bash` schema.
- Store background task metadata and logs in extension-owned storage; make returned output paths readable by Pi's normal file read tool.
- Enforce hard output caps by stopping the task when exceeded.
- Provide a standalone dry-run-first migration CLI for `~/.async-subagents/*`; never bulk-edit async subagent configs during extension startup, reload, or normal tool execution.

## Package and file layout

Create the package in the monorepo with this shape:

```txt
packages/pi-extension-background-bash/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts
    config.ts
    bash-tool.ts
    foreground.ts
    background-runner.ts
    process-tree.ts
    task-registry.ts
    task-types.ts
    output-log.ts
    watchdogs.ts
    notifications.ts
    prompt.ts
    ui.ts
    commands.ts
    migration/
      cli.ts
      scanner.ts
      planner.ts
      transforms.ts
      backups.ts
      rollback.ts
      types.ts
  test/
    foreground-parity.test.ts
    background-runner.test.ts
    task-registry.test.ts
    process-tree.test.ts
    watchdogs.test.ts
    activation.test.ts
    migration-dry-run.test.ts
    fixtures/
```

Adjust names to match existing package conventions, but keep the same separation of responsibilities.

## Public interfaces

### Extension config

```ts
type BackgroundBashConfig = {
  enabled: boolean;
  dataDir?: string;
  defaultMaxRuntimeMs?: number;
  defaultMaxOutputBytes?: number;
  idleTimeoutMs?: number;
  shutdownPolicy?: "kill-session-tasks" | "leave-running";
  notifyModelOnCompletion?: boolean;
  notifyUiOnCompletion?: boolean;
  promptBlockBehavior?: "mark-blocked" | "stop";
  retentionDays?: number;
};
```

Required defaults:

- `enabled`: false unless the extension is explicitly enabled by Pi's extension loading mechanism.
- `defaultMaxOutputBytes`: bounded, with a documented value chosen during implementation.
- `shutdownPolicy`: `kill-session-tasks`.
- `notifyModelOnCompletion`: false.
- `notifyUiOnCompletion`: true.
- `promptBlockBehavior`: `mark-blocked` unless product review chooses auto-stop.

### Overridden `bash`

```ts
type BashInput = {
  command: string;
  timeout?: number;
  run_in_background?: boolean;
  wake_on_completion?: boolean;
};
```

Behavior:

- If `run_in_background` is omitted or false, use foreground delegation and preserve the built-in subset.
- If `run_in_background` is true, start a managed task and immediately return standard Pi tool content containing task id, status, output path, and monitoring guidance.
- In background mode, `timeout` means maximum runtime before process-tree termination.
- `wake_on_completion` is opt-in per invocation and must not be enabled by migration or config defaults.

### Auxiliary tools

Implement:

- `background_task_list({ includeCompleted?: boolean })`
- `background_task_status({ taskId: string })`
- `background_task_stop({ taskId: string, signal?: "SIGTERM" | "SIGKILL", killAfterMs?: number })`

Add `background_task_output` only if normal read/tail support is insufficient after testing.

### Task record

Use the record from the design as the persisted compatibility contract, including `processStartTime` and `processCommandLine` for PID reuse safety. Add `blockedReason?: string`, `outputBytes?: number`, and `stopReason?: "timeout" | "output_cap" | "interactive_prompt" | "user" | "shutdown"` if needed.

## Implementation phases

### Phase 0: compatibility and API spike

1. Locate existing Pi extension package conventions, test runner, renderer APIs, slash command APIs, and lifecycle event APIs.
2. Verify that an extension can register a tool named `bash` and override the built-in by documented APIs only.
3. Verify active tool inspection with `getAllTools()` and `getActiveTools()`, including source metadata if available.
4. Prototype foreground delegation with `createBashTool(cwd, options)`.
5. If `createBashTool` cannot be invoked as a delegate, prototype `createLocalBashOperations()` plus a wrapper matching built-in result formatting, timeout, abort, cwd/env, and rendering behavior.
6. Capture current built-in bash prompt guidance and renderer expectations that must be explicitly included because override prompt metadata is not inherited.
7. Gate: do not proceed to a shipping override unless foreground delegation and activation precedence are proven.

### Phase 1: package skeleton and opt-in activation

1. Create `packages/pi-extension-background-bash` using repo package conventions.
2. Add extension entrypoint in `src/index.ts` that reads config and registers nothing unless enabled by explicit install/config semantics.
3. Register the overridden `bash` tool and the auxiliary task tools only when enabled.
4. After registration, verify active tool resolution:
   - exactly one active model-facing `bash`;
   - active `bash` source is this extension;
   - auxiliary tools are active only when intended.
5. If activation verification fails, emit a startup diagnostic and do not advertise background bash prompt guidance.
6. Document disabling/replacing built-in bash in `README.md`:
   - preferred path: enable this extension and rely on override precedence;
   - if precedence is ambiguous: use documented active-tool config to remove built-in `bash` and insert extension `bash`;
   - `--exclude-tools bash` only as workaround;
   - `--no-builtin-tools` only for profiles that explicitly re-add all required built-ins and this extension.
7. Add initial tests for enabled/disabled activation and schema shape.

### Phase 2: foreground-compatible `bash` override

1. Implement `src/bash-tool.ts` split:
   - validate input;
   - route foreground calls to `foreground.execute()`;
   - route background calls to a temporary explicit “not implemented” error until Phase 3 is ready.
2. Implement `src/foreground.ts` using the Phase 0 chosen delegation path.
3. Preserve standard Pi tool result content and renderer behavior for foreground calls.
4. Add prompt metadata in `src/prompt.ts` that includes built-in bash guidance plus:
   - use `run_in_background: true` for servers/watchers/long builds/long tests;
   - do not use shell `&`;
   - read output path or use `/tasks`/task tools;
   - stop unneeded tasks;
   - stop/ask user if command needs credentials, confirmation, TTY, or input.
5. Gate: foreground parity tests must pass before enabling background start behavior.

### Phase 3: background runner, logs, and registry

1. Implement `task-types.ts` with task status enum:
   - `starting`, `running`, `blocked`, `exited`, `failed`, `timed_out`, `killed`, `orphaned`, `unknown`.
2. Implement `task-registry.ts`:
   - persistent JSON registry plus per-task `metadata.json` mirror;
   - atomic writes where practical;
   - in-memory index keyed by sanitized task id;
   - retention metadata;
   - owner session id.
3. Implement task directory allocation under configured `dataDir`, defaulting to a safe extension/workspace location such as `.pi/background-bash/<taskId>/` only if readable and ignored/documented.
4. Implement `output-log.ts`:
   - create `output.log` with restrictive permissions where practical;
   - combine stdout/stderr in temporal order by default;
   - append lifecycle sentinel lines for started, warning, timeout, killed, output cap, exit.
5. Implement `background-runner.ts`:
   - spawn via platform shell with cwd/env semantics matching foreground as closely as possible;
   - Unix: detached process group and kill via negative pgid;
   - Windows: store pid and use process-tree handling from `process-tree.ts`;
   - redirect process output directly to files, never unbounded memory buffers;
   - record pid, pgid if available, process start/birth time, command line, timestamps, output path, limits;
   - return immediately with task id and output path;
   - monitor exit and update registry exactly once.
6. Implement hard max output cap:
   - track cumulative bytes written;
   - when cap is exceeded, append sentinel, stop process tree, mark terminal with `stopReason: "output_cap"`;
   - do not merely rotate indefinitely.
7. Implement max runtime from background `timeout` or config.
8. Ensure spawn failures return a foreground-style error result and do not leave partial running records.
9. Gate: background start/exit/output/readability tests pass on the primary platform.

### Phase 4: controls, TUI, and progressive disclosure

1. Implement auxiliary tools for list/status/stop using registry APIs.
2. Implement stop semantics:
   - verify ownership before destructive actions;
   - Unix: SIGTERM process group, then SIGKILL after grace;
   - Windows: `taskkill /F /T /PID <pid>` or documented equivalent;
   - if PID reuse validation fails, mark `unknown`/`orphaned` and refuse destructive stop unless a safe handle exists.
3. Implement `/tasks` commands in `commands.ts`:
   - `/tasks`
   - `/tasks all`
   - `/tasks show <taskId>`
   - `/tasks tail <taskId> [lines]`
   - `/tasks stop <taskId>`
   - `/tasks cleanup`
4. Implement TUI rendering in `ui.ts`:
   - foreground bash rendering should remain as close to built-in as possible;
   - background start/result cards use `renderShell: "self"` if default chrome duplicates framing;
   - cards show short id, status glyph, runtime/limit, truncated command, shortened output path, exit/signal, warning badges;
   - raw metadata, full command, pid/pgid, env, and log tail are detail-only.
5. Follow TUI skill requirements:
   - ANSI-aware width math;
   - no `process.stdout.columns` reliance;
   - stable truncation and responsive narrow layout;
   - throttle/coalesce updates, never repaint per output chunk.
6. Add compact footer/widget: normal `BG 2 running`, attention `BG 1 failed`/`BG 1 blocked`.
7. Gate: renderer snapshots/golden tests and manual narrow-terminal review pass.

### Phase 5: notifications and watchdogs

1. Implement `notifications.ts` with XML-like terminal event envelopes:

   ```xml
   <background_bash_notification>
     <task_id>...</task_id>
     <status>...</status>
     <exit_code>...</exit_code>
     <command>...</command>
     <output_path>...</output_path>
     <started_at>...</started_at>
     <completed_at>...</completed_at>
     <summary>...</summary>
   </background_bash_notification>
   ```

2. Emit one terminal notification for completion/failure/timeout/killed/output-cap/prompt-blocked.
3. Default to UI notification plus persisted metadata only.
4. Do not call model-waking APIs (`sendUserMessage`, `sendMessage({ triggerTurn: true })`, or equivalents) unless `wake_on_completion: true` or an explicit future config enables it.
5. Add guardrails to prevent recursive wake loops:
   - no repeated wakes per task;
   - no output-chunk wakes;
   - bounded tail excerpts only.
6. Implement `watchdogs.ts`:
   - interactive prompt detection for password, confirmations, `Press any key`, login/MFA/device-code prompts, TTY errors, package manager prompts;
   - optional idle timeout warning/stop;
   - max runtime;
   - max output cap integration.
7. Default interactive prompt behavior: mark `blocked`, notify UI with bounded tail and guidance; do not type into process or auto-answer.
8. Gate: watchdog tests and no-default-model-wake tests pass.

### Phase 6: lifecycle, reconciliation, cleanup, and PID reuse safety

1. On `session_start`, load registry and reconcile non-terminal tasks.
2. Reattach only if ownership can be validated:
   - pid exists;
   - process start/birth time matches where platform exposes it;
   - command line/cwd matches where available.
3. Never treat PID match alone as proof of ownership.
4. If validation is incomplete or mismatched, mark `unknown` or `orphaned`, surface bounded warning, and disable destructive controls.
5. On extension reload, avoid eagerly killing tasks; rebuild watchers from valid records.
6. On session shutdown:
   - if `shutdownPolicy` is `kill-session-tasks`, terminate non-persistent running tasks owned by the session;
   - append lifecycle marker to logs;
   - update registry terminal state.
7. Implement `/tasks cleanup` and retention cleanup for completed task metadata/logs.
8. Gate: reload, restart with stale PID, shutdown cleanup, and orphan safety tests pass.

### Phase 7: standalone async subagent migration CLI

Build a manually invoked CLI, for example:

```bash
pi-background-bash migrate --root ~/.async-subagents --dry-run
pi-background-bash migrate --root ~/.async-subagents --apply --profile <name>
pi-background-bash migrate rollback --backup <backup-id>
```

Required behavior:

1. Dry-run is default and must never write files.
2. Scan `~/.async-subagents/*` for:
   - Pi role definitions;
   - tool allowlists/denylists;
   - `--exclude-tools` and `--no-builtin-tools` flags;
   - extension load config;
   - prompt fragments mentioning bash, backgrounding, tmux, monitors, long-running commands, shell `&`.
3. Detect active runs and refuse or warn before touching files associated with running agents.
4. Classify authoritative config files versus generated/cache/run artifacts; do not edit generated/cache files by default.
5. Produce a per-file dry-run report with proposed diffs and risk labels.
6. Require explicit operator confirmation before writes, ideally per profile/change group.
7. Before writes, create versioned backups with a manifest mapping original path to backup path and transform id.
8. Apply selected transforms:
   - ensure opted-in roles load the extension;
   - ensure active `bash` resolves to the override;
   - remove parallel built-in `bash` exposure;
   - for allowlists, replace the built-in bash entry with the extension-backed `bash` slot and add `background_task_list/status/stop` where needed;
   - for deny/exclude lists, avoid accidentally excluding extension `bash`;
   - for `--no-builtin-tools`, explicitly re-add required built-ins plus extension tools;
   - update prompts to use `run_in_background: true`, not shell `&`, and to monitor via output path and `/tasks`/task tools.
9. Provide rollback that restores backups and documents how to disable the extension.
10. Support canary migration of a small selected profile set before any bulk migration.
11. Gate: migration dry-run, backup, apply-to-fixture, and rollback tests pass.

### Phase 8: documentation, rollout, and release gates

1. Document opt-in status, blast radius, and disabling/replacing built-in bash.
2. Document config defaults and the no-default-model-wake policy.
3. Document output directory, ignore/source-indexing recommendations, log retention, and security limits.
4. Document Windows behavior and `taskkill /F /T /PID` fallback.
5. Document known unsupported cases: fully interactive TTY workflows, secret-safe output redaction, immortal tasks unless future persistent mode is added.
6. Add examples:
   - foreground command;
   - background dev server;
   - checking `/tasks`;
   - reading output log;
   - stopping a task;
   - dry-run migration and rollback.
7. Release only after all review gates below pass.

## Dependencies and sequencing

- Phase 0 determines whether foreground delegation is safe; all later phases depend on it.
- Phase 1 must land before any package can be loaded in a canary profile.
- Phase 2 foreground parity is a hard prerequisite for shipping the override.
- Phase 3 background runner is required before enabling `run_in_background` in docs/prompt as available.
- Phase 4 UI and controls should land before broad canary use so operators can stop tasks.
- Phase 5 must land before rollout to avoid output noise, wake loops, and runaway tasks.
- Phase 6 must land before restart/reload testing and any real user rollout.
- Phase 7 migration CLI is independent of runtime startup and must remain manually invoked.

## Validation

Use repo-specific package-manager commands once confirmed in Phase 0. All commands should run with explicit fail-fast timeouts in CI or local scripts.

### Static checks

```bash
timeout 120s pnpm --filter pi-extension-background-bash typecheck
timeout 120s pnpm --filter pi-extension-background-bash lint
```

If the repo uses npm/yarn/turbo instead of pnpm, replace with the established equivalent.

### Unit and integration tests

```bash
timeout 180s pnpm --filter pi-extension-background-bash test -- foreground-parity
timeout 180s pnpm --filter pi-extension-background-bash test -- background-runner
timeout 180s pnpm --filter pi-extension-background-bash test -- task-registry
timeout 180s pnpm --filter pi-extension-background-bash test -- process-tree
timeout 180s pnpm --filter pi-extension-background-bash test -- watchdogs
timeout 180s pnpm --filter pi-extension-background-bash test -- activation
timeout 180s pnpm --filter pi-extension-background-bash test -- migration-dry-run
```

### Foreground parity tests

- `bash({ command: "echo hi" })` output matches built-in behavior.
- Nonzero exit surfaces like built-in.
- Foreground timeout kills command/process group.
- Abort signal cancels command.
- Large foreground output follows built-in bounds.
- Existing `{ command, timeout? }` calls work unchanged.
- Foreground renderer/session reconstruction remains compatible.

### Background execution tests

- `run_in_background: true` returns quickly with task id and output path.
- Long-running command continues after tool return.
- Output appears in `output.log` and is readable with normal read.
- Exit updates registry with exit code/signal.
- Completion notification is emitted exactly once.
- Spawn failure returns a clear error and leaves no running task.

### Task controls tests

- List includes running and completed tasks as requested.
- Status reports timestamps, pid, output path, and terminal state.
- Stop kills child process trees, not just shell parent.
- Cleanup removes completed task files according to retention policy.
- Destructive stop refuses orphaned/unknown records without validated ownership.

### Lifecycle tests

- Extension reload preserves/reconciles running tasks.
- Session shutdown kills owned non-persistent tasks.
- Restart with stale PID does not kill unrelated process.
- Orphaned/unknown tasks surface a bounded warning.

### Watchdog and security tests

- Interactive prompt patterns mark blocked or stop per config.
- Max runtime timeout terminates process tree.
- Hard max output cap stops task and appends sentinel.
- Task id/path sanitization prevents path traversal.
- Logs are created with safe permissions where platform supports it.
- No model wake-up occurs by default.

### TUI/manual review checks

- Background task cards render cleanly at narrow and wide widths.
- ANSI-aware truncation does not corrupt glyphs/colors.
- Footer/widget does not steal vertical space.
- Raw JSON/full metadata is hidden by default and available only via detail commands.
- Running log growth does not repaint per output chunk.

### Migration CLI tests

```bash
timeout 180s pnpm --filter pi-extension-background-bash test -- migration-dry-run
```

Fixture assertions:

- Dry-run writes nothing.
- Active-run detection warns/refuses.
- Tool allowlist transforms replace built-in `bash` with extension-backed `bash` and add needed task tools.
- `--exclude-tools`/`--no-builtin-tools` transforms keep extension `bash` available.
- Prompt transforms remove shell `&`/tmux-only guidance where appropriate and add `run_in_background` guidance.
- Backups are versioned.
- Rollback restores exact original file contents.

Manual canary command sequence:

```bash
timeout 60s pi-background-bash migrate --root ~/.async-subagents --dry-run
timeout 60s pi-background-bash migrate --root ~/.async-subagents --dry-run --profile <canary-profile>
timeout 120s pi-background-bash migrate --root ~/.async-subagents --apply --profile <canary-profile>
timeout 120s pi-background-bash migrate rollback --backup <backup-id>
```

Skip or adapt these exact commands until the binary name and package scripts are finalized.

## Rollout plan

1. Land package disabled by default behind explicit extension enablement.
2. Enable in a local developer canary profile only.
3. Verify active tool resolution:
   - visible `bash` schema includes `run_in_background`;
   - no parallel built-in `bash` is model-visible;
   - auxiliary task tools are available only as intended.
4. Run foreground parity suite before any background testing.
5. Run background lifecycle suite with short-lived commands.
6. Test one long-running dev server/watch command and stop it through `/tasks stop`.
7. Test reload, restart, and shutdown cleanup.
8. Test Windows process-tree cleanup on Windows before claiming Windows support.
9. Run migration CLI dry-run on `~/.async-subagents/*`; do not apply broadly.
10. Canary-migrate one low-risk async subagent profile and run a background command smoke test.
11. Review logs, notifications, UI, and no-wake behavior.
12. Expand only to explicitly selected profiles.

## Rollback plan

Runtime rollback:

1. Disable/uninstall the extension for the affected Pi profile.
2. Restore built-in `bash` exposure through normal active-tool config.
3. If `--exclude-tools bash` was used as a workaround, remove that workaround or replace it with the intended built-in configuration.
4. If `--no-builtin-tools` was used, re-add built-in `bash` or restore previous profile config.
5. Stop or classify any running extension-owned tasks using `/tasks stop` before disabling where possible.
6. Preserve task logs for debugging unless retention cleanup is explicitly requested.

Migration rollback:

1. Run `pi-background-bash migrate rollback --backup <backup-id>`.
2. Verify restored async subagent configs no longer load the extension unless intended.
3. Verify prompts/tool lists match pre-migration backups.
4. Re-run dry-run to confirm no pending unintended changes.

Emergency rollback:

- If foreground parity fails in a released canary, disable the override immediately and fall back to separate background tools or no background capability until fixed.
- If model wake loops occur, disable all model-waking notification paths; default config must already have them off.

## Review gates

- **API gate:** documented extension APIs are sufficient; no registry internals are used.
- **Activation gate:** exactly one model-visible active `bash`, sourced from the extension, when enabled.
- **Foreground gate:** built-in-compatible foreground behavior passes parity tests.
- **Lifecycle gate:** reload/restart/shutdown semantics are safe and tested.
- **PID safety gate:** no destructive action relies on PID alone.
- **Output gate:** hard output cap stops runaway tasks.
- **Notification gate:** no default model wake and no recursive wake loops.
- **TUI gate:** progressive disclosure and TUI skill requirements are satisfied.
- **Windows gate:** `taskkill /F /T /PID` or equivalent process-tree strategy is tested or Windows support is explicitly marked limited.
- **Migration gate:** standalone migration CLI is dry-run-first, backup-backed, rollback-tested, and never runs during extension startup.
- **Docs gate:** opt-in risk, disabling/replacing built-in bash, rollout, and rollback are documented.

## Risks / Unknowns

- Exact foreground delegation via `createBashTool(cwd, options)` may not preserve all renderer/session behavior; fallback reimplementation increases risk.
- Exact extension API for prompt metadata replacement and renderer inheritance must be confirmed.
- Active tool precedence for extension `bash` versus built-in `bash` must be verified on the installed Pi version.
- The safest default values for max runtime, output cap, idle timeout, and retention need product review.
- Output directory choice may vary across single-workspace, multi-root, and read-tool sandbox configurations.
- Windows process-tree ownership validation may be weaker than Unix; stop controls may need conservative disabling when ownership cannot be proven.
- Existing async subagent config formats under `~/.async-subagents/*` may include generated/cache files that should not be edited.
- Some async subagent roles may intentionally forbid shell access or prefer existing durable monitor/tmux guidance; migration must remain opt-in per profile.
- Persistent tasks are deferred; adding them later will require a separate ownership, restart, and security review.
