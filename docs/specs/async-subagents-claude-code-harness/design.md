# Async Subagents Claude Code Harness

Status: draft — fresh modular rewrite
Date: 2026-06-30

## Summary

Add first-class Claude Code variants to `@bravo/async-subagents` while preserving async-subagents as the only orchestration source of truth. A parent Pi session should be able to start `worker/claude`, `reviewer/claude`, or user-defined Claude variants through normal `subagent_start`; the child may be Claude Code internally, but run identity, status, inbox, result, wakeups, task association, and TUI projection remain async-subagents contracts.

This is a harness addition, not a new orchestrator and not a Hive-style daemon.

## Spec modules

Read these files as one spec:

1. [`contracts.md`](./contracts.md) — harness abstraction, definition schema, inheritance, parent prompt/catalog/tool surfaces.
2. [`claude-runtime.md`](./claude-runtime.md) — Claude command construction, auth/home strategy, dangerous execution mode, best-effort memory posture, shell-home split, oneshot/interactive launch.
3. [`control-lifecycle.md`](./control-lifecycle.md) — MCP child-control server, inbox delivery/ack states, liveness, pause/continue/cancel, reconciliation, wakeup ordering.
4. [`skills.md`](./skills.md) — harness-aware skill resolution and Claude skill installation.
5. [`tui-observability.md`](./tui-observability.md) — status/result/launch metadata, TUI cards/widgets, wakeup envelopes.
6. [`validation.md`](./validation.md) — Joe-method runtime invariants, faithful seams, scripted smoke, optional visual smoke, definition of done.
7. [`implementation-plan.md`](./implementation-plan.md) — implementation phases and open questions.
8. [`research-findings.md`](./research-findings.md) — Tango/Hive/Claude CLI hand-test findings and reusable probe results.

## Goals

- Support `harness: "claude"` on agent definitions and variants.
- Let built-in and user templates expose Claude variants without changing parent orchestration tools.
- Preserve durable run files: `status.json`, `events.jsonl`, `inbox.jsonl`, `result.json`, `summary.json`, `logs/`, and `artifacts/`.
- Keep Pi tools/extensions out of Claude children.
- Treat skills as first-class harness-resolved capabilities.
- Make Claude interactive sessions explicitly managed: liveness, idle, message delivery, timeout, cleanup, and stale transport states are durable and visible.
- Make normal validation credential-free through fake Claude CLI, real subprocess/tmux, real MCP JSON-RPC, and real filesystem run stores.

## Non-goals

- Do not expose Pi tools to Claude Code.
- Do not load Pi extensions inside Claude Code.
- Do not use Claude Code's native `Task` tool for recursive delegation.
- Do not require live Claude API calls for normal tests or CI.
- Do not introduce a persistent daemon.
- Do not add peer-to-peer child communication.
- Do not treat arbitrary files as skills; Claude-compatible skill directories must contain `SKILL.md` and pass resolver safety checks.
- Do not expose operator Claude credentials or ambient operator home contents to Claude Bash subprocesses.

## Architectural invariant

> Async-subagents owns the orchestration contract. Claude Code is one child harness.

Claude may be interactive internally. Parent-visible coordination still flows through async-subagents files, events, status, results, and wakeups. A Claude child must never become an untracked terminal session whose result, question, idle state, or lifecycle exists only in Claude's transcript.

## Incorporated audit decisions

The modular rewrite intentionally incorporates the planner and audit findings from the prior draft:

- add explicit liveness state machine: `running`, `idle`, `waiting_for_input`, `ack_pending`, `rate_limited`, `comatose`, `stale_transport`, `orphaned_process`, `paused`, terminal states;
- split inbox states into `queued`, `injected`, `received`, `handled`, `failed`;
- make `requiresAck` meaningful for Claude by waiting for handled acknowledgement by default;
- require a real tmux integration lane for interactive support;
- require fake Claude to speak real MCP JSON-RPC, never mutate run files directly;
- test wakeups at the actual Pi `sendMessage` boundary, not only renderer snapshots;
- define harness-boundary inheritance so base Pi tools/extensions do not leak into Claude variants;
- switch v1 posture to trusted dangerous Claude children using `--dangerously-skip-permissions`, not permission-profile theater;
- do not use `--bare` in built-in/default Claude variants because normal Claude auth is required; memory isolation is best-effort non-bare;
- target `claude-sonnet-5` and `claude-opus-4-8` as built-in model strings;
- replace operator-real-`HOME` Bash wrapper with run-local shell home where technically possible, and truthfully report limitations;
- define MCP stdio ownership/runDir containment without pretending per-call token auth exists, and add per-run mutation serialization;
- define terminal-result dominance for wakeup dedupe;
- require scripted, self-verifying fake-Claude smoke; manual tmux attach is visual-only.

## Compatibility posture

Default behavior remains Pi. Existing agent definitions without `harness` keep current behavior. Claude support is opt-in through a variant or definition field. When a field is ambiguous across harnesses, the spec chooses fail-closed or explicit non-inheritance over compatibility shims.
