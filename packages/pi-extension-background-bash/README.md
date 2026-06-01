# @bravo/pi-extension-background-bash

Opt-in Pi extension that overrides the model-facing `bash` tool with Claude-Code-like background task support.

Disabled by default. Enable at extension load with `PI_BACKGROUND_BASH_ENABLED=1`. Runtime config can tune behavior after load, but does not currently enable registration.

For async-subagents, add `src/async-subagents-global.ts` as a `defaultExtensions` entry in `~/.async-subagents/config.json`; that wrapper sets `PI_BACKGROUND_BASH_ENABLED=1` for child Pi processes and then loads the normal extension.

When enabled, the extension registers `bash` plus `background_task_list`, `background_task_status`, and `background_task_stop`. Foreground calls delegate to Pi's exported `createBashTool`; background calls spawn a managed process, write `.pi/background-bash/<taskId>/output.log`, persist task metadata, and enforce max runtime/output caps.

Prefer enabling this extension and relying on Pi tool override precedence. If precedence is ambiguous, explicitly remove the built-in `bash` from active tools and expose this extension's `bash`; use `--exclude-tools bash` only as a workaround.

Model wake-up on completion is off by default. Pass `wake_on_completion: true` per call only when explicitly desired.

## Async subagent migration CLI

`pi-background-bash` is a standalone operator CLI for `~/.async-subagents/*`; it is not imported by extension activation and never runs during startup or normal tool execution.

- Preview only (default): `pi-background-bash dry-run` or `pi-background-bash migrate`
- Canary/profile selection: `pi-background-bash dry-run --canary 2` or `--profiles alpha,beta`
- Apply after review: `pi-background-bash migrate --apply --yes`
- Roll back: `pi-background-bash rollback --manifest ~/.async-subagents/.background-bash-migration/<stamp>/manifest.json`

The scanner skips cache/run artifacts and refuses writes when run-artifact warnings are in scope. Backups are written before any modified config/prompt file is changed.
