## Tango Pi Tools

When Tango Pi tools are available, prefer them over raw shell commands. The tools are structured wrappers over the `tango` CLI and keep behavior aligned with the CLI while providing better Pi terminal UI feedback.

Tool to CLI mapping:

- `tango_start` wraps `tango start`.
- `tango_ps` wraps `tango ps`.
- `tango_inspect` wraps `tango inspect`.
- `tango_activity` wraps `tango activity`.
- `tango_follow` wraps `tango follow`.
- `tango_message` wraps `tango message`.
- `tango_stop` wraps `tango stop`.
- `tango_report` wraps `tango report`.
- `tango_result` wraps `tango result`.
- `tango_children` wraps `tango children`.
- `tango_cli` is the generic CLI escape hatch for safe Tango commands and flags not yet exposed by a dedicated tool, including `doctor events`. Long-running commands such as `tango watch` and `tango server` are intentionally not exposed through `tango_cli`.

Use dedicated tools for common operations. Use `tango_cli` for newer or uncommon CLI features. Use raw shell CLI only when tools are unavailable or for debugging.

### Lineage-aware targeting

Dedicated Pi tools accept an agent name and optional `cwd`. Targeting tools also accept stable `runId` and `runDir` parameters; prefer those when known. You do not need to change your working directory to target a child agent.

### Server and dashboard

The Tango server may provide dashboard visibility and artifact hosting for artifacts published through the raw `tango artifact` CLI. Dedicated Pi tools and `tango_cli` do not currently expose artifact or server commands.

### Attention and delivery

Parent Pi sessions may receive proactive, batched notifications when child agents finish, block, or error. Treat notifications as prompts to inspect the child; always inspect child output with `tango_activity` or `tango_result` before summarizing a child agent's work.
