# Pi Background Bash Wakeups

> **Superseded:** `docs/specs/unified-task-plane/` is the current contract. This document is retained as historical record, not current instructions.

Status: implemented and validated
Date: 2026-06-30
Implemented: 2026-07-01
Owner package: `packages/pi-extension-background-bash`
Related spec: `docs/specs/pi-background-bash/design.md`

## Problem

Managed background bash can run long tests/builds and persist terminal state. This spec closes the prior gap where background task completion could not wake the agent, while keeping wakeups per-call opt-in and session-routed.

## Goal

Add per-call opt-in model wake-up delivery for managed background bash terminal state transitions while preserving the existing single `bash` tool surface, registry ownership, task controls, and quiet-by-default behavior.

Terminal states in scope:

- successful exit (`exited`, exit code `0`)
- non-zero exit (`failed`)
- runtime timeout (`timed_out`)
- explicit stop/kill (`killed`)

## Non-goals

- Do not make Monitor run workloads or replace background bash lifecycle ownership.
- Do not add a second watcher/poller that duplicates `BackgroundRunner`.
- Do not stream continuous task output into the conversation.
- Do not enable model wakeups by default for every profile, legacy config, or migration.
- Do not change foreground `bash({ command, timeout? })` behavior.
- Do not make background tasks interactive or auto-answer prompts.
- Do not model-wake during session shutdown in v1.

## Modular contracts

- [`contracts/tool-contract.md`](contracts/tool-contract.md) — model-facing `bash` and task-control behavior.
- [`contracts/lifecycle-contract.md`](contracts/lifecycle-contract.md) — terminal transition ownership and exactly-once finalization.
- [`contracts/notification-contract.md`](contracts/notification-contract.md) — model wake event envelope, delivery API, tail bounds, and duplicate prevention.
- [`contracts/session-routing-contract.md`](contracts/session-routing-contract.md) — hard isolation rule preventing wakeups from drifting across active Pi sessions.
- [`contracts/pi-message-api-contract.md`](contracts/pi-message-api-contract.md) — required Phase 0 evidence for real Pi sendMessage/session semantics.
- [`contracts/persistence-contract.md`](contracts/persistence-contract.md) — task record fields and registry durability requirements.
- [`contracts/prompt-context-contract.md`](contracts/prompt-context-contract.md) — system prompt/tool-response guidance updates.
- [`validation.md`](validation.md) — runtime invariants, faithful seams, injected faults, and definition of done.
- [`implementation-plan.md`](implementation-plan.md) — staged implementation path and stop/replan triggers.
- [`review-log.md`](review-log.md) — reviewer findings and changes made in response.

## Implemented behavior

As of 2026-07-01:

- `BackgroundRunner` owns spawn, output handling, timeout, stop, output-cap, shutdown, and terminal wake finalization.
- `bash({ run_in_background: true, wake_on_completion: true })` is the only v1 model-wake opt-in path.
- Wake-eligible tasks persist `wakePolicyVersion: 1` and `wakePolicySource: "tool_arg_v1"`; legacy/config `notifyModelOnCompletion` does not enable wakes.
- `notifications.ts` builds bounded XML-like wake messages and normalizes/escapes output tails.
- Wake dispatch uses a session-bound `pi.sendMessage()` wrapper with `triggerTurn: true` and `deliverAs: "followUp"`.
- Terminal wake finalization uses an atomic per-task claim file and freezes `modelWakeCanonicalTerminal` before send.
- Shutdown kills suppress model wake and persist `SHUTDOWN_SUPPRESSED` routing metadata.
- `TaskRegistry` prefers terminal/newer per-task metadata over stale active registry entries to keep status reads consistent with terminal facts.

## Design stance

This is a harness/tool contract fix. Prompt guidance alone cannot solve it. The task lifecycle owner dispatches a bounded, structured, at-most-once wake event after terminal metadata is durable, through an atomic notification claim, and only to the Pi session that started the task. If owner-session routing cannot be proven at dispatch time, the implementation refuses to wake and records a routing failure.
