# @bravo/async-subagents

Async subagent runtime for bounded, session-backed child agents, Pi milestone tasks, and optional budget-auto-swarm orchestration.

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

### Render cadence

The Pi extension drives its UI from the shared `@bravo/render-clock` rather than
its own `setInterval`. Two subscribers run: a session-long **non-visual** one
(status badge + task reconcile + wake-up polling, which never requests a render)
and a **visual** one that updates the live widget only while a time-dependent
item is visible (active runs/tasks, terminal rows within their expiry window, or
finished tasks within the 30 s grace). The widget's elapsed age now ticks live
via a fixed-width field whose width is reserved before summary truncation, so an
age tick is one width-stable line and idle sessions request zero renders. The
status badge is value-gated per `(ui, key)`. Dead-but-non-terminal "zombie" rows
left by a child that exited without a terminal status are reconciled (via an
injectable process-liveness probe) to `cancelled`/`failed` so they age out on
resume; rows with unknown/unsignalable or missing pids are kept. The root-session
lease is a non-render clock subscriber.

### Herdr presentation overlay

When the parent Pi process is running inside a Herdr-managed pane,
async-subagents reports a short-lived Herdr metadata overlay with
`pane.report_metadata`. This changes the visible status text under the Herdr
pane title while child subagents are active, without taking lifecycle authority
from Herdr's official Pi integration:

- source: `bravo:async-subagents`
- guarded to Pi panes with `agent = "pi"` and `applies_to_source = "herdr:pi"`
- active text: `async working (N subagent[s])`
- blocked text: `async blocked (N subagent[s])`
- inactive state clears only the async-subagents metadata fields

The overlay is display-only: async-subagents does **not** call
`pane.report_agent`, does not change Herdr waits/rollups, and does not compete
with `source = "herdr:pi"` for semantic `idle`/`working`/`blocked` authority.
It is refreshed on the existing 2 s non-visual poll cadence with a 7 s TTL, so
Herdr automatically drops the label if the parent Pi process exits before an
inactive clear can be sent.

The aggregate feeding that presentation is derived from canonical active/recent
run summaries, not from the visual widget window, so old uncollected terminal
results remain visible as active until handled. Before reporting it applies the
same non-visual guards used by the widget path: dead process-owned rows are
reconciled to terminal state, and terminal `resultReady` rows are kept active
only while their wakeup is current.

Inside each **child** Pi session the child-control extension is also a
`@bravo/render-clock` subscriber rather than owning its own `setInterval`: its
inbox poll (`async-child-inbox-poll`, 1 s) is a non-render subscriber that runs
the real `deliverInbox` on each due tick. The clock is injectable for
deterministic tests, the subscriber is established before the guarded immediate
delivery (a malformed pre-existing inbox cannot skip polling), and the inbox
cursor advances only after a successful `sendUserMessage` so a transient send
failure retries instead of dropping or double-sending a parent message.

## Budget auto swarm

Pi exposes a sticky, branch-scoped mode:

```text
/budget-auto-swarm on|off|status
```

Enabling it also enables task orchestration, displays the lavender `SWARM:auto` status, injects the durable ready-set scheduling policy, and guards every new Pi child start before allocation. New starts must use `variant: "luna"` with `thinkingLevel: high|xhigh|max` or `variant: "sol"` with `thinkingLevel: low|medium`; `fastTrack` is forbidden. Existing continuations retain their recorded launch identity. Turning the mode off leaves tasks enabled.

Claude Code users explicitly invoke `/budget-auto-swarm <objective>`. Its Opus 5 medium override lasts only for that invocation turn; reinvoke after user-authored continuation. Claude Code native Tasks are the sole Claude dependency graph and progress ledger; the CLI owns child-run lifecycle only. Installation links both Claude skills.

Pass one canonical `--store-cwd` to every run lifecycle command; `start --cwd` remains the separate child execution/discovery checkout.

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

Every built-in role has pure model variants `luna` (`bravo-codex-balanced/gpt-5.6-luna`) and `sol` (`bravo-codex-balanced/gpt-5.6-sol`) in addition to its existing `gemini` variant. Use the default by omitting `variant`; select a variant with `subagent_start({ agent: "scout", variant: "luna", thinkingLevel: "high", task: "..." })`.

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

Fast-track is sticky for the lifetime of the child lineage. Resuming a paused run keeps the same process and launch configuration. Continuing a terminal run creates a new process over the recorded Pi session and inherits fast-track when the prior run actually had it applied, even if `/fast-track` has since been disarmed. Runs where fast-track was merely requested but not applied do not inherit it.

## Codex auth balancer

When the balancer is enabled, every Codex-backed child launch is routed through the
per-request lease provider `@bravo/codex-auth-balancer`. Requested Codex models are
**remapped at launch**:

- `openai-codex/<X>` → `bravo-codex-balanced/<X>`
- `openai-codex-responses/<X>` → `bravo-codex-balanced/<X>`

The child then acquires a token lease per provider request (no long-lived per-child
credential copy). This is the normal Bravo Codex path and it eliminates the OAuth
refresh-token rotation race that the older copied-credential path was exposed to.

Provenance is preserved: the originally-requested model (e.g. `openai-codex/gpt-5.5`)
is what status, results, and metadata report. Only the *launched/exec* model changes —
the child `pi --model` and the `launchedModel` field in `launch.json` show the remapped
`bravo-codex-balanced/*` id.

### Extension requirement (important)

Child Pi launches are intentionally isolated with `--no-extensions`. A
`bravo-codex-balanced/*` model is registered by the codex-auth-balancer **provider Pi
extension**, so async-subagents adds that extension's loadable module
(`@bravo/codex-auth-balancer/extensions/pi` → `dist/extensions/pi/index.js`, resolved
robustly relative to the installed package) to the child `-e` list automatically for
every balanced launch. Before spawn, the cheap model preflight runs against the exact
isolated extension set and **fails closed** (`MODEL_PREFLIGHT_FAILED` with a
provider-extension hint) if the model still cannot resolve. The codex-auth-balancer
package must be built (`dist/extensions/pi/index.js` present) for this to work.

Enable it in `~/.async-subagents/config.json`:

```json
{
  "version": 1,
  "defaultExtensions": [],
  "codexAuthBalancer": {
    "enabled": true,
    "provider": "bravo",
    "stateDir": "~/.bravo/codex-auth-balancer",
    "mode": "process-env",
    "timeoutMs": 10000,
    "failClosed": true,
    "onlyForProviders": ["openai-codex", "openai-codex-responses"]
  }
}
```

`stateDir` is optional; it defaults to `CODEX_AUTH_BALANCER_HOME` or
`~/.bravo/codex-auth-balancer`. It is propagated to balanced children as
`CODEX_AUTH_BALANCER_HOME` so the provider extension reads the same lease state.
When the balancer is **disabled**, no remap occurs and the requested model launches
as-is (legacy behavior / escape hatch).

### Retired copied-credential path

The old path copied a refresh token into an isolated child auth home
(`<runDir>/auth/codex-balancer/...`) that then rotated it lock-free — the rotation race
class. It is now **dormant**: with the remap, balanced launches never trigger it, and
`prepareCodexBalancer` short-circuits to a no-op for any Codex provider string. It can
only be re-armed with the explicit opt-in flag:

```json
"codexAuthBalancer": { "enabled": true, "copiedCredentialsLegacy": true }
```

(or `CODEX_AUTH_BALANCER_COPIED_CREDENTIALS_LEGACY=1`). Under that flag the requested
Codex model is **not** remapped, the isolated auth home is prepared with
`PI_CODING_AGENT_DIR`/`CODEX_HOME` injected, the supervisor `syncBack`s refreshed OAuth
tokens after child exit and `cleanupLaunch`es on success, and a sync-back conflict
retains the isolated dir with `ASYNC_SUBAGENTS_RETAINED.json` for manual inspection.
Use it only for explicit maintenance/debug. `failClosed` (default true) still applies:
if legacy prepare-launch fails, the child run fails rather than silently using the
parent's auth. Set `failClosed: false` only for explicit maintenance/debug fallback.

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
- Per-run `summary.json` is updated by status, event, and result mutations. Widgets, compaction reminders, and wake-up polling use this compact summary for broad discovery and avoid scanning full event/result files for every historical run. They still open canonical files in bounded cases: result-ready rows may read `result.json` for current display/handled checks, and subscribed wake polling may scan `events.jsonl` to deliver pending question and blocked events exactly once.
- UI refreshes call `RunStore.listActiveOrRecentRuns()`, which prunes old terminal rows from the in-memory refresh set after their visibility window unless `resultReady` still needs attention. The pruning cache is invalidated by summary file changes and by the visibility boundary, so old completed/failed runs stop participating in hot widget refreshes while newly updated or unhandled-result runs reappear.
- `async-subagents archive [--older-than-days N] [--dry-run]` archives eligible handled terminal runs as `.tar.zst` files before removing live run directories. Active, recent, and unhandled-wakeup runs are skipped.

Model-facing wakeups are runtime envelopes marked `NOT USER INPUT`. Terminal result wakeups include the terminal `RunResult.body` inline, capped at 32,000 user-facing characters by default, while `message.details.result` keeps the full body redacted to avoid duplicate payloads. If the inline body is truncated, the wakeup includes a clear marker; use `subagent_result` as the canonical recovery path for overflow, artifacts, metadata, or rereading the stored `result.json`. If the inline body is untruncated and sufficient, the parent can continue without first calling `subagent_result`.

## Task orchestration

Task orchestration is enabled by default and sticks to the Pi session like Caveman mode: `/tasks on|off` writes a session-history marker, restores across session-tree updates, and syncs the runtime state used by tools. The Pi footer/status area shows a minimal `tasks:on` or `tasks:off` badge.

Commands:

```text
/tasks            # status
/tasks status     # status
/tasks on         # enable task orchestration for this async root session
/tasks off        # disable task orchestration for this async root session
```

Turning tasks off hides/disables `task_*` tools and task rows in the live widget while preserving direct `subagent_start` handoff.

Async subagents also provide a lightweight durable task layer scoped by root session. Tasks are parent-owned milestone board entries: use them for coarse multi-step milestones and hard dependency gates over time. Subagent runs remain normal execution attempts; they do not claim tasks, receive task tokens, call task-specific child tools, submit task receipts, or require parent acceptance through a separate result-ready state.

Parent tools are `task_create`, `task_list`, `task_get`, `task_update`, `task_cancel`, and `task_clear`. Stored task status is exactly `open`, `active`, `blocked`, `done`, `failed`, or `cancelled`; readiness is derived as `ready`, `waiting`, or `null` and exposed as `readiness`. `task_create` and `task_update` return `newly_ready` synchronously so the parent can schedule newly unblocked child attempts in the same turn. Task mutations do not emit `task.ready` wakeups and `task_update` returns no `next` field.

Recommended loop: create coarse milestones with `task_create`, start normal children directly with `subagent_start` when inputs are ready, collect normal child result/event wakeups, then update milestone notes/status/evidence with `task_update`. Attach child run IDs, receipt paths, artifact paths, and evidence through `task_update` after reading child results.

Task storage lives next to run delivery state under `session-tasks/<rootSessionId>/`. Old child-owned task records that contain removed statuses or ownership/result fields require migration/recreation rather than silent interpretation as milestone tasks.

## Runtime budgets and expiry continuation

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

The budget measures time the agent spent working, not wall clock. While a child's state is `blocked` or `waiting_for_input` the supervisor holds the clock and reinstalls the timers when it moves back — a run waiting on a human answer does not burn its budget and die at the deadline having done nothing since. An explicit parent `pause` still owns the clock outright; the hold never resumes a run the parent paused.

When a child approaches its budget, the supervisor appends an inbox warning asking the child to finish or emit a checkpoint. At hard expiry the supervisor sends SIGTERM to the child process group, captures the available output/checkpoint, and finalizes the run as terminal `expired` with error code `MAX_RUN_SECONDS_EXPIRED`. No budget-expired process is left paused.

A child killed mid-report has written nothing to stdout while everything it actually said sits in `events.jsonl`. Rather than finalize with an empty body, the supervisor reconstructs one from those event summaries and bodies, marked `# Reconstructed report` so it is not mistaken for the agent's intended deliverable.

Continue useful unfinished work from the recorded session by calling `subagent_continue` on the terminal run. This creates a new continuation run that replays the session state; use `additionalRunSeconds` to choose the smallest reasonable budget for the remaining work.

## Parent Tools

- `subagent_start`: start a durable async child run and return immediately; accepts `fastTrack: true` for armed, allowlisted critical-path launches.
- `subagent_status`: inspect current and recent child state.
- `subagent_result`: canonical backup/recovery read of terminal `result.json`; use for truncated wakeups, artifacts, metadata, or reread, and to mark terminal delivery handled.
- `subagent_message`: send normal parent input only (`instruction`, `answer`, `context`). Reports `delivery`: `acknowledged` (the child confirmed it inside the call's window), `queued` (durably in `inbox.jsonl`, pickup on the child's own cadence — the normal case, not an error), or `undeliverable` (the run is terminal; nothing will read that inbox again). Only `undeliverable` is a failure.
- `subagent_interrupt`: pause or cancel an active child.
- `subagent_continue`: resume an explicitly parent-paused child, optionally with `additionalRunSeconds`, or create a continuation from a terminal run's recorded session (including budget-expired runs). A terminal continuation inherits fast-track only when it was applied to the prior run; callers do not need or receive a `fastTrack` parameter. Its repeatable `files` input widens scope additively and never narrows or removes prior entries. Omitting `files` preserves the existing scope. Calling it on a run that is already running is not an error: the body is delivered as a message and the response carries `RUN_ALREADY_RUNNING` with the run's live state.

Allowed-file scope is a durable contract enforced through status, task prompts, and inbox amendments. Paths must be non-empty, single-line strings. This is not OS-level sandboxing or filesystem permission enforcement.

A run launched with `files` has a real `allowedFiles` list, and a grant unions into it. A run launched without `files` keeps its scope as prose in its brief, which the runtime cannot see or union with; a grant there is delivered as an additive amendment and `allowedFiles` stays unset. Writing the granted paths into `allowedFiles` would be a silent narrowing — telling an agent scoped to a subtree that its scope is now one file.

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
- child-control consumes inbox messages and emits `message.received`; required
  acknowledgement succeeds only after `message.handled`;
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

One binary carries the whole surface: the operator subcommands (`agents`, `start`, `run`, `watch`,
`status`, `wait`, `result`, `continue`, `message`, `pause`, `cancel`, `archive`, `install`) and the
internal entrypoints async child runs use (`supervisor`, `claude-child-mcp`).

All commands emit JSON on stdout; `watch` emits NDJSON. Errors are also JSON on stdout with a
non-zero exit, so a caller reading stdout can never mistake a failed `start` for a silent success.
Redirect stderr with `2>/dev/null` rather than `2>&1` when parsing: node prepends an
`ExperimentalWarning: SQLite` banner that will break `jq`.

## Agent templates

Five built-in role templates ship in `agents/`: `scout`, `planner`, `worker`, `reviewer`,
`generalist`. Discovery layers three sources, later ones shadowing earlier by name:

| Source | Location |
| --- | --- |
| `builtin` | `packages/async-subagents/agents/*.md` |
| `user` | `$ASYNC_SUBAGENTS_HOME/agents/*.md` (default `~/.async-subagents/agents`) |
| `project` | `<repo>/.agents/*.md` and `<repo>/.agents/subagents/*.md` |

`async-subagents agents --cwd "$PWD"` prints the resolved catalog with each entry's `source`.

A template names Pi extensions in frontmatter. Prefer a **package specifier**
(`@bravo/web-evidence-cache/extensions/pi`) over an absolute path: the child receives extensions
verbatim as `-e <value>` resolved against its own cwd, so an absolute path pins the template to one
machine's checkout. Specifiers are resolved to absolute paths at definition-load time. Absolute
paths and bare extension names still pass through untouched.

Overriding a built-in means copying it to the `user` or `project` layer — but note that a copy stops
tracking the shipped template, and your machine then exercises a path nobody else runs. Prefer
editing the built-in.

## Install

```sh
npm install && npm run build --workspace @bravo/async-subagents
node packages/async-subagents/dist/src/cli.js install
```

`install` makes two symlinks into this checkout — symlinks rather than copies so the documented flags
and the parsed flags can never drift:

| Link | Points at | Override |
| --- | --- | --- |
| `~/.claude/skills/pi-async-subagents` | `skills/pi-async-subagents` | `--claude-dir` |
| `~/.async-subagents/bin/async-subagents` | `dist/src/cli.js` | `--home` |

Either link refuses to replace a real directory or file unless you pass `--force`; an existing
symlink is reclaimed silently.

The CLI is intentionally left off PATH. `SKILL.md` names the launcher path literally, because the two
alternatives both fail: a bare `async-subagents` assumes a PATH entry nothing guarantees, and an
absolute install path differs per machine so it cannot be committed. `~/.async-subagents/bin/` is the
same string everywhere and needs no shell config. Adding it to PATH for interactive use is fine and
changes nothing for the skill.

## Validation

```sh
npm run check --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
npm run check
npm run build
pi list
```
