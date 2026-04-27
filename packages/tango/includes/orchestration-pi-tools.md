## Tango Pi Tools

When Tango Pi tools are available, prefer them over raw shell commands. The tools are structured wrappers over the `tango` CLI and keep behavior aligned with the CLI while providing better Pi terminal UI feedback.

Tool to CLI mapping:

- `tango_start` wraps `tango start`.
- `tango_list` wraps `tango list`.
- `tango_look` wraps `tango look`.
- `tango_message` wraps `tango message`.
- `tango_stop` wraps `tango stop`.
- `tango_status` wraps `tango status`.
- `tango_result` wraps `tango result`.
- `tango_cli` is the generic CLI escape hatch for safe Tango commands and flags not yet exposed by a dedicated tool, including `children`, `wait`, and `doctor events`. Long-running commands such as `tango watch` and `tango server` are intentionally not exposed through `tango_cli`.

Use dedicated tools for common operations. Use `tango_cli` for newer or uncommon CLI features. Use raw shell CLI only when tools are unavailable or for debugging.

### Lineage-aware targeting

Dedicated Pi tools accept an agent name and optional `cwd`, but they do not yet expose `--run-id` or `--run-dir` parameters. For stable targeting with run IDs or run directories, use `tango_cli` or the raw `tango` CLI directly. You do not need to change your working directory to target a child agent.

### Server and dashboard

The Tango server may provide dashboard visibility and artifact hosting for artifacts published through the raw `tango artifact` CLI. Dedicated Pi tools and `tango_cli` do not currently expose artifact or server commands.

### Attention and delivery

Parent Pi sessions may receive proactive, batched notifications when child agents finish, block, or error. Treat notifications as prompts to inspect the child; always inspect child output with `tango_look` or `tango_result` before summarizing a child agent's work.
