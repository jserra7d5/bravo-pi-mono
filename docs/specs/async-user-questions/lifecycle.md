# Lifecycle and Ownership

## Behavior ownership & lifecycle

- **Owner:** a package-local question service owns request state, transitions, projection, idempotency, and answer-event identity.
- **Formatting/validation:** tool schema and validation modules own model input validation; the picker owns only draft editing and answer composition.
- **Persistence/observation:** Pi custom session entries are the durable event log; the in-memory service is a branch-scoped projection rebuilt from `ctx.sessionManager.getBranch()`.
- **Transport/execution:** the Pi runtime coordinator owns blocking waiters and delivery of resolved non-blocking answers through `pi.sendMessage`.
- **Presentation:** inbox, badge, and picker render service state. Presentation-only close has no domain effect; Escape in a live blocking picker explicitly invokes cancellation through the coordinator.
- **Forbidden owners/surfaces:** unresolved Promises, modal instances, footer text, tool renderers, and process-global variables must not be authoritative state.

## Value lifetime

- request/event IDs: stable for the Pi session branch;
- request lifecycle and answers: durable branch-scoped session state;
- drafts and current inbox cursor: process-local presentation state;
- active blocking waiter: process/session-runtime only;
- badge text: derived ephemeral projection;
- delivery acknowledgement: durable event so reload does not redeliver.

## Canonical model

```ts
type Delivery = "blocking" | "non_blocking";
type Urgency = "low" | "normal" | "high";
type RequestState = "pending" | "answered" | "declined" | "withdrawn";

type QuestionRequest = {
  requestId: string;
  originatingToolCallId: string;
  delivery: Delivery;
  urgency: Urgency;
  state: RequestState;
  questions: Question[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  resolution?: QuestionResolution;
};
```

Options gain stable IDs for authoritative answer storage. Labels remain display values. Free text is stored separately from selected option IDs.

## Durable events

Custom entry type: `async-user-question`.

Versioned event variants:

- `question.created`
- `question.escalated`
- `question.answered`
- `question.declined`
- `question.withdrawn`
- `question.answer_delivered`

Every event carries `version`, `eventId`, `requestId`, `occurredAt`, and the transition-specific payload. Projection is last-valid-transition wins, not last-record blindly wins.

## Lifecycle

### Creation

1. Validate the question batch and uniqueness rules.
2. Derive a deterministic request identity from the originating tool call.
3. If already present, return or wait on the existing request according to its current state.
4. Append `question.created` before acknowledging success or opening UI.
5. Refresh projection and badge.

### Blocking path

1. Persist pending request.
2. Register a process-local waiter for `requestId`.
3. Open the existing picker.
4. Explicit Submit/Decline commits a terminal event and resolves the waiter.
5. Escape cancels a live blocking picker: append `question.withdrawn`, remove it from the actionable badge/inbox, and resolve the tool waiter with the withdrawn state.
6. If the runtime shuts down, detach the waiter without changing request state.

### Non-blocking path

1. Persist pending request.
2. Return a compact pending receipt immediately.
3. Continue independent agent work.
4. On answer/decline, persist the terminal event.
5. If no live blocking waiter consumed the resolution, enqueue one asynchronous answer message.
6. Append `question.answer_delivered` only after the delivery call is accepted.

### Escalation

`wait_for_user_question` atomically changes pending non-blocking to pending blocking, appends `question.escalated`, registers a waiter, and waits.

- already answered/declined/withdrawn: return stored terminal state immediately;
- already blocking: attach/wait idempotently;
- urgency does not change;
- escalation never reopens a terminal request.

### Withdrawal

`withdraw_user_question` transitions only pending requests. It exists to remove obsolete questions from the actionable badge. Repeated withdrawal is idempotent.

## Ordering and counts

The actionable count includes every pending request, regardless of read/open state.

Inbox order:

1. blocking before non-blocking;
2. high, normal, low urgency;
3. oldest first within a bucket.

## Concurrency and conflict rules

- A request has exactly one terminal resolution.
- Answer vs decline/withdraw: first valid terminal transition wins.
- Answer vs escalation: if answer wins, escalation returns it; if escalation wins, the answer resolves the waiter.
- Duplicate delivery is suppressed during a live runtime and after any replay containing `question.answer_delivered`. A crash after Pi accepts the follow-up but before the marker append may redeliver once; this bounded crash gap is accepted in v1.
- Duplicate create for one tool-call identity returns the existing request.
- Submit and blocking Escape race: the first valid terminal transition wins. Escape from an inbox/non-blocking picker only closes presentation.

## Restart/reload reconciliation

On `session_start`:

1. project valid events from the current branch;
2. discard invalid/unknown-version events with a bounded diagnostic, not a crash;
3. clear all process-local waiter assumptions;
4. deliver any terminal non-blocking resolution lacking `question.answer_delivered`;
5. treat previously blocking pending requests as pending without a waiter; when answered, deliver asynchronously;
6. restore the derived badge.
