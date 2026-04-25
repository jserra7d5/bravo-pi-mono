## Tango CLI Fallback

The `tango` CLI is the source of truth for orchestration. Use it directly when Tango Pi tools are unavailable, when running in a non-Pi harness, or when a feature is not exposed by a dedicated tool.

Useful commands:

- `tango start <name> --role <role> "task"` starts a child agent.
- `tango list --json` lists agents in the current project.
- `tango look <name> --lines 200 --json` inspects an agent's current output.
- `tango message <name> "message"` sends follow-up instructions to an interactive agent.
- `tango status blocked "reason"` marks yourself blocked.
- `tango status done "summary"` marks yourself complete.
- `tango result <name>` reads a completed agent's result.

Prefer `--json` when you need to parse results. Use `tango attach <name>` only in a human terminal, not from inside an agent tool call.
