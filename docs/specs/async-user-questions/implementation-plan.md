# Async User Questions Implementation Plan

Status: Implemented and validated
Package: `packages/ask-user-question`
Source of truth: [`design.md`](design.md), [`lifecycle.md`](lifecycle.md), [`tools-and-prompting.md`](tools-and-prompting.md), [`tui.md`](tui.md), and [`verification.md`](verification.md). This plan sequences their implementation and does not supersede their contracts.

## Objective and completion bar

Extend the existing `ask_user_question` extension into a branch-scoped, session-durable question inbox while preserving the current picker behavior that remains valid. The package-local question service becomes the sole owner of request state, transitions, projection, idempotency, and answer-event identity. Pi custom entries remain the durable event log; the coordinator owns only runtime waiters and model delivery; TUI components own only presentation and drafts.

Completion requires every invariant in `verification.md` to execute through its named faithful seam, including a duplicate/replay or conflicting-transition fault, package `check`/`test`, and one isolated actual Pi extension-load smoke. Do not add a test framework, PTY suite, browser lane, daemon, database, or broad monorepo validation.

## Gate 0 — prove the Pi boundary before lifecycle implementation

The installed Pi API exposes all intended primitives:

- `pi.appendEntry(customType, data)` and `ctx.sessionManager.getBranch()`;
- `pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true })`;
- `ctx.ui.custom(..., { overlay: true })`;
- `ctx.ui.setStatus`, `pi.registerCommand`, and `pi.registerShortcut`;
- `before_agent_start`, `session_start`, and `session_shutdown` hooks.

Before building domain logic, add a thin Pi-shaped harness that invokes the real extension factory and captures registrations, entries, messages, status calls, commands, shortcuts, and UI completion. Prove these assumptions:

1. `appendEntry` is called synchronously before a non-blocking tool result is returned and before the blocking picker opens.
2. A picker can call `done({ kind: "closed" })`, close `ctx.ui.custom`, and leave the tool execution awaiting a separate coordinator waiter; reopening from `/questions` can resolve that waiter.
3. A successful synchronous `sendMessage` call is Pi's only observable enqueue-acceptance boundary; only then may `question.answer_delivered` be appended.
4. `getBranch()` exposes active-branch custom entries in their branch order and excludes abandoned descendants.
5. `Key.ctrlShift("u")` (rather than a raw guessed escape sequence) is accepted by `registerShortcut`; `/questions` remains the fallback on conflict.

### Required contradiction decision

Pi's `sendMessage` and `appendEntry` are separate synchronous `void` operations. The frozen spec requires the delivery marker only after answer delivery is accepted, while also saying an answer is delivered once. A process failure after `sendMessage` but before `question.answer_delivered` leaves no atomic evidence that prevents redelivery on restart. The specified event set has no pre-send claim event, and Pi exposes no transactional/idempotency key.

Before implementation, explicitly choose one interpretation:

- **Recommended bounded guarantee:** at most one accepted follow-up enqueue during a live runtime and after any replay that contains `question.answer_delivered`; acknowledge the unavoidable crash gap between enqueue and marker. This matches the practical reload tests in `verification.md` without adding a contract or persistence path.
- **Re-plan:** if “once” includes that crash interval, revise the frozen contract or obtain a Pi idempotent/transactional delivery seam. Do not silently add a claim event, mark delivery before sending, inspect unrelated transcript state as a second authority, or claim exactly-once behavior.

Stop immediately if any other Gate 0 assumption fails. In particular, use the stop/re-plan triggers from `design.md` rather than faking the harness or introducing an alternate lifecycle path.

## Intended module ownership and write scope

Use this smallest coherent package structure:

| File | Responsibility |
|---|---|
| `packages/ask-user-question/extensions/pi/schema.ts` | TypeBox tool schemas and canonical request/answer/event TypeScript types; defaults and stable option-ID normalization shapes. |
| `packages/ask-user-question/extensions/pi/validate.ts` | Existing batch uniqueness and model-input validation only. |
| `packages/ask-user-question/extensions/pi/question-service.ts` (new) | Event validation/projection, deterministic request identity, revisioned transitions, idempotency, ordering, counts, and terminal event identity. Sole domain owner. |
| `packages/ask-user-question/extensions/pi/runtime-coordinator.ts` (new) | Append-then-apply persistence, branch rebuild, waiter registry, picker orchestration, answer delivery, shutdown detachment, and restart reconciliation. |
| `packages/ask-user-question/extensions/pi/component.ts` | Existing picker editing/navigation; return `submitted`, `declined`, or `closed`; no durable state or delivery. |
| `packages/ask-user-question/extensions/pi/inbox.ts` (new) | Pure badge projection plus inbox overlay rendering/navigation and responsive width policy. |
| `packages/ask-user-question/extensions/pi/prompt.ts` (new) | The exact tool-coupled prompt guidance, injected only while the question tools are active. |
| `packages/ask-user-question/extensions/pi/index.ts` | Composition root: one coordinator instance per extension runtime, three tool registrations/renderers, hooks, command, shortcut, status, and prompt wiring. No domain decisions. |
| `packages/ask-user-question/test/harness.ts` (new) | Minimal Pi boundary fake that runs the real extension registration and real registered handlers. |
| `packages/ask-user-question/test/component.test.ts` | Preserve/adapt the existing 109 picker/schema tests where behavior remains supported. |
| `packages/ask-user-question/test/question-service.test.ts` (new) | Projector and transition properties/faults. |
| `packages/ask-user-question/test/runtime-coordinator.test.ts` (new) | Waiter, persistence, delivery, and reconciliation behavior. |
| `packages/ask-user-question/test/inbox.test.ts` (new) | Count/order/status gating and ANSI-aware width cutoffs. |
| `packages/ask-user-question/test/extension.test.ts` (new) | Real registration/tool/prompt/non-interactive harness tests. |
| `packages/ask-user-question/README.md` | Final user-facing tools, inbox controls, durability limitation, and development commands after behavior stabilizes. |

No new dependency is expected, so `package.json`, root lockfile, and `tsconfig.json` should remain unchanged unless implementation proves otherwise. If a package metadata change becomes necessary, explain it before editing. Do not create compatibility wrappers or retain the old modal-owned execution path.

## Dependency-ordered milestones

One primary worker should implement Milestones 0–7 in order. Milestone 8 is focused review and evidence collection, not a second implementation lane.

### Milestone 0 — boundary harness and explicit seam decision

1. Add `test/harness.ts` with captured real registrations and controllable branch/UI/message behavior.
2. Write narrow extension tests for the five Gate 0 assumptions.
3. Record the selected delivery guarantee in implementation comments/tests without modifying the frozen spec.

**Gate:** Gate 0 passes on the real registered extension shape. If custom UI cannot close independently of the waiter, branch projection is not faithful, or safe follow-up delivery needs Pi core, stop/re-plan.

**Verification binding:** package-discovery seam; tool-call-to-durable-request seam scaffolding; non-blocking-delivery seam scaffolding.

### Milestone 1 — canonical schemas, IDs, and event projection

1. Replace the old `Result`/`cancelled` model in `schema.ts` with the frozen three tool inputs and shared request envelope. Preserve omitted `delivery` → `blocking` and omitted `urgency` → `normal`.
2. Add optional input option IDs and normalized stable option IDs. Derive request identity deterministically from `toolCallId`; derive omitted option IDs deterministically from the request/question/option position so replay cannot change authoritative answer IDs.
3. Define versioned `async-user-question` event unions for all six variants. Treat decoded session data as untrusted: reject unknown versions, malformed payloads, inconsistent request IDs, duplicate event IDs, and invalid transitions with bounded diagnostics.
4. Implement the pure projector and query helpers in `question-service.ts`: last-valid-transition wins, first terminal transition wins, duplicate event IDs are no-ops, revision is monotonic, pending count is state-derived, and order is blocking → urgency high/normal/low → oldest.
5. Ignore legacy custom entries safely; do not translate the old `cancelled` shape into current state.

**Gate:** Replay is deterministic and has one canonical state for every request. No renderer, modal, waiter, or footer value may mutate lifecycle state.

**Verification binding:** `Session entries → projection`, `Badge/inbox projection → TUI`, and the projection rows of the compatibility matrix. Inject duplicate terminal, answer-after-withdrawal, duplicate create identity, malformed event, and unknown version.

### Milestone 2 — service transitions and append-then-apply persistence

1. Implement service commands for create, escalate, answer, decline, withdraw, and answer-delivered. Each returns either one valid event to append or the existing idempotent state; it never writes Pi state itself.
2. In `runtime-coordinator.ts`, centralize `appendEvent`: call `pi.appendEntry("async-user-question", event)` first, then apply the exact event to the in-memory projection and refresh derived presentation. Never acknowledge creation or open UI before this call returns.
3. Serialize coordinator mutations through one package-local synchronous/queued mutation boundary so answer/escalate/withdraw conflicts are decided against the latest revision. Do not duplicate transition checks in tools or UI.
4. Make duplicate tool execution reuse the request derived from `toolCallId`; terminal duplicates return stored state, pending duplicates follow the request's current delivery behavior.

**Gate:** exactly one terminal resolution; first valid conflict wins; repeated create/escalate/withdraw/delivery-marker operations are idempotent.

**Verification binding:** `Tool call → durable request` and `Escalation/withdraw conflicts`. Exercise answer-vs-escalate in both orders, answer-vs-withdraw in both orders, and duplicate transition callbacks.

### Milestone 3 — coordinator waiters, picker outcomes, and blocking compatibility

1. Change `AskUserQuestionComponent` to return a presentation outcome union: `submitted` with structured answer composition, `declined`, or `closed`. Store selected option IDs and free text separately; labels are derived for the tool envelope.
2. Make Escape help context-sensitive. Escape inside the free-text editor remains “back”; inbox and inbox-selected pickers say `close` and have no domain effect; live blocking ask/wait pickers say `cancel` and return `closed` for coordinator interpretation. Preserve current tabs, review, multi-select, free text, draft semantics, and one-shot callback guard.
3. Add coordinator waiter registration keyed by request ID. A blocking create persists, registers a waiter, opens the picker, and awaits the waiter. For a live blocking picker, `closed` commits withdrawal and resolves the waiter; for an inbox-selected picker it only returns to the inbox. Submit/decline commit through the service and resolve exactly one waiter.
4. On answer with a live waiter, return the stored envelope through the blocked tool and suppress async delivery. On `session_shutdown`, detach all waiters without writing lifecycle events.
5. Implement `wait_for_user_question`: terminal returns immediately; pending non-blocking appends escalation then waits; pending blocking attaches idempotently without changing urgency or creating a request.

**Gate:** blocking Escape withdraws and settles exactly once; inbox/non-blocking Escape has no domain effect; explicit submit/decline settles once; duplicate callback cannot create a second terminal event or follow-up.

**Verification binding:** `Picker → service transition`, `Blocking waiter → answer`, default blocking compatibility, Escape cases, answered/pending escalation cases. Drive the real component through keyboard input, including Submit followed by Escape/repeated Enter.

### Milestone 4 — non-blocking creation, withdrawal, and answer delivery

1. Return the compact pending envelope only after the created event append returns.
2. Implement `withdraw_user_question` through the service; pending becomes withdrawn, repeated withdrawal is idempotent, terminal requests remain terminal.
3. For any terminal resolution not consumed by a live waiter—including a previously blocking request reconstructed after restart—send one custom answer message with stable terminal event identity in `details`, compact authoritative content, `deliverAs: "followUp"`, and `triggerTurn: true`.
4. Only after the synchronous enqueue call succeeds, append `question.answer_delivered`. On a thrown delivery call, leave it undelivered, emit a bounded diagnostic, and permit reconciliation retry according to the Gate 0 guarantee.
5. On `session_start`, discard previous runtime/waiter assumptions, project the active branch, reconcile each terminal resolution lacking a marker, and restore status. Do not reopen old blocking tool executions.

**Gate:** a live waiter and asynchronous delivery are mutually exclusive; accepted follow-ups receive one marker; marked terminal events do not replay; delivery failure does not corrupt terminal state.

**Verification binding:** `Non-blocking answer → model delivery`, reload with pending, reload with undelivered answer, answer active blocking, and delivery duplicate suppression. Test replay before delivery, after marker, and a throwing `sendMessage`; apply the exact Gate 0 interpretation to the crash-gap case.

### Milestone 5 — badge, inbox overlay, command, and shortcut

1. Implement pure badge derivation in `inbox.ts`: count all pending bundles, maximum urgency color, and a compact blocking marker. Cache the last rendered text/style and call `setStatus` only when it changes; clear at zero.
2. Implement an inbox `Component` using Pi-supplied render width and ANSI-aware truncation. Never read `process.stdout.columns`.
3. Render ordered pending rows with semantic urgency and delivery glyph/text. At narrow widths drop age, then delivery label, then urgency text while retaining glyph and truncated topic.
4. Add Up/Down cursor, Enter picker, and Escape close. Opening/closing changes no service state. Picker Escape returns to inbox; preserve drafts only in coordinator-owned process-local presentation storage.
5. Register `/questions` and `Key.ctrlShift("u")` to the same coordinator entry point. If there is no UI, notify clearly and do not mutate state. Do not add a second persistent widget or mouse behavior.

**Gate:** badge equals pending service projection; opening/reading/closing never decrements it; every rendered line fits supplied width; command remains available if shortcut conflicts.

**Verification binding:** `Badge/inbox projection → TUI`, Escape inbox picker, withdraw/badge, mixed ordering, status value-gating, and width cutoffs.

### Milestone 6 — tools, prompt, transcript rendering, and non-interactive behavior

1. Keep tool wiring in `index.ts` thin: validate model input, invoke coordinator, and format the shared envelope. Register exactly `ask_user_question`, `wait_for_user_question`, and `withdraw_user_question`; add no list/status/poll tool.
2. Put the frozen prompt guidance in `prompt.ts` and append it through `before_agent_start` only when the question tools are active. Keep UI commands out of model guidance.
3. Update renderers: pending creation shows request ID/topic/urgency; blocking answers show selected answers; escalation and withdrawal show compact transitions; all cards remain width bounded and transcript-safe.
4. On the first UI-dependent invocation in `ctx.hasUI === false`, return a clear unsupported error and remove all three question tools from the active set. Also ensure the prompt module is absent once disabled. Do not create state before this check.
5. Preserve the existing question count/options/header/label constraints and uniqueness errors; invalid input creates no event.

**Gate:** omitted fields preserve blocking/normal compatibility; all three tools share one envelope and one lifecycle owner; non-interactive mode leaves no request and no active question tool.

**Verification binding:** the tool schema/execution rows, real extension registration harness, non-interactive harness, invalid duplicate input, and transcript width checks.

### Milestone 7 — package documentation and actual load smoke

1. Update the package README only after tool names, controls, and test identities stabilize. Document branch-scoped durability, context-sensitive Escape behavior, `/questions`, shortcut fallback, non-interactive behavior, and the non-resumption of blocking calls after restart.
2. Run the actual Pi package/extension load in an isolated, non-destructive temporary session/config. Confirm loader success and registration of three tools, command, and shortcut. Do not use the live user session or mutate global Pi configuration.
3. If source directory loading differs from built package loading, test the package's declared `pi.extensions` path rather than adding a loader shim.

**Gate:** actual Pi loads without errors; package docs match implemented behavior and the selected Gate 0 delivery guarantee.

**Verification binding:** `Package discovery` and the final compatibility matrix row.

### Milestone 8 — focused review and remediation

After the primary worker supplies evidence, perform focused review in dependency order:

1. **Lifecycle reviewer:** inspect service ownership, projection, event validation, conflict ordering, waiter/delivery exclusivity, and restart behavior.
2. **TUI/tool reviewer:** inspect Escape semantics, inbox ordering/width, status value-gating, schema defaults, prompt activation, and transcript rendering.
3. Re-run only the package checks and the one extension-load smoke after remediation. If two remediation cycles fail in the same lifecycle area, stop/re-plan as required by `design.md`.

Review must reject duplicated domain checks in `index.ts`, `component.ts`, or `inbox.ts`; process-global authoritative state; a compatibility shim; a second persistence path; scripted tests that bypass real registration; or a fake “delivered” assertion that never executes `pi.sendMessage`.

## Validation matrix and commands

| Runtime invariant | Required trustworthy evidence |
|---|---|
| Successful creation is durable before acknowledgment/UI | Real registered tool execution; captured `appendEntry` precedes result or `ui.custom`; same `toolCallId` twice yields one create. |
| Projection is deterministic and branch scoped | Real projector over session-entry-shaped active-branch records; duplicate terminal, invalid post-terminal, malformed, legacy, and unknown-version records do not corrupt state. |
| Escape follows context | Real picker keyboard input plus captured coordinator events; blocking Escape emits one withdrawal and clears pending state, while inbox/non-blocking Escape emits no terminal event. |
| Live blocking resolution has one transport | Controlled real coordinator waiter and captured `sendMessage`; one tool result, zero follow-ups under duplicate answer callback. |
| Unwaited terminal resolution has bounded once-only follow-up delivery | Real coordinator/extension registration and captured `sendMessage`/entries; replay before send, after marker, and delivery throw, interpreted per Gate 0. |
| Badge and inbox are projections | Pure mixed-state projection plus real `setStatus` capture and component render calls at cutoff widths; opening/closing leaves count unchanged. |
| Conflicts are atomic and idempotent | Service transition tests over revisioned events in both event orders; terminal state never reopens. |
| Package is discoverable | Actual isolated Pi package load, plus captured registration/non-interactive harness. |

Run with fail-fast outer timeouts appropriate to the environment:

```bash
timeout 120s npm run check --workspace @bravo/ask-user-question
timeout 180s npm test --workspace @bravo/ask-user-question
# Then one bounded, isolated actual Pi extension-load smoke using the locally available Pi CLI.
```

Do not run root `npm run check`, all-workspace tests, browser tests, PTY automation, or unrelated package tests. Manual visual inspection may refine layout after correctness but is not completion evidence.

## Stop/re-plan conditions and non-goals

Stop and return to the frozen design if any trigger in `design.md` occurs, including inability to close blocking presentation independently, unfaithful active-branch reconstruction, need for Pi core changes, unsafe follow-up delivery, need for another persistence system, or pressure to retain old and new lifecycle paths. Also stop if implementation cannot make the harness execute the real extension registration/persistence/delivery path.

Do not implement cross-session/global inboxes, polling/status tools, durable unresolved-tool resumption, a database/daemon/server/scheduler, notifications outside Pi follow-ups, mouse input, duplicate persistent widgets, broad terminal automation, performance benchmarks, or compatibility for the old `cancelled` result beyond safely ignoring historical entries.
