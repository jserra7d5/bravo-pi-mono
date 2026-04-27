## Tango CLI Fallback

The `tango` CLI is the source of truth for orchestration. Use it directly when Tango Pi tools are unavailable, when running in a non-Pi harness, or when a feature is not exposed by a dedicated tool.

### Stable targeting

Many commands accept `--run-id <id>` or `--run-dir <path>` for lineage-aware targeting. Prefer these over name-only targeting when available, because they resolve unambiguously across root sessions and workstreams. You do not need to `cd` into a child agent’s project directory to target it.

### Useful commands

- `tango start <name> --role <role> "task"` starts a child agent.
- `tango list --json [--all]` lists agents. Without `--all`, this scopes to the current project; with `--all`, it spans the entire `TANGO_HOME`.
- `tango look <name> [--run-id <id>] [--run-dir <dir>] --lines 200 --json` inspects an agent's current output.
- `tango message <name> [--run-id <id>] [--run-dir <dir>] "message"` sends follow-up instructions to an interactive agent.
- `tango result <name> [--run-id <id>] [--run-dir <dir>]` reads a completed agent's result.
- `tango stop <name> [--run-id <id>] [--run-dir <dir>]` stops an agent.
- `tango children [parent-name] [--run-id <id>] [--run-dir <dir>] --tree` shows child agents by lineage.
- `tango wait <name...> [--run-id <id>] [--run-dir <dir>] --json` waits until named children are terminal.
- `tango watch --json [--all] [--from-start]` streams Tango status events. By default, this watches the current root session/workstream lineage; use `--all` only when you intentionally need events across the entire `TANGO_HOME`.
- `tango doctor events` emits a synthetic event to smoke-test event/watch delivery.
- `tango reconcile --json [--all] [--children]` runs finite lifecycle reconciliation for stale `running` agents; parent sessions may run this opportunistically.
- `tango metrics update --run-dir <dir> --payload <json>` updates internal best-effort metrics snapshots; agents normally should not call this manually unless implementing runtime integration plumbing.
- `tango server [--host 127.0.0.1] [--port 43117] [--token TOKEN]` starts the optional HTTP+SSE control plane, dashboard, and artifact server.
- `tango artifact publish <path> [--title title] [--entry file]` registers/copies an artifact. When the server is running and discoverable, the result includes a tokenized URL; otherwise it returns an artifact ID/manifest for later serving.
- `tango artifact list` and `tango artifact revoke <artifact-id>` manage artifacts.

Prefer `--json` when you need to parse results. Parent sessions may receive proactive Tango completion notifications, but still inspect child output with `tango result` or `tango look` before relying on it. Use `tango attach` only in a human terminal, not from inside an agent tool call.

### Non-Pi harness guidance

Claude Code and other non-Pi harnesses do not have Pi tools or persistent extensions. They should use the CLI commands above, prefer `--json` for parsing, and use the Tango server when it is available for dashboard visibility and artifact hosting.
