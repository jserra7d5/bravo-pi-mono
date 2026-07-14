# Background Bash Wakeup Contracts

> **Superseded:** `docs/specs/unified-task-plane/` is the current contract. This document is retained as historical record, not current instructions.

Status: implemented

This directory decomposes the background-bash wakeup design into implementation contracts. Implementers should treat these as a set: satisfying one contract while violating another is not acceptable.

## Contracts

1. [`tool-contract.md`](tool-contract.md) — model-facing tool behavior and compatibility.
2. [`lifecycle-contract.md`](lifecycle-contract.md) — terminal transition ownership and exactly-once finalization.
3. [`notification-contract.md`](notification-contract.md) — wake event envelope, Pi delivery API, tail bounds, duplicate prevention.
4. [`session-routing-contract.md`](session-routing-contract.md) — owner-session-only delivery and no cross-session drift.
5. [`pi-message-api-contract.md`](pi-message-api-contract.md) — required Phase 0 evidence for real Pi sendMessage/session semantics.
6. [`persistence-contract.md`](persistence-contract.md) — task record fields, metadata durability, registry behavior.
7. [`prompt-context-contract.md`](prompt-context-contract.md) — model guidance, start responses, and behavior evals.

## Cross-contract hard requirements

- Wakeups are per-call opt-in in v1 and never silently enabled by migration or legacy config.
- Wakeups are emitted only by the lifecycle owner, not by Monitor, polling, or status reads.
- Terminal task facts are persisted before model wake dispatch.
- Wake dispatch is at-most-once per task terminal transition through an atomic durable notification claim.
- Wake payloads are bounded, escaped, and model-sufficient.
- Wake delivery is session-routed; a task can only wake the Pi session that started it.
- Session shutdown kills do not model-wake in v1.
- Validation must run real background processes and fake only the Pi message delivery boundary after real Pi session-binding semantics are proven.
