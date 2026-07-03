# Claude Runtime: Launch, Home, Permissions, Memory, and Shell Boundary

This module defines how async-subagents launches Claude Code as a trusted, authenticated, observable child process.

## Runtime posture

V1 Claude variants are **trusted local dangerous-mode children using normal Claude Code auth**.

Do not describe Claude Code permission settings as a hard security boundary. The default is intentionally autonomous:

- do **not** pass `--bare` in normal v1 launches;
- use the installed Claude Code auth path (OAuth/Claude Max/keychain/file auth as supported by the local CLI);
- pass `--dangerously-skip-permissions`;
- generate settings with `permissions.defaultMode = "bypassPermissions"`;
- generate settings with `skipDangerousModePermissionPrompt = true`;
- record this in catalog/status/result as `executionMode: "dangerous-auth"`.

Safety work moves to:

- deterministic launch artifacts;
- strict MCP config;
- no copied ambient project files unless explicitly requested;
- run-file contracts and MCP lifecycle;
- redaction;
- explicit trusted-child operator posture.

Future sandboxed modes can be added later, but v1 should not pretend they exist.

## Memory and auth decision

Claude Code `--bare` is the documented memory-disabled path: local `claude --help` for 2.1.197 says `--bare` skips hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and `CLAUDE.md` auto-discovery, while skills still resolve via `/skill-name`.

However, `--bare` also refuses the normal local OAuth/Claude Max/keychain auth path:

- `--bare` requires `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`;
- OAuth and keychain are never read;
- on this machine, `--bare` failed with `Not logged in · Please run /login` because the operator uses Claude Max/OAuth and has no API-key/helper auth configured.

Therefore v1 default is **not bare**. It prioritizes using the operator's working Claude auth over strict memory-disable semantics.

Memory posture for default `dangerous-auth`:

- best-effort memory minimization, not a guarantee;
- do not copy project `CLAUDE.md` files into the run home;
- do not pass `--add-dir` for memory discovery unless explicitly required;
- use generated `--system-prompt-file` and task artifact files for all intended context;
- use `--strict-mcp-config` so ambient MCP servers are not loaded;
- use generated settings and controlled setting sources;
- record `memoryIsolation: "best-effort-non-bare"` in launch metadata.

There is no v1 `--bare` launch mode. If strict memory disable becomes necessary later, it requires a separate design around API-key/helper auth and should not be smuggled into the normal-auth harness.

## Launch artifacts

Before spawn, write task/prompt artifacts under the run directory:

```text
<runDir>/artifacts/system.md      # role + Claude child runtime contract
<runDir>/artifacts/task.md        # full user task, files, attachments, run metadata
<runDir>/artifacts/mcp.json       # generated strict MCP config
<runDir>/artifacts/settings.json  # generated session settings passed via --settings
```

The full task text must never be placed on the Claude command line. The CLI prompt is a constant bounded string such as `Begin the assigned async-subagents task.` Long or sensitive task text lives only in artifacts/logically redacted files.

## Target models

Default model targets:

- Sonnet lane: `claude-sonnet-5`.
- Opus lane: `claude-opus-4-8`.

Local probes on Claude Code 2.1.197 confirmed both `claude-sonnet-5` and `claude-opus-4-8` pass CLI/model validation and reach the budget gate. Keep model strings configurable and preflight them because Claude Code aliases change over time.

## Launch modes

### Oneshot

Oneshot is for cheap scouts, parity tests, non-interactive review lanes, and command/parser validation.

Oneshot v1 does **not** expose async-subagents child-control MCP. Result ownership belongs to the supervisor stream-json parser. The generated strict MCP config is empty to suppress ambient MCP servers.

Launch shape:

```sh
claude \
  --print \
  --verbose \
  --output-format stream-json \
  --no-session-persistence \
  --no-chrome \
  --name <display-name> \
  --dangerously-skip-permissions \
  --settings <runDir>/artifacts/settings.json \
  --setting-sources user \
  --strict-mcp-config --mcp-config <generated-empty-mcp-config> \
  --disallowed-tools Task \
  --model <model> \
  --effort <effort> \
  --system-prompt-file <runDir>/artifacts/system.md \
  -- \
  "Begin the assigned async-subagents task."
```

The supervisor parses stream-json and writes `result.json`. Oneshot does not support live inbox delivery after launch. If a future oneshot mode enables child-control MCP, it must define terminal-result precedence between stream-json and `subagent_complete` and add race tests first.

### Interactive

Interactive is the default for `harness: "claude"` variants in v1.

V1 uses a tmux-backed transport extracted from Tango's tmux runtime. Do not add a second transport until tmux behavior is reliable and tested.

Interactive v1 exposes the async-subagents child-control MCP server. Terminal result ownership belongs to `subagent_complete`; supervisor process exit writes failure/cancel only if no MCP terminal result exists.

Launch shape:

```sh
claude \
  --no-chrome \
  --name <display-name> \
  --dangerously-skip-permissions \
  --settings <runDir>/artifacts/settings.json \
  --setting-sources user \
  --strict-mcp-config --mcp-config <generated-child-control-mcp-config> \
  --disallowed-tools Task \
  --model <model> \
  --effort <effort> \
  --system-prompt-file <runDir>/artifacts/system.md \
  -- \
  "Begin the assigned async-subagents task."
```

Interactive completion boundary:

- Claude must call `subagent_complete(summary, body?, outcome?)` through the package MCP server.
- The MCP server writes the terminal result through the normal terminal finalizer.
- After terminal result, the supervisor cleans up tmux session, Claude process group, and MCP helpers.
- `idle` is non-terminal liveness, not completion.

## Generated settings

Generated session settings include:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "mcp__async_subagents__*"],
    "deny": []
  },
  "skipDangerousModePermissionPrompt": true,
  "includeGitInstructions": false,
  "spinnerTipsEnabled": false,
  "feedbackSurveyRate": 0,
  "skillListingBudgetFraction": 0.02
}
```

Notes:

- `skipDangerousModePermissionPrompt` is supported in user settings and by `--settings`; docs say project settings cannot auto-skip dangerous prompt.
- `--dangerously-skip-permissions` is still passed so the session starts directly in bypass mode.
- Because v1 is dangerous by default, allowed tool entries are documentation/diagnostic posture, not a security boundary.
- Do not use `apiKeyHelper` in default mode; default mode should exercise the same auth path as the operator's normal `claude` CLI.

## Auth/home strategy

Default v1 must use the operator's working Claude auth path without `--bare`.

Preferred implementation:

```text
<runDir>/home/
  .claude/skills/        # requested run-local skills only
  ... minimal generated settings/auth bridge if proven necessary ...
<runDir>/shell-home/
  ... optional whitelisted shell files ...
<runDir>/bin/
  async-subagents-bash
```

Implementation must hand-test which auth files/state Claude Code 2.1.197 needs for non-bare OAuth/Max on Linux. Acceptable v1 options, in order:

1. generated run-local `HOME` seeded with the minimum auth material required for `claude` to pass the auth/budget gate;
2. if minimum seeding is not stable, explicit operator-real-`HOME` auth mode labeled `authHome: "operator-home"` and `memoryIsolation: "best-effort-non-bare"`.

Do not copy the entire operator `~/.claude` directory by default. Do not copy `CLAUDE.md`, hooks, plugins, skills, MCP config, or project state unless explicitly needed and recorded. If OAuth credential material must be copied/symlinked for auth, redact it everywhere and treat the child as trusted-dangerous.

## Shell-home split

Tango's current Bash wrapper restores real operator `HOME`; do not copy that behavior blindly.

Claude Bash/tool subprocesses should run with `HOME=<runDir>/shell-home`, not operator home, where technically possible. `shell-home` contains only whitelisted convenience files. Since the default is dangerous bypass, this is hygiene and blast-radius reduction, not a hard sandbox.

If Claude Code itself must run with operator `HOME` for auth, the Bash wrapper still attempts to redirect tool subprocess `HOME` to `shell-home`. If Claude's tool runtime cannot support that split reliably, record `shellHomeIsolation: "unsupported"` and show it in launch metadata rather than silently claiming isolation.

## Extra MCP servers

Extra MCP servers are deferred from v1.

Generated MCP config includes only:

- interactive: the package-owned async-subagents child-control server;
- oneshot: an empty strict MCP config.

Definitions/config that request extra MCP servers fail pre-spawn with `EXTRA_MCP_UNSUPPORTED`.

## Redaction

Redact in `logs/launch.json`, supervisor logs, status details, result details, preflight diagnostics, and failure cards:

- credential/token/key/password/secret patterns;
- OAuth fields and Claude credential values;
- MCP server env values;
- npm/ssh/cloud credential values;
- full task text when it may contain sensitive content.
