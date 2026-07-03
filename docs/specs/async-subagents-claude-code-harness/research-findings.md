# Research and Hand-Test Findings

Date: 2026-06-30
Environment: Claude Code `2.1.197`, tmux `3.4`

Reusable probes live in [`handtests/`](./handtests/).

## Tango extraction candidates

Extract or reuse:

- `packages/tango/src/runtime/tmux.ts`
  - `startTmux`, `captureTmux`, `sendTmux`, `stopTmux`, `tmuxAlive`.
  - Uses run-local socket, `load-buffer` + `paste-buffer` + delayed `C-m`.
- `packages/tango/src/harnesses/claude.ts`
  - command-builder basics: `--no-chrome`, `--name`, `--strict-mcp-config`, `--mcp-config`, `--disallowed-tools Task`, `--system-prompt-file`, model/effort handling, isolated HOME scaffolding.
  - settings basics: `permissions.defaultMode=bypassPermissions`, `skipDangerousModePermissionPrompt=true`, project trust/onboarding config.
- `packages/tango/src/skillResolver.ts`
  - already supports Claude skill dirs and Pi-style skill discovery (`.agents/skills/<name>`, `.pi/skills`, package skill entries).

Do **not** copy blindly:

- Tango's Bash wrapper restores real operator `HOME`; async-subagents Claude harness should not do that for Bash subprocesses unless explicitly accepted as trusted-dangerous behavior.
- Tango copies raw Claude credentials into run-local home; async-subagents should first hand-test the minimum non-bare OAuth/Max auth material needed, avoid copying ambient memory/config, and redact any copied/symlinked credential state.

## Hive behavior worth copying

Observed in `/tmp/hive-inspect/Hive`:

- synthetic HOME per agent;
- `.claude/CLAUDE.md` role contract;
- `.claude/settings.json` with MCP server and permissions;
- `skipDangerousModePermissionPrompt` / all-tool allow style;
- PTY prompt injection via bracketed paste + delayed Enter;
- liveness/telemetry lessons: PID/PTY alone are not enough.

Hive currently symlinks credentials from real HOME and injects project/extra MCP servers. That is useful prior art but not the desired async-subagents v1 safety posture.

## Claude CLI findings

`claude --help` confirms:

- `--dangerously-skip-permissions` bypasses all permission checks.
- `--allow-dangerously-skip-permissions` enables bypass as an option without making it default.
- `--permission-mode` accepts `bypassPermissions`, but the stronger no-prompt startup path for our default should use `--dangerously-skip-permissions` plus generated settings.
- `--bare` skips hooks, LSP, plugin sync, attribution, **auto-memory**, background prefetches, keychain reads, and `CLAUDE.md` auto-discovery. It sets `CLAUDE_CODE_SIMPLE=1`.
- `--bare` still supports skills via `/skill-name`.
- `--bare` auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`; OAuth/keychain are not read.
- `--mcp-config` accepts JSON files or JSON strings.
- `--strict-mcp-config` ignores other MCP configurations.
- `--system-prompt-file` is supported.

Hand-test result: normal/OAuth works; `--bare` failed locally with `Not logged in · Please run /login` because this machine uses Claude Max/OAuth and has no `ANTHROPIC_API_KEY` env.

## MCP hand-test findings

Probe: `handtests/run-mcp-handtest.sh`.

Results:

- file-path `--mcp-config` works;
- inline JSON `--mcp-config` works;
- Claude Code starts the server and sends newline-delimited JSON-RPC over stdio;
- Content-Length response framing did not work for the toy server;
- newline-delimited responses worked;
- observed protocol version from client: `2025-11-25`;
- sequence observed:
  - `initialize`;
  - `notifications/initialized`;
  - `tools/list`;
  - `tools/call` with `_meta.claudecode/toolUseId` and `progressToken`;
- tool exposed to model as `mcp__handtest__sentinel`;
- sentinel result returned successfully for both config forms.

Spec implication: async-subagents MCP server should support newline-delimited JSON-RPC for Claude Code 2.1.197. Content-Length support may be optional for portability, but line framing is required.

## Skill hand-test findings

Probe: `handtests/run-skill-probe.sh`.

Setup:

```text
<temp-home>/.claude/skills/handtest-skill/SKILL.md
```

Prompt invoked `/handtest-skill`.

Result: Claude returned `SKILL_SENTINEL_OK`.

Spec implication: Claude is compatible with Pi-style skill directories containing `SKILL.md`, at least for this local Claude Code version. V1 can resolve Pi skill directories directly into run-local `.claude/skills/<name>/SKILL.md` instead of requiring a `claude/` subdir, while still recording compatibility/provenance and rejecting executable/path-unsafe content.

## Model probe findings

Probe: `handtests/run-model-probe.sh`.

Accepted by CLI budget gate:

- `sonnet`
- `claude-sonnet-5`
- `opus`
- `claude-opus-4-5`
- `claude-opus-4-5-20251101`
- `claude-opus-4-8`

Rejected locally:

- `claude-opus-4.8`
- `opus-4.8`
- `sonnet-5`
- `fable` currently unavailable

Spec implication: target Sonnet 5 as `claude-sonnet-5`; target Opus as `claude-opus-4-8`. Keep model strings configurable and validate with a preflight budget-gated model probe because Claude Code aliases change over time.

## Tmux prompt injection findings

Probe: `handtests/run-tmux-claude-injection.sh`.

- Claude interactive starts cleanly under tmux with `--dangerously-skip-permissions` and shows bypass permissions on.
- Tango-style `load-buffer` + `paste-buffer` + delayed `C-m` reaches the Claude TUI.
- Bracketed-paste style also reaches the TUI.
- Claude treated adversarial “Reply X only” test prompts as prompt-injection attempts, but the transport path worked.

Spec implication: production nudges should be clearly framed as harness/runtime control-plane instructions, not arbitrary user-task instructions. The durable message body should remain in MCP inbox, with the terminal nudge only telling Claude to read/ack the inbox.

## Decisions for spec update

- Extract Tango tmux runtime and parts of Claude command/home scaffolding.
- Use `--dangerously-skip-permissions` by default for Claude variants.
- Generate settings with `permissions.defaultMode=bypassPermissions` and `skipDangerousModePermissionPrompt=true` to bypass dangerous-mode prompt.
- Do not use `--bare` for v1 built-in/default Claude variants; normal Claude auth is required.
- Record memory isolation as best-effort non-bare. `--bare` remains documentary proof of the strict memory-disable tradeoff but is not a v1 launch mode because normal Claude auth is required.
- Prevent ambient memory/config by not copying `CLAUDE.md`, hooks, plugins, ambient skills, or ambient MCP config into run homes unless explicitly configured and recorded.
- Treat Pi-style `SKILL.md` skill directories as Claude-compatible by default when copied into `.claude/skills/<name>/`.
- Use newline-delimited JSON-RPC in the MCP server; test file and inline `--mcp-config`.
- Default target models: `claude-sonnet-5` and `claude-opus-4-8`.
