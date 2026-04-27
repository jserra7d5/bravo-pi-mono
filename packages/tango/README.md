# tango

`tango` is a CLI-first native/tmux agent orchestrator.

It provides:

- a `tango` CLI for starting, inspecting, messaging, and stopping agents;
- harness adapters for Pi, Claude Code, Gemini CLI, and generic shell commands;
- reusable agent roles and shared prompt includes;
- a Pi extension wrapper that exposes the CLI as Pi tools/commands.

## Basic commands

```bash
tango roles list
tango start repo-scout --role scout "Summarize this repo"
tango ps
tango activity repo-scout
tango result repo-scout
tango children --tree
tango follow --until terminal repo-scout --json
tango watch --json
tango doctor events
```

## Claude Code and Gemini CLI harnesses

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

Gemini roles use `harness: gemini` and launch Gemini CLI under Tango's run directory and tmux conventions. By default, Gemini starts in `interactive` mode rather than one-shot/headless mode.

Example:

```bash
tango start gemini-worker --role gemini-worker --model gemini-3.1-pro-preview "Implement the assigned task"
tango result gemini-worker
```

Gemini harness behavior:

- launches `gemini --prompt-interactive <task> --yolo --skip-trust` with a required Gemini model; only `gemini-3.1-pro-preview` and `gemini-3-flash-preview` are accepted;
- injects the assembled Tango system prompt into the interactive prompt text;
- keeps Gemini runtime state isolated with `HOME=<runDir>/home`;
- sets `TANGO_REAL_HOME=<operator-home>` and `TANGO_AGENT_HOME=<runDir>/home`;
- preserves `TANGO_HOME` for recursive Tango CLI calls;
- seeds minimal Gemini OAuth/config files from `~/.gemini` (`oauth_creds.json`, `google_accounts.json`, settings/project/trust state, and related config files) when present;
- maps role/CLI `thinking` to run-local Gemini `modelConfigs.overrides` using Gemini 3 `thinkingLevel` (`LOW`, `MEDIUM`, or `HIGH`) when set;
- ignores role `tools` because Pi tools and Gemini CLI tools are not portable;
- rejects role `extensions` because Pi extensions are not available in Gemini CLI;
- copies role `skills` directories into `<runDir>/home/.gemini/skills/` on a best-effort basis for Gemini installations that support local skills.

Pi harness behavior similarly keeps Pi runtime state isolated while loading a Tango Pi extension that makes the Pi `bash` tool run with `HOME=$TANGO_REAL_HOME` when `bash` is enabled for the role.

`tango start` returns after an agent is launched. One-shot agents continue in a detached finite runner, so coordinators can observe them with `tango ps`, `tango follow --until terminal`, and proactive status events while they run.

Report changes are written to a durable event log at `$TANGO_HOME/events.jsonl`. `tango watch` tails this log; the Pi extension uses it to send persisted, deduped, batched notifications to parent sessions when child agents finish, block, or error. For interactive agents, `tango report done` requires `--result-file <path>` so `result.md` contains the full deliverable; use explicit `--summary-only` only when no deliverable is intended. `tango children`, `tango follow --until terminal`, `tango reconcile`, and `tango doctor events` support parent/child coordination, stale lifecycle repair, and event-delivery smoke tests.

Pi-harness Tango children also write best-effort metrics snapshots to `<runDir>/metrics.json` for tool counts, token/context usage, and runtime-oriented TUI summaries. `tango ps --json` and `tango children --json` include these snapshots when available; `tango metrics update --run-dir <dir> --payload <json>` is the internal update surface used by the Pi metrics extension.

Recursive Claude roles receive CLI orchestration instructions and should delegate with `tango ... --json` commands. Loom integration remains outside Tango: Loom can pass context through environment variables and task prompts when it launches Tango agents.

## Server/dashboard rollout checks

Tango's CLI is designed to remain usable without the optional dashboard server running. Roll out the server/dashboard path with these compatibility checks:

- `tango ps --json`, `tango roles list`, and other read-only CLI commands should work with no `TANGO_SERVER_URL`, no `TANGO_SERVER_TOKEN`, and no discovery file.
- `tango start ...` launches only the requested agent; it must not auto-start `tango server`. Start the dashboard explicitly with `tango server [--host 127.0.0.1] [--port 43117] [--token TOKEN]`.
- Dashboard/API auth is disabled by default on the localhost server. Passing `--token TOKEN` explicitly enables token auth and prints the dashboard URL plus token separately.
- Server discovery is read from `TANGO_SERVER_URL` (and optional `TANGO_SERVER_TOKEN`) when set; otherwise Tango falls back to `$TANGO_HOME/server/server.json` written by `tango server`.
- `tango artifact publish` stores artifacts regardless of server availability. It prints/returns a URL only when server discovery is available; otherwise it returns the artifact id for later listing/serving.
- Validate package rollout with:
  - `npm test --workspace @bravo/tango`
  - `npm run check --workspace @bravo/tango`
  - `npm run build --workspace @bravo/tango`

See `../../docs/specs/tango-v1/design.md`, `../../docs/specs/tango-events/design.md`, `../../docs/specs/tango-home-tooling/design.md`, `../../docs/specs/tango-claude-code-runtime/design.md`, and `../../docs/specs/tango-gemini-cli-runtime/design.md` for design details. See `docs/gemini-harness.md` for Gemini harness usage.
