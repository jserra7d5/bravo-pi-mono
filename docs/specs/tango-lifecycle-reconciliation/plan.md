# Tango Lifecycle Reconciliation Implementation Plan

Date: 2026-04-26
Status: implemented

## Scope

Implement no-daemon lifecycle reconciliation for stale `running` Tango agents.

In scope:

- central lifecycle reconciler in Tango core;
- one-shot PID liveness reconciliation;
- interactive tmux session reconciliation;
- lazy reconciliation from read/wait CLI paths;
- non-blocking one-shot start via detached finite supervisor;
- finite `tango reconcile` command;
- parent Pi opportunistic reconcile timer;
- tests/smoke validation for stale-running repair.

Out of scope:

- external daemon;
- new status taxonomy;
- PID reuse hardening via `/proc` identity;
- output scraping or success inference from transcript text.

## Steps

1. Make one-shot `tango start` non-blocking by spawning a detached finite runner/supervisor.
2. Add shared terminal-status and PID/tmux lifecycle reconciliation helpers.
3. Replace CLI-local `refreshStatus()` logic with the core reconciler.
4. Ensure list/look/children/wait/result/message/attach read paths reconcile before use.
5. Add `tango reconcile [--json] [--all] [--children]`.
6. Add parent Pi timer that periodically calls finite reconciliation for child agents while a parent session is alive.
7. Update docs/includes for the new command.
8. Validate with build/typecheck and targeted CLI smoke tests.

## Result

Implemented lifecycle reconciliation:

- Made one-shot `tango start` return immediately by spawning a detached finite runner/supervisor.
- Added core `reconcileAgentLifecycle()` with terminal-status idempotence, one-shot PID liveness checks, no-PID grace handling, and interactive tmux liveness checks.
- Wired CLI read/wait paths through reconciliation.
- Added finite `tango reconcile [--json] [--all] [--children]`.
- Added parent Pi opportunistic reconcile timer that invokes the finite CLI command and relies on normal status events for notifications.
- Updated docs/includes for the new command.

Validation covered stale dead-PID repair, terminal-status preservation, live-PID preservation, no-PID stale repair, `tango wait` repair, and child-scoped reconcile.
