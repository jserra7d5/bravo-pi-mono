# Contracts

Agent-facing surface of the unified task plane. Anything not specified here is
wiring and may change freely (`wiring.md`). Owner for everything on this page:
`packages/task-plane` (see design.md).

## Conventions (locked ecosystem-wide)

- **ID:** `task_id`, everywhere, for both task types. `monitor_id` is deleted.
  One generator, one prefix scheme (`bash-…`, `mon-…` prefixes are fine; the field
  name never varies).
- **Durations:** seconds, suffixed `_s`, agent-facing. Milliseconds never appear in
  a schema.
- **Timestamps:** ISO 8601 strings.
- **Booleans:** action flags are `verb_noun` (`run_in_background`); no `is_` prefix.
- **Envelope keys:** `tasks` for collections, `count` for counts. No pagination
  (the active-task cap makes it unnecessary).
- **Null vs missing:** optional result fields are omitted when not applicable
  (`exit_code` absent for a stopped task), never null.

## State vocabulary

One set for both task types. Model-facing state names are the stored state names —
no translation layer.

| State | Meaning | Terminal |
|---|---|---|
| `running` | live (includes starting; includes a suspended-but-resumable monitor between sessions) | no |
| `blocked` | live but likely waiting on interactive input | no |
| `completed` | ended successfully (exit 0 / predicate matched) | yes |
| `failed` | ended unsuccessfully (nonzero exit / spawn error) | yes |
| `stopped` | ended by intervention: `task_stop`, output cap, event flood, or session shutdown (bash only — see shutdown exception) | yes |
| `timed_out` | ended by max-runtime or lifespan expiry | yes |
| `orphaned` | live process from a previous runtime; unverifiable | no (unmanageable) |

`terminal(status)` ≡ `status ∈ {completed, failed, stopped, timed_out}`. All v2
monitor states outside the table above and the `event`/`ended` display mapping are
deleted.

## Channel semantics (stdout vs stderr)

Locked, identical for both monitor modes:

- **Events are stdout lines only.** stderr never produces events.
- **`until_output_matches` matches stdout only** (per interval execution).
- **Change detection (interval mode) hashes `{exit_code, stdout}` only.**
- **`output_path` receives both streams**, line-buffered per descriptor (no
  cross-descriptor chunk interleaving within a line), each poll execution prefixed
  with a timestamp/exit sentinel.
- An observer that wants stderr considered redirects it itself (`2>&1`). Prompting
  teaches this.

## `bash`

Unchanged except: **`wake_on_completion` is deleted.** Background completion always
notifies (delivery-layer batching handles noise; see `wiring.md`), with the
shutdown exception below.

```
bash({
  command: string,              // required
  timeout?: number,             // seconds. Foreground: return timeout.
                                // Background: max process runtime (min 30,
                                // default 1800, max 86400).
  run_in_background?: boolean,
})
```

Background start returns (text + `details`):

```
{ task_id, status: "running", output_path, max_runtime_s }
```

Invariants: output at `output_path` from the first byte; stdin never written;
descendants outside the managed process group are not supervised.

## `monitor`

```
monitor({
  command: string,              // required. Observer command. stdout lines = events;
                                // exit = terminal. Exit code 0 → completed,
                                // nonzero → failed.
  name?: string,
  interval_s?: number,          // min 5. Presence selects interval mode: harness
                                // runs command every N s, emits event when stdout
                                // changes. Absence = stream mode: command runs once,
                                // each stdout line is an event.
  until_output_matches?: string,// regex over stdout; interval mode only. Match →
                                // completed. Predicate input is capped at 5 MiB
                                // per execution; overflow → failed.
  lifespan_s?: number,          // max total watch time → timed_out. Enforced for
                                // BOTH modes.
  throttle_s?: number,          // min seconds between event notifications (default 1)
  cwd?: string,
  command_timeout_s?: number,   // per-execution timeout, interval mode only
  idempotency_key?: string,
})
```

Returns: `{ task_id, status: "running", output_path, mode: "stream" | "interval" }`.

Deleted from v2: `kind`, `emit`, `projection`, `wake`, `path`, `file_mode`,
`pattern`, `encoding`, `shell`, `labels`, `metadata`, `description`. Commands run
through pi's normal shell resolution, period.

### `idempotency_key` semantics

Scope: current session, **active tasks only** (`running`/`blocked`). A key match
returns the existing task with `idempotent: true`, ignoring parameter differences.
Terminal and `orphaned` records never match — restarting after completion creates
a new task. Matching and admission are one atomic registry operation (no
read-then-create race).

### Terminal decision (normative)

| Mode | completed | failed | timed_out | stopped |
|---|---|---|---|---|
| stream | process exit 0 | exit ≠ 0 or spawn error | `lifespan_s` expired | `task_stop` / event flood |
| interval | `until_output_matches` matched | command exit ≠ 0, spawn error, or **per-execution `command_timeout_s` exceeded** | `lifespan_s` expired | `task_stop` / event flood |

`lifespan_s` is wall-clock from task start (`deadline_at = started_at +
lifespan_s`, absolute); time suspended between sessions counts. A
`command_timeout_s` breach is an observer runtime failure (the observer itself is
broken), terminal `failed`, with the timeout recorded in the notification and
output file. Interval stdout used for hashing, event extraction, and
`until_output_matches` is decoded incrementally and capped at **5 MiB per
execution**. Exceeding that budget is an observer runtime failure: the task becomes
`failed` with an overflow sentinel in `output_path`. The predicate is exact within
the budget; it is never silently evaluated over a truncated window.

Session shutdown is **not** a monitor-terminal path: monitors suspend and resume
(see `wiring.md` rehydration); bash tasks terminalize as `stopped`. There is no
other terminal path and no non-terminal wake policy.

## Active-task cap

Max **25 active tasks per session across both types**. Active ≡
`running ∪ blocked`. `orphaned` does not count (it is unmanageable, not active),
but `task_list` always shows orphans so they are visible. Admission (cap check +
idempotency check + record creation) is a single atomic registry operation;
concurrent starts cannot overshoot.

## Output caps (per-type matrix)

| Type | Cap | On reaching cap | Retention invariant |
|---|---|---|---|
| monitor | 5 MiB | truncate oldest, watch continues (a truncation sentinel is written) | file ≤ cap + sentinel; newest bytes always present |
| bash | 10 MiB | process tree terminated → `stopped`, `stop_reason:"output_cap"` | everything up to the cap retained; sentinel appended |

Rationale: observer output is rolling evidence — the watch matters more than old
bytes; workload output is the product — silent loss is worse than stopping.
Sentinel bytes never count toward the cap accounting.

## `task_list`

```
task_list({ include_completed?: boolean })   // default false
```

Returns `{ tasks: [...], count }`; each item:
`{ task_id, type: "bash" | "monitor", status, name?, command, output_path,
started_at, ended_at? }`.

## `task_stop`

```
task_stop({
  task_id: string,
  signal?: "SIGTERM" | "SIGKILL",   // default SIGTERM
  kill_after_s?: number,            // escalation delay, default 5
})
```

For a task owned by the current runtime, returns `{ task_id, status: "stopped",
output_path }` only after process close and durable terminalization. For a task
owned by another live runtime, `task_stop` first persists a stop request and waits
for that owner to acknowledge it within an internal bounded acknowledgement grace,
then waits through the requested `kill_after_s` escalation delay plus the bounded
close/drain phase; success has the same return shape. `kill_after_s` controls
SIGTERM→SIGKILL escalation, not how quickly another runtime must notice the durable
request. If ownership is lost or acknowledgement does not arrive in the grace, it
returns a `route` error and leaves (or transitions) the task
`orphaned` when its execution cannot be verified. It never signals a PID/PGID from
persisted metadata. Stopping an already `orphaned` task also returns a `route`
error (see tiers).

## Notification envelope

One shape for both task types and both event classes. Delivered as a control-plane
follow-up turn, never as user input.

```xml
<task_notification not_user_input="true">
  <task_id>…</task_id>
  <type>bash|monitor</type>
  <status>running|completed|failed|stopped|timed_out</status>
  <output_path>…</output_path>
  <!-- terminal only, when applicable: -->
  <exit_code>…</exit_code>
  <signal>…</signal>
  <stop_reason>timeout|output_cap|event_flood|user|interactive_prompt</stop_reason>
  <failure_reason>command_timeout</failure_reason> <!-- failed interval execution only -->
  <!-- monitor events only (status=running): batched stdout lines, capped -->
  <lines>…</lines>
</task_notification>
```

- **Terminal notifications are metadata-only** (post-f020f73 rule): never command
  text, never output content. The agent reads `output_path`.
- **Monitor event notifications carry the batched stdout lines** — the line content
  *is* the signal. Caps: `throttle_s` batching window, max 20 lines per
  notification, and max **64 KiB decoded characters per line**. An oversized line
  is delivered once as its first 64 KiB plus an explicit truncation marker; it is
  never silently dropped, and `output_path` retains bytes according to the normal
  output-cap policy. Flood auto-stop remains line-count based (`wiring.md`).
- **Batching, not merging:** when multiple terminal notifications are pending in
  one dispatch flush, they are delivered as ONE follow-up message containing
  multiple complete `<task_notification>` blocks. The singular envelope is never
  aggregated or summarized; per-task exactly-once accounting (claim files) is
  unchanged.
- **Shutdown exception:** tasks terminalized by session shutdown are NOT notified —
  the owning session is dying and wakes are conversation-bound (no successor
  backfill for bash tasks; monitors suspend instead of terminalizing). Their
  terminal metadata persists and is visible via `task_list` in the next session.
- **Delivery guarantee (honest):** **at-most-once host invocation per terminal
  event, best-effort delivery.** The pi host provides no delivery
  acknowledgement, so exactly-once *delivery* is unprovable and is not claimed;
  the claim-file discipline guarantees no duplicate invocation, and a missed wake
  (ambiguous post-invoke persistence) is recoverable via `task_list`, never
  replayed. Persisted dispatch states say what is known (`dispatch_requested`,
  `host_api_invoked`, `dispatch_sync_failed`) — nothing may claim "delivered" on
  the basis of a returned host call.

## Error tiers

Three tiers, surfaced in every error return as `{ error_type, message,
suggested_action }` — both task types, no legacy shapes:

- `validation` — the input can never work. Do not retry unchanged; the message
  states the correct pattern. All dead-config rejections live here (below).
- `route` — wake/session routing or ownership cannot be satisfied (session
  mismatch, orphaned task, lost handle after reload). Do not retry; surface to the
  user if it blocks.
- `runtime` — the underlying process/system failed (spawn error, registry lock
  failure, output write failure). Retry or fall back is reasonable.

Every failure source in the implementation maps to exactly one tier; `wiring.md`
requires the exhaustive mapping table as part of the implementation, with
tool-boundary normalization tests for both task types (a thrown internal exception
must never reach the agent in a legacy shape).

## Validation rejections (teaching surface)

Configs that previously were accepted-and-dead are now `validation` errors whose
message text teaches the correct pattern:

| Rejected | Message teaches |
|---|---|
| `until_output_matches` without `interval_s` | stream monitors terminate by process exit; make the command self-terminating (e.g. `gh run watch --exit-status`) |
| `until_output_matches` that is not a valid regex | fix the regex; it is matched against each execution's stdout |
| `interval_s` with no `until_output_matches` and no `lifespan_s` | an unbounded interval monitor can only end by error or manual stop; give it a predicate or a lifespan |
| workload command in `monitor` | monitor observes; run workloads with `bash({run_in_background:true})` |
| `timeout < 30` on background `bash` | timeout is max runtime, not a return-quickly mechanism |
| `wake_on_completion`, `emit`, `projection`, `wake`, `kind`, `condition` params | removed in v3; state the replacement |
