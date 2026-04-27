## Agent Orchestration

You may use the `tango` CLI to delegate work to child agents.

Tango uses stable runtime identity (run ID, run directory, root session, workstream) so you can target agents without changing your working directory. Prefer `--run-id` or `--run-dir` when available.

Useful commands:

- `tango start <name> --role <role> "task"` starts a child agent. Interactive agents require a deliverable by default; use `--no-result-required` only for status-only agents.
- `tango ps --json [--all]` lists agents in the current project or across `TANGO_HOME`.
- `tango activity <name> [--run-id <id>] [--run-dir <dir>] --lines 200 --json` inspects an agent's current output.
- `tango message <name> [--run-id <id>] [--run-dir <dir>] "message"` sends follow-up instructions to an interactive agent.
- `tango report blocked "reason"` marks yourself blocked.
- `tango report done --result-file <path> "summary"` marks an interactive agent complete and copies a full deliverable into `result.md` before notifying parents.
- `tango report done --summary-only "summary"` is the explicit opt-out only for agents started with `--no-result-required`; the summary is operational metadata and does not create/overwrite `result.md`.
- Oneshot agents may have their final assistant response captured as `result.md`; interactive agents must use `--result-file` unless the run was explicitly started as not requiring a result.
- `tango result <name> [--run-id <id>] [--run-dir <dir>] [--watch] [--timeout seconds]` reads a completed agent's deliverable and reports readiness/issues/warnings when missing or suspicious.
- `tango children [parent-name] [--run-id <id>] [--run-dir <dir>] --tree` shows child agents by lineage.
- `tango follow --until terminal <name...> [--run-id <id>] [--run-dir <dir>] --json` waits until named children are terminal.

Use child agents only when delegation reduces complexity. Give child agents bounded tasks and explicit expected output.

For full guidance, see the split includes: `orchestration-core.md`, `orchestration-cli.md`, and `orchestration-pi-tools.md`.
