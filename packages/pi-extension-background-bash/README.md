# @bravo/pi-extension-background-bash

Opt-in Pi extension that overrides the model-facing `bash` tool with Claude-Code-like background task support.

Disabled by default. Enable at extension load with `PI_BACKGROUND_BASH_ENABLED=1`. Runtime config can tune behavior after load, but does not currently enable registration.

For async-subagents, add `src/async-subagents-global.ts` as a `defaultExtensions` entry in `~/.async-subagents/config.json`; that wrapper sets `PI_BACKGROUND_BASH_ENABLED=1` for child Pi processes and then loads the normal extension.

When enabled, the extension registers `bash` plus `background_task_list`, `background_task_status`, and `background_task_stop`. It also registers the scoped slash command `/bash-tasks [list|all|show <id>|tail <id> [lines]|stop <id>|cleanup]` for human TUI inspection/control. Foreground calls delegate to Pi's exported `createBashTool`; background calls spawn a managed shell child, write `~/.pi/background-bash/<taskId>/output.log` by default, persist schema-v1 task metadata, and enforce max runtime/output caps. Timeout, output-cap, and user-stop requests record a reason and signal the process tree; the task remains active until the managed shell child closes so stdout/stderr can drain. That close is the lifecycle boundary: detached descendants that outlive the shell are not supervised or used to delay terminal metadata. The task record stores the original command cwd and owner Pi session as metadata; repo-local `.pi/background-bash` storage is opt-in via `backgroundBash.dataDir`.

The registry file is an active-lifecycle index, not a full history table: it tracks starting/running/blocked/attention-needed tasks so refreshes stay small. TUI widgets, `background_task_*` tools, and `/bash-tasks` controls are session-scoped by default, so stale tasks from another Pi session do not appear in new sessions or unrelated CWDs. Successfully persisted terminal metadata leaves the active index and remains under the task directory for inspection or cleanup. A terminal persistence fault is contained and warned but can leave stale active metadata; this bounded extension does not provide retrying supervision. `background_task_stop` is for live or blocked tasks in the current session; if the target has already reached a terminal state, stop does not re-add it to the active registry.

Prefer enabling this extension and relying on Pi tool override precedence. If precedence is ambiguous, explicitly remove the built-in `bash` from active tools and expose this extension's `bash`; use `--exclude-tools bash` only as a workaround.

Model wake-up on completion is off by default and is v1 per-call opt-in only. Pass `wake_on_completion: true` together with `run_in_background: true` to request one best-effort follow-up model turn when that task reaches `exited`, `failed`, `timed_out`, or `killed`. Admission fails before task allocation unless the host send API, runtime, current/owner/notifier session ids, and optional session-file route agree. Config-level `notifyModelOnCompletion`, omitted flags, and old schema-v2/v3 evidence never opt a task in or trigger retroactive dispatch.

A wake is expensive and starts a separate turn. It can reprocess context that preceded completion, so use it only when the model will otherwise be idle and one terminal event warrants resuming work. For parallel jobs, omit per-task wakes or create one faithful barrier task and wake on that barrier. Omit wake for servers, watchers, and services. The wake payload contains metadata only: task id, terminal status, output path/byte count, and applicable exit code, signal, or stop reason. It never embeds command text, output, tails, summaries, timestamps, or delivery claims. `sendMessage` is a synchronous void host call; persisted `dispatched_to_host` means only `host_api_invoked`, not accepted, enqueued, delivered, or turn-completed. If persistence after the call fails, durable `dispatch_requested` remains ambiguous rather than being mislabeled as a host failure. Ambiguous claimed/requested states are never replayed after reload.

Read task output with the normal read tool using bounded `offset`/`limit` requests, and use `background_task_status` for lifecycle state.

## Async subagent migration CLI

`pi-background-bash` is a standalone operator CLI for `~/.async-subagents/*`; it is not imported by extension activation and never runs during startup or normal tool execution.

- Preview only (default): `pi-background-bash dry-run` or `pi-background-bash migrate`
- Canary/profile selection: `pi-background-bash dry-run --canary 2` or `--profiles alpha,beta`
- Apply after review: `pi-background-bash migrate --apply --yes`
- Roll back: `pi-background-bash rollback --manifest ~/.async-subagents/.background-bash-migration/<stamp>/manifest.json`

The scanner skips cache/run artifacts and refuses writes when run-artifact warnings are in scope. Backups are written before any modified config/prompt file is changed.
