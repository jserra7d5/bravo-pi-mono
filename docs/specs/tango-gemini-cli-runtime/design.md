# Tango Gemini CLI Runtime Design

Date: 2026-04-27
Status: implemented

## Goal

Add a `gemini` Tango harness that launches Gemini CLI agents under Tango's existing native/tmux runtime, analogous to the Claude Code harness but optimized for Gemini CLI's interactive behavior.

Gemini headless mode (`gemini --prompt` / `-p`) is not the default because it is prone to rate limiting in the current environment. Tango therefore treats Gemini as an interactive-first harness and relies on tmux for prompt delivery and follow-up messages.

## Supported model policy

The harness intentionally supports only the two Gemini models currently desired for Tango agent work:

- `gemini-3.1-pro-preview`
- `gemini-3-flash-preview`

If a role or `tango start --model` requests any other Gemini model, Tango fails early with a clear validation error. If no model is supplied, the harness defaults to `gemini-3.1-pro-preview`.

Default roles:

- `gemini-scout`: `gemini-3-flash-preview`, `thinking: low`
- `gemini-worker`: `gemini-3.1-pro-preview`, `thinking: high`
- `gemini-team-lead`: `gemini-3.1-pro-preview`, `thinking: high`

## Launch behavior

Interactive mode is the default for `harness: gemini`.

Tango launches Gemini with:

```bash
gemini \
  --model <gemini-3.1-pro-preview|gemini-3-flash-preview> \
  --yolo \
  --skip-trust \
  --prompt-interactive <assembled Tango system prompt + task>
```

`--yolo` is required so Gemini does not prompt for tool/action approval.

`--skip-trust` is required so the child starts without a trust prompt. The harness also writes run-local `trustedFolders.json` for the target cwd.

Explicit `--mode oneshot` is still wired through `gemini --prompt ... --output-format text` for completeness, but roles and default behavior should prefer interactive mode.

## Prompt injection

Gemini CLI does not expose a Claude-style `--system-prompt-file` flag in the observed version. Tango therefore embeds the assembled Tango system prompt and task into the initial `--prompt-interactive` text:

```text
System instructions:
<assembled Tango system prompt>

Task:
<task>
```

This keeps the harness simple and avoids relying on project-local `GEMINI.md` discovery.

## Runtime home and auth isolation

The harness sets:

- `HOME=<runDir>/home`
- `TANGO_AGENT_HOME=<runDir>/home`
- `TANGO_REAL_HOME=<operator home>`
- `TANGO_HOME=<parent Tango home>`
- `TANGO_AGENT_NAME`, `TANGO_RUN_ID`, `TANGO_RUN_DIR`, and lineage env vars when available

Before launch, it creates `<runDir>/home/.gemini` and copies a minimal set of Gemini auth/config files from the operator home when present:

- `oauth_creds.json`
- `google_accounts.json`
- `installation_id`
- `state.json`
- `projects.json`

It also writes a run-local `settings.json` and `trustedFolders.json`.

Unlike the Claude Code harness, Gemini CLI has no verified shell-prefix equivalent to `CLAUDE_CODE_SHELL_PREFIX`, so shell tool subprocesses inherit the Gemini runtime environment rather than a separate real-home shell wrapper.

## Thinking support

Gemini CLI does not expose a `--thinking` flag. Thinking is configured through run-local Gemini settings under `modelConfigs.overrides`:

```json
{
  "match": { "model": "gemini-3.1-pro-preview" },
  "modelConfig": {
    "generateContentConfig": {
      "thinkingConfig": { "thinkingLevel": "HIGH" }
    }
  }
}
```

Tango maps role/CLI thinking levels as follows:

- `minimal`, `low` -> `LOW`
- `medium` -> `MEDIUM`
- `high`, `xhigh` -> `HIGH`
- `off` or unset -> no override

This is based on Gemini CLI's documented `modelConfigs` / `thinkingConfig` support for Gemini 3 aliases.

## Messaging

Gemini runs inside Tango's tmux runtime. `tango message` uses tmux paste buffers and Enter, with a short post-paste delay to avoid Gemini swallowing the submit key after bracketed paste.

This same path remains compatible with Claude Code and generic tmux agents.

## Roles, tools, skills, and recursion

Gemini roles use `orchestration: cli` for recursive coordination. Gemini agents do not receive Pi tools or Pi extensions; they should call the `tango` CLI directly.

The harness rejects roles declaring `extensions`, because Pi extensions are only supported by `harness: pi`.

Role `tools` are not mapped to Gemini CLI tools. Gemini's tool and policy surface is separate from Pi's.

Role `skills` are copied best-effort into `<runDir>/home/.gemini/skills/<skill-name>/`, but Gemini skill packaging compatibility should be verified per skill.

## Validation performed

- `npm run check --workspace @bravo/tango`
- `npm test --workspace @bravo/tango`
- Live Gemini interactive smoke test with copied OAuth, `--yolo`, `--skip-trust`, and `--thinking low` mapped to `thinkingLevel: LOW`.
