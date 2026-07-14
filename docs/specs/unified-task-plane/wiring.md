# Wiring

Internal semantics. Free to evolve as long as `contracts.md` holds. Owner for all
of it: `packages/task-plane`.

## Ownership (normative, per implementation-readiness)

- **Policy, validation, execution, persistence, delivery:** `packages/task-plane`,
  one extension entrypoint (`pi-extension-task-plane`). It registers all four
  tools, the single prompt module, and every session hook
  (`session_start`/`before_agent_start`/shutdown).
- **State root:** exactly one (`$PI_TASK_PLANE_HOME` or `~/.pi/task-plane`),
  layout `tasks/<task_id>/{metadata.json, output.log, model-wake.claim}` plus one
  active-index file. `~/.pi/monitor` and `~/.pi/background-bash` are retired.
- **Forbidden owners:** no other package, extension, or module holds a registry,
  dispatcher, state root, tool registration, or lifecycle hook for these tools.
  `packages/monitor` and `packages/pi-extension-background-bash` are deleted, not
  wrapped.
- **Value lifetimes:** task records are durable (survive process death); process
  handles/ownership are per-runtime (`ownerRuntimeId`); wake claims are per
  terminal event (durable, one-shot); delivery throttle state is in-memory
  per-runtime.

Kept unchanged from background-bash (moved, not reimplemented): 0600 output files,
payload-byte caps with sentinel-excluded accounting, process-group spawn +
SIGTERM→SIGKILL escalation, `ownedChildren`/`ownerRuntimeId` ownership, orphan
marking after reload, claim-file one-shot wake dispatch with strict route
validation.

## Terminal decision

- **bash / stream monitor:** normally finalize on child `close`, after stdio
  drains (the f020f73 rule). After the managed group leader exits, a detached
  descendant outside that process group may retain an inherited pipe forever.
  The supervisor therefore allows **5 seconds** for stdio drain; on expiry it
  destroys its local pipe readers, records `stdio_drain_timed_out`, and finalizes
  from the already-observed leader outcome. This is not authority to signal the
  detached descendant. The deadline bounds shutdown/stop while preserving normal
  drain-before-finalize behavior.
- **interval monitor:** evaluated per execution, in order: `command_timeout_s`
  exceeded or spawn error or command exit ≠ 0 → `failed`;
  `until_output_matches` against this execution's stdout → `completed`;
  lifespan expired → `timed_out`; else `running`, schedule next run. Timeout
  classification must be explicit — do NOT port the v2 baseline bug where
  non-numeric `exec` errors coerce to exit 0
  (`packages/monitor/src/checks/command.ts:18-20`), which silently treats a
  timed-out observer as successful. The v2
  `nonterminalV2PollChange` demotion, `computeNextState` machinery, and the
  internal `ConditionSpec` evaluator are deleted — the regex predicate replaces
  them.
- **stdout/stderr:** separate line buffers per descriptor everywhere (events,
  hashing, predicate = stdout only; output file = both). Raw output bytes are
  written and cap-accounted as they arrive, before newline framing; decoded text
  uses an incremental UTF-8 decoder. Interval stdout retained for hashing,
  events, and predicate evaluation is capped at the 5 MiB per-attempt budget in
  contracts.md; overflow terminalizes `failed`, never a silent truncated match.
  See contracts.md "Channel semantics".

## Delivery layer (replaces wake policy)

All notifications flow through one dispatcher that owns cost control:

- **Terminal:** dispatched for every terminal event, **at-most-once host
  invocation per task** (best-effort delivery — see contracts.md "Delivery
  guarantee") — claim-file one-shot + strict route validation kept verbatim.
  Metadata-only payload. Exception: session shutdown delivers nothing
  (contracts.md "Shutdown exception").
- **Monitor events:** batched per task (`throttle_s` window, default 1s; max 20
  lines per notification), delivered with stdout line content.
- **Flush batching:** all notifications pending in one dispatch flush go out as a
  single follow-up message containing complete envelopes. No aggregation or
  summarization occurs; terminal claim accounting stays per task. If a monitor
  produces stdout and then exits naturally before its throttle window flushes,
  the batch preserves order with a `status=running` event envelope followed by
  that task's metadata-only terminal envelope. Manual stop, flood stop, and
  suspension discard pending event envelopes instead.
- **Flood auto-stop (property, not vibe):** if a monitor emits more than
  **`flood_max_lines` (default 300) raw stdout lines within any rolling
  `flood_window_s` (default 60s)** — counted pre-batching, so throttling cannot
  mask it — the task is stopped: process tree killed, status `stopped`,
  `stop_reason:"event_flood"`, one terminal notification advising a tighter
  filter. Ordering: a natural exit or manual stop that races the flood decision
  wins (first terminalizer wins via the same claim discipline as wakes).
- **Honest dispatch states:** `dispatch_requested` → `host_api_invoked` |
  `dispatch_sync_failed`. Nothing persists "delivered"; the pi host gives no
  delivery acknowledgement. Ambiguous post-invoke persistence failure leaves
  `dispatch_requested` and is never replayed (no duplicate wakes; a missed wake is
  recoverable via `managed_task_list`, a duplicated one poisons context).

## Durability and rehydration (the new mechanism, fully traced)

v2 asymmetry (polls durable, streams in-memory-and-killed) becomes uniform.
Lifecycle for a stream monitor across a session boundary:

```
running (process live; deadline_at = started_at + lifespan_s, absolute, fixed
at creation — suspension does NOT pause the clock)
  → shutdown hook: stop scheduler claims; atomically mark suspension requested
    while RETAINING the attempt lease and process ownership; SIGTERM process group
  → process close during shutdown: atomically record attempt close, clear the
    lease/PID, and enter suspended state; no terminal state and no notification
  → next session_start (same session identity): registry sweep finds
    running+suspended monitor records owned by this session →
      now ≥ deadline_at → finalize timed_out (notify normally)
      else atomically claim-and-resume the SAME command (attempt n+1), append a
      restart sentinel to output.log, continue
  → respawn failure → failed (notify normally)
```

Every lifespan decision (sweep, rehydration, scheduler) derives remaining time
from the persisted absolute `deadline_at` — never from a stored "remaining"
value, which would silently stop the clock while suspended.

- Restart is safe because observer commands are re-runnable by definition — the
  workload-rejection heuristic is load-bearing for this and stays.
- Duplicate session starts / a second runtime: claim-and-resume is one registry
  transaction through the same lease/ownership check as interval claims — one
  runtime wins. An expired lease alone never authorizes respawn or signaling: if
  the prior process cannot be verified from a live in-runtime handle, the attempt
  becomes visible `orphaned` rather than risking duplicate execution or PID reuse.
- A `managed_task_stop` issued from a non-owner runtime persists a monotonic stop request.
  The live owner consumes and acknowledges it before signaling its own handle.
  A separate internal acknowledgement grace accounts for the scheduler/control
  tick; `kill_after_s` begins only after acknowledgement and remains the owner's
  SIGTERM→SIGKILL escalation delay. If acknowledgement cannot be obtained in the
  grace, the caller receives a `route` error; no runtime signals a PID/PGID read
  from metadata.
- Absolute lifespan expiry follows the same ownership rule. A runtime holding the
  live handle terminates and finalizes `timed_out`; a foreign runtime may persist
  the timeout stop request but must not terminalize or clear ownership around a
  possibly-live foreign process.
- Events pending (unbatched lines) at suspension are flushed to `output.log` only;
  they are not carried across the boundary as notifications.
- **bash tasks:** never restarted (workloads are not re-runnable); shutdown
  terminalizes them `stopped` without notification; reload without shutdown stays
  orphan-marking.
- **interval monitors:** unchanged mechanics — persisted, lease-based scheduler
  (1s tick, bounded concurrency), resume + terminal-wake backfill on session
  start.

## Scheduler

The interval scheduler is the v2 scheduler minus condition/triggered machinery:
claim due records (excluding suspended, suspension-requested, closing,
stop-requested, and outcome-pending attempts), run command, hash
`{exit_code, stdout}` for change detection, evaluate the terminal order above,
emit event notification on change, persist, reschedule. `lifespan_s` enforcement
lives in the shared registry sweep so it
covers streams too (fixes the v2 gap where stream `deadline_at` was stored but
unenforced).

## Error normalization

One boundary module maps every internal failure to the three-tier shape before it
reaches the agent. The implementation must include the exhaustive mapping table
(source exception/failure point → tier → suggested_action → side-effect status →
whether a notification is emitted) covering at minimum: spawn errors, invalid
regex, unknown `task_id`, foreign-session `task_id`, orphaned-task operations,
stop-escalation timeout, registry lock contention/failure, output append failure,
claim-file collision, post-dispatch persistence failure. A thrown internal
exception reaching the agent unnormalized is a bug.

## Faithful seams and injected faults (binding for the test suite)

Seams (per the seam-fidelity doctrine — cut at the true boundary, never above the
contract):

- **pi host boundary:** a deterministic harness that loads the REAL
  `pi-extension-task-plane` entrypoint into the real pi extension runtime (or the
  repo's established faithful pi-host harness) and observes real
  `sendMessage(..., {deliverAs:"followUp", triggerTurn:true})` routing — not a
  callback spy passed into internal classes. Assertions: exactly 4 tools + 1
  prompt module registered; follow-up reaches the owning session at most once —
  and exactly once absent injected faults — under a close/stop race;
  session-mismatch routes are refused.
- **processes:** real children, real process groups, real signals. No fake
  spawners.
- **store:** the real filesystem registry in a temp state root. No in-memory
  stand-in.

Injected faults (each must have a test; deterministic, at the port boundary):

- process: nonzero exit, spawn failure, kill mid-output, detached-grandchild
  close-delay, output-cap breach (both types), interactive-prompt stall,
  real-child `command_timeout_s` breach (interval mode → `failed`, never exit-0
  coercion);
- filesystem: write failure at each boundary — task creation, output append,
  terminal metadata, claim creation, dispatch-request persistence, post-invoke
  persistence — asserting recoverability, no fabricated dispatch state, no
  duplicate wake on rerun;
- delivery: close/stop race (exactly-once), flood boundary (limit−1, limit,
  burst, sustained), suspend/rehydrate with expired and with remaining lifespan,
  respawn failure, concurrent-runtime respawn contention;
- registry: concurrent admission at the cap (25th + 26th simultaneous), concurrent
  idempotency_key starts.

## Cutover mechanics

- One PR: `packages/task-plane` created; `packages/monitor` and
  `packages/pi-extension-background-bash` deleted (code, tests, prompt modules).
- At first load, check only whether each legacy root path exists. For each existing
  root, atomically create a dedicated notice marker under the unified state root;
  log its retirement only when marker creation succeeds for the first time. Leave
  the legacy root and all records untouched in place. Never enumerate directory
  entries or open, read, copy, transform, or migrate any legacy record.
- Repo prompts/skills referencing old tool names (`monitor_start`,
  `background_task_*`) are updated in the same PR. The cutover grep covers current
  operational docs, prompts, skills, and package surfaces. It explicitly excludes
  superseded historical specs, debates, feedback, and fixtures, which remain as
  historical evidence rather than current instructions.

## One-time proofs (not permanent tests)

Per repo testing doctrine, one-time greps over current operational docs, prompts,
skills, and package surfaces prove that old tool names and old package ownership
are gone and that there is no second registry. Explicitly superseded historical
specs, debates, feedback, and fixtures are excluded because they preserve evidence,
not live instructions. The two legacy root literals are expected only in the
single retirement detector and its focused tests; prove that no other current
surface references them. Record these greps in the change ledger rather than as
permanent vocabulary tests. Permanent tests are the behavioral set above, bound
to the faithful seams. Done gate: design.md "Definition of done".
