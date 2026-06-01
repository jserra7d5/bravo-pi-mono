# Debate brief: Pi background bash via extensions

## Question
Should Pi implement Claude-Code-like "background any script" capability by overriding/extending the built-in `bash` tool via a Pi extension, or by adding separate background task/monitor tools that coexist with the built-in `bash` tool?

## Context
User wants a mapped approach for Pi extensions to support backgrounding arbitrary scripts, comparable to Claude Code's `run_in_background`, completion notification, output-file reading, status/kill controls, and process cleanup.

Relevant Pi facts:
- Pi extensions can register custom tools, override built-in tools by registering the same name, add commands/shortcuts/UI/status/widgets/footer, mutate tool calls, modify system prompt, send messages, and persist session state.
- Built-in tools can be overridden. Renderer inheritance is per slot, but prompt metadata is not inherited.
- `createBashTool(cwd, options)` and `createLocalBashOperations()` are exported; `BashOperations.exec()` is synchronous one-shot: command/cwd/options -> Promise exitCode with output callback.
- Built-in `bash` schema is only `{ command: string, timeout?: number }`; no background flag.
- Built-in `bash` spawns shell detached on Unix, streams stdout/stderr to an `OutputAccumulator`, waits for child exit, and timeout/abort kills process group.
- Built-in `bash` supports `commandPrefix`, `spawnHook`, and custom operations, but the operations contract still returns only when command is complete.
- User-bash (`!`) can be intercepted separately via `user_bash`.
- Pi already has durable monitor tools in this environment, but these are extension/tooling-specific, not necessarily upstream Pi core. They provide command monitors with `monitor_start`, `monitor_output`, `monitor_stop`, notifications/wake_agent, etc.
- Pi README currently says: "No background bash. Use tmux. Full observability, direct interaction."

Relevant Claude Code facts:
- Bash schema includes `run_in_background`.
- Prompt says not to use `&`, and that completion notification will arrive later.
- Claude Code registers a background task ID, redirects output to a disk file, tracks task/process state, has stall/size watchdogs, posts completion task notifications, allows reading output via normal Read, and cleans up owned tasks on agent shutdown.

## Positions
- Debater A (GPT generalist): Argue for overriding/extending the built-in `bash` tool named `bash` with a `background`/`run_in_background` parameter, preserving one model-facing bash surface.
- Debater B (Gemini generalist): Argue for separate tools, e.g. `background_bash`, `background_output`, `background_list`, `background_stop`, possibly using/bridging durable monitor infrastructure, leaving built-in `bash` unchanged.

## Max rounds
2 rounds: opening and rebuttal.

## Convergence criteria
Stop after round 2. Judge should identify whether the design choice is substantive or if one option clearly dominates under Pi extension constraints.

## Initial feasibility pass
See `initial-feasibility.md`.
