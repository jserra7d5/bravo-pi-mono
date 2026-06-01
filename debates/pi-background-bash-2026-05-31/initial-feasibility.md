# Initial feasibility pass

## What Pi extension APIs support
- Register custom tools and commands; override built-in tools by registering the same tool name.
- Manage active tools (`getActiveTools`, `setActiveTools`) and inspect all tools.
- Use lifecycle events (`session_start`, `session_shutdown`) for restore/cleanup.
- Use `pi.sendMessage`/`sendUserMessage` to inject notifications/follow-ups.
- Use custom renderers/status/widgets/footer for UI affordances.
- Use `pi.exec`, Node `spawn`, filesystem, and arbitrary TS code inside trusted extensions.
- Custom tools can stream partial updates via `onUpdate` and return `details` for render/session reconstruction.

## What built-in bash exposes
Source: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/tools/bash.ts`.
- Schema: `{ command, timeout? }` only.
- `createBashToolDefinition()` has fixed schema and synchronous execute contract.
- `createLocalBashOperations().exec()` uses Node `spawn`, pipes output, waits for completion, kills process group on timeout/abort.
- `BashOperations` can replace execution, but its contract cannot return a background task result shape without also replacing the tool definition/schema.
- `spawnHook` can mutate command/cwd/env only; it cannot add background job management.

## Feasible extension designs
1. Override `bash` completely:
   - Register a tool named `bash` with extended schema `{ command, timeout?, run_in_background? }`.
   - For foreground, delegate to `createBashTool()` or reimplement equivalent local execution.
   - For background, spawn command directly, redirect stdout/stderr to a file, record task id/pid/process group/output path/status in extension state, return immediately.
   - Add slash commands and/or auxiliary tools for list/status/output/stop.
   - Prompt metadata must be rewritten; built-in prompt snippet/guidelines are not inherited.

2. Add separate background tools:
   - Keep built-in `bash` unchanged.
   - Register `background_bash` plus `background_output/list/stop` (or single multiplexed `background_task`).
   - For output, either return path for built-in `read`, or expose a tail/read tool.
   - Can be implemented with native Node process registry or by wrapping existing monitor infrastructure if packaging/runtime dependency is acceptable.

## Main risks
- Extension state is per extension runtime; real background process handles disappear across `/reload`, session switch, or Pi restart unless persisted and reattached by PID/output files.
- Cross-session ownership and cleanup need careful semantics: kill on `session_shutdown`? only quit? not reload? opt-in persistence?
- Injecting completion notifications from background processes must avoid noisy/recursive turns.
- Process tree handling must be Unix/Windows aware.
- Output files need size caps and prompt/stall detection to avoid runaway logs/interactivity deadlocks.
- Overriding `bash` is a high-blast-radius replacement of a core tool contract.
