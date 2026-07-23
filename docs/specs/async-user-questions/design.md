# Async User Questions Design

Status: Approved design, implementation pending
Package: `packages/ask-user-question`

## Goal

Extend the existing structured `ask_user_question` Pi extension with a session-durable question inbox. Agents may ask blocking questions or enqueue non-blocking questions, continue independent work, and later wait on a pending request when its answer becomes necessary.

The existing picker remains the answer-entry component. Lifecycle ownership moves out of the modal into a question service reconstructed from Pi session entries.

## Product contract

- One tool call creates one question request containing 1–4 related questions.
- `delivery` and `urgency` are orthogonal:
  - delivery controls whether the invoking tool waits;
  - urgency controls ordering and visual attention.
- Non-blocking creation returns only after the request is durably appended.
- Blocking creation persists first, opens the picker, and waits for explicit resolution.
- Escape is context-sensitive: in the inbox or a non-blocking picker it only closes presentation; in a live blocking picker it cancels that blocking request by withdrawing it and releasing the tool call.
- Pending requests remain visible through one footer badge and a keyboard/command-opened inbox.
- A pending non-blocking request may later become the blocking point through `wait_for_user_question`.
- Non-blocking answers use bounded once-only delivery at a safe follow-up boundary: no duplicate accepted enqueue within a live runtime or after replay containing a delivery marker. A process crash after Pi accepts the follow-up but before the marker is appended may cause one replay. Blocking answers are returned through the waiting tool and are not also injected.

## Modular contract documents

- [Lifecycle and ownership](lifecycle.md)
- [Agent tool and prompt contracts](tools-and-prompting.md)
- [TUI interaction contract](tui.md)
- [Runtime invariants and verification](verification.md)

These documents jointly define the source of truth. If they conflict, this design overview controls product intent, while the more specific module controls mechanics within its named surface.

## Package boundary

The change stays inside `packages/ask-user-question` plus this spec and root lockfile metadata if package structure changes.

Expected internal modules:

- schema/types: request, answer, event, and tool schemas;
- question service/store: canonical projection and transitions;
- Pi runtime coordinator: event persistence, waiter registry, answer delivery, restart reconciliation;
- inbox UI: badge, ordering, overlay, picker navigation;
- tool registration/rendering: agent-facing contracts and compact transcript output.

The picker component must not own durable state, delivery, escalation, or restart behavior.

## Compatibility

- Existing callers that omit `delivery` and `urgency` retain blocking behavior with normal urgency.
- Existing question schema remains accepted.
- The existing `ask_user_question` name remains stable.
- No compatibility layer for the old `cancelled` result shape is required outside stored historical session entries; old entries must be ignored safely during projection.
- No Pi core changes.

## Non-goals

- Cross-session or global user-question inbox.
- Multi-user synchronization or cloud storage.
- Durable resumption of an unresolved blocking tool call after process restart.
- A new database, daemon, server, notification subsystem, or task scheduler.
- A general-purpose agent messaging framework.
- Mouse input.
- A persistent multi-line widget duplicating the badge.
- A broad testing framework or exhaustive terminal automation suite.

## Current runtime limitations

Pi has no proven persisted interrupt/resume seam for an unresolved tool execution across process restart. Therefore:

- non-blocking requests and answers are session-durable;
- blocking waits are process/session-runtime lifetime only;
- if a blocking waiter is lost on reload/restart, the request remains pending and a later answer uses asynchronous delivery rather than pretending the original tool call resumed.

Pi also cannot atomically pair `sendMessage` with the `question.answer_delivered` custom entry. The accepted v1 guarantee is bounded once-only delivery: normal live execution and replay with a marker suppress duplicates, but a crash after enqueue acceptance and before marker persistence may redeliver once. Strict exactly-once delivery would require a Pi transactional/idempotent delivery seam and is outside this package.

## Stop/re-plan triggers

Stop implementation and return to design if:

- `ctx.ui.custom()` cannot restore the editor and resolve a blocking invocation cleanly when Escape cancels the blocking request;
- Pi custom entries cannot faithfully reconstruct branch-scoped pending state;
- reliable answer delivery requires a Pi core change;
- a second persistence system, background daemon, or cross-session store becomes necessary;
- runtime evidence shows `followUp` delivery cannot provide a safe deduplicated answer boundary;
- implementation needs a compatibility shim or duplicate old/new lifecycle path;
- two remediation cycles fail in the same lifecycle area.

## Definition of done

The real extension registration, session-entry persistence/projection, inbox interaction, and answer-delivery paths execute green through the package’s practical local test seam. Validation includes one injected duplicate/replay or conflicting-transition fault and one package load/runtime smoke. Manual visual inspection is useful for refinement but is not the correctness seam.
