# @bravo/async-subagents

Pi-only async subagent primitive for bounded, session-backed child agents.

The runtime is file-backed. By default, each child run gets a durable directory under a harness-owned cache outside the target repo:

```text
~/.async-subagents/projects/<project-hash>/runs/<runId>/
```

Set `ASYNC_SUBAGENTS_HOME` to move that cache root. Explicit `runRoot` callers can still choose a custom location. For run-id recovery across cwd changes, new runs are also appended to a harness-level lookup index at `~/.async-subagents/run-index.jsonl`; legacy project-local `.subagents/run-index.jsonl` files remain readable.

Each run directory contains:

- `status.json`
- `events.jsonl`
- `inbox.jsonl`
- `result.json` after terminal completion
- `artifacts/`
- `logs/`
- `pi-session/`

This package implements the storage contracts, markdown agent definition
discovery, root-session leases, prompt assembly, Pi child launch construction,
supervisor lifecycle, parent Pi tools, terminal status widgets, wake-up polling,
and the child-control transport used for inbox delivery and structured child
events.

## Defaults

Built-in agents are bounded oneshot agents:

- `scout`: read-only reconnaissance, `openai-codex/gpt-5.4-mini`
- `reviewer`: code review and risk checks, `openai-codex/gpt-5.5`
- `worker`: scoped implementation, `openai-codex/gpt-5.5`

The built-ins use fully-qualified `openai-codex/...` model ids so child Pi
processes use Codex OAuth instead of resolving through another provider.

Default child policy:

- `mode: oneshot`
- `context: fresh`
- `session: record`

Agent definitions may declare named `variants` that keep the same prompt/body but overlay launch config such as `model`, `thinkingLevel`, tools, skills, extensions, context/session policy, and budgets:

```md
---
description: Read-only repository reconnaissance.
model: openai-codex/gpt-5.4-mini
thinkingLevel: medium
tools: [read, grep, find, ls, bash]
variants:
  gemini:
    model: antigravity-code-assist/gemini-3.5-flash
    thinkingLevel: high
    extensions: [/absolute/path/to/gemini-code-assist/extensions/pi/index.ts]
---

You are a focused reconnaissance agent.
```

Use the default by omitting `variant`; use a variant with `subagent_start({ agent: "scout", variant: "gemini", task: "..." })`.

Provider-backed variants must include the provider extension that registers the model because child Pi launches are intentionally isolated with `--no-extensions`. Point `extensions` at a loadable Pi extension module file, such as `extensions/pi/index.ts` or `dist/extensions/pi/index.js`; a package extension directory may not be enough when async-subagents passes it through Pi's `-e` CLI flag.

Recorded children launch Pi with:

```sh
pi --session <runDir>/pi-session/session.jsonl \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --no-extensions \
  --append-system-prompt "" \
  --system-prompt <runDir>/artifacts/system.md \
  --tools <user-tools-plus-runtime-tools> \
  -e <child-control-extension> \
  --mode text \
  -p @<runDir>/artifacts/task.md
```

`session: none` is an explicit opt-out and uses `--no-session`.

When a child launch declares a model, async-subagents runs a cheap preflight using the exact isolated extension set before starting the child. If Pi cannot list the requested model, the run fails before spawn with `MODEL_PREFLIGHT_FAILED` and guidance to add the relevant provider extension. If a child still reaches Pi and Pi reports `Model "..." not found`, the supervisor augments the failure with the same provider-extension diagnostic.

`context: fork` requires a persisted parent Pi session. It branches the current
parent leaf with `SessionManager.open(...).createBranchedSession(leafId)` and
launches the child with the generated branch path as `piSessionPath`. It does
not use Pi CLI `--fork`, and it fails clearly unless `allowFreshFallback: true`
is explicitly set.

## Parent Tools

- `subagent_start`: start a child run.
- `subagent_wait`: wait for interesting events or terminal results.
- `subagent_status`: inspect current and recent child state.
- `subagent_result`: read terminal `result.json` and mark terminal delivery handled.
- `subagent_message`: send normal parent input only (`instruction`, `answer`, `context`).
- `subagent_interrupt`: pause or cancel an active child.
- `subagent_continue`: resume a paused child and optionally send normal input.

Lifecycle controls are intentionally not accepted by `subagent_message`.

## Verification Status

Validated in this repo:

- default bounded child creates a non-empty Pi session file using Codex OAuth;
- `context: fork` creates a generated branched Pi session and the child sees
  inherited parent context as reference material;
- child-control consumes inbox messages and emits `message.received` for
  required acknowledgement;
- pause, continue, and cancel work through durable status/result files;
- terminal wake-ups use `terminal:<runId>:<result.createdAt>` and are lease
  claimed, delivered, and handled without deleting `result.json`;
- package and repo validation pass with the commands below.

Manual visual TUI checks still need an interactive Pi terminal. The status line
and widget are file-backed projections, so headless validation covers the
underlying run files and delivery state, not terminal rendering pixels.

## CLI

```sh
async-subagents --help
```

The CLI exposes the supervisor entrypoint used by async child runs.

## Validation

```sh
npm run check --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
npm run check
npm run build
pi list
```
