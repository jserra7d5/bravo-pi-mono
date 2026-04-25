# tango v1 Design

Status: draft scaffold  
Date: 2026-04-24

## Summary

`tango` is a CLI-first native/tmux agent orchestration system inspired by pi's extension model and Scion's runtime/harness pattern.

The goal is to manage specialized coding agents as independent CLI processes with isolated context, visible tmux sessions, reusable role prompts, and optional recursive delegation.

The first-class implementation target is a standalone CLI. Pi integration should be a thin pi package/extension wrapper around that CLI, not the core orchestrator.

## Goals

- Build a standalone agent orchestration CLI usable by humans and agents.
- Launch agents as subprocesses in tmux sessions for observability and attach/detach workflows.
- Start with a `pi` harness.
- Add a Claude Code harness later without changing the orchestration model.
- Keep child agents context-clean by default.
- Allow explicitly scoped tools, skills, extensions, and shared prompt includes per role.
- Support recursive delegation through the CLI rather than in-process SDK subagents.
- Package pi integration as a normal pi package loaded at runtime.

## Non-goals

- Do not modify or recompile pi.
- Do not build in-process SDK subagents for v1.
- Do not require containers for v1.
- Do not use MCP as the orchestration interface.
- Do not load ambient project/global context into child agents by default.
- Do not make project-local role definitions trusted by default.

## Repository Shape

This package lives inside a monorepo:

```txt
bravo-pi-mono/
  AGENTS.md
  package.json
  docs/
    specs/
      tango-v1/
        design.md
  packages/
    tango/
      package.json
      README.md
      src/
      extensions/
        pi/
      roles/
      includes/
      skills/
```

The root repository can grow additional packages later. `packages/tango` is one package among many.

## Core Concepts

### Role

A role defines a reusable agent identity and operating envelope.

Example:

```md
---
name: scout
description: Fast codebase reconnaissance and compressed handoff
harness: pi
mode: oneshot
model: claude-haiku-4-5
thinking: low
tools: [read, grep, find, ls]
contextFiles: false
skills: []
extensions: []
includes: [handoff-format]
recursive: false
---

You are a scout.

Quickly investigate the codebase and return structured findings that another agent can use without re-reading everything.
```

The markdown body is the role's primary system/instruction prompt.

### Include

An include is a reusable shared prompt fragment injected into one or more roles.

Examples:

- `orchestration.md` — how to use the `tango` CLI.
- `status-protocol.md` — how to report blocked/done/error states.
- `handoff-format.md` — required output structure for handoffs.
- `coding-standards.md` — common coding instructions.

Role prompts are assembled from selected includes plus the role body.

### Skill

A skill is a harness-native reusable capability/instruction package.

For the pi harness, skills map to pi skills and are loaded explicitly with:

```bash
--no-skills --skill /path/to/SKILL.md
```

Default behavior is no ambient skills. Roles must opt in to specific skills.

### Harness

A harness adapts `tango` to a particular agent CLI.

Initial harnesses:

- `pi`
- `claude` later

Potential future harnesses:

- `codex`
- `gemini`
- `opencode`
- `generic`

A harness is responsible for preparing agent home/config, constructing the command, setting env vars, and defining how to inject role/system instructions.

### Runtime

The v1 runtime is native tmux.

It manages:

- run directories;
- isolated agent homes;
- tmux sockets/sessions;
- process lifecycle;
- terminal snapshots;
- message injection via tmux send-keys.

### Agent Instance

An agent instance is one concrete running/stopped/completed agent created from a role.

Each instance has metadata, home directory, prompt files, logs, and a tmux session/socket.

## Directory Layout

Global data, draft shape:

```txt
~/.tango/
  config.json
  roles/
  includes/
  skills/
  runs/
    <project-slug>/
      <agent-name>/
        metadata.json
        prompt.md
        system.md
        result.md
        events.jsonl
        output.log
        home/
        tmux.sock
```

Package-provided defaults live under:

```txt
packages/tango/roles/
packages/tango/includes/
packages/tango/skills/
```

Project-local roles/includes may exist later, but should be opt-in because they are repo-controlled instructions.

## CLI v1

### Lifecycle

```bash
tango start <name> --role <role> [task...]
tango list
tango look <name>
tango attach <name>
tango message <name> "..."
tango stop <name>
tango delete <name>
tango status <state> [message]
```

### JSON Mode

Every command intended for agent/tool use should support `--json`.

Examples:

```bash
tango list --json
tango start auth-scout --role scout "Find auth code" --json
tango look auth-scout --json
```

### `tango start`

Starts an agent.

Draft flags:

```txt
--role <name>             Role definition to use
--harness <name>          Override role harness
--mode <mode>             Override role mode: oneshot | interactive
--model <model>           Override role model
--thinking <level>        Override role thinking level: off | minimal | low | medium | high | xhigh
--cwd <path>              Working directory
--workspace <path>        Workspace path
--clean                   Remove previous same-name instance first
--attach                  Attach after launch
--json                    Structured output
--recursive               Equip agent for recursive delegation
--no-recursive            Disable recursive delegation
```

## Execution Modes

### `oneshot`

For bounded jobs such as scout/planner/reviewer.

For pi, launch shape:

```bash
pi --mode json -p \
  --no-session \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --model <model> \
  --thinking <level> \
  --tools <tools> \
  --append-system-prompt <system-file> \
  --skill <explicit-skill> \
  "Task: <task>"
```

The orchestrator captures events/output, exit code, and final result.

### `interactive`

For long-lived leads/workers that should be inspectable and steerable.

For pi, launch shape:

```bash
pi \
  --no-session \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --model <model> \
  --thinking <level> \
  --tools <tools> \
  --append-system-prompt <system-file> \
  "Task: <task>"
```

The process runs in tmux. `tango look`, `tango attach`, and `tango message` operate on that tmux session.

## Default Isolation Policy

Child agents should not inherit ambient instructions by default.

Pi harness defaults:

```bash
--no-session
--no-context-files
--no-skills
--no-prompt-templates
```

Optional stricter mode:

```bash
--no-extensions
```

If role-specific skills are configured, keep `--no-skills` and add explicit `--skill` flags.

If role-specific extensions are configured, keep `--no-extensions` and add explicit `-e` flags.

## Role Schema Draft

```yaml
name: scout
description: Fast codebase reconnaissance
harness: pi
mode: oneshot
model: claude-haiku-4-5
thinking: low
tools:
  - read
  - grep
  - find
  - ls
contextFiles: false
skills: []
extensions: []
includes:
  - handoff-format
recursive: false
allowedChildRoles: []
```

Fields:

- `name`: role name.
- `description`: human/model-facing role summary.
- `harness`: CLI adapter, e.g. `pi` or `claude`.
- `mode`: `oneshot` or `interactive`.
- `model`: harness-specific model selector.
- `thinking`: harness-specific reasoning/thinking level. For the pi harness: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `tools`: harness-specific tool allowlist.
- `contextFiles`: whether ambient context files should be loaded. Default false.
- `skills`: explicit skill names/paths. Default none.
- `extensions`: explicit extension names/paths. Default none.
- `includes`: shared prompt fragments to inject.
- `recursive`: whether to inject orchestration instructions and permit child spawning.
- `allowedChildRoles`: optional policy for recursive roles.

## Shared Includes

Example `includes/orchestration.md`:

```md
## Agent Orchestration

You may use the `tango` CLI to delegate work.

Useful commands:

- `tango start <name> --role <role> "task"` starts a child agent.
- `tango list --json` lists agents.
- `tango look <name> --plain` inspects an agent.
- `tango message <name> "message"` sends follow-up instructions.
- `tango status blocked "reason"` marks yourself blocked.
- `tango status done "summary"` marks yourself complete.

Use child agents only when delegation reduces complexity.
```

## Recursion Model

Recursive delegation is CLI-based.

A recursive agent needs:

1. `tango` available on `PATH`.
2. Environment variables identifying its run context.
3. Orchestration instructions injected into its system prompt.
4. Optional policy limits such as `allowedChildRoles` and max child count.

The parent agent starts children by choosing roles:

```bash
tango start auth-scout --role scout "Find auth code"
tango start auth-worker --role worker "Implement the auth plan"
```

The child role defines its own harness, tools, model, skills, and includes. Parent agents should not usually pass raw skill files or prompt fragments directly.

## Status Protocol

Interactive agents need a completion protocol.

Draft command:

```bash
tango status running [message]
tango status blocked "Waiting for auth-worker"
tango status done "Completed auth implementation"
tango status error "Tests are failing"
```

When called from inside an agent, `tango status` should infer the agent from env vars such as:

```txt
TANGO_AGENT_NAME
TANGO_RUN_DIR
```

## Pi Extension Integration

The pi extension should be a thin adapter over the CLI.

Potential tools:

- `tango_start`
- `tango_list`
- `tango_look`
- `tango_message`
- `tango_stop`
- `tango_status`

The extension should shell out to `tango ... --json` and render results in pi.

The package exposes pi resources through `packages/tango/package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/pi"],
    "skills": ["./skills"]
  }
}
```

No pi source recompilation is required.

## Security Notes

- Extensions and package code execute with full user permissions.
- Project-local roles/includes should be opt-in.
- Ambient context files are disabled by default for child pi agents.
- Ambient pi skills are disabled by default for child pi agents.
- Recursive roles should be explicit and may need child-role allowlists.
- Claude/other harness auth projection should be explicit; do not blindly share a full user home.

## Open Questions

- Final package/repo name.
- Final CLI binary name: `tango`, `pageant`, or another name.
- Whether v1 should implement both `oneshot` and `interactive` immediately.
- How to robustly capture final result in interactive mode.
- Whether to use git worktrees in v1 or defer.
- Exact local/global config precedence.
- Whether package-provided roles should be copied into `~/.tango` or loaded in place.
