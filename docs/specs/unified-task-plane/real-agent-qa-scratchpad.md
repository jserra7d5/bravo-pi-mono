# Unified Task Plane — Real-Agent QA Scratchpad

Date: 2026-07-13
Worktree: `/home/joe/Documents/projects/bravo-pi-mono-unified-task-plane`
Candidate commit: `17c0d5e`
Status: Complete — pass; default Pi composition proof added after list-tool rename

## Isolated launch

The interactive QA agent is launched in a dedicated `agent-4` tmux window with Pi's documented exact-load pattern:

```bash
PI_TASK_PLANE_HOME=/tmp/unified-task-plane-real-agent-qa/state \
PI_CODING_AGENT_SESSION_DIR=/tmp/unified-task-plane-real-agent-qa/sessions \
PI_SKIP_VERSION_CHECK=1 \
pi --no-extensions \
  --no-skills --no-prompt-templates \
  -e /home/joe/Documents/projects/bravo-pi-mono/packages/codex-auth-balancer/extensions/pi/index.ts \
  -e /home/joe/Documents/projects/bravo-pi-mono-unified-task-plane/packages/task-plane/src/index.ts \
  --provider bravo-codex-balanced --model gpt-5.5 --thinking medium \
  --name unified-task-plane-real-qa
```

Isolation intent:
- `--no-extensions` disables all discovered global/project extensions and packages, including legacy background-bash and monitor implementations.
- The only `-e` paths load the non-legacy authentication provider and the worktree's unified task-plane extension explicitly.
- Task state and Pi sessions use disposable `/tmp` roots.
- Skills/templates are disabled to reduce unrelated behavior shaping; normal repository context remains loaded.

## QA matrix

### Smoke
- [x] Startup/provenance visible and usable
- [x] Foreground bash
- [x] Owned background bash and completion notification
- [x] `managed_task_list` lifecycle visibility (named `task_list` during the original isolated pass)
- [x] Self-terminating stream monitor
- [x] Interval monitor with terminal predicate

### Advanced
- [x] Nonzero bash and monitor exits preserve output/status
- [x] Background timeout
- [x] Explicit `managed_task_stop`
- [x] Monitor idempotency key
- [x] Throttle/batching across multiple events
- [x] Lifespan terminalization
- [x] Per-poll command timeout
- [x] Output path usability
- [x] Default versus completed-inclusive task listing

### Adversarial
- [x] Agent routes workload away from monitor
- [x] Monitor workload heuristic rejects misuse
- [x] Retired parameters reject cleanly
- [x] Invalid/unbounded monitor shapes reject cleanly
- [x] Unknown/terminal task-stop routes reject cleanly
- [x] Event flood auto-stop
- [x] TERM-resistant process escalates and leaves no late side effect
- [x] Session shutdown suppresses notification and persists suspension
- [x] Expired suspended monitor terminalizes on resume
- [x] Live suspended monitor rehydrates and completes
- [x] No shell `&` or timeout-as-return-quickly behavior
- [x] Notification-driven flows proceed without task polling once the initiating turn ends

## Observations

- Isolation was verified from the real TUI startup header: only `pi` (the explicitly loaded auth provider) and `src` (the explicit worktree task-plane entrypoint) were loaded. Legacy background-bash and monitor packages were not discovered or enabled.
- Startup emits the task-plane's one-time retired-root notices without reading or migrating the legacy records.
- Smoke: foreground bash, owned background bash, self-terminating stream monitor, notifications, and the list tool (then named `task_list`; now `managed_task_list`) all worked. Runtime metadata and output files agreed with the agent transcript.
- Advanced A: background exits 0 and 7 were persisted as `completed` and `failed`; interval predicate completed on `STATE-2`; a duplicate `idempotency_key` start returned the same task id; the side-effect counter was exactly 2.
- Advanced B: a 30-second bash runtime cap produced `timed_out + SIGTERM + stop_reason=timeout`; explicit stop of a TERM-resistant task escalated to `SIGKILL + stop_reason=user`; both late side effects were absent. A five-event stream was delivered in 4+1 throttled batches. A six-second interval lifespan timed out after two ticks. All terminal records cleared PID, PGID, runtime owner, and lease.
- Notification-driven continuation works when the initiating assistant run actually ends after admission. Queued notifications trigger a fresh follow-up run with the expected task evidence.
- Graceful shutdown stopped owned bash with `SIGTERM + stop_reason=user`, suspended the monitor with `status=running + attempt_phase=suspended`, cleared all process ownership, suppressed shutdown notifications, and prevented the bash late side effect.
- First exact-session resume occurred after the monitor's 90-second absolute lifespan had expired. Rehydration correctly terminalized it immediately as `timed_out` without respawning or producing output.
- A second exact-session resume observed the monitor durably suspended, then rehydrated it with fresh PID, PGID, runtime owner, and lease. External release produced `RESTART2-EVENT`; the monitor completed exit 0 and resumed the agent through a notification.
- Nine malformed/misrouted requests were rejected synchronously with validation/route guidance and did not increase the durable task count.
- A 301-line stream auto-stopped as `event_flood`, retained exactly 301 events, cleared ownership, and left no process behind.
- Final terminal semantics: nonzero stream failed with exit 9; interval command timeout failed with `SIGKILL + failure_reason=command_timeout`; explicit monitor stop produced `SIGTERM + stop_reason=user`; default task listing returned 0 while completed-inclusive listing returned all 16 terminal tasks.
- Post-merge default-install verification exposed a composition blocker hidden by the isolated launch: the globally enabled async-subagents package already registers the milestone-board tool `task_list`. Pi rejected task-plane's process/monitor list tool with the same name. (The stop tool—then `task_stop`, now `managed_task_stop`—was unique.)

## Findings

### F-01 — Agent can accidentally defeat notification-driven waiting (prompt/ergonomics, non-blocking)

In the first smoke run the agent said it would wait, but called `task_list` immediately in the same assistant run. Because task notifications are delivered only after the active run settles, the cards and custom messages were appended after the agent's summary. A later notification-triggered turn merely said no further action. Explicitly instructing the agent to end its response immediately after admission produced the intended lifecycle in Advanced A.

Evidence: session JSONL entries 11–16 in `/tmp/unified-task-plane-real-agent-qa/sessions/2026-07-14T00-02-33-496Z_019f5dee-b798-7a7f-b8bf-4242548f0b66.jsonl`.

Follow-up applied: the shared task-plane guidance now teaches that waiting is an idle state, preserves useful independent work, and tells the agent to end the current response instead of calling `managed_task_list`, sleeping, or polling merely to keep the turn alive.

### F-02 — Isolated CLI startup shows stale model-scope warnings (QA harness UX, not task-plane)

With discovered extensions disabled, Pi initially warns that globally enabled `bravo-codex-balanced/*` scope patterns are unmatched before the explicitly loaded auth provider registers them. The provider then refreshes the scope and operates normally. This is harmless but noisy in exact-extension QA launches.

### F-03 — Command-text `pgrep -f` is a lying process-cleanup probe (QA probe error, not task-plane)

The flood-pass agent used `pgrep -f` with the literal monitored script embedded in its own foreground verification command. `pgrep` matched that verifier, reporting `process-remains` even though durable PID/PGID/runtime/lease fields were cleared and external process-table inspection found no monitored process. Future hand-guided probes should preserve the admitted PID/PGID before terminalization and test that identity, not grep command text.

### F-04 — Default Pi tool-name collision with async-subagents (resolved)

The global async-subagents package owns `task_list` for its parent milestone board. Task-plane defined the same name for process/monitor lifecycle visibility with a different schema and semantics. (Its stop tool is unique; async-subagents uses `task_cancel`/`task_clear`.) Pi rejected the duplicate custom tool registration before startup:

```
Failed to load extension ".../packages/task-plane/src/index.ts":
Tool "task_list" conflicts with .../packages/async-subagents/extensions/pi/index.ts
```

The isolated real-agent pass used `--no-extensions`, so async-subagents was intentionally absent and could not expose this composition failure. Load order and “lead extension” status cannot safely resolve it; Pi permits overriding built-ins such as `bash`, but custom-tool duplicates fail closed.

Resolution: task-plane's management pair is now `managed_task_list` / `managed_task_stop`. A real Pi loader composition proof loads task-plane and async-subagents together and verifies that task-plane's managed tools and async-subagents' milestone-board `task_list` register without collision.

## Final assessment

**Pass.** The unified task plane worked through a real interactive Pi agent across foreground/background execution, stream and interval observation, notification continuation, idempotency, throttling, terminal errors, stop escalation, runtime/lifespan/command timeouts, flood control, durable shutdown, expiry-on-resume, and successful rehydration.

F-01 was addressed with one compact addition to the shared injected guidance. F-02 is isolated-launch noise outside task-plane behavior. F-03 is a QA-probe lesson. F-04 was resolved by the narrow task-plane list-tool rename and a real-loader composition proof.

Evidence roots:
- Pi session: `/tmp/unified-task-plane-real-agent-qa/sessions/2026-07-14T00-02-33-496Z_019f5dee-b798-7a7f-b8bf-4242548f0b66.jsonl`
- Durable tasks/output: `/tmp/unified-task-plane-real-agent-qa/state/tasks/`
- Tmux window used during the pass: `agent-4:3`
