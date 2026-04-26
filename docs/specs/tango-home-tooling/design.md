# Tango Home Isolation and Tooling Home Design

Date: 2026-04-26
Status: proposed v1

## Problem

Tango currently isolates child agent `HOME` for Pi and Claude harnesses. That keeps agent runtime config, skills, and auth under the run directory, but it also breaks normal developer tooling that resolves credentials/config from `HOME`, such as Git, SSH, GitHub CLI, npm, language toolchains, and user shell configuration.

We need both:

- isolated agent runtime/config/auth state; and
- normal user-home behavior for commands the agent runs as developer tooling.

## Core principle

Separate **agent runtime home** from **tool subprocess home**.

```text
Agent process HOME       = isolated run-local home
Tool subprocess HOME     = real operator home
TANGO_REAL_HOME          = real operator home
TANGO_AGENT_HOME         = isolated run-local home
```

The agent runtime can keep isolated auth/config/skills, while commands executed by its shell/tool layer act like the operator's normal terminal.

## Environment contract

For harnesses that need runtime home isolation:

```text
HOME=<runDir>/home
TANGO_AGENT_HOME=<runDir>/home
TANGO_REAL_HOME=<parent HOME>
TANGO_RUN_DIR=<runDir>
TANGO_HOME=<inherited or real-home .tango>
```

For tool subprocesses launched by the agent's shell tool:

```text
HOME=$TANGO_REAL_HOME
TANGO_AGENT_HOME=<runDir>/home
TANGO_RUN_DIR=<runDir>
```

This restores normal access to:

- `~/.gitconfig`
- `~/.ssh`
- `~/.config/gh`
- `~/.npmrc`
- language caches/configs under real home

while preserving isolated runtime state under `TANGO_AGENT_HOME`.

## Claude Code harness

Claude Code should keep isolated runtime home:

```text
HOME=<runDir>/home
```

This keeps Claude Code's discovered config, auth files, and skills scoped to the run-local home seeded by Tango.

Claude Code's Bash tool should run through a Tango shell wrapper using `CLAUDE_CODE_SHELL_PREFIX`:

```text
CLAUDE_CODE_SHELL_PREFIX=<runDir>/bin/tango-bash
PATH=<runDir>/bin:$PATH
```

Wrapper behavior:

```bash
#!/usr/bin/env bash
export HOME="$TANGO_REAL_HOME"
exec /usr/bin/bash "$@"
```

Scout findings from `/home/joe/Documents/misc/claude_code_source` support this direction:

- Claude Code discovers bash/zsh via PATH and `which`.
- Claude Code passes full `process.env` to subprocesses.
- Claude Code supports `CLAUDE_CODE_SHELL_PREFIX` in the Bash provider.
- No regular Bash tool hardcoding of `/bin/bash` was found.

Expected result:

- Claude process sees isolated `HOME`.
- Claude Bash tool commands see real `HOME`.
- Git/SSH/GitHub CLI/npm work normally inside Bash commands.
- Claude skills/auth/settings remain isolated to the run-local home.

## Pi harness

Pi should keep isolated runtime home:

```text
HOME=<runDir>/home
PI_CODING_AGENT_DIR=<runDir>/home/.pi/agent
```

Pi source review in `/home/joe/Documents/misc/pi-mono` found a clean tool-layer hook:

- Bash tool implementation: `packages/coding-agent/src/core/tools/bash.ts`.
- `createLocalBashOperations()` spawns the shell with an explicit `env`.
- `BashToolOptions` supports `spawnHook?: BashSpawnHook`.
- `BashSpawnHook` receives `{ command, cwd, env }` and returns transformed `{ command, cwd, env }`.
- Extensions can register a replacement `bash` tool; example: `examples/extensions/bash-spawn-hook.ts`.

Therefore Tango's Pi extension should replace/register the bash tool with a spawn hook when `TANGO_REAL_HOME` is set:

```ts
const bashTool = createBashTool(process.cwd(), {
  spawnHook: ({ command, cwd, env }) => ({
    command,
    cwd,
    env: { ...env, HOME: process.env.TANGO_REAL_HOME ?? env.HOME },
  }),
});
```

Expected result:

- Pi process sees isolated `HOME` and isolated `PI_CODING_AGENT_DIR`.
- Pi `bash` tool subprocesses see real `HOME`.
- Git/SSH/GitHub CLI/npm work normally from Pi bash tool calls.
- Pi auth/settings/models remain isolated.

Fallback only if the extension replacement proves incompatible:

```text
Pi process HOME=$TANGO_REAL_HOME
PI_CODING_AGENT_DIR=<runDir>/pi-agent
```

The fallback is less isolated and should not be the first choice.

## Generic harness

Generic shell agents should continue to inherit normal `HOME` by default. They have no separate model-runtime config to isolate unless a future generic role opts into a run-local home.

## Loom interaction

Loom aliases and registry resolution become less fragile when developer tooling sees real `HOME`. Loom-spawned agents should still prefer absolute Loom paths for durability:

```text
LOOM_DEFAULT=/absolute/path/to/.loom
```

rather than relying only on registry aliases.

## Risks

- Some non-Bash Claude tool subprocesses may still inherit isolated `HOME`; v1 targets the Bash tool because that is where developer commands run.
- Shell wrappers must avoid recursion and should exec a known real shell path.
- This changes command behavior inside agent-run Bash tools; validation should explicitly check `echo $HOME`, `git config --global`, `gh auth status`, and SSH/Git access.
- Pi bash replacement must preserve existing bash tool schema/rendering/streaming behavior by wrapping `createBashTool`, not reimplementing shell execution from scratch.

## Non-goals

- Perfect sandboxing of all subprocesses.
- Copying or symlinking arbitrary user dotfiles into run homes.
- Prompt-only instructions such as "remember to set HOME"; this should be an environment/tooling contract, not a model convention.
