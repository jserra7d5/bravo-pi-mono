# Tango Lifecycle Reconciliation Design

Date: 2026-04-26
Status: draft

## Problem

A Tango child agent can become stuck in `running` even after its backing process has exited. One observed case showed a child apparently reporting a final handoff/status, but `tango list` continued to show `running`; checking the recorded PID showed no live process.

Recent Tango status-event work improves delivery once a status transition is persisted, and the one-shot close observer attempts to transition children to `done` or `error` on process exit. However, stale `running` can still happen when:

- the child says `tango status done` in text but does not actually execute the command/tool;
- the child process exits and the close observer misses or fails before recording exit state;
- status metadata is written somewhere unexpected or fails;
- a parent/CLI view reads stale lifecycle metadata without checking the runtime.

The system needs a no-external-daemon way to repair stale lifecycle state and notify parents through the existing status-event path.

## Goals

- Prevent `tango wait`, `tango list`, `tango children`, and parent UI surfaces from indefinitely trusting stale `running` metadata.
- Keep Tango core as the lifecycle source of truth.
- Avoid an external watchdog daemon.
- Use existing status transitions and events for notifications.
- Preserve explicit child statuses (`done`, `blocked`, `error`, `stopped`) as authoritative.
- Keep Pi extension logic thin: it may trigger reconciliation, but must not duplicate lifecycle rules.

## Non-goals

- Do not infer successful completion from textual output alone.
- Do not scrape tmux panes to decide completion.
- Do not add a long-running system/user daemon.
- Do not introduce a new status taxonomy unless existing statuses are insufficient.
- Do not make Pi availability required for lifecycle repair.

## Architectural smell

Tango currently has multiple lifecycle truth signals:

- metadata status;
- one-shot process PID/exit;
- interactive tmux session liveness;
- result/output files;
- child-reported `tango status` calls.

The smell is that read paths can trust metadata without reconciling it against the runtime boundary. The fix is not a separate watchdog authority; it is a centralized lifecycle reconciler used by all state-reading surfaces.

## Recommended architecture

### 1. Central lifecycle reconciler in Tango core

Add one core function, conceptually:

```ts
reconcileAgentLifecycle(meta: AgentMetadata, options?: {
  reason?: "list" | "look" | "wait" | "children" | "reconcile" | "watchdog";
  now?: Date;
}): AgentMetadata
```

This should live near metadata/status logic, not in the Pi extension. It owns the rules for comparing lifecycle metadata with runtime liveness.

Responsibilities:

- return terminal agents unchanged;
- check interactive tmux liveness for interactive agents;
- check PID liveness for one-shot agents;
- apply startup grace periods;
- choose reconciled terminal statuses and summaries;
- call the existing status transition helper so durable events are emitted.

### 2. Terminal status is authoritative

If metadata status is already terminal:

```text
done, blocked, error, stopped
```

then reconciliation must not override it based on PID/tmux state.

This preserves explicit child status as the strongest signal. If a child successfully executed `tango status done`, later process exit or missing tmux state should not downgrade or duplicate the result.

### 3. One-shot process reconciliation

For `mode === "oneshot"` and `status === "running"`:

1. If `exitCode` is present:
   - `exitCode === 0` → transition to `done` if not already terminal.
   - `exitCode !== 0` → transition to `error`.
2. Else if recorded `pid` is alive:
   - keep `running`.
3. Else if no `pid` and the agent is within a short startup grace period:
   - keep `running`.
4. Else if no `pid` after the grace period:
   - transition to `error` with summary:
     ```text
     Agent is running but no child PID was recorded
     ```
5. Else if recorded `pid` is gone and no exit code/terminal status was observed:
   - transition to `error` with summary:
     ```text
     Process exited but Tango did not observe exit code or terminal status
     ```

Use `error` rather than `unknown` for the stale one-shot case because:

- it is already terminal in existing logic;
- Pi status notifications already deliver `error`;
- the lifecycle contract failed even if the underlying task may have succeeded;
- no downstream status taxonomy changes are needed.

Do not infer `done` from `result.md` or output text alone unless Tango has a stronger producer contract. A completed-looking transcript is not proof that the agent reached a clean terminal state.

### 4. Interactive tmux reconciliation

For `mode === "interactive"` and `status === "running"`:

- if `tmux has-session` succeeds, keep `running`;
- if the tmux session is gone, transition to `stopped` with summary:
  ```text
  tmux session is no longer alive
  ```

Tmux is the runtime boundary for interactive agents. Do not use ordinary child PID checks for interactive agents unless Tango records reliable pane/process identity later.

### 5. PID liveness primitive

For one-shot agents, use PID liveness as the v1 no-daemon runtime check:

```ts
process.kill(pid, 0)
```

Interpretation:

- success → process exists;
- `EPERM` → process exists but is inaccessible;
- `ESRCH` → process is gone;
- other errors → treat conservatively and keep `running` or report diagnostic without terminal transition.

PID reuse is a known caveat. V1 can use basic PID checks; a later hardening pass may record Linux `/proc/<pid>/stat` start time or command identity to detect reuse.

### 6. Startup grace period

There is a short window where a one-shot agent may be marked `running` before its PID is recorded. Reconciliation must avoid false errors in that window.

Recommended default:

```text
running + oneshot + no pid + age < 10s => keep running
running + oneshot + no pid + age >= 10s => error
```

Use `updatedAt` or `createdAt` as the age source; prefer the timestamp closest to the transition to `running` if available in future metadata.

### 7. Lazy reconciliation on all read/wait paths

Every command that reads agent lifecycle state should reconcile before returning/displaying:

- `tango list`
- `tango look`
- `tango children`
- `tango wait`
- `tango result`
- `tango message`
- `tango attach`
- parent Pi footer/list refreshes, via the same CLI paths

This is the main no-daemon guarantee: stale state repairs whenever a human, parent agent, or tool inspects it.

`refreshStatus()` in `packages/tango/src/cli.ts` is the current seam, but the logic should move into a core helper so CLI and future integrations share one implementation.

### 8. Explicit finite reconcile command

Add a finite command:

```bash
tango reconcile [--json] [--all] [--children]
```

Behavior:

- `tango reconcile` checks current-project agents.
- `--all` checks all agents under `$TANGO_HOME`.
- `--children` checks children of `TANGO_RUN_DIR`; optionally accept a parent name later.
- It returns checked and changed agents.

Example JSON:

```json
{
  "ok": true,
  "checked": 4,
  "changed": 1,
  "agents": []
}
```

This command is useful for humans, tests, and parent Pi opportunistic reconciliation. It is not a daemon and does not loop.

### 9. Parent Pi opportunistic watchdog

The parent Pi extension may trigger reconciliation while it is already alive, but it should not implement lifecycle rules.

Recommended behavior:

- Keep the existing `tango watch --json --from-start` process for status-event delivery.
- Add a low-frequency timer when running in a Tango parent session (`TANGO_RUN_DIR` is set).
- Every ~15 seconds, run:
  ```bash
  tango reconcile --children --json
  ```
- The CLI reconciler mutates metadata and emits status events if needed.
- The existing event watcher delivers `error`/`stopped`/terminal notifications as appropriate.

This is not an external daemon because it:

- lives only inside the active parent Pi process;
- exits with the parent session;
- uses Tango core as authority;
- performs finite CLI calls rather than owning state.

If the parent Pi session is not alive, lazy reconciliation still occurs the next time someone runs `tango list`, `tango wait`, `tango children`, etc.

## Event behavior

Reconciled transitions must use the existing centralized status transition helper. This ensures:

- metadata is updated consistently;
- `$TANGO_HOME/events.jsonl` receives a normal `agent.status` event;
- `tango watch` observes the repair;
- parent Pi status notifications use the same path as explicit child status updates.

Avoid Pi-only synthetic stale notifications. They would create split-brain lifecycle behavior.

## Failure modes

### Child explicitly reports terminal status, then exits

- Metadata is already terminal.
- Reconciler does nothing.
- No duplicate event.

### Child exits successfully but never executed `tango status`, and close observer missed exit

- Metadata remains `running`, PID is dead, exit code absent.
- Reconciler transitions to `error`.
- This may classify a successful task as error, but Tango cannot prove success. The actionable truth is that lifecycle observation failed.

### Child process is alive but PID was reused

- Basic PID check may falsely preserve `running`.
- Later hardening can record process start identity from `/proc`.
- Do not block v1 on this unless it becomes observed.

### Supervisor dies while child keeps running

- If PID remains alive, reconciliation keeps `running`.
- If child later exits and no exit code/status is recorded, reconciliation marks `error`.

### Pi parent is absent

- No proactive repair occurs.
- Lazy reconciliation repairs on the next CLI/tool read path.

### `tango wait` on stale running

- `wait` loops should call reconciliation each iteration.
- Dead one-shot agents become terminal and `wait` returns instead of hanging indefinitely.

## Implementation sequence

### Phase 1: Core reconciler

- Add `reconcileAgentLifecycle(meta, options)` in Tango core.
- Add `isTerminalStatus(status)` helper shared by start/cli/reconciler.
- Add `pidAlive(pid)` helper for one-shot checks.
- Move current interactive tmux check from CLI `refreshStatus()` into the reconciler.
- Use stable summaries to avoid repeated same-status event spam.

### Phase 2: Wire read paths

- Replace CLI `refreshStatus()` with the core reconciler.
- Ensure these commands reconcile:
  - `list`
  - `children`
  - `wait`
  - `look`
  - `result`
  - `message`
  - `attach`
- Ensure JSON outputs include reconciled metadata.

### Phase 3: Add `tango reconcile`

- Implement finite reconciliation command.
- Support `--json`, `--all`, and `--children`.
- Return checked/changed counts and changed agent list.

### Phase 4: Parent Pi opportunistic trigger

- Add a timer in the Tango Pi extension only when `TANGO_RUN_DIR` exists.
- Timer calls `tango reconcile --children --json` at a conservative interval.
- Do not deliver messages directly from this timer; rely on status events.

### Phase 5: Hardening

Optional later work:

- record child process start identity;
- validate `/proc/<pid>/stat` start time on Linux;
- add reconciliation diagnostics fields such as `reconciledAt` or `reconciledReason` if needed;
- add `tango doctor lifecycle` for synthetic stale-running checks.

## Validation plan

- Running one-shot with dead PID reconciles to `error` and emits event.
- Terminal `done` with dead PID stays `done` and emits no new event.
- Interactive running with missing tmux session reconciles to `stopped`.
- Running one-shot with live PID stays `running`.
- Running one-shot with no PID inside grace period stays `running`.
- Running one-shot with no PID after grace period becomes `error`.
- `tango wait` returns for a stale-running dead PID instead of hanging.
- `tango reconcile --children --json` checks only children of `TANGO_RUN_DIR`.
- Parent Pi watchdog timer calls only the finite reconcile command and does not duplicate lifecycle rules.

## Recommendation

Implement centralized lazy lifecycle reconciliation first. It directly fixes stale `running` without a daemon and without coupling lifecycle truth to Pi. Then add a finite `tango reconcile` command and let the parent Pi extension call it opportunistically while a parent session is alive.
