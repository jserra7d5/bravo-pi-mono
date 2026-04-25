# Tango Claude Code Runtime Implementation Summary

Date: 2026-04-25
Status: implemented and hand-tested

## What changed

### Tango

- Added Claude Code harness: `packages/tango/src/harnesses/claude.ts`.
- Added role `effort` support and CLI `--effort`.
- Added harness-aware oneshot result parsing via `resultParser`:
  - `pi-json`
  - `claude-stream-json`
  - `plain`
- Added Claude default roles:
  - `claude-scout`
  - `claude-worker`
  - `claude-team-lead`
- Added `TANGO_HOME` to child environments so recursive agents with run-local `HOME` still use the parent Tango run registry.
- Changed `tango message` to use tmux paste buffers plus `C-m`, which works reliably for Claude Code interactive prompts.
- Updated Tango docs and top-level README.

### Claude harness behavior

Claude agents launch with:

- `HOME=<runDir>/home`
- minimal seeded Claude auth/config
- `--system-prompt-file <runDir>/system.md`
- `--permission-mode bypassPermissions`
- `--setting-sources user`
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
- `--disallowed-tools Task`
- optional `--model <model>`
- optional `--effort <effort>`

Role `tools` are ignored for Claude. Role `extensions` are rejected for Claude.

### Loom

Tango remains Loom-agnostic. Loom owns Loom-aware injection.

Loom changes:

- `loom spawn` / `loom dispatch` now include the Loom agent guide in the task prompt.
- Loom creates a run-local `loom` shim on `PATH` for spawned agents.
- Loom preserves `LOOM_HOME`, `LOOM_AGENT_ID`, `LOOM_DEFAULT`, and `LOOM_CONTEXT` for spawned agents.

## Verified Claude Code behavior

Local Claude Code:

- path: `/home/joe/.local/bin/claude`
- version: `2.1.119`

Verified:

- `--system-prompt-file` works.
- `--append-system-prompt-file` works.
- `--print --output-format stream-json` requires `--verbose`.
- Stream JSON final answer is available on final `type: "result"` event as `result`.
- Isolated `HOME` works with copied `~/.claude/.credentials.json` and trimmed `~/.claude.json`.
- `--bare` breaks OAuth auth on this host.
- Skills are discovered at `<HOME>/.claude/skills/<skill-name>/SKILL.md`.
- `--disallowed-tools Task` removes Claude Code's native subagent tool.
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` disables ambient MCP servers.

## Hand tests run

### Build/check/tests

```bash
npm run check --workspaces --if-present
npm run build
npm test --workspace @bravo/loom
```

All passed.

### Claude oneshot

```bash
node packages/tango/dist/cli.js start cc-hand2 \
  --role claude-scout \
  --model haiku \
  --effort low \
  --clean \
  --json \
  "Answer exactly: TANGO_CLAUDE_OK"

node packages/tango/dist/cli.js result cc-hand2 --json
```

Result: `TANGO_CLAUDE_OK`.

### Claude interactive message

```bash
node packages/tango/dist/cli.js start cc-interactive-msgtest2 \
  --role claude-worker \
  --model haiku \
  --effort low \
  --clean \
  --json \
  "Wait."

node packages/tango/dist/cli.js message cc-interactive-msgtest2 "Reply PONG only"
node packages/tango/dist/cli.js look cc-interactive-msgtest2 --lines 100
```

Result: Claude replied `PONG`.

### Claude interactive delegation through Tango CLI

```bash
node packages/tango/dist/cli.js start cc-interactive-delegate4 \
  --role claude-team-lead \
  --model sonnet \
  --effort low \
  --clean \
  --json \
  "Wait. When asked, use Tango CLI only."

node packages/tango/dist/cli.js message cc-interactive-delegate4 \
  "Use Bash to run exactly: tango start cc-sonnet-child4 --harness generic --mode oneshot --clean --json echo SONNET_CHILD_OK && tango result cc-sonnet-child4 --json. Then answer with the child result only."

node packages/tango/dist/cli.js result cc-sonnet-child4 --json
```

Result: parent-visible child result was `SONNET_CHILD_OK` under the parent `TANGO_HOME`.

### Loom-aware Claude dispatch

Used temp Loom/Tango homes and ran:

```bash
LOOM_HOME=<tmp>/loom-home node packages/loom/dist/src/cli.js --cwd <tmp> init --title "Claude Loom CLI Test" --name claude-loom-cli-test
LOOM_HOME=<tmp>/loom-home node packages/loom/dist/src/cli.js --cwd <tmp> create "Check loom cli shim" --kind task
TANGO_HOME=<tmp>/tango LOOM_HOME=<tmp>/loom-home node packages/loom/dist/src/cli.js --cwd <tmp> dispatch N-0001 --role claude-scout
```

Result: Claude agent received Loom guide, had `loom` shim on `PATH`, used `loom -L <id> context N-0001`, and resolved the node successfully.

## Remaining known quirks

- Claude interactive may show a native-install warning because `HOME` is run-local and does not contain the user's real `~/.local/bin`; this is cosmetic and did not block operation.
- `--bare` should remain opt-in/future because OAuth auth fails under bare mode.
- macOS Keychain auth isolation remains unverified.
