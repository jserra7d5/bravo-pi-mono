# Prompting

Tool-coupled prompt modules: each tool ships its usage guidance; the extension
injects it via `before_agent_start` only when the tool is registered and its
override is verified through the fail-closed ownership check in
`packages/task-plane/src/index.ts`. No agent prompt references these tools
directly.

## The decision boundary (shared module, injected once)

The selection prior is taught by notification count, mirroring Claude Code's rule,
plus pi's ownership boundary:

> Pick by what you're waiting for:
> - **One notification when something you own finishes** → `bash({command,
>   run_in_background: true})`. Tests, builds, installs, migrations, dev servers,
>   scripts. You'll be notified when it exits — do not poll, do not append `&`.
> - **A notification per occurrence from something external** → `monitor({command})`.
>   Logs, CI/deploy status, health checks, queue depth, file conditions. Each stdout
>   line is an event; the command's exit ends the watch.
> - Nothing to wait for → plain `bash`.

## Waiting means becoming idle

After admitting background bash or a monitor, the agent may continue useful independent
work. When no independent work remains, waiting means ending the current response and
becoming idle—not calling another tool to keep the turn alive. The task plane delivers
notifications as follow-ups with turn triggering, so it asynchronously resumes the same
session. `managed_task_list`, sleeps, and polling are inspection mechanisms, not wait mechanisms.

## Per-tool use-when / avoid-when

`bash` (background):
- use_when: long-running work whose process you own and whose single completion
  you care about.
- avoid_when: the command observes external evidence/state → `monitor`; the command
  finishes in seconds → foreground.

`monitor`:
- use_when: watching external state change over time; streaming another system's
  events.
- avoid_when: running a workload → background `bash`; a one-shot "wait until done"
  where a self-terminating command exists → still `monitor`, but as a stream with
  that command (`gh run watch --exit-status`), not an interval poll.

## The coverage rule (ported from Claude Code, mandatory)

> **Silence is not success.** Your monitor command must produce a terminal signal
> for *every* outcome, not just the happy path. A stream command must exit on
> failure states too (prefer `--exit-status`-style flags); an interval monitor's
> `until_output_matches` must match failure statuses as well as success, or be
> paired with `lifespan_s` as a backstop. Before starting a monitor, ask: *if the
> watched thing crashed right now, would this monitor end?*

This is the prompting half of the incident fix; the schema half is
`until_output_matches` + the validation rejections in `contracts.md`.

## Anti-patterns taught

- Appending `&` instead of `run_in_background`.
- `timeout: 1` on a background task to return quickly (also rejected).
- Polling a task you'll be notified about; sleep-loops around failing commands.
- Piping monitor output through buffering stages (`grep` without `--line-buffered`,
  `head`) — matches sit unseen in the buffer.
- Expecting stderr to produce events or match `until_output_matches` — events and
  the predicate see stdout only; redirect with `2>&1` if stderr matters.
- Watching only the success marker (coverage rule above).
- Using monitor to run workloads (also rejected).

## Control-plane framing (kept from v2)

Every notification is prefixed/attributed as control-plane evidence, not user
input, with the standing instructions: inspect `output_path` with `read` only if
needed; continue the active workstream; tell the user only if it changes the
outcome, blocks progress, or completes the task.

## What the modules do NOT contain

Wake-policy guidance ("wake is expensive, opt in only when idle…") is deleted —
there is no wake policy to teach. Delivery cost is a harness problem
(`wiring.md`: batching, collapse, flood auto-stop), not an agent decision.
