## Tango CLI Fallback

The `tango` CLI is the source of truth for orchestration. Use it directly when Tango Pi tools are unavailable, when running in a non-Pi harness, or when a feature is not exposed by a dedicated tool.

Useful commands:

- `tango start <name> --role <role> "task"` starts a child agent.
- `tango list --json` lists agents in the current project.
- `tango look <name> --lines 200 --json` inspects an agent's current output.
- `tango message <name> "message"` sends follow-up instructions to an interactive agent.
- `tango status blocked "reason" --needs review` marks yourself blocked and identifies the needed parent action.
- `tango status done "summary"` marks yourself complete.
- `tango result <name>` reads a completed agent's result.
- `tango children [parent-name] --tree` shows child agents for the current Tango parent or named parent.
- `tango wait <name...> --json` waits until named children are terminal.
- `tango watch --json` streams Tango status events for the current project; use `--all` only when you intentionally need all projects under the same `TANGO_HOME`.
- `tango doctor events` emits a synthetic event to smoke-test event/watch delivery.

Prefer `--json` when you need to parse results. Parent Pi sessions may receive proactive Tango completion notifications, but still inspect child output with `tango result` or `tango look` before relying on it. Use `tango attach <name>` only in a human terminal, not from inside an agent tool call.
