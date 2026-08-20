# @bravo/pi-extension-task-plane

Unified Pi task plane. It registers exactly four tools:

- `bash` — foreground shell execution or owned background work via `run_in_background`.
- `monitor` — external-state observation with one metadata-only notification at termination.
- `managed_task_list` — list bash and monitor tasks.
- `managed_task_stop` — stop either task type.

State lives under `$PI_TASK_PLANE_HOME` or `~/.pi/task-plane`, with per-task `metadata.json`, `output.log`, and terminal claim file. Once terminal notification dispatch is resolved (or suppressed during shutdown), the task directory moves under `archive/tasks/` and its original `tasks/<task_id>` path becomes a symlink. Normal scheduler and lock scans skip these links; `managed_task_list(include_completed=true)` follows them on demand. Terminal follow-ups are best-effort with at-most-once host invocation; tasks stopped during session shutdown do not notify. Monitor stdout is an internal observation API for predicates, hashing, and flood accounting—not a conversation stream. Full stdout/stderr stays in `output.log`; noisy monitors still auto-stop. Each terminal XML envelope is metadata-only and bounded to 4096 UTF-8 bytes.

Design monitor commands for bounded output cardinality. Emit only compact decision evidence on stdout; route redraws, progress bars, repeated/full tables, and diagnostics to stderr. Stream monitors must self-terminate. For GitHub Actions, prefer compact terminal observation (for example `gh run watch --exit-status >/dev/null`) or an interval query selecting only status/conclusion rather than streaming full job tables.

Use `npm test --workspace @bravo/pi-extension-task-plane` for package validation.
