# Tango Claude Code Runtime Implementation Plan

Status: implemented in working tree
Date: 2026-04-25
Related: `design.md`

## Verified Claude Code behavior

Local version tested: Claude Code `2.1.119` at `/home/joe/.local/bin/claude`.

Findings:

- `--system-prompt-file` and `--append-system-prompt-file` work even though only prompt-string flags show in the main option list.
- `--print --output-format stream-json` requires `--verbose`.
- Stream JSON emits `system/init`, `assistant`, `rate_limit_event`, and final `result` events. The final text is reliably available as `event.result` on `type: "result"`.
- `HOME=<runDir>/home` works if Tango seeds Claude auth/config files.
- Copying only `~/.claude/.credentials.json` is enough for OAuth on this Linux host; copying a trimmed `~/.claude.json` with `oauthAccount` and onboarding/trust state smooths startup.
- `--bare` does not work with OAuth/keychain auth. It returns `Not logged in · Please run /login` unless API-key auth is configured.
- Claude discovers skills under `<HOME>/.claude/skills/<skill-name>/SKILL.md`.
- `--disallowed-tools Task` removes the Claude Code `Task` tool from the available tool list.
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` disables ambient MCP servers.
- `--setting-sources user` avoids project/local setting sources while preserving isolated user-home settings.
- Interactive Claude in Tango tmux works after seeding:
  - `~/.claude.json` with `hasCompletedOnboarding: true`
  - project trust entry for `cwd`
  - `~/.claude/settings.json` with `skipDangerousModePermissionPrompt: true`
- `tango message` should use tmux paste buffers plus `C-m`; raw `send-keys <long message> Enter` can leave long Claude prompts typed but not submitted.
- Child agents need `TANGO_HOME` preserved separately from isolated `HOME`; otherwise recursive `tango result <child>` resolves against the child home and parent cannot see the delegated run.
- Loom-aware injection belongs in Loom, not Tango. Loom now passes the Loom agent guide in task prompts and creates a run-local `loom` shim on `PATH` while preserving `LOOM_HOME`, `LOOM_DEFAULT`, and `LOOM_CONTEXT`.

Known quirk:

- Interactive Claude may show a native-install warning because HOME points at a run-local directory. It does not block operation.

## Implementation decisions

- Add `harness: claude` role support.
- Use Claude Code CLI directly, no Pi extension/tools.
- Use `--system-prompt-file <runDir>/system.md`.
- For oneshot use:

  ```bash
  claude --print --verbose --output-format stream-json --no-session-persistence ...
  ```

- For interactive omit print flags and let Tango own tmux.
- Always pass:
  - `--permission-mode bypassPermissions`
  - `--setting-sources user`
  - `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
  - `--disallowed-tools Task`
- Ignore role `tools` for Claude for now. Do not map Pi tools to Claude tools.
- Support role/CLI `model` and `effort`.
- Copy role `skills` directories into `<runDir>/home/.claude/skills/<skill-name>/`.
- Add harness-aware result parsing with `resultParser: "claude-stream-json"`.

## Files changed

- `packages/tango/src/harnesses/claude.ts` — Claude command construction, auth/home seeding, skill copy.
- `packages/tango/src/types.ts` — `effort`, `resultParser`.
- `packages/tango/src/roles.ts` — parse `effort`.
- `packages/tango/src/start.ts` — dispatch Claude harness and parse Claude stream JSON.
- `packages/tango/src/cli.ts` — `--effort` flag and help/role metadata.
- `packages/tango/roles/claude-*.md` — default Claude roles.
- `docs/specs/tango-claude-code-runtime/design.md` — update decisions/findings.
- `packages/tango/README.md` — document basic Claude use.

## Hand-test checklist

- `npm run check --workspace @bravo/tango`
- `npm run build --workspace @bravo/tango`
- Dry-run:

  ```bash
  tango start cc-dry --role claude-scout --model haiku --effort low --dry-run --json "Say OK"
  ```

- Oneshot:

  ```bash
  tango start cc-hand --role claude-scout --model haiku --effort low --clean "Answer exactly: TANGO_CLAUDE_OK"
  tango result cc-hand
  ```

- Skill copy dry-run with path skill.
- Interactive:

  ```bash
  tango start cc-interactive-hand --role claude-worker --model haiku --effort low --clean "Answer OK and wait"
  tango message cc-interactive-hand "Reply PONG only"
  tango look cc-interactive-hand
  tango stop cc-interactive-hand
  ```

- Interactive delegation with Sonnet:

  ```bash
  tango start cc-interactive-delegate --role claude-team-lead --model sonnet --effort low --clean "Wait. When asked, use Tango CLI only."
  tango message cc-interactive-delegate "Use Bash to run exactly: tango start cc-sonnet-child --harness generic --mode oneshot --clean --json echo SONNET_CHILD_OK && tango result cc-sonnet-child --json. Then answer with the child result only."
  tango result cc-sonnet-child
  ```

- Loom-aware dispatch, owned by Loom:

  ```bash
  loom dispatch N-0001 --role claude-scout
  ```

  Verified child receives Loom guide in task prompt and has a `loom` shim on `PATH`.
