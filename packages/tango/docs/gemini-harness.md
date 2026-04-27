# Gemini CLI harness

Tango supports Gemini CLI through `harness: gemini`.

Use this harness when you want a Tango-managed Gemini CLI child agent running in tmux with normal Tango lifecycle, `tango activity`, `tango message`, `tango stop`, and result/report protocols.

## Quick start

```bash
tango start gemini-work --role gemini-worker "Implement the requested change"
tango activity gemini-work --lines 100
tango message gemini-work "Run the focused check and report back"
```

Available package roles:

- `gemini-scout` — interactive reconnaissance using `gemini-3-flash-preview`, `thinking: low`.
- `gemini-worker` — bounded implementation using `gemini-3.1-pro-preview`, `thinking: high`.
- `gemini-team-lead` — CLI-orchestrating coordinator using `gemini-3.1-pro-preview`, `thinking: high`.

## Model policy

Only these models are accepted:

- `gemini-3.1-pro-preview`
- `gemini-3-flash-preview`

Examples:

```bash
tango start g31 --harness gemini --model gemini-3.1-pro-preview "Do the task"
tango start gf --harness gemini --model gemini-3-flash-preview "Scout the repo"
```

If no model is provided, Tango defaults Gemini to `gemini-3.1-pro-preview`.

## Interactive-first behavior

Gemini defaults to interactive mode in Tango. The harness launches:

```bash
gemini --model <model> --yolo --skip-trust --prompt-interactive <prompt>
```

Why:

- `--yolo` avoids approval prompts.
- `--skip-trust` avoids the folder trust prompt.
- `--prompt-interactive` sends the initial task while keeping the session available for `tango message`.
- Headless `gemini --prompt` exists, but Tango does not default to it because this environment can 429 in headless mode.

## Thinking

Gemini CLI has no `--thinking` command-line flag in the observed version.

Tango maps role/CLI `thinking` into run-local Gemini settings:

- `minimal` / `low` -> `thinkingLevel: LOW`
- `medium` -> `thinkingLevel: MEDIUM`
- `high` / `xhigh` -> `thinkingLevel: HIGH`
- `off` / unset -> no thinking override

Example:

```bash
tango start gthink \
  --harness gemini \
  --model gemini-3-flash-preview \
  --thinking medium \
  "Analyze the tradeoffs"
```

The generated setting is written under:

```text
<runDir>/home/.gemini/settings.json
```

as a `modelConfigs.overrides` entry for the selected model.

## Auth and runtime home

The harness runs Gemini with:

```text
HOME=<runDir>/home
TANGO_AGENT_HOME=<runDir>/home
TANGO_REAL_HOME=<operator-home>
TANGO_HOME=<parent Tango home>
```

It copies minimal Gemini auth/config files from `~/.gemini` when present:

- `oauth_creds.json`
- `google_accounts.json`
- `installation_id`
- `state.json`
- `projects.json`

It also writes run-local `settings.json` and `trustedFolders.json`.

## Messaging

Use normal Tango messaging:

```bash
tango message gemini-work "Reply with a concise status update"
```

Tango delivers messages via tmux paste buffer plus Enter. The runtime includes a short post-paste delay so Gemini reliably submits pasted messages.

## Limitations

- Gemini roles cannot use Pi extensions; roles declaring `extensions` fail early.
- Pi tool names are not mapped to Gemini tools.
- Skills are copied best-effort to `<runDir>/home/.gemini/skills/`; verify each skill works with Gemini CLI before relying on it.
- There is no verified Gemini equivalent of Claude Code's `CLAUDE_CODE_SHELL_PREFIX`, so shell subprocess home-splitting is not implemented for Gemini.
