# Review Log

Status: implemented and reviewed
Date: 2026-06-30

## Reviewers

- Seam-fidelity audit: async reviewer using Joe-method `audit-spec-seams` lens.
- Harness/tool audit: async reviewer using `tool-design`, `behavior-shaping`, and `context-presentation` lenses.

## Findings addressed

### Atomic exactly-once wake claim

Finding: ordinary metadata `upsert()` markers were not enough to prevent duplicate dispatch under stop/exit/reconcile races.

Changes:

- `contracts/lifecycle-contract.md` now requires an atomic durable per-task notification claim.
- `contracts/notification-contract.md` forbids plain read/check/upsert for claim acquisition.
- `contracts/persistence-contract.md` adds claim state fields.
- `validation.md` adds race tests for stop/exit/finalize attempts.

### Async send and accepted-vs-delivered semantics

Finding: specs treated `sendMessage` as synchronous and conflated API acceptance with model delivery.

Changes:

- `contracts/notification-contract.md` now defines async `BackgroundWakeNotifier.send(): Promise<BackgroundWakeSendResult>`.
- Metadata uses `modelWakeAcceptedAt` and `modelWakeDeliverySemantics`, not ambiguous `modelWakeDeliveredAt`.
- `implementation-plan.md` Phase 0 requires documenting real Pi send semantics.
- `validation.md` adds delayed acceptance and rejection coverage.

### Real Pi session-routing proof

Finding: synthetic per-session fakes could pass while real Pi `sendMessage` routing remained unproven.

Changes:

- Added `contracts/pi-message-api-contract.md` as a required Phase 0 artifact.
- `implementation-plan.md` requires real Pi session/sendMessage proof or stopping.
- `validation.md` requires real API proof before relying on fake delivery-boundary tests.
- `contracts/session-routing-contract.md` says model wake must be refused without a session-bound delivery handle.

### No cross-session drift

Finding/user requirement: wakeups must not drift across different active Pi sessions.

Changes:

- Added `contracts/session-routing-contract.md`.
- Threaded owner-session routing into README, notification, persistence, validation, and implementation plan.
- Required no wake when ownership/session identity cannot be proven.

### Same-session reload wake eligibility

Finding: in-memory-only notifiers could be lost after same-session reload.

Changes:

- `contracts/lifecycle-contract.md` and `contracts/session-routing-contract.md` require same-session reload to either reconstruct safe delivery or persist explicit wake-lost failure.
- `validation.md` adds a same-session running reload test.

### Config-level default wake risk

Finding: honoring `notifyModelOnCompletion: true` without per-call opt-out could create loops/noise.

Changes:

- `contracts/tool-contract.md` makes v1 per-call opt-in only.
- Legacy/pre-existing `notifyModelOnCompletion: true` must be ignored/logged until a versioned future contract enables it.
- `validation.md` adds legacy config/metadata true tests.

### Shutdown wakeups

Finding: model-waking during session shutdown is dangerous and underspecified.

Changes:

- `contracts/lifecycle-contract.md`, `session-routing-contract.md`, and `notification-contract.md` make shutdown model wake out of scope for v1.
- Prompt guidance now says session-shutdown kills do not wake.

### Output-cap terminal path

Finding: tail tests did not prove the max-output watchdog routes through terminal finalization.

Changes:

- `validation.md` adds real output-cap kill/wake test.
- `lifecycle-contract.md` keeps output-cap as `killed` + `stopReason: "output_cap"` through finalization.

### XML/tail robustness

Finding: CDATA/XML-like payload could be broken by arbitrary command output.

Changes:

- `notification-contract.md` removes CDATA and requires XML-escaped text nodes.
- Tail requirements now strip ANSI, normalize control chars, preserve UTF-8, and test `]]>`, nested fake notification tags, and control sequences.

### Timeout precision

Finding: timeout minimum/units were underspecified.

Changes:

- `tool-contract.md` defines positive integer seconds, omitted default, min 30 seconds, max 86,400 seconds.
- `validation.md` adds invalid timeout coverage.

## Closure review blockers addressed

### Legacy `wakeOnCompletion: true` metadata ambiguity

Finding: the first remediation still did not distinguish new v1 per-call opt-in tasks from pre-feature running/orphaned records that already contained `wakeOnCompletion: true`.

Changes:

- `contracts/persistence-contract.md` adds `wakePolicyVersion: 1` and `wakePolicySource: "tool_arg_v1"`.
- `contracts/tool-contract.md` defines wake eligibility as `wakeOnCompletion === true` plus both v1 marker fields.
- Pre-existing metadata without the marker is not wake-eligible, regardless of state.
- `validation.md` now tests legacy running, orphaned, unknown, and terminal metadata.

### Stop/exit race payload/status drift

Finding: a losing finalizer could mutate terminal facts after the wake claim, causing `background_task_status` to disagree with the wake payload.

Changes:

- `contracts/persistence-contract.md` adds `modelWakeCanonicalTerminal`.
- `contracts/lifecycle-contract.md` makes the first claimed terminal transition canonical for wake-visible fields.
- Later finalizers may only add supplemental diagnostics and must not mutate canonical `status`, `exitCode`, `signal`, `stopReason`, or `endedAt`.
- `validation.md` adds post-wake status-vs-payload race assertions.

## Implementation review blockers addressed

### Async send at the real tool seam

Finding: `BackgroundRunner.finalize()` awaited notifier sends, but the `buildBackgroundBashTools()` wrapper around `pi.sendMessage()` returned accepted immediately when a promise-returning send handle rejected later.

Changes:

- `packages/pi-extension-background-bash/src/bash-tool.ts` now normalizes sync/promise `sendMessage` with `await Promise.resolve(result)` before returning accepted semantics.
- `packages/pi-extension-background-bash/test/core.test.ts` covers delayed async resolution and async rejection through the real tool-created notifier seam.

### Tail cap after normalization

Finding: a 4096-byte control-heavy log tail could expand far beyond 4 KiB after control-character normalization.

Changes:

- `packages/pi-extension-background-bash/src/notifications.ts` now applies the byte cap after UTF-8 decoding/normalization and again after line trimming.
- Tests cover control-character expansion and UTF-8 boundary cases.

### Shutdown wake suppression

Finding: shutdown originally reused the manual `stop()` path and could wake through the captured live notifier.

Changes:

- `packages/pi-extension-background-bash/src/background-runner.ts` now records `stopReason: "shutdown"`, suppresses wake claiming/sending, and persists `SHUTDOWN_SUPPRESSED` routing metadata.
- Tests cover wake-enabled owned task shutdown with no send.

### Active registry stale-write races

Finding: concurrent `TaskRegistry` instances could resurrect stale active rows or overwrite terminal metadata, causing `background_task_status` to disagree with terminal per-task metadata.

Changes:

- `packages/pi-extension-background-bash/src/task-registry.ts` now prefers terminal/newer per-task metadata over stale active index rows in `get()`, `list(false)`, and persistence.
- Stale same-task active `upsert()` cannot overwrite terminal/newer metadata.
- `failed` and `timed_out` are treated as terminal metadata, not active registry rows.
- Tests cover stale concurrent active index, stale same-task active upsert, and failed/timed-out terminal metadata staying out of `registry.json` / `list(false)`.
