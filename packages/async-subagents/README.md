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

Trusted parent extensions can request child loading by setting `ASYNC_SUBAGENTS_INHERITED_EXTENSIONS` to a path-delimited or JSON string-array list of extension module paths before launch. These inherited extensions are loaded after configured defaults and before agent-declared extensions, and are intended for session-scoped behavior propagation such as caveman response mode.

## Fast track

`/fast-track` is a lead-session speed policy for critical-path async children. It is intentionally separate from project-local `/fast`: `/fast` affects only the interactive UI session, while fast track authorizes selected noninteractive child launches.

Commands:

```text
/fast-track            # status
/fast-track status     # status
/fast-track on         # arm for this async root session
/fast-track off        # disarm
```

When armed, a lead agent can request priority service tier for one child launch:

```ts
subagent_start({
  agent: "worker",
  task: "Implement the critical-path slice...",
  fastTrack: true
})
```

Fast track is a scarce critical-path lever, not a blanket mode. Use it for implementation, planning, or gating-review children whose heavy output-token work bottlenecks the pipeline. Keep scouts, broad fanout, routine non-gating reviews, status checks, low-risk mechanical work, Gemini variants, and non-Codex providers on the normal lane.

Eligibility is fail-safe:

- `fastTrack: true` while `/fast-track` is off fails closed at the tool boundary.
- `scout` is never fast-tracked.
- `bravo-codex-balanced/*` is eligible because that provider family is the normal Bravo subagent path.
- `openai-codex/gpt-5.5` is eligible.
- Unknown `codex-*`, Gemini, and other non-allowlisted providers are not eligible and launch normally with fast-track metadata explaining why it was not applied.

Applied launches inject the package-owned `extensions/child-fast-track` child extension, which sets `service_tier: "priority"` in `before_provider_request`. Status/result metadata, launch logs, launch/result cards, and the live widget expose fast-track state for auditability.

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

Async subagents also provide a lightweight durable task layer scoped by root session. Use tasks for multi-step, dependency-ordered work over time; for simple independent parallel fanout, call direct `subagent_start` for each child instead of creating a task plan. Parent tools create/query/accept task state (`task_create`, `task_list`, `task_get`, `task_accept_result`, `task_reopen`, `task_cancel`, `task_clear`). `subagent_start({ taskId })` is the only spawn path for task-owned child runs; it validates readiness, claims the task, injects task identity/token env, and adds a task-owned result contract to the child prompt. Duplicate starts for already owned/running/result-ready tasks are idempotent and return the existing task/run state without launching another child. Children submit durable receipts with `task_submit_result` and may use `task_update_progress` or `task_report_blocked`; parent acceptance is still required before dependencies are satisfied.

The parent session owns scheduling, and the runtime keeps the loop moving with forward-progress wakeups rather than auto-spawning children (which agent runs a task is a parent decision). A task with no unresolved dependencies emits a `task.ready` wakeup — at creation for immediately-ready tasks, and at acceptance for dependents that just unblocked — so a created-then-idle session does not leave ready tasks sitting at `ready` forever. Ready wakeups are one-shot and re-checked at delivery: if the parent already claimed the task (the normal in-turn path) the nudge is skipped, so no spam. The suggested next action is the concrete one for each event — `subagent_start({ taskId })` for a ready task, `task_get({ taskId, view: "receipt" })` for a submitted result before accept/reopen, and `task_get` for failures or blockers — instead of always pointing back at a passive read.

A task-owned child can exit without ever calling `task_submit_result`. The parent extension runs a reconcile pass on every poll tick (UI and headless), so a dead owner transitions the task off `running` and wakes the parent, instead of stranding it as `running` until a manual `task_list`/`task_get` happens to inspect it.

Task storage lives next to run delivery state under `session-tasks/<rootSessionId>/`. `task_get` has a smart default: once a task has a submitted/accepted result, `task_get({ taskId })` includes the dereferenced receipt or an explicit missing/unreadable/invalid receipt diagnostic. Use `task_get({ taskId, view: "status" })` to opt down to compact status/pointers only. `task_get({ view: "receipt" })` surfaces the submitted receipt body, receipt path, and artifact paths; `subagent_result` for task-owned runs also includes the durable task receipt or receipt diagnostic so placeholder child finals can still be diagnosed from native tool output.

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

- `subagent_start`: start a durable async child run and return immediately; accepts `fastTrack: true` for armed, allowlisted critical-path launches.
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
