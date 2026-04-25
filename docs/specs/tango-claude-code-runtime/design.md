# Tango Claude Code Runtime Design

Status: implemented
Date: 2026-04-25
Related: `docs/specs/tango-v1/design.md`, `docs/specs/tango-v1/design-v1.1.md`

## Summary

Add a `claude` Tango harness that launches Claude Code CLI agents under the existing Tango native/tmux runtime.

The integration should preserve Tango's core invariant:

> Tango CLI owns orchestration. Harnesses only adapt a specific agent CLI to Tango's run directory, metadata, prompt, env, and tmux conventions.

The Claude Code harness should support the practical controls users expect from Tango roles:

- Claude model selection.
- Explicit system prompt / role prompt injection.
- Claude reasoning effort.
- Default Claude Code tools left enabled, with optional future restrictive overrides.
- Explicit Claude Code skills where supported.
- Isolated per-agent home/config state.
- Recursive Tango delegation through the CLI, not through Claude Code-specific tools or extensions.

Pi-specific concepts such as Pi tools and Pi extensions do not apply to Claude Code agents. A recursive Claude Code agent should receive the shared Tango CLI orchestration prompt and use `tango ... --json` commands directly.

## Current Tango Context

Relevant current implementation:

- `packages/tango/src/start.ts` chooses a harness and writes:
  - `system.md`
  - `task.md`
  - `command.json`
  - metadata under the agent run directory.
- `packages/tango/src/harnesses/pi.ts` implements the first harness adapter.
- `packages/tango/src/harnesses/generic.ts` implements a minimal shell fallback.
- `packages/tango/src/roles.ts` assembles role bodies and includes into one system prompt.
- `packages/tango/src/runtime/tmux.ts` launches interactive agents under a per-agent tmux socket.
- `packages/tango/src/types.ts` already has role fields useful for Claude:
  - `harness`
  - `model`
  - `tools`
  - `skills`
  - `includes`
  - `recursive`
  - `orchestration`

The first implementation should add a new harness file rather than changing the orchestration model:

```txt
packages/tango/src/harnesses/claude.ts
```

Then `start.ts` dispatches:

```ts
if (harness === "generic") command = buildGenericCommand(...)
else if (harness === "claude") command = buildClaudeCommand(...)
else command = buildPiCommand(...)
```

## Goals

- Add `harness: claude` role support.
- Launch Claude Code in both `oneshot` and `interactive` modes.
- Keep each child agent's Claude home/config isolated under the Tango run directory.
- Allow role-level model and effort selection.
- Allow role-level prompt control without relying on ambient project `CLAUDE.md`.
- Leave Claude Code's default tool set enabled by default.
- Support recursive delegation with the existing Tango CLI instructions.
- Keep implementation CLI-first and testable with `tango start --dry-run --json`.

## Non-goals

- Do not implement Claude Code as a Pi extension.
- Do not expose Tango Pi tools to Claude Code agents.
- Do not try to make Pi extensions, Pi prompt templates, or Pi skills work in Claude Code.
- Do not build an in-process Claude SDK agent runner.
- Do not depend on Docker/container isolation.
- Do not make project `CLAUDE.md` discovery part of Tango's prompt contract.
- Do not silently copy all host Claude Code configuration into child agents.

## Claude Code CLI Capabilities Observed

Local `claude --help` reports these relevant flags:

```txt
-p, --print                         non-interactive output
--output-format <format>            text | json | stream-json; only with --print
--input-format <format>             text | stream-json; only with --print
--model <model>                     alias or full model name
--effort <level>                    low | medium | high | xhigh | max
--system-prompt <prompt>            system prompt to use for the session
--append-system-prompt <prompt>     append to default system prompt
--bare                              minimal mode; skips CLAUDE.md auto-discovery, hooks,
                                    plugin sync, auto-memory, keychain reads, etc.
--tools <tools...>                  built-in tool set, e.g. Bash,Edit,Read
--allowed-tools <tools...>          allowlist tool patterns
--disallowed-tools <tools...>       denylist tool patterns
--disable-slash-commands            disable all skills
--add-dir <directories...>          additional directories to allow tool access to
--settings <file-or-json>           additional settings JSON
--setting-sources <sources>         user, project, local
--no-session-persistence            only with --print
--permission-mode <mode>            acceptEdits | auto | bypassPermissions | default | dontAsk | plan
--dangerously-skip-permissions      bypass all permission checks
--name <name>                       display name
--continue / --resume               continue/resume sessions
```

The help text mentions `--system-prompt[-file]` and `--append-system-prompt[-file]`, but only `--system-prompt` and `--append-system-prompt` appeared in the option list. Phase 0 verified that `--system-prompt-file` and `--append-system-prompt-file` both work. Tango uses `--system-prompt-file` to avoid OS argument length limits.

## Role Schema

### Existing fields reused

A Claude role can use existing frontmatter fields:

```md
---
name: claude-scout
description: Scout using Claude Code
harness: claude
mode: oneshot
model: sonnet
skills: []
includes: [handoff-format]
recursive: false
---

You are a scout. Return concise findings with file paths and line references.
```

`model` maps to `claude --model`.

`tools` is ignored for Claude roles in the initial implementation. Do not set it in default roles. Tango does not map Pi tools to Claude Code tools.

`skills` should mean Claude Code skills for `harness: claude`, not Pi skills.

`includes`, `recursive`, and `orchestration` continue to be handled by Tango prompt assembly. Since the harness is not Pi, recursive Claude roles should receive:

```txt
orchestration-core + orchestration-cli + status-protocol
```

not `orchestration-pi-tools`.

### New field: effort

Add an optional role field:

```ts
effort?: "low" | "medium" | "high" | "xhigh" | "max" | string;
```

Example:

```md
---
name: claude-planner
harness: claude
model: opus
effort: high
---
```

This maps to:

```bash
claude --effort high
```

Keep the TypeScript type permissive enough to tolerate future Claude Code values, but validate known values in docs/tests.

### Optional future fields

These should be deferred unless immediately needed:

```ts
claude?: {
  bare?: boolean;
  permissionMode?: "bypassPermissions";
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  settingSources?: string[];
  settings?: Record<string, unknown> | string;
  maxBudgetUsd?: string;
  fallbackModel?: string;
}
```

For the first implementation, prefer flat fields only when they are broadly useful. Avoid turning role frontmatter into a full Claude Code settings schema too early.

## Prompt Strategy

Tango already assembles a role system prompt and writes it to:

```txt
<runDir>/system.md
```

The Claude harness should use that assembled content as Claude's system prompt.

Required default:

```bash
claude --system-prompt-file <runDir>/system.md ...
```

Use `--system-prompt-file`, not `--append-system-prompt-file`. Claude Code still retains Anthropic's non-removable base/safety system instructions; this flag replaces the user/project-level system prompt layer that Tango intends to own. In practice this should primarily avoid ambient instructions such as a discovered `CLAUDE.md`, while keeping Claude Code's built-in safety/runtime behavior intact.

Do not add a `promptMode: append` option in the first implementation. Appending would make child-agent behavior depend on ambient Claude Code defaults and project memory in ways Tango is trying to avoid.

### Avoid ambient `CLAUDE.md`

The safest prompt isolation mode is Claude Code `--bare`, because the help text says it skips `CLAUDE.md` auto-discovery, hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, and keychain reads.

However, `--bare` also changes auth behavior:

- Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`.
- OAuth and keychain are never read.
- Third-party providers such as Bedrock/Vertex use their own credentials.

Therefore the first implementation should not use `--bare` by default. The desired auth path is Claude Code's normal OAuth/auth JSON flow, not API-key-only auth.

Default isolation is:

```txt
isolation mode: home
```

The harness must set `HOME=<runDir>/home`, seed only the needed Claude auth/config files, and then launch Claude Code with `--system-prompt-file`. A future strict mode can add `--bare`, but it must be opt-in because it disables OAuth/keychain auth paths.

## Command Construction

### Common args

For both modes:

```bash
claude \
  --no-chrome \
  --name <agent-name> \
  --permission-mode bypassPermissions \
  --setting-sources user \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --disallowed-tools Task \
  --model <role.model> \
  --effort <role.effort> \
  --system-prompt-file <runDir>/system.md \
  -- \
  <task>
```

Only include optional flags when the role sets them, except `--permission-mode bypassPermissions`, which is always included for the Claude harness.

Do not pass `--tools` by default. Claude Code should keep its normal default tool set unless a specialized future role explicitly requests a restrictive tool override.

### Oneshot mode

For `mode: oneshot`, use print mode with Claude stream JSON and implement the parser immediately:

```bash
claude \
  --print \
  --verbose \
  --output-format stream-json \
  --no-session-persistence \
  ... \
  "Task: ..."
```

Tango's existing `runOneshot()` is Pi-shaped: it looks for Pi-style `message_end` events. Claude stream JSON has a different event schema, so the first Claude implementation must add harness-aware result extraction.

Required design change:

```ts
interface CommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  resultParser?: "pi-json" | "claude-stream-json" | "plain";
}
```

`buildPiCommand()` should set or imply `resultParser: "pi-json"`.

`buildClaudeCommand()` should set:

```ts
resultParser: "claude-stream-json"
```

The Claude parser should:

- write raw stream JSON lines to `events.jsonl`, as Pi does;
- preserve stdout in `output.log`;
- extract the final assistant text into `result.md`;
- tolerate unknown event types;
- fall back to useful plain output if final-text extraction fails.

Phase 0 captured real Claude `stream-json` output. `--verbose` is required with `--output-format stream-json`. The final answer is available on the final `type: "result"` event as `result`; assistant text also appears in `type: "assistant"` events.

### Interactive mode

For `mode: interactive`, omit `--print` and let Tango's tmux runtime own the session:

```bash
claude ... "Task: ..."
```

Tango already wraps the command in a per-agent tmux socket/session via `startTmux()`.

Avoid Claude Code's own `--tmux` flag. Tango is the tmux runtime; nested tmux would make `tango look`, `tango message`, `tango attach`, and `tango stop` less predictable.

## Environment and Home Isolation

The Claude harness should follow the same base env shape as the Pi harness:

```ts
env = {
  ...process.env,
  HOME: meta.homeDir,
  TANGO_AGENT_NAME: meta.name,
  TANGO_RUN_DIR: meta.runDir,
  TANGO_PARENT_RUN_DIR: meta.parentRunDir,
}
```

But it should not set `PI_CODING_AGENT_DIR`.

Add Claude-specific isolation paths under `meta.homeDir`:

```txt
<runDir>/home/.claude/
<runDir>/home/.config/claude-code/       # only if Claude uses XDG config in practice
<runDir>/home/.cache/claude-code/        # only if needed
```

Questions to verify during implementation:

- Does Claude Code respect only `HOME`, or also `XDG_CONFIG_HOME` / `XDG_CACHE_HOME`?
- Does Claude Code have a `CLAUDE_CONFIG_DIR` or similar env var? No such flag was visible in `claude --help`.
- Does `--setting-sources user` prevent project/local settings while preserving user settings under isolated `HOME`?

### Auth seeding

Do not use API-key auth as the primary path. The desired behavior is to mirror the local Claude Code OAuth/auth JSON setup, similar to the local `ccswitch` helper.

Observed `ccswitch` behavior from `/home/joe/.local/bin/ccswitch`:

- It chooses the Claude config path with this priority:
  1. `$HOME/.claude/.claude.json` if it exists and contains `.oauthAccount`.
  2. `$HOME/.claude.json` otherwise.
- On Linux/WSL, it reads credentials from:

  ```txt
  $HOME/.claude/.credentials.json
  ```

- On macOS, it reads credentials from the Keychain service:

  ```txt
  Claude Code-credentials
  ```

- Managed accounts are backed up under:

  ```txt
  $HOME/.claude-switch-backup/configs/.claude-config-<num>-<email>.json
  $HOME/.claude-switch-backup/credentials/.claude-credentials-<num>-<email>.json
  ```

- Switching writes the target credentials back to `$HOME/.claude/.credentials.json` on Linux/WSL and merges the target `.oauthAccount` into the selected Claude config JSON.

Tango should use the same file-level idea, but without mutating the operator's real home. Before launch, with the operator's real home still available to the parent process, seed the child home:

```txt
<real-home>/.claude/.credentials.json      -> <runDir>/home/.claude/.credentials.json
trimmed Claude config                       -> <runDir>/home/.claude.json
```

The important auth/config data is the OAuth account JSON plus the credentials JSON. Do not copy the entire `~/.claude` directory.

The trimmed config includes only startup/auth/UX fields needed for seamless non-interactive and interactive runs: `oauthAccount`, theme, onboarding completion, tips history, and a project trust entry for the run `cwd`. Tango also writes `<runDir>/home/.claude/settings.json` with bypass-permission prompt suppression.

Open macOS question: ccswitch uses Keychain for credentials. Tango's per-agent `HOME` isolation cannot isolate Keychain state by itself. Options to verify later:

1. Prefer a file credentials export into `<runDir>/home/.claude/.credentials.json` if Claude Code accepts it on macOS.
2. If Claude Code insists on Keychain on macOS, document that Claude Tango auth isolation is Linux/WSL-first or add a macOS-specific credential export/import strategy.

Redaction must include Claude auth variables and copied auth file paths in `command.json`/logs:

- `ANTHROPIC_API_KEY`, if present incidentally.
- `CLAUDE_CODE_OAUTH_TOKEN`, if present incidentally.
- anything matching existing `TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH` redaction.

## Skills

Tango `skills` are harness-specific.

For `harness: pi`, skills resolve to Pi `SKILL.md` files and are passed with Pi's `--skill` CLI flag.

For `harness: claude`, skills should be materialized into the isolated Claude home, not passed as a Claude CLI argument. A role's `skills` list means: resolve each named skill from Tango/user/package skill locations and copy it into the child agent's Claude Code skill directory before launching `claude`.

Target layout:

```txt
<runDir>/home/.claude/skills/<skill-name>/...
```

Expected role usage:

```yaml
skills: [review, test-runner]
```

Expected launch preparation:

```txt
~/.tango/skills/review/        -> <runDir>/home/.claude/skills/review/
~/.tango/skills/test-runner/   -> <runDir>/home/.claude/skills/test-runner/
```

or, for package-provided skills:

```txt
packages/tango/skills/review/  -> <runDir>/home/.claude/skills/review/
```

No `claude --skill ...` flag should be used.

Claude Code help indicates:

- `--disable-slash-commands` disables all skills.
- In `--bare`, skills still resolve via `/skill-name`.

This fits the copy-into-home model: because Tango sets `HOME=<runDir>/home`, Claude Code should discover only the copied skills in `<runDir>/home/.claude/skills` plus any project-local skill mechanisms that remain enabled by the chosen isolation mode.

### Skill source resolution

The Claude harness should support the same name resolution style as the Pi harness, but copy directories instead of passing file paths:

1. An explicit path, if `skills` entry is a path.
2. User Tango skill directory, e.g. `~/.tango/skills/<name>/`.
3. Package Tango skill directory, e.g. `packages/tango/skills/<name>/`.
4. Optionally a single-file skill path if Claude Code supports file-based skills; otherwise reject it with a clear error.

For Claude Code, directory-form skills are preferred. The copied directory should preserve all files below the source skill directory.

### Skill compatibility

Do not assume Pi skills and Claude Code skills are automatically compatible. The initial implementation should treat skills as opaque directories and copy them. If a copied skill is malformed for Claude Code, Claude Code should surface that error or ignore it according to its own behavior.

Future package convention:

```txt
skills/<name>/
  SKILL.md                 # optional portable human-readable source
  claude/                  # optional Claude-native skill directory
  pi/SKILL.md              # optional Pi-native skill entrypoint
```

Resolution rule for future multi-harness skills:

- If `skills/<name>/claude/` exists, copy that directory to `.claude/skills/<name>/`.
- Otherwise copy `skills/<name>/` as-is and rely on it being Claude-compatible.

### Empty skills

If a Claude role declares no skills and strict isolation is desired, the harness may pass:

```bash
--disable-slash-commands
```

This should be controlled by a future isolation/strictness setting, not forced globally. Some users may want installed Claude Code skills in their copied/seeded home, while others want a fully closed skill set.

## Tools

Do not configure Claude Code tools from role `tools` by default.

The Claude harness omits `--tools` and `--allowed-tools`. It always passes `--disallowed-tools Task` so Claude-native subagents are disabled and recursive work stays observable through Tango. Claude Code's other default tools remain enabled because the harness uses bypass permissions and run-local home/config isolation.

### Claude-native subagents

No dedicated `claude --no-agents` / `--no-subagents` flag was visible in local `claude --help` or `claude agents --help`.

Claude Code's normal subagent mechanism appears to be exposed through its built-in `Task` tool and configured/background agents. If Tango needs to prevent Claude-native delegation while keeping Tango delegation available, the likely control is a tool restriction such as:

```bash
claude --disallowed-tools Task ...
```

or, more restrictively, an explicit `--tools` list that omits `Task`. This requires verification against the installed Claude Code version because the exact built-in tool name and semantics are CLI-version-specific.

Default decision: disable Claude-native subagents by passing `--disallowed-tools Task`. Tango recursive roles should use Tango CLI delegation for observable/scoped child agents.

Guidance for phase 1:

- Default roles do not declare `tools`.
- If a Claude role declares `tools`, Tango ignores it for now.
- Do not map Pi tool names to Claude Code tool names.

Possible future restrictive-tool design:

- `tools` maps to `--tools` for a full built-in tool set override.
- `allowedTools` maps to `--allowed-tools` for permission/pattern rules.
- `disallowedTools` maps to `--disallowed-tools`.

But this is explicitly not part of the initial implementation.

## Extensions and prompt templates

Claude Code agents do not support Pi extensions or Pi prompt templates.

If a role sets `extensions` and `harness: claude`, the first implementation should either:

1. Warn and ignore them in dry-run/command metadata, or
2. Throw a clear error.

Recommendation: throw by default. Silent ignore makes role behavior surprising.

```txt
Role claude-worker uses harness=claude but declares extensions. Pi extensions are only supported by harness=pi.
```

## Recursive delegation

Recursive Claude Code agents should use Tango CLI, not Pi tools.

Role example:

```md
---
name: claude-team-lead
harness: claude
mode: interactive
model: opus
effort: high
recursive: true
orchestration: cli
---

You coordinate child agents through the Tango CLI.
```

`roles.ts` already does the correct thing for non-Pi recursive roles under `orchestration: auto`: it includes CLI orchestration instructions, not Pi tool instructions.

The Claude harness only needs to ensure the child process gets:

```txt
TANGO_AGENT_NAME
TANGO_RUN_DIR
TANGO_PARENT_RUN_DIR
PATH containing tango
TANGO_HOME pointing at the parent Tango data root, because HOME is run-local
```

## Example role files

### Claude scout

```md
---
name: claude-scout
description: Fast repository reconnaissance using Claude Code
harness: claude
mode: oneshot
model: haiku
effort: low
includes: [handoff-format]
recursive: false
---

You are a scout. Inspect only what is needed and report concise findings with file paths.
```

### Claude worker

```md
---
name: claude-worker
description: Bounded implementation using Claude Code
harness: claude
mode: interactive
model: sonnet
effort: medium
recursive: false
---

You implement bounded code changes. Prefer small diffs and run focused checks.
```

### Claude team lead

```md
---
name: claude-team-lead
description: Claude Code coordinator that delegates through Tango CLI
harness: claude
mode: interactive
model: opus
effort: high
recursive: true
orchestration: cli
allowedChildRoles: [claude-scout, claude-worker, reviewer]
---

You coordinate work by starting focused Tango child agents and synthesizing their findings.
```

## Implementation Plan

### Phase 0: CLI behavior capture

Status: complete. See `plan.md` for captured findings.

Before coding, capture the installed Claude Code behavior:

```bash
claude --help
claude --print --output-format text "say ok"
claude --print --output-format json "say ok"
claude --print --verbose --output-format stream-json "say ok"
claude --print --verbose --output-format stream-json --system-prompt "You are terse" "say ok"
claude --bare --print --verbose --output-format stream-json --system-prompt "You are terse" "say ok"
```

Record:

- Which flags are accepted.
- Whether `--system-prompt-file` exists.
- JSON/stream-json schema.
- Whether `--bare` can operate with the intended auth mode.
- Where Claude writes state when `HOME` points to a temp dir.

### Phase 1: minimal harness

- Add `packages/tango/src/harnesses/claude.ts`.
- Set `HOME=meta.homeDir`.
- Seed minimal Claude auth/config into the run-local home.
- Build `claude` command for stream-json oneshot and interactive modes.
- Add `effort` to `RoleConfig` and frontmatter parsing.
- Resolve `role.skills` and copy Claude-compatible skill directories to `<runDir>/home/.claude/skills/<name>/` before launch.
- Dispatch `harness === "claude"` in `start.ts`.
- Add `claude` roles and dry-run/manual examples.

### Phase 2: status polish and hardening

- Redact Claude auth in `command.json`.
- Improve errors when unsupported fields are present.
- Add tests for Claude stream-json parser fixtures.

### Phase 3: stricter isolation

- Add role/global setting for `bare` mode.
- Add run-local settings JSON support.
- Add minimal auth-file seeding if needed.
- Decide whether to set `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` to run-local directories.

### Phase 4: Claude skills polish

- Verify Claude Code skill layout and document the exact expected files.
- Add multi-harness skill packaging conventions, e.g. optional `skills/<name>/claude/` subdirectories.
- Add diagnostics for missing or malformed copied skills.

## Acceptance Criteria

A minimal integration is successful when:

```bash
tango start cc-scout --harness claude --role claude-scout --dry-run --json "Summarize this repo"
```

returns a command containing:

- `command: "claude"`
- `HOME` under the Tango run directory
- `TANGO_AGENT_NAME`
- `TANGO_RUN_DIR`
- `--print` for oneshot mode
- `--model` when the role has `model`
- `--effort` when the role has `effort`
- `--system-prompt-file`
- `--permission-mode bypassPermissions`
- no `--tools` flag for default roles
- copied skill directories under `<runDir>/home/.claude/skills/<name>/` when the role has `skills`

And:

```bash
tango start cc-scout --harness claude --role claude-scout "Summarize this repo"
tango result cc-scout
```

returns the final Claude response in `result.md`.

For interactive mode:

```bash
tango start cc-worker --harness claude --role claude-worker --mode interactive "Make a small change"
tango look cc-worker
tango message cc-worker "continue"
tango attach cc-worker
```

should operate through Tango's tmux socket without nested tmux.

## Risks and Open Questions

- `--bare` is attractive for prompt isolation but may break OAuth/keychain-based Claude Code auth.
- Passing large system prompts as a CLI argument may hit OS arg length limits; verify file-form system prompt flags or use a generated wrapper script if needed.
- Claude stream JSON schema differs from Pi's JSON stream; Tango needs harness-aware result parsing.
- Tool names and semantics differ from Pi; role authors must use Claude Code tool names for Claude roles.
- Claude Code skill layout and portability need verification.
- Claude Code may still load project settings or memory unless `--bare` or setting-source controls are used.
- Native/tmux isolation is not a security sandbox. A Claude Code child process can access host files permitted to the current OS user.
