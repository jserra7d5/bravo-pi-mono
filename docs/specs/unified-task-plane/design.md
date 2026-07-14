# Unified Task Plane (monitor + background bash v3)

## Status

Implemented and fully validated. Supersedes
`docs/specs/monitor-ergonomics-v2/` (the spec that produced the former
`monitor_start` v2 surface) and the agent-facing surface of
`docs/specs/pi-background-bash*/`. Wiring from both packages is largely retained;
the agent-facing contracts are replaced.

## Problem

A real incident (`/tmp/pi-monitor-terminal-predicate-issue.md`, 2026-07-12): a poll
monitor with `wake:"on_terminal"` watched a GitHub Actions run, the run completed,
and the monitor polled forever without waking the agent. Root cause is structural,
not usage error:

- v2 poll monitors can never reach a success-terminal state from an observation —
  `scheduler.ts` deliberately demotes every matched poll to a non-terminal event
  (`nonterminalV2PollChange`), and `computeNextState` never inspects observation
  content.
- The predicate system that could express `status == "completed"`
  (`conditions/evaluator.ts`) exists and is wired into the scheduler, but
  `monitor_start` rejects the `condition` param and hard-codes `condition: undefined`.
- `wake:"on_terminal"` is a delivery policy over a state machine that (for polls)
  has no reachable success-terminal; the config is accepted and silently does nothing.
- Adjacent dead configs: `emit:"terminal"` on polls mutes all matches;
  `emit`/`projection` on streams are accepted and ignored; stream `monitor_lifespan_s`
  is stored but unenforced.

A source-level comparison against Claude Code's Monitor and background-Bash tooling
(four-lane investigation, 2026-07-12; lane reports retained in session scratchpad)
showed the deeper divergence: Claude Code puts all semantics in the script and keeps
the schema tiny; pi reified polling, change detection, projection, and wake policy
as schema — and the declarative surface has a hole exactly where the agent needed it.

## Design principles

Adopted from what Claude Code's agent experience gets right, formalized via the
`harness-engineering:tool-design` skill:

1. **The script is the predicate language.** "When is this done" is expressed in
   shell, where it is testable and unbounded — never in schema. Every schema knob
   that duplicated shell (`emit`, `projection`, condition DSLs) is deleted.
2. **Process exit is the universal terminal signal.** One rule, no matrix. A monitor
   that cannot end is unrepresentable.
3. **Notify by default; manage noise at the delivery layer.** The agent must not
   predict at spawn time whether it will be idle later. Wake-mode enums and
   `wake_on_completion` are deleted; batching, collapse, throttles, and flood
   auto-stop are harness wiring.
4. **One task plane, one owner.** Agents reason by analogy across tools;
   consistency is what makes the analogy work. Both spawn verbs share one registry,
   one `task_id` namespace, one state vocabulary, one notification envelope, one
   management pair (`managed_task_list`, `task_stop`), and one error tier vocabulary — and
   all of it is owned by **one new package, `packages/task-plane`** (extension id
   `pi-extension-task-plane`), which registers all four tools, all session hooks,
   the single state root, and the single delivery dispatcher.
   `packages/monitor` and `packages/pi-extension-background-bash` are deleted in
   the cutover; no module outside `task-plane` may hold a registry, dispatcher,
   state root, or lifecycle hook. (Two packages sharing a registry seam would be
   bridging scaffolding between phases of the same effort — prohibited.)

## The model, in two sentences

> Run work you own with `bash({run_in_background: true})`; watch external state with
> `monitor({command})` whose stdout lines are events and whose exit means done.
> You will be told when anything finishes.

Everything else is wiring.

## Surface summary

| Tool | Role | Replaces |
|---|---|---|
| `bash` | run workloads; `run_in_background` for long-running | `bash` (drops `wake_on_completion`) |
| `monitor` | observe external state; **stdout** = events, exit = terminal | `monitor_start` (drops `kind`, `emit`, `projection`, `wake`, `file_*`) |
| `managed_task_list` | list tasks of both types | `background_task_list`, `monitor_list` |
| `task_stop` | stop a task of either type | `background_task_stop`, `monitor_stop` |

All four registered by `packages/task-plane` — one entrypoint, one prompt module,
one shutdown path.

Deleted outright: `background_task_status` (superseded by the completion
notification plus `read` on `output_path` — the same reasoning that led Claude Code
to deprecate `TaskOutput`).

Native tool count drops from 7 to 4. Exact schemas, states, envelopes, and error
shapes: `contracts.md`.

## Polling and the terminal predicate

`monitor` keeps `interval_s` as pure sugar: the harness runs the command every N
seconds and emits an event when output changes (hash-based, as today). Interval
monitors terminate in exactly three ways:

- `until_output_matches` (regex over the command's stdout) matches → `completed`.
  This is the single predicate parameter — one regex, not a condition DSL — and it
  closes the incident gap declaratively. Predicate input is exact up to the locked
  5 MiB per-execution budget; overflow fails the observer rather than silently
  matching a truncated window.
- command exits nonzero → `failed` (the observer itself broke);
- `lifespan_s` expires → `timed_out`.

The preferred spelling for lifecycle waits remains a self-terminating stream command
(`gh run watch --exit-status`); prompting and validation-error text both teach it.
The v2 `kind:"file"` is deleted — file conditions are one-liner interval commands
(`test -f p && echo EXISTS`), and a dedicated kind was a second way to say the same
thing.

## What is deliberately kept from pi

The comparison showed pi ahead of Claude Code in wiring; all of it is retained,
invisible to the agent: durable store with session-scoped identity and wake
backfill, one-shot claim-file wake dispatch with strict route validation, orphan
discipline after reload, process-group kill with escalation, capped per-task output
files, metadata-only terminal notifications (post-f020f73), and the
observer-vs-workload rejection heuristic.

New wiring obligation created by this design: interval scheduling and stream
supervision both hang off the unified registry, and monitors become durable
uniformly (see `wiring.md` — stream rehydration is the one genuinely new mechanism).

## Cutover

Clean cutover, no compatibility layer: `packages/task-plane` lands and
`packages/monitor` + `packages/pi-extension-background-bash` are deleted — code,
tests, and prompt modules — in the same PR. The v2 state-translation layer
(`event`/`ended` mapping), `wake_on_completion`, and `background_task_status` go
with them. At first load, the extension checks only whether each legacy root path
exists. For each existing root it atomically creates a marker under the unified
state root and logs retirement only when that marker is first created. The legacy
root and all records remain untouched in place: records are never enumerated,
opened, copied, transformed, or migrated. There are no external consumers of the
old tool names beyond prompts/skills inside this repo (grep is the inventory).

## Stop / re-plan triggers

Implementation stops and returns to planning (no narrow patching) when any of
these fire; after two failed implement/review cycles in one conceptual area, the
full invariant class is re-audited before any further patch:

- evidence moves registry/dispatcher/state-root ownership outside
  `packages/task-plane`, or a second registry/state root becomes the easy path;
- the pi host boundary cannot be exercised as a faithful seam (no way to load the
  real extension and observe real follow-up routing deterministically);
- stream suspend/rehydrate (wiring.md) cannot be expressed without a terminal-state
  contradiction, or requires new pi host APIs;
- a compatibility shim, dual tool registration, or old-name re-export becomes the
  easiest way to keep an intermediate state coherent;
- the cutover discovers an external consumer of the old tool names or state roots.

## Definition of done

Not "tests pass": the real code path ran. The `task-plane` extension entrypoint
loaded in a real pi extension harness registers exactly the four tools and one
prompt module; real child processes ran against the real filesystem registry; at
least one notification was routed through the real follow-up delivery boundary;
and the injected-fault set in `wiring.md` (process, filesystem, post-dispatch)
executed green. Evidence pasted, not asserted.

## Module map

- `contracts.md` — tool schemas, state vocabulary, ID/naming conventions,
  notification envelope, return shapes, error tiers, validation rejections.
- `prompting.md` — tool-coupled prompt module content: descriptions,
  use-when/avoid-when boundaries, the coverage rule, anti-patterns.
- `wiring.md` — internal semantics: terminal decision, delivery layer, durability
  and rehydration, registry unification, cutover mechanics.
- `implementation-plan.md` — handoff plan for the implementing lead: environment
  constraints (worktree-only builds/tests), work ordering, validation gate,
  review loop.
