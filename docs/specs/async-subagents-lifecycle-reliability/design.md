# Async-subagents lifecycle reliability + transcript archival

Status: FINAL 2026-07-15. Decisions locked after two independent reviews (opus design lane; sol diagnosis lane run_mrmdhl0m_EwDA8vAM-EQ — full state-machine inventory, death matrix, and proposals recorded in that run's result).
Owner: Joe (lead: Claude session 2026-07-15).

## Problem

Poll-only parents (Claude Code) routinely fail to detect subagent lifecycle changes. Two structural gaps:

- **Attention gap** — budget expiry SIGSTOPs the child process group and writes `state: "paused"` (`src/supervisor.ts` `pauseForBudget`). Non-terminal by design, invisible to terminal-only watchers. Frozen budget-paused children observed alive 11–35h after expiry.
- **Crash gap** — an ungracefully dead supervisor (SIGKILL, reboot, OOM) leaves `state: "running"` forever. The stdio supervisor records only the **child** pid — never its own (`supervisor.ts:407-467`; only tmux writes `supervisorPid`). `reconcileProcessHealth` (`extensions/pi/tools.ts:350`) patches `processHealth` only, never `state`, only fires on an explicit `subagent_status` call, writes without the run-mutation lock, and misclassifies EPERM as dead.
- **Startup orphan gap** — launcher death between writing `queued`/`created` and spawning the supervisor leaves a run no process will ever own (`start.ts:650-690`, spawn at `start.ts:1081-1098`).
- **Torn finalization** — `finalizeTerminalRun` writes result.json → events → status in order, not transactionally (`lifecycle.ts:115-151`); a crash mid-sequence leaves result.json present with non-terminal status, and no poll-only reader repairs it (`awaitStableResult` exists but only a live supervisor calls it).

Evidence (this machine, 2026-07-15): of the 600 most recently touched runs — 20 wedged `running`, 8 `paused`, 2 `blocked`, all >1h stale. The skill's documented monitor loop tests non-existent states (`timeout|error`), misses `expired`, and globs 43,030 project-scope dirs per iteration. `~/.async-subagents` is 13 GB / 329k status files; global `run-index.jsonl` is 110 MB, append-only, fully parsed on cross-project runId lookups. `start`'s "async wakeups" promise requires a live pi lease + 2s extension timer (`wakeups.ts:378-388`, `extensions/pi/index.ts:504-524`) — no push channel exists for CLI parents.

## Decisions

**D1 — Budget expiry becomes terminal `expired` on the stdio path.** Delete SIGSTOP-on-budget in `pauseForBudget`: finalize via `finalizeTerminalRun` with state `expired`, keeping the pre-expiry soft-warning inbox message, with the run's captured output as body. The tmux path already expires terminally; stdio is the outlier. Resume path is `subagent_continue` on the terminal run (recorded session replay — the session is the state). `paused` remains ONLY for explicit `subagent_interrupt action=pause`. No `budgetOutcome` config flag (sol proposed pause-as-default + policy flag; rejected: a resumable frozen PID buys little over session replay, costs held checkouts/auth slots — 11–35h frozen PIDs observed — and a policy flag is a dual path).

**D2 — New `watch` CLI subcommand: the detection contract for poll-only parents.**
`async-subagents.mjs watch --cwd DIR --run-id A [--run-id B ...] [--interval-seconds N=5] [--no-result-body]`
- Resolves run dirs via the index (`resolveRunDir`) — never globs project dirs.
- Per poll, per run, in order: (1) **result-first repair** — if `result.json` exists but status is non-terminal, repair status under the run lock (reuse `awaitStableResult` logic); (2) **reconcile** (D3); (3) read status.
- Emits one NDJSON line per observed state transition: `{"runId","state","bucket","summary","supervisorAlive","attentionReason"?}`.
- **3-bucket parent contract**: `terminal` (`completed|failed|cancelled|expired`), `attention` (`paused|blocked|waiting_for_input`), `busy` (everything else, incl. writer-less `idle`/`stalled`). Machine-readable `attentionReason` (e.g. `budget_expired` — until D1 ships nothing emits it, kept for explicit pauses/questions), never summary-text matching.
- **Inline results (saves the `result` fetch step):** on a terminal transition, include `resultSummary` always, and `resultBody` (capped 16k chars, truncation marker pointing at `result --run-id`) exactly once per run globally — guarded by a `result-reported.json` marker written in the runDir under the run lock. Later watchers of the same run emit `"resultReported":true` + `resultPath` instead of the body. `--no-result-body` suppresses bodies.
- Missing/corrupt run dirs → explicit `{"runId","error"}` line, never silence.
- Exits 0 with a final `{"allSettled":true}` line when every tracked run is terminal-or-attention.
- Designed to be wrapped by Claude Code's Monitor tool; replaces the skill's hand-rolled loop. `wait`/`run` remain for single-lane synchronous consumers but the skill demotes them.

**D3 — Read-side reconciliation, shared, lock-guarded, identity-checked.** New `reconcileUnderLock(store, runId)` in `src/lifecycle.ts` (or sibling):
- Supervisors (stdio AND tmux) record at startup: `supervisorPid: process.pid`, `supervisorHost: hostname()`, `supervisorStartedAtToken` (process start-time identity, reusing the model in `runLock.ts` — bare pid probes suffer reuse + EPERM misclassification).
- Inside `withRunMutationLock`: re-read status; if non-terminal AND `supervisorHost === hostname()` AND the identity probe says definitively dead → finalize `failed` / `SUPERVISOR_DIED`. EPERM or identity-mismatch-uncertain → report `supervisorAlive:"unknown"`, never promote. Cross-host → never promote. Idempotent (second reconciler sees terminal, no-ops).
- **Startup-orphan promotion:** `created|queued` older than a grace window (5 min) with no recorded supervisor identity (or a dead one) → finalize `failed` / `SUPERVISOR_LAUNCH_FAILED`. Closes the launcher-death window without a new handshake protocol.
- Replace `reconcileProcessHealth`'s inline logic in `subagent_status` with this helper — one code path; fixes the unlocked-write race and the state-promotion gap in the same cut.
- **No periodic heartbeat in v1** (sol ranked it ship-with; deferred): with D1, healthy-but-slow runs are budget-bounded; the dominant wedge class is dead-supervisor, covered by identity probes; heartbeats add write amplification and suspend/resume false positives. `watch` reports `updatedAt` staleness so the parent can judge live-but-quiet runs. Revisit only with cross-host runs or observed alive-but-wedged supervisors.

**D4 — Archive, never delete: runs terminal (or D3-reconciled) and untouched for >7 days.**
- `async-subagents.mjs archive [--older-than-days N=7] [--dry-run]`: reconcile-first (D3), then for each eligible run `tar --zstd` the entire run dir to `~/.async-subagents/archive/YYYY-MM/<runId>.tar.zst`, append `{runId, agentName, state, createdAt, archivedAt, projectScope, archivePath}` to `~/.async-subagents/archive/archive-index.jsonl`, then remove the run dir. Reuse `pruneRuns` eligibility (skip active, skip unhandled wakeups). **Include the legacy top-level `~/.async-subagents/runs/` tree.**
- Opportunistic sweep on `start`: budget-capped (≤25 runs), best-effort, never blocks or fails the start.
- Run-index compaction in `archive`: atomically rewrite project + global `run-index.jsonl` dropping records whose runDir no longer exists; remove empty project-scope dirs.
- Archived runs are not continuable in place; manual recovery = extract tarball. Accepted (7-day-dead runs won't be continued).
- `~/.pi/agent/sessions` same policy, separate later pass — not in the first PR.

**D5 — Truthful delivery contract in responses.** `start`/`continue` responses gain `delivery: {mode: "pi-poll"|"none", pushAvailable: bool}`; the wakeup-promise summary text appears only when a live pi runtime capability exists — CLI parents are pointed at `watch`. `subagent_status` response gains `scope:"explicit"` + `requestedRunIds` (it is already per-run for explicit ids — the skill's aggregate warning is stale; fix both sides).

**D6 — Skill rewrite.** Replace the ~100-line "Getting told when a lane finishes" section with the `watch`+Monitor contract (~10 lines: arm one Monitor wrapping `watch`; terminal vs attention buckets; results arrive inline). Delete warnings whose failure modes no longer exist (verbatim-loop, glob-discovery, result-as-signal, stderr-suppression, wrong state list, stale status-aggregate warning). Correct: "`continue` blocks" → only with `--timeout-seconds`; the SIGTERM incident explanation → harness kills the descendant tree (proven by run_mrlgo498's supervisor log: detachment does not remove ancestry; a waiting wrapper keeps the new supervisor in the killable tree) — the keep-blocking-calls-in-background rule stays, now with the true mechanism. Keep: verify-the-work-yourself, implausibly-short-run skepticism, never-two-write-lanes-per-checkout. Document `archive`.

**D7 — 3-bucket parent contract everywhere parent-facing.** `watch` output, skill doc, and `subagent_status` summaries speak buckets first. No new states; `idle`/`stalled` (writer-less) are not exposed as meaningful.

**D8 — No daemons, sockets, inotify, exec-hooks, or event buses.** On-read reconciliation inside `watch` is self-limiting and sufficient. An on-terminal receipt-file hook (sol rank 6) is unnecessary — Monitor+`watch` already delivers push to the only consumer we have, and a hook cannot fire from a dead supervisor anyway.

## Resolved open items

- **O1 (continue death):** not a runtime defect. Terminal continuation spawns a properly detached supervisor; the harness's timeout kill terminates the whole descendant tree (cgroup/recursive), which detachment cannot escape while the waiting wrapper keeps the ancestry alive. Fix is contractual: skill teaches background-launch + `watch`; D5's truthful responses remove the temptation to block.
- **O2 (status aggregate):** stale skill claim; `subagent_status` with explicit runIds is already per-run. D5 adds explicit scope fields; D6 fixes the doc.
- **O3 (extra wedge classes):** startup orphans (`created|queued`, F5) → D3 grace-window promotion; sticky `waiting_for_input`/`blocked` (F6) → attention bucket; writer-less `idle`/`stalled` (F12) → busy bucket + staleness reporting; torn finalization (F8) → D2 result-first repair.
- **O4 (watch surface):** `status.json` is lifecycle ground truth (atomic rename writes); `result.json` reconciled first; `events.jsonl` consulted for attention detail (`attentionReason`); `summary.json` never trusted (derived cache, bypassed by child-control writes).

## Implementation lanes

1. **Runtime lane** (sol worker): D1, D2, D3, D5, D7 in `packages/async-subagents` + tests. Branch `async-subagents-lifecycle`.
2. **Archive lane** (sol worker): D4. Sequenced after lane 1 (same checkout; shares reconcile helper).
3. **Skill lane**: D6 + wrapper `watch`/`archive` passthrough (`~/.claude/skills/async-subagents/` — outside repo; parallel-safe with lane 2).
4. **Review + closure**: opus intent review + sol code review; live gates below; one-time archive sweep of the existing 13 GB debris.

## Verification (faithful seams; real code paths; injected faults)

- Expiry: real stdio supervisor over a slow fake child with small `effectiveMaxRunMs` → terminal `expired` result, output body preserved, no SIGSTOPed process left, `wait`/`run` return instead of hanging.
- Reconcile: real supervised run, SIGKILL the supervisor → `watch` promotes to `failed/SUPERVISOR_DIED` under lock; concurrent second `watch` no-ops; foreign `supervisorHost` → no promotion; EPERM probe → `supervisorAlive:"unknown"`, no promotion; stale `queued` with no owner → `SUPERVISOR_LAUNCH_FAILED`.
- Watch: NDJSON stream over running→blocked→continue→completed; inline result body exactly once across two sequential watchers (second sees `resultReported:true`); torn-finalization repair (result.json present, status running → repaired + reported); corrupt run dir → error line.
- Archive: real aged run dirs → tarball round-trips (extract, byte-compare session.jsonl), index compacted, active runs untouched, legacy tree swept; injected fault: unwritable archive dir → run dir preserved, error surfaced; start-sweep never blocks a start.
- Existing paused-on-budget assertions (`timerSweep`, `wakeups`, `supervisor` tests) move to the new expiry truth in the same change; old assertions deleted, no legacy-parity tests.
