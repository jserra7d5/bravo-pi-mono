# tango

`tango` is a CLI-first native/tmux agent orchestrator.

It provides:

- a `tango` CLI for starting, inspecting, messaging, and stopping agents;
- harness adapters for Pi, Claude Code, and generic shell commands;
- reusable agent roles and shared prompt includes;
- a Pi extension wrapper that exposes the CLI as Pi tools/commands.

## Basic commands

```bash
tango roles list
tango start repo-scout --role scout "Summarize this repo"
tango list
tango look repo-scout
tango result repo-scout
```

## Claude Code harness

Claude roles use `harness: claude` and launch Claude Code under Tango's run directory and tmux conventions.

Example:

```bash
tango start cc-scout --role claude-scout --model haiku --effort low "Summarize this repo"
tango result cc-scout
```

Supported controls:

- `--model` or role `model` maps to `claude --model`.
- `--effort` or role `effort` maps to `claude --effort`.
- `mode: oneshot` uses `claude --print --verbose --output-format stream-json` and writes `result.md`.
- `mode: interactive` runs Claude in Tango's tmux session.

Claude harness behavior:

- uses `--system-prompt-file <runDir>/system.md`;
- sets `HOME=<runDir>/home` and preserves `TANGO_HOME` for recursive Tango CLI calls;
- seeds minimal Claude auth/config;
- disables ambient MCP servers with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`;
- disables Claude-native subagents with `--disallowed-tools Task` so delegation stays observable through Tango;
- ignores role `tools` because Pi tools and Claude Code tools are not portable;
- rejects role `extensions` because Pi extensions are not available in Claude Code;
- copies role `skills` directories into `<runDir>/home/.claude/skills/`.

Recursive Claude roles receive CLI orchestration instructions and should delegate with `tango ... --json` commands. Loom integration remains outside Tango: Loom can pass context through environment variables and task prompts when it launches Tango agents.

See `../../docs/specs/tango-v1/design.md` and `../../docs/specs/tango-claude-code-runtime/design.md` for design details.
