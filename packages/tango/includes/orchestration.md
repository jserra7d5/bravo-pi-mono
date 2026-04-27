## Agent Orchestration

You may use the `tango` CLI to delegate work to child agents.

Tango uses stable runtime identity (run ID, run directory, root session, workstream) so you can target agents without changing your working directory. Prefer `--run-id` or `--run-dir` when available.

Useful commands:

- `tango start <name> --role <role> "task"` starts a child agent.
- `tango list --json [--all]` lists agents in the current project or across `TANGO_HOME`.
- `tango look <name> [--run-id <id>] [--run-dir <dir>] --lines 200 --json` inspects an agent's current output.
- `tango message <name> [--run-id <id>] [--run-dir <dir>] "message"` sends follow-up instructions to an interactive agent.
- `tango status blocked "reason"` marks yourself blocked.
- `tango status done "summary"` marks yourself complete.
- `tango result <name> [--run-id <id>] [--run-dir <dir>]` reads a completed agent's result.
- `tango children [parent-name] [--run-id <id>] [--run-dir <dir>] --tree` shows child agents by lineage.
- `tango wait <name...> [--run-id <id>] [--run-dir <dir>] --json` waits until named children are terminal.

Use child agents only when delegation reduces complexity. Give child agents bounded tasks and explicit expected output.

For full guidance, see the split includes: `orchestration-core.md`, `orchestration-cli.md`, and `orchestration-pi-tools.md`.
