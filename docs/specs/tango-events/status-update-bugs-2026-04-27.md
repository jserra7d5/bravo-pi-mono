# Tango status update bugs observed 2026-04-27

## Context

During a Quantiiv root Pi session, three Tango scout agents were started and then explicitly awaited/inspected by the parent:

- `roger-run-viewer-scout`
- `switchyard-events-scout`
- `roger-integration-scout`

The parent used `tango wait ... --json`, then `tango_result` for all three, synthesized the results, and replied to the user.

After that, the parent session received separate proactive wake-up messages for each already-handled completion:

```text
Tango status update:

- <agent> (scout) is done
  Suggested: tango_result <agent>

Treat this as a wake-up only; inspect child output/result before summarizing or taking action.
```

## Observed bugs / UX issues

### 1. Stale completion notifications after explicit wait/result handling

The notifications arrived after the parent had already:

1. waited for terminal status with `tango wait`,
2. inspected results with `tango_result`, and
3. summarized those results to the user.

This made the notifications stale and caused redundant user-visible responses.

Expected behavior options:

- suppress proactive completion notifications for agents already observed via `tango wait` or `tango_result`; or
- mark those notifications as already acknowledged/handled; or
- batch them before the next assistant turn rather than delivering them individually afterward.

### 2. One notification per child causes noisy user-visible turns

The three completed children generated three separate wake-ups, each requiring a response. Because the parent had already handled all three, the session produced repetitive acknowledgements.

Expected behavior options:

- coalesce multiple completed-child notifications into one batched update;
- include an `alreadyInspected` / `lastObservedAt` signal so the assistant can silently ignore stale events;
- only surface wake-ups when they represent new terminal state not yet observed by the parent.

### 3. Suggested action is misleading when result was already inspected

The message suggested `tango_result <agent>` even though `tango_result` had already been called. The instruction says to inspect before summarizing, which is correct in general, but stale suggestions create unnecessary work and user-facing noise.

Expected behavior options:

- suggestions should account for parent observation state;
- if the event is stale, say so explicitly or do not emit it;
- if the agent result has already been read, suggest no action.

## Impact

- Adds extra assistant turns that do not advance the user's task.
- Makes proactive Tango notifications feel unreliable/stale.
- Increases the chance that the parent re-summarizes old child output or distracts from the main workflow.

## Repro shape

1. Start multiple oneshot Tango children.
2. Wait for all with `tango wait child1 child2 child3 --json`.
3. Read all with `tango_result`.
4. Reply to user with synthesized findings.
5. Observe delayed proactive `Tango status update` messages for already-handled children.

## Possible fix direction

Maintain per-parent child observation/ack state keyed by child name + terminal version/update timestamp. Mark a child as observed when the parent runs any of:

- `tango wait <child>` returning terminal state,
- `tango_result <child>`,
- possibly `tango_look <child>` after terminal state.

The proactive notifier should suppress or de-prioritize terminal notifications whose terminal state version is already observed. If multiple unobserved terminal events exist, deliver one batch.
