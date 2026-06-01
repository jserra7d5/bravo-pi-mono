# @bravo/async-subagents

Pi-only async subagent primitive for bounded, session-backed child agents.

The runtime is file-backed. By default, each child run gets a durable directory under a harness-owned cache outside the target repo:

```text
~/.async-subagents/projects/<project-hash>/runs/<runId>/
```

Set `ASYNC_SUBAGENTS_HOME` to move that cache root. Explicit `runRoot` callers can still choose a custom location. For run-id recovery across cwd changes, new runs are also appended to a harness-level lookup index at `~/.async-subagents/run-index.jsonl`; legacy project-local `.subagents/run-index.jsonl` files remain readable. A derived `run-index-cache.json` is maintained next to the project run index so direct-child and root-session lookups avoid repeatedly scanning historical JSONL.

Each run directory contains:

- `status.json`
- `events.jsonl`
- `inbox.jsonl`
- `result.json` after terminal completion
- `summary.json` compact derived read model for hot polling paths
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

## Codex auth balancer

Async subagents can optionally launch Codex-backed children through `@bravo/codex-auth-balancer`. The balancer does not expose arbitrary child env to agents; it internally prepares isolated auth homes and injects only:

- `PI_CODING_AGENT_DIR=<runDir>/auth/codex-balancer/pi-agent`
- `CODEX_HOME=<runDir>/auth/codex-balancer/codex`

Enable it in `~/.async-subagents/config.json`:

```json
{
  "version": 1,
  "defaultExtensions": [],
  "codexAuthBalancer": {
    "enabled": true,
    "provider": "bravo",
    "stateDir": "/home/joe/.bravo/codex-auth-balancer",
    "mode": "process-env",
    "timeoutMs": 10000,
    "failClosed": true,
    "onlyForProviders": ["openai-codex", "openai-codex-responses"]
  }
}
```

`stateDir` is optional; it defaults to `CODEX_AUTH_BALANCER_HOME` or `~/.bravo/codex-auth-balancer`. Balancing is fail-closed by default: if prepare-launch fails, the child run fails rather than silently using the parent's auth. Set `failClosed: false` only for explicit maintenance/debug fallback.

The supervisor calls the package `syncBack` API after child exit so refreshed OAuth tokens are copied back safely, then `cleanupLaunch` on success. If sync-back reports a conflict, the isolated auth directory is retained with `ASYNC_SUBAGENTS_RETAINED.json` and must be inspected or cleaned up explicitly.

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

## Performance read models and retention

The canonical files remain `run-index.jsonl`, `status.json`, `events.jsonl`, `inbox.jsonl`, and `result.json`. Hot Pi paths use derived projections instead:

- `run-index-cache.json` contains latest records plus parent/root-session maps. It is rebuilt automatically when stale and can be rebuilt explicitly with `RunStore.rebuildDerivedIndexes()`.
- Per-run `summary.json` is updated by status, event, and result mutations. Widgets, compaction reminders, and wake-up polling use this compact summary for broad discovery and avoid scanning full event/result files for every historical run. They still open canonical files in bounded cases: result-ready rows may read `result.json` for current display/handled checks, and subscribed wake polling may scan `events.jsonl` to deliver every pending question/blocked/paused timeout event exactly once.
- `pruneRuns(store, { olderThanMs, dryRun })` provides conservative manual retention. It never prunes active runs, `resultReady` runs, or runs with delivered-but-unhandled wakeups. `dryRun` defaults to true.

Model-facing wakeups are runtime envelopes marked `NOT USER INPUT`. Terminal result wakeups include the terminal `RunResult.body` inline, capped at 32,000 user-facing characters by default, while `message.details.result` keeps the full body redacted to avoid duplicate payloads. If the inline body is truncated, the wakeup includes a clear marker; use `subagent_result` as the canonical recovery path for overflow, artifacts, metadata, or rereading the stored `result.json`. If the inline body is untruncated and sufficient, the parent can continue without first calling `subagent_result`.

## Task orchestration

Async subagents also provide a lightweight durable task layer scoped by root session. Parent tools create/query/accept task state (`task_create`, `task_list`, `task_get`, `task_accept_result`, `task_reopen`, `task_cancel`). `subagent_start({ taskId })` is the only spawn path for task-owned child runs; it validates readiness, claims the task, injects task identity/token env, and adds a task-owned result contract to the child prompt. Children submit durable receipts with `task_submit_result` and may use `task_update_progress` or `task_report_blocked`; parent acceptance is still required before dependencies are satisfied.

Task storage lives next to run delivery state under `session-tasks/<rootSessionId>/`. Tool returns are compact by default: `task_get` starts with status/pointers and only returns receipt/full details when requested. Task result, failure, and input-needed events produce once-only parent wakeups with `task_get` as the suggested next action.

## Runtime budgets and timeout continuation

Agent definitions use second-based runtime budgets:

```md
---
maxRunSeconds: 1800
variants:
  quick:
    maxRunSeconds: 300
---
```

User config may provide a fallback:

```json
{
  "version": 1,
  "defaultMaxRunSeconds": 1800
}
```

Authored `maxRunMs` is rejected with a migration error. Internally the runtime records `effectiveMaxRunMs` for timers and diagnostics.

When a child approaches its budget, the supervisor appends an inbox warning asking the child to finish or emit a checkpoint. If the hard budget expires and the process group can be preserved, the run moves to `paused` instead of terminal `expired`; parent wakeups suggest either cancelling or resuming with a bounded extension, for example:

```ts
subagent_continue({ runId, additionalRunSeconds: 900 })
```

Choose the smallest reasonable `additionalRunSeconds` for the remaining work. If the result is no longer needed, cancel the paused run with `subagent_interrupt({ runId, action: "cancel" })`.

## Parent Tools

- `subagent_start`: start a durable async child run and return immediately.
- `subagent_status`: inspect current and recent child state.
- `subagent_result`: canonical backup/recovery read of terminal `result.json`; use for truncated wakeups, artifacts, metadata, or reread, and to mark terminal delivery handled.
- `subagent_message`: send normal parent input only (`instruction`, `answer`, `context`).
- `subagent_interrupt`: pause or cancel an active child.
- `subagent_continue`: resume a paused/timed-out child, optionally with `additionalRunSeconds`, or create a continuation for terminal runs.

Lifecycle controls are intentionally not accepted by `subagent_message`.

## Parent orchestration model

Async subagents are sibling child processes, not a task graph. A child cannot wait on another child, so the parent session owns dependency sequencing:

- Start independent child lanes concurrently when their inputs already exist.
- Do not pre-launch a dependent follow-up child with instructions to wait for another child to finish; it will run immediately.
- Collect prerequisite results from terminal wakeup bodies when untruncated/sufficient, or with `subagent_result` when you need overflow, artifacts, metadata, recovery, or a reread; then start the follow-up child with concrete files, diffs, artifacts, or claims to inspect.
- Prefer lane-level pipelining over batch barriers: when one lane becomes reviewable or otherwise ready for a downstream step, start that step without waiting for unrelated lanes.
- For delegated implementation that changes meaningful artifacts, normally run an independent review/remediation loop unless the change is trivial, review was explicitly waived, or no suitable review lane is available.

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
