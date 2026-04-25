# tango v1 Implementation Plan

Status: draft  
Date: 2026-04-24  
Spec: `docs/specs/tango-v1/design.md`

## Research Summary

This plan is based on the current `tango v1` design plus a review of pi's documented package, extension, skill, prompt-template, JSON-mode, resource-loading, and subagent-extension behavior.

The important conclusion is that `tango` should be built as a standalone CLI package inside this monorepo, with pi integration provided through pi's normal runtime package/extension system. We should not modify or recompile pi.

## Relevant Pi Integration Findings

### Pi packages are the intended distribution mechanism

Pi packages can bundle extensions, skills, prompt templates, and themes. A package declares resources in `package.json` under the `pi` key:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Pi can install packages from npm, git, URL, or local path:

```bash
pi install npm:@scope/pkg@1.0.0
pi install git:github.com/user/repo@v1
pi install /absolute/path/to/package
pi install ./relative/path/to/package
```

For local development, local path install is ideal because the package points at the local repo rather than copying it.

Recommended local dev install:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tango
```

Project-local install is also possible with `-l`, but global local-path install is safer for this orchestrator because project-local settings are repository-controlled:

```bash
pi install -l /home/joe/Documents/projects/bravo-pi-mono/packages/tango
```

### Pi extensions are runtime-loaded TypeScript modules

Extensions are TypeScript or JavaScript modules loaded at runtime. TypeScript works without compilation via `jiti`.

An extension exports a default factory:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ /* ... */ });
  pi.registerCommand("name", { /* ... */ });
}
```

Extension loading options:

- auto-discovered global: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts`
- auto-discovered project: `.pi/extensions/*.ts` or `.pi/extensions/*/index.ts`
- explicit one-run flag: `pi -e ./extension.ts`
- package resources via `package.json` `pi.extensions`

For this project, package resources are the right convention.

### No pi recompilation is needed

Pi supports extension/package integration directly:

- `pi install /path/to/package`
- `pi -e /path/to/extension.ts`
- auto-discovery from extension directories
- package manifests with `pi.extensions`, `pi.skills`, `pi.prompts`, and `pi.themes`

Therefore `bravo-pi-mono` should remain separate from upstream `pi-mono`. Upstream pi source is a reference, not a modification target.

### Runtime dependencies belong in `dependencies`

For pi packages installed from npm or git, pi runs `npm install`. Runtime dependencies must be in `dependencies`; `devDependencies` may not be available at runtime.

Pi core packages should be peer dependencies, not bundled:

```json
"peerDependencies": {
  "@mariozechner/pi-ai": "*",
  "@mariozechner/pi-agent-core": "*",
  "@mariozechner/pi-coding-agent": "*",
  "@mariozechner/pi-tui": "*",
  "typebox": "*"
}
```

This package should follow that pattern.

### Pi package conventional directories

If a package has no `pi` manifest, pi auto-discovers conventional directories:

- `extensions/` loads `.ts` and `.js`
- `skills/` recursively finds `SKILL.md` folders and top-level `.md` skills
- `prompts/` loads `.md`
- `themes/` loads `.json`

Because `tango` needs explicit resource boundaries, use a `pi` manifest rather than relying only on convention.

### Package resource filtering exists

Pi settings can filter resources from a package:

```json
{
  "packages": [
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

This means we can safely ship multiple resources in `packages/tango` and users can disable subsets later. For v1, keep the package small and explicit.

### `--no-*` flags can be combined with explicit resource flags

Pi's CLI supports disabling discovery while allowing explicit resources:

```bash
pi --no-extensions -e ./my-ext.ts
pi --no-skills --skill ./some-skill/SKILL.md
pi --no-prompt-templates --prompt-template ./template.md
```

This is essential for child-agent isolation.

### Context-file isolation requires `--no-context-files`

`--no-session` only makes the session ephemeral. It does not disable context-file loading.

For child agents that should avoid ambient global/project `AGENTS.md` and `CLAUDE.md`, use:

```bash
--no-context-files
```

### Skill scoping is supported

Pi loads skills from defaults, settings, packages, and CLI flags. Discovery can be disabled while explicit skills still load:

```bash
pi --no-skills --skill /path/to/skill/SKILL.md
```

This matches the `tango` role model:

```yaml
skills:
  - repo-map
  - test-runner
```

The pi harness should resolve those names to explicit paths and emit `--skill` flags.

### Prompt templates should not be part of tango v1 roles

Pi prompt templates are slash-command snippets loaded from `prompts/`, settings, packages, or `--prompt-template`. They expand when a user or agent types `/template-name`.

They are useful for human workflows, but they are not the right primitive for shared role prompt fragments. For `tango`, use `includes/` as orchestrator-level shared system-prompt fragments.

V1 should avoid role-level `promptTemplates` to reduce confusion.

### JSON mode is suitable for oneshot harness execution

Pi's JSON mode emits JSON lines for session and agent events:

```bash
pi --mode json "Your prompt"
```

Useful event types include:

- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `agent_end`

The pi example subagent extension uses:

```ts
const args = ["--mode", "json", "-p", "--no-session"];
```

and parses `message_end` events to collect final assistant messages and usage.

For `tango`, oneshot pi agents should use JSON mode and capture structured output.

### Interactive mode is still needed for tmux observability

JSON/print mode is best for bounded work. Interactive mode is better for tmux attach/message workflows.

Therefore v1 should support both:

- `oneshot`: `pi --mode json -p ...`
- `interactive`: `pi ...` in tmux, with messages sent via tmux

### Extensions have no UI in print/json mode

Pi extension docs state `ctx.hasUI` is false in print and JSON mode. Any pi extension wrapper we write must not rely on interactive UI for oneshot subagent work.

For the `tango` pi extension:

- tools should return text/details normally;
- commands can use UI when interactive;
- guard interactive UI with `ctx.hasUI`.

### Custom tools should use TypeBox and StringEnum

Pi extension tools use TypeBox schemas. For string enums, pi docs recommend `StringEnum` from `@mariozechner/pi-ai`, not `Type.Union([Type.Literal(...)])`, due to Google provider compatibility.

Use:

```ts
import { StringEnum } from "@mariozechner/pi-ai";
```

### Custom tool output should be truncated

Pi docs emphasize output truncation for custom tools. Built-in limits are 50KB or 2000 lines. The pi extension wrapper should truncate `tango look` output or expose line limits by default.

### Extension state should not be the source of truth

Pi extensions can persist state in session entries/tool details, but `tango` should keep orchestration state in its own run directories and metadata files. The pi extension should be a stateless/thin adapter that shells out to `tango --json`.

### Dynamic resource discovery exists but should not be core v1

Extensions can respond to `resources_discover` and provide dynamic `skillPaths`, `promptPaths`, and `themePaths`. This is useful later if `tango` wants to expose generated skills or prompts to the parent pi session.

For v1, prefer static package manifest resources plus CLI role/include resolution.

## Package Layout Plan

Current package location:

```txt
/home/joe/Documents/projects/bravo-pi-mono/packages/tango
```

Target structure:

```txt
packages/tango/
  package.json
  README.md
  tsconfig.json
  src/
    cli.ts
    commands/
      start.ts
      list.ts
      look.ts
      attach.ts
      message.ts
      stop.ts
      delete.ts
      status.ts
    config.ts
    roles.ts
    includes.ts
    paths.ts
    process.ts
    runtime/
      tmux.ts
      types.ts
    harnesses/
      types.ts
      pi.ts
      claude.ts       # later
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

## `package.json` Plan

The root monorepo package should remain private and use workspaces:

```json
{
  "private": true,
  "workspaces": ["packages/*"]
}
```

The `packages/tango/package.json` should be both a Node CLI package and a pi package:

```json
{
  "name": "@bravo/tango",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "tango": "./dist/cli.js"
  },
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/pi"],
    "skills": ["./skills"]
  },
  "dependencies": {
    "commander": "^12.0.0",
    "gray-matter": "^4.0.3"
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-agent-core": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest"
  }
}
```

Notes:

- `extensions/pi/index.ts` can run uncompiled when loaded by pi.
- The CLI should be compiled to `dist/cli.js` for normal `tango` binary use.
- Runtime CLI dependencies belong in `dependencies`.
- Pi-provided packages belong in `peerDependencies`.

## Installation Plan

### Development install for CLI

From repo root:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono
npm install
npm run build
npm link --workspace @bravo/tango
```

If workspace linking is awkward, use package-local linking:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono/packages/tango
npm install
npm run build
npm link
```

Then verify:

```bash
tango --help
```

### Development install for pi integration

Install the local package into pi global settings:

```bash
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tango
```

Then verify pi sees the package:

```bash
pi list
```

During extension development, test direct loading if needed:

```bash
pi -e /home/joe/Documents/projects/bravo-pi-mono/packages/tango/extensions/pi/index.ts
```

Long-term, prefer `pi install` over ad-hoc `-e`.

## Implementation Phases

## Phase 0 — Repo Hygiene and Naming

1. Confirm final CLI/package name:
   - current spec slug: `tango-v1`
   - current CLI placeholder: `tango`
   - current monorepo: `bravo-pi-mono`
2. Initialize git repo if desired.
3. Package name is locked as `@bravo/tango`.
4. Add `.gitignore`:
   - `node_modules/`
   - `dist/`
   - `.DS_Store`
   - local run/temp files if any
5. Add root README later after first implementation slice.

## Phase 1 — Minimal CLI Skeleton

Build a working CLI with no agent spawning yet.

Commands:

```bash
tango --help
tango start --help
tango list --help
tango look --help
tango attach --help
tango message --help
tango stop --help
tango delete --help
tango status --help
```

Implementation tasks:

1. Add `src/cli.ts` with shebang.
2. Add command routing.
3. Add `--json` support convention.
4. Add shared JSON result/error helpers.
5. Add path helpers for `~/.tango` and per-project run dirs.
6. Ensure compiled `dist/cli.js` is executable or invoked correctly through npm bin.

Acceptance:

```bash
npm run build --workspace @bravo/tango
tango --help
tango list --json
```

## Phase 2 — Role and Include Loading

Implement role parsing and system prompt assembly.

Search locations for v1:

1. package defaults: `packages/tango/roles`, `packages/tango/includes`
2. user overrides: `~/.tango/roles`, `~/.tango/includes`
3. project-local roles/includes only later or behind explicit opt-in

Role format:

```md
---
name: scout
description: Fast codebase reconnaissance
harness: pi
mode: oneshot
model: claude-haiku-4-5
tools: [read, grep, find, ls]
contextFiles: false
skills: []
extensions: []
includes: [handoff-format]
recursive: false
---

You are a scout...
```

Tasks:

1. Add markdown/frontmatter parser.
2. Validate required fields.
3. Resolve includes by name/path.
4. Assemble final system prompt:
   - selected includes;
   - auto orchestration include if `recursive: true`;
   - role body.
5. Write system prompt to run dir as `system.md`.

Acceptance:

```bash
tango roles list --json
tango roles show scout
```

If we do not want extra role commands in v1, these can be internal plus tested through `start --dry-run`.

## Phase 3 — Run Directory and Metadata

Implement agent instance storage.

Run dir shape:

```txt
~/.tango/runs/<project-slug>/<agent-name>/
  metadata.json
  task.md
  system.md
  result.md
  events.jsonl
  output.log
  home/
  tmux.sock
```

Metadata draft:

```json
{
  "name": "auth-scout",
  "role": "scout",
  "harness": "pi",
  "mode": "oneshot",
  "status": "running",
  "cwd": "/repo",
  "runDir": "...",
  "homeDir": ".../home",
  "tmuxSocket": ".../tmux.sock",
  "createdAt": "...",
  "updatedAt": "...",
  "task": "Find auth code"
}
```

Tasks:

1. Compute project slug from cwd.
2. Create run directory.
3. Create isolated home directory.
4. Write task/system files.
5. Write/update metadata atomically where practical.
6. Implement `list` from metadata.
7. Implement `delete` for stopped/completed agents.

Acceptance:

```bash
tango start test --role scout --dry-run "Find auth code"
tango list
tango list --json
tango delete test
```

## Phase 4 — Native tmux Runtime

Implement tmux session management independent of pi.

Tasks:

1. Check `tmux` availability.
2. Start detached sessions with per-agent socket:
   ```bash
   tmux -S "$RUN_DIR/tmux.sock" new-session -d -s tango -- <command>
   ```
3. Capture pane for `look`:
   ```bash
   tmux -S "$socket" capture-pane -p -t tango -S -200
   ```
4. Attach:
   ```bash
   tmux -S "$socket" attach-session -t tango
   ```
5. Message:
   ```bash
   tmux -S "$socket" send-keys -t tango -- "message" Enter
   ```
6. Stop:
   ```bash
   tmux -S "$socket" kill-session -t tango
   ```
7. Update status based on tmux session existence.

Acceptance:

```bash
tango start shell-test --harness generic -- "bash -lc 'echo hello; sleep 30'"
tango look shell-test
tango attach shell-test
tango stop shell-test
```

A temporary generic harness may be useful to test runtime before pi harness.

## Phase 5 — Pi Harness Oneshot Mode

Implement pi harness command construction for bounded agents.

Command shape:

```bash
HOME="$AGENT_HOME" \
PI_CODING_AGENT_DIR="$AGENT_HOME/.pi/agent" \
TANGO_AGENT_NAME="$AGENT_NAME" \
TANGO_RUN_DIR="$RUN_DIR" \
pi --mode json -p \
  --no-session \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --model "$MODEL" \
  --tools "$TOOLS" \
  --append-system-prompt "$RUN_DIR/system.md" \
  --skill "$SKILL_PATH" \
  "Task: $TASK"
```

Important details:

- `--append-system-prompt` accepts file paths and reads them.
- `--no-context-files` is required for context isolation.
- `--no-skills` does not block explicit `--skill` flags.
- `--no-prompt-templates` should be default.
- Consider `--no-extensions` for non-recursive roles unless explicit extensions are configured.
- Capture stdout JSON lines into `events.jsonl`.
- Capture stderr into `output.log` or `stderr.log`.
- Parse `message_end` events to extract final assistant output and usage.

Acceptance:

```bash
tango start scout-test --role scout --mode oneshot "List the main files in this repo"
tango list
tango result scout-test
cat ~/.tango/runs/*/scout-test/events.jsonl
```

## Phase 6 — Pi Harness Interactive Mode

Implement interactive pi sessions in tmux.

Command shape:

```bash
HOME="$AGENT_HOME" \
PI_CODING_AGENT_DIR="$AGENT_HOME/.pi/agent" \
TANGO_AGENT_NAME="$AGENT_NAME" \
TANGO_RUN_DIR="$RUN_DIR" \
pi \
  --no-session \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --model "$MODEL" \
  --tools "$TOOLS" \
  --append-system-prompt "$RUN_DIR/system.md" \
  "Task: $TASK"
```

Tasks:

1. Start pi in tmux.
2. Verify initial prompt through CLI argument works as expected.
3. If needed, start pi without prompt and inject prompt via tmux send-keys.
4. Implement `look`, `attach`, `message`, `stop` against tmux.
5. Add role default `mode: interactive` for team leads/workers.

Acceptance:

```bash
tango start lead-test --role team-lead --mode interactive "Plan this repo"
tango look lead-test
tango message lead-test "Keep the plan brief."
tango attach lead-test
```

## Phase 7 — Status and Result Protocol

Implement status/result commands usable from inside agents.

Commands:

```bash
tango status running [message]
tango status blocked "Waiting for scout"
tango status done "Completed plan"
tango status error "Tests failing"
tango result <agent>
```

Inside an agent, infer identity from:

```txt
TANGO_AGENT_NAME
TANGO_RUN_DIR
TANGO_PARENT_RUN_DIR
```

Tasks:

1. `status` updates `metadata.json`.
2. `status done` optionally writes summary.
3. `result` reads `result.md` if present, otherwise derives best available final output.
4. Include `status-protocol.md` in recursive/interactive roles.

Acceptance:

```bash
TANGO_RUN_DIR=/tmp/test-run tango status done "ok"
tango result lead-test
```

## Phase 8 — Recursive Delegation

Implement recursion mechanically and instructionally.

Role fields:

```yaml
recursive: true
allowedChildRoles: [feature-lead, scout, planner, reviewer]
```

Tasks:

1. Ensure `tango` is on child PATH.
2. Inject `TANGO_*` env vars.
3. Auto-include `orchestration.md` for recursive roles.
4. Add policy checks in `tango start`:
   - if called from an agent with `allowedChildRoles`, enforce them;
   - optionally limit children per parent later.
5. Add package default includes:
   - `orchestration.md`
   - `status-protocol.md`
   - `handoff-format.md`

Acceptance:

```bash
tango start lead --role team-lead "Start a scout to inspect this repo and summarize findings"
tango look lead
tango list
```

## Phase 9 — Pi Extension Wrapper

Build `packages/tango/extensions/pi/index.ts` as a thin adapter over the CLI.

Initial tools:

- `tango_start`
- `tango_list`
- `tango_look`
- `tango_message`
- `tango_stop`
- `tango_status`

Implementation rules:

1. Shell out with `pi.exec` or Node child process.
2. Prefer `tango ... --json` for stable parsing.
3. Use TypeBox schemas.
4. Use `StringEnum` for enum-like fields.
5. Do not store orchestration state in pi session entries as source of truth.
6. Truncate large `look` outputs by default.
7. Guard UI methods with `ctx.hasUI`.
8. Return useful `details` for custom rendering later.

Example tool command mapping:

```txt
tango_start -> tango start <name> --role <role> <task> --json
tango_list  -> tango list --json
tango_look  -> tango look <name> --lines <n> --json
```

Potential commands:

```txt
/agents
/agent-look <name>
/agent-start ...
```

Commands are optional after tools work.

Acceptance:

```bash
pi -e /home/joe/Documents/projects/bravo-pi-mono/packages/tango/extensions/pi/index.ts
```

Then ask pi to list/start/look agents using the tool.

## Phase 10 — Package Install Verification

Verify actual pi package loading.

Steps:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono/packages/tango
npm install
npm run build
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tango
pi list
pi
```

Inside pi, verify:

- tango extension tools are registered;
- no resource errors occur;
- tool calls shell out to installed/local `tango` binary;
- package can be disabled/enabled via `pi config`.

If CLI binary is not found from extension context, add fallback resolution:

1. try `tango` on PATH;
2. try package-local `dist/cli.js` via `node`;
3. emit clear install/build error.

## Phase 11 — Hardening

1. Atomic metadata writes.
2. Better process cleanup.
3. Detect stale tmux sessions.
4. `--clean` behavior for existing agent names.
5. Better project slug handling.
6. Max output limits.
7. Signal handling for child processes.
8. Validate role schemas with clear errors.
9. Better JSON errors for extension consumption.
10. Tests for command builders.

## Phase 12 — Claude Code Harness Later

Do not implement in v1 unless pi harness is stable.

Planned shape:

- isolated `HOME`;
- explicit auth/config projection;
- system prompt injection through Claude Code supported mechanism;
- same tmux runtime;
- same role/include model.

## Open Decisions Before Implementation

1. Final CLI name: `tango`, `pageant`, or another.
2. Final npm package name is `@bravo/tango`.
3. Whether to implement a temporary generic harness first to test tmux runtime.
4. Whether v1 should include project-local roles behind an explicit flag.
5. Whether non-recursive pi roles should default to `--no-extensions`.
6. Whether `oneshot` agents should run inside tmux or directly as child processes.
   - Direct process is simpler for JSON capture.
   - tmux oneshot preserves observability but complicates event capture.
7. How strict to make recursive role policy in v1.

## Recommended v1 Build Order

Shortest path to useful system:

1. Rename package metadata to final scope.
2. Add CLI skeleton.
3. Add role/include loading.
4. Add run dirs and metadata.
5. Add tmux runtime.
6. Add pi oneshot harness.
7. Add pi interactive harness.
8. Add default roles/includes.
9. Add pi extension wrapper.
10. Install package into pi via local path and iterate.

## Acceptance Criteria for v1

A successful v1 should support:

```bash
tango start repo-scout --role scout "Summarize this repo"
tango list
tango look repo-scout
tango result repo-scout

tango start lead --role team-lead --mode interactive "Coordinate a small implementation plan"
tango message lead "Keep child agents read-only."
tango attach lead
tango stop lead
```

And from pi, after package install:

- the model can call a `tango_start` tool;
- the model can call `tango_list`;
- the model can call `tango_look`;
- the extension uses the CLI instead of implementing orchestration in-process.

## Key Implementation Principle

The pi extension is not the orchestrator.

The orchestrator is the `tango` CLI plus native/tmux runtime and harnesses. Pi integration is a package-provided adapter that exposes that CLI to pi in the way pi's creator intended: runtime-loaded extension code, installed via pi package mechanisms, without upstream pi source changes.
