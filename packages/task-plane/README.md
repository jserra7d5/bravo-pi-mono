# @bravo/pi-extension-task-plane

Unified Pi task plane. It registers exactly four tools:

- `bash` — foreground shell execution or owned background work via `run_in_background`.
- `monitor` — external-state observation; stdout lines are events and process exit is terminal.
- `managed_task_list` — list bash and monitor tasks.
- `task_stop` — stop either task type.

State lives under `$PI_TASK_PLANE_HOME` or `~/.pi/task-plane`, with per-task `metadata.json`, `output.log`, and terminal claim file. Terminal follow-ups are best-effort with at-most-once host invocation; tasks stopped during session shutdown do not notify. Monitor events are throttled/batched and noisy monitors auto-stop.

Use `npm test --workspace @bravo/pi-extension-task-plane` for package validation.
