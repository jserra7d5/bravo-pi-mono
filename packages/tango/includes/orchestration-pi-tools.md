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
- `tango_cli` is the generic CLI escape hatch for safe Tango commands and flags not yet exposed by a dedicated tool, including `children`, `wait`, and `doctor events`. Long-running commands such as `tango watch` are intentionally not exposed through `tango_cli`.

Use dedicated tools for common operations. Use `tango_cli` for newer or uncommon CLI features. Use raw shell CLI only when tools are unavailable or for debugging.

Parent Pi sessions may receive proactive, batched notifications when child agents finish, block, or error. Treat notifications as prompts to inspect the child; always inspect child output with `tango_look` or `tango_result` before summarizing a child agent's work.
