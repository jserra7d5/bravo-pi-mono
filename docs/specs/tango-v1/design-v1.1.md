# Tango v1.1 Design — Tool-First Pi UX, CLI-First Core

Status: implemented  
Date: 2026-04-25  
Supersedes/extends: `docs/specs/tango-v1/design.md`

## Summary

Tango remains a CLI-first native/tmux agent orchestration system. The `tango` CLI is the only orchestration implementation and the source of truth for run directories, metadata, tmux sessions, harness launches, status, and results.

Tango v1.1 adds a stronger Pi integration design:

- Pi tool wrappers are the preferred orchestration surface for any Pi session that has the Tango extension loaded.
- The tools literally shell out to the `tango` CLI and parse `--json` output.
- The tools provide structured schemas, custom terminal UI rendering, and notifications.
- Recursive Pi agents should receive the Tango extension explicitly when orchestration is enabled.
- Non-Pi harnesses use the Tango CLI directly.
- The canonical orchestration prompt is split into shared includes so the parent Pi session and child agents do not drift.

The guiding rule is:

> Tools where the harness supports them; CLI everywhere as fallback and source of truth.

## Current Codebase Shape

```txt
bravo-pi-mono/
  AGENTS.md
  README.md
  package.json
  docs/
    specs/
      tango-v1/
        design.md
        plan.md
        design-v1.1.md
        plan-v1.1.md
  packages/
    tango/
      package.json
      README.md
      tsconfig.json
      src/
        cli.ts
        start.ts
        metadata.ts
        paths.ts
        roles.ts
        types.ts
        json.ts
        harnesses/
          generic.ts
          pi.ts
        runtime/
          tmux.ts
      extensions/
        pi/
          index.ts
      roles/
        scout.md
        planner.md
        reviewer.md
        worker.md
        team-lead.md
      includes/
        orchestration.md
        status-protocol.md
        handoff-format.md
      skills/
```

v1.1 should evolve the includes into environment-specific orchestration includes:

```txt
packages/tango/includes/
  orchestration-core.md
  orchestration-cli.md
  orchestration-pi-tools.md
  status-protocol.md
  handoff-format.md
```

The existing `orchestration.md` can be retained as a compatibility aggregator or replaced by role assembly logic.

## Research Notes: Pi Terminal UI and Extension Rendering

Pi extensions can shape terminal UI in several relevant ways.

### Tool call/result renderers

Custom tools can define:

```ts
renderCall(args, theme, context) { ... }
renderResult(result, options, theme, context) { ... }
```

These return TUI components such as `Text`, `Container`, `Box`, `Spacer`, and `Markdown` from `@mariozechner/pi-tui`.

Important renderer practices from the docs/examples:

- Use `theme.fg("success" | "error" | "warning" | "accent" | "muted" | "dim", text)` for consistent colors.
- Use `Text` for compact rows.
- Use `Container` + `Spacer` for expanded multi-section layouts.
- Use `Markdown` for final agent output or handoff content.
- Respect `expanded` to keep the collapsed view compact.
- Truncate large outputs; built-in guidance is 50KB or 2000 lines.
- For string enums in tool schemas, use `StringEnum` from `@mariozechner/pi-ai` rather than `Type.Union` for provider compatibility.

### Custom messages

Extensions can call:

```ts
pi.sendMessage({ customType, content, display: true, details })
pi.registerMessageRenderer(customType, renderer)
```

This is useful for parent-session status messages that are not tool results, e.g. background polling or lifecycle notifications.

For v1.1, Tango should primarily rely on tool renderers. Custom messages can be added later for async notifications such as "agent completed while you were working."

### Footer status

Extensions can use:

```ts
ctx.ui.setStatus("tango", "...")
```

This is useful for a persistent footer indicator like:

```txt
Tango: 2 running · 3 done
```

For v1.1, update the status during tool calls and on `session_start`. Continuous polling should be deferred unless explicitly enabled.

### Widgets and overlays

Pi supports persistent widgets with:

```ts
ctx.ui.setWidget("tango", ...)
```

and custom overlays with:

```ts
ctx.ui.custom(component, { overlay: true })
```

These are powerful but should not be v1.1 defaults. They are better for later commands such as `/tango-dashboard`.

### Terminal line width rule

Custom components must not render lines wider than the provided width. Use `truncateToWidth` or built-in `Text` wrapping. For Tango v1.1 renderers, prefer built-in `Text`, `Container`, and `Markdown` rather than hand-built wide strings.

## Core Invariant: CLI/Tool Synchronization Rule

The Tango CLI is the only orchestration implementation.

Pi extension tools must:

1. Shell out to the `tango` CLI with `--json` where available.
2. Parse CLI JSON output.
3. Return structured `details` for rendering.
4. Never create run directories directly.
5. Never spawn tmux directly.
6. Never launch harnesses directly.
7. Never write Tango metadata directly.

Allowed in Pi tools:

- argument schema definition;
- user/model-facing descriptions;
- CLI argument assembly;
- CLI process execution with `shell: false`;
- JSON parsing;
- output truncation;
- terminal rendering;
- notifications/status widgets;
- prompt injection.

Disallowed in Pi tools:

- importing `src/start.ts` to call `startAgent()` directly;
- reimplementing `tango start` logic;
- mutating run metadata outside the CLI;
- making a second orchestration state store in Pi session data.

This avoids silent divergence between CLI and tools.

## Orchestration Surfaces

### 1. Tango CLI

The CLI is portable and canonical.

Examples:

```bash
tango start repo-scout --role scout "Summarize this repo"
tango list --json
tango look repo-scout --lines 200 --json
tango message lead "Narrow scope to backend files"
tango status done "Completed implementation"
tango result repo-scout
```

Every operation that changes or reads orchestration state should exist in the CLI first.

### 2. Tango Pi tools

The Pi tools are structured wrappers over the CLI.

Dedicated tools:

```txt
tango_start      wraps `tango start`
tango_list       wraps `tango list`
tango_look       wraps `tango look`
tango_message    wraps `tango message`
tango_stop       wraps `tango stop`
tango_status     wraps `tango status`
tango_result     wraps `tango result`
tango_cli        generic safe CLI wrapper / escape hatch
```

The dedicated tools expose common operations with nice schemas and custom renderers. `tango_cli` exposes the CLI for commands/flags that do not yet have a dedicated wrapper.

### 3. Raw shell CLI fallback

If Tango Pi tools are unavailable, an agent with shell access can still use:

```bash
tango ...
```

This is the fallback for non-Pi harnesses and for debugging.

## Harness Policy

### Pi parent session

A parent Pi session with the Tango extension loaded should receive:

- Tango Pi tools;
- canonical Tango prompt injection;
- custom tool rendering;
- optional footer/status updates.

Instruction policy:

> Prefer Tango Pi tools. Use `tango_cli` for unsupported CLI features. Use raw shell CLI only if the tools are unavailable or when debugging.

### Pi recursive child agent

A recursive Pi child agent should receive the Tango extension explicitly, not ambient extension discovery.

Launch policy:

```bash
pi \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --no-extensions \
  -e /path/to/packages/tango/extensions/pi/index.ts \
  ...
```

This gives the child semantic Tango tools and UI when attached through tmux while preserving isolation from global/project extensions.

Instruction policy:

> Prefer Tango Pi tools when available. Use the CLI fallback for unsupported operations or debugging.

### Non-Pi recursive child agent

Claude Code, Codex, Gemini, generic shell, and other harnesses receive CLI instructions only.

Instruction policy:

> Use the `tango` CLI directly. Prefer `--json` when parsing results.

### Non-recursive agents

Non-recursive roles should not receive orchestration tools or orchestration instructions by default.

## Role Schema Additions

Existing fields remain:

```yaml
name: team-lead
description: Delegates work to scouts, planners, workers, and reviewers
harness: pi
mode: interactive
contextFiles: false
skills: []
extensions: []
includes: [handoff-format]
recursive: true
allowedChildRoles: [scout, planner, worker, reviewer]
```

v1.1 adds an explicit orchestration policy:

```yaml
orchestration: auto
```

Valid values:

```yaml
orchestration: none   # no orchestration prompt/tools
orchestration: cli    # inject CLI instructions only
orchestration: tools  # require harness-native Tango tools
orchestration: auto   # pi => tools, non-pi => cli
```

Default behavior:

```txt
recursive: false -> orchestration: none
recursive: true  -> orchestration: auto
```

For `harness: pi` and `orchestration: auto`, Tango should explicitly load the Tango Pi extension.

## Prompt Includes

Replace the single orchestration include with a composable set.

### `orchestration-core.md`

Defines the delegation model:

- what Tango is;
- when to delegate;
- common roles;
- recommended scout/planner/worker/reviewer flow;
- avoid excessive delegation.

### `orchestration-pi-tools.md`

Defines Pi tool usage:

- prefer dedicated Tango tools when available;
- tool list and mapping to CLI commands;
- use `tango_cli` as escape hatch;
- use raw CLI only as fallback/debugging.

### `orchestration-cli.md`

Defines CLI usage:

- `tango start`;
- `tango list --json`;
- `tango look --json`;
- `tango message`;
- `tango status`;
- `tango result`.

### Assembly policy

Parent Pi extension injection:

```txt
orchestration-core.md
orchestration-pi-tools.md
orchestration-cli.md
```

Recursive Pi child role:

```txt
orchestration-core.md
orchestration-pi-tools.md
orchestration-cli.md
status-protocol.md
```

Recursive non-Pi child role:

```txt
orchestration-core.md
orchestration-cli.md
status-protocol.md
```

Non-recursive role:

```txt
role includes only
```

## Parent Pi Prompt Injection

The Tango Pi extension should read the canonical includes from package files and append them to the parent Pi system prompt using `before_agent_start`.

Design:

```ts
pi.on("before_agent_start", async (event) => {
  return {
    systemPrompt: event.systemPrompt + "\n\n" + assembledTangoParentPrompt,
  };
});
```

Avoid putting detailed Tango orchestration instructions in `AGENTS.md`, because `AGENTS.md` can drift from child-agent prompts.

The extension should optionally support a disable flag later:

```bash
pi --no-tango-prompt
```

v1.1 may inject by default when the extension is installed.

## Tool UI Design

### General rendering principles

All Tango tool renderers should support collapsed and expanded views.

Collapsed view:

- one to five lines;
- status icon;
- agent name / role / mode;
- concise result summary;
- hint if expanded view contains more.

Expanded view:

- command mapping;
- task/message;
- run directory;
- status;
- child outputs or result markdown;
- errors/stderr when present.

Recommended status icons:

```txt
✓ done/success
⏳ running
◐ blocked/partial
✗ error
■ stopped
```

Recommended theme colors:

```txt
success -> done/success
warning -> running/blocked/partial
error   -> failed
accent  -> agent names / roles
dim     -> run dirs, timestamps, hints
muted   -> labels and secondary text
```

### `tango_start`

Call renderer:

```txt
tango start <name> as <role>
  <task preview>
```

Result collapsed:

```txt
⏳ Tango started repo-scout
  scout · oneshot · running
```

Result expanded:

```txt
Tango agent started
Name: repo-scout
Role: scout
Harness: pi
Mode: oneshot
Status: running
Run dir: ~/.tango/runs/.../repo-scout
Task:
  Summarize this repo
Next:
  Use tango_look to inspect output.
```

For oneshot agents that complete before the tool returns, show `✓` and `done`.

### `tango_list`

Collapsed:

```txt
Tango agents: 2 running · 1 done · 0 error
```

Expanded:

```txt
⏳ lead          team-lead   interactive/pi   running
✓ repo-scout    scout       oneshot/pi       done
✗ auth-worker   worker      interactive/pi   error
```

### `tango_look`

Call renderer:

```txt
tango look repo-scout --lines 200
```

Result collapsed:

```txt
repo-scout output
Found auth code in src/auth/session.ts, src/auth/middleware.ts...
```

Result expanded:

- render output as Markdown if possible;
- otherwise `Text`;
- include status and line count;
- indicate truncation.

### `tango_message`

Collapsed:

```txt
→ Sent message to lead
  "Please narrow scope to backend files"
```

Expanded:

```txt
Message sent
Agent: lead
Message:
  Please narrow scope to backend files
```

### `tango_stop`

Collapsed:

```txt
■ Stopped lead
```

Expanded:

```txt
Stopped Tango agent
Name: lead
Previous status: running
Run dir: ~/.tango/runs/.../lead
```

### `tango_status`

Collapsed:

```txt
✓ Status: done — Completed implementation
```

Expanded:

```txt
Status updated
Agent: worker-1
State: done
Message: Completed implementation
```

### `tango_result`

Collapsed:

```txt
✓ repo-scout result
  <first line / short summary>
```

Expanded:

Render result as Markdown.

### `tango_cli`

Collapsed:

```txt
tango <args preview>
```

Result collapsed:

```txt
✓ tango list --json
```

Expanded:

- show command args;
- show parsed JSON if available;
- show stdout/stderr;
- block or warn for interactive commands like `attach`.

## `tango_cli` Safety Policy

`tango_cli` should use `spawn(command, args, { shell: false })`.

Allowed commands:

```txt
start, list, look, message, stop, delete, status, result, roles
```

Blocked commands:

```txt
attach
```

Reason: `attach` is interactive and will hang inside a Pi tool. Users should run `tango attach` manually in a terminal.

`tango_cli` should append `--json` automatically for commands where JSON is supported unless the caller explicitly includes a conflicting output mode.

## Extension Status UI

On `session_start`, the extension may set a footer status:

```txt
Tango: ready
```

After tools run, update it with a summary:

```txt
Tango: 1 running · 2 done
```

Implementation should avoid aggressive polling in v1.1. Status can update opportunistically after `tango_start`, `tango_list`, `tango_stop`, etc.

## Installation and Child Agent Extension Loading

The package is installed into parent Pi with:

```bash
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tango
```

Pi child agents with orchestration tools should be launched with:

```bash
--no-extensions -e /home/joe/Documents/projects/bravo-pi-mono/packages/tango/extensions/pi/index.ts
```

The Pi harness must be able to resolve the package extension path at runtime.

## Non-goals for v1.1

- No continuous background polling dashboard.
- No full-screen Tango overlay yet.
- No custom footer replacement.
- No in-process orchestration implementation inside the extension.
- No project-local Tango orchestration instructions in `AGENTS.md`.
- No dependency on Pi tools for non-Pi harness recursion.

## Acceptance Criteria

1. Parent Pi session with Tango extension loaded receives canonical Tango instructions without `AGENTS.md` duplication.
2. Pi recursive child agents can be launched with explicit Tango extension tools while keeping ambient extensions disabled.
3. All Tango Pi tools shell out to the CLI.
4. `tango_cli` exists as a generic escape hatch.
5. Dedicated tools return structured details and have compact custom renderers.
6. CLI behavior remains usable without Pi.
7. Non-Pi harnesses can still recurse through CLI instructions.
