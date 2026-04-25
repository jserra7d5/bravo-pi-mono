## Agent Orchestration

You may use the `tango` CLI to delegate work to child agents.

Useful commands:

- `tango start <name> --role <role> "task"` starts a child agent.
- `tango list --json` lists agents in the current project.
- `tango look <name> --lines 200 --json` inspects an agent's current output.
- `tango message <name> "message"` sends follow-up instructions to an interactive agent.
- `tango status blocked "reason"` marks yourself blocked.
- `tango status done "summary"` marks yourself complete.
- `tango result <name>` reads a completed agent's result.

Use child agents only when delegation reduces complexity. Give child agents bounded tasks and explicit expected output.
