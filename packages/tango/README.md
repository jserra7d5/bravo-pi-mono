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
tango children --tree
tango wait repo-scout --json
tango watch --json
tango doctor events
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
- keeps Claude runtime state isolated with `HOME=<runDir>/home`;
- sets `TANGO_REAL_HOME=<operator-home>` and `TANGO_AGENT_HOME=<runDir>/home`;
- routes Claude Bash tool commands through `CLAUDE_CODE_SHELL_PREFIX=<runDir>/bin/tango-bash`, so Bash commands see the operator's real `HOME` for Git/SSH/GitHub CLI/npm config;
- preserves `TANGO_HOME` for recursive Tango CLI calls;
- seeds minimal Claude auth/config;
- disables ambient MCP servers with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`;
- disables Claude-native subagents with `--disallowed-tools Task` so delegation stays observable through Tango;
- ignores role `tools` because Pi tools and Claude Code tools are not portable;
- rejects role `extensions` because Pi extensions are not available in Claude Code;
- copies role `skills` directories into `<runDir>/home/.claude/skills/`.

Pi harness behavior similarly keeps Pi runtime state isolated while loading a Tango Pi extension that makes the Pi `bash` tool run with `HOME=$TANGO_REAL_HOME` when `bash` is enabled for the role.

`tango start` returns after an agent is launched. One-shot agents continue in a detached finite runner, so coordinators can observe them with `tango list`, `tango wait`, and proactive status events while they run.

Status changes are written to a durable event log at `$TANGO_HOME/events.jsonl`. `tango watch` tails this log; the Pi extension uses it to send persisted, deduped, batched notifications to parent sessions when child agents finish, block, or error. `tango children`, `tango wait`, `tango reconcile`, and `tango doctor events` support parent/child coordination, stale lifecycle repair, and event-delivery smoke tests.

Pi-harness Tango children also write best-effort metrics snapshots to `<runDir>/metrics.json` for tool counts, token/context usage, and runtime-oriented TUI summaries. `tango list --json` and `tango children --json` include these snapshots when available; `tango metrics update --run-dir <dir> --payload <json>` is the internal update surface used by the Pi metrics extension.

Recursive Claude roles receive CLI orchestration instructions and should delegate with `tango ... --json` commands. Loom integration remains outside Tango: Loom can pass context through environment variables and task prompts when it launches Tango agents.

See `../../docs/specs/tango-v1/design.md`, `../../docs/specs/tango-events/design.md`, `../../docs/specs/tango-home-tooling/design.md`, and `../../docs/specs/tango-claude-code-runtime/design.md` for design details.
