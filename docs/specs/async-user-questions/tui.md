# TUI Interaction Contract

## Surface selection

Use one persistent footer status segment and one on-demand overlay. Do not add a persistent widget containing the same information.

## Badge

Default rendering:

```text
[3 user-questions]
```

Contract:

- counts unresolved pending request bundles;
- opening or reading a request does not decrement it;
- value is updated only when rendered text/style changes;
- color reflects maximum pending urgency: low dim, normal amber, high red/attention;
- when any request is blocking, include a compact question/blocking marker without adding another status segment;
- clears when no pending requests remain.

## Entry points

- `/questions` opens the inbox.
- A registered shortcut opens the same inbox; initial default candidate is `ctrl+shift+u`.
- The command is the stable fallback if the shortcut conflicts with user configuration or another extension.
- Tool/prompt guidance must not require the model to invoke UI commands.

## Inbox overlay

Use `ctx.ui.custom(..., { overlay: true })` and Pi-provided render width. No `process.stdout.columns`.

Rows display:

- blocking/non-blocking state;
- urgency;
- age;
- question header/topic summary.

Ordering follows the lifecycle spec: blocking first, urgency descending, oldest first.

Suggested controls:

- Up/Down: move request cursor.
- Enter: open selected request.
- Escape: close inbox.
- Optional explicit key for decline may be added only if clearly labeled; there is no implicit dismissal.

## Picker reuse

The existing `AskUserQuestionComponent` remains the question editor, with these lifecycle changes:

- it returns a distinct presentation outcome: submitted, declined, or closed;
- the component reports a `closed` presentation outcome; the coordinator interprets it by context;
- when opened from inbox, Escape returns to inbox without changing request state;
- when opened by a blocking call, Escape is labeled cancel, withdraws the request, clears it from badge/inbox, and releases the tool call;
- only explicit Submit creates an answer;
- explicit Decline, if exposed, creates a declined resolution;
- drafts may survive closing during the current process but are not durable and never count as answers.

## Focus and navigation

- The inbox remains an overlay. The picker uses the original extension surface in the editor area, and closing it restores the normal editor focus.
- A reopened request reconstructs committed request state and any process-local draft.
- Multiple question tabs and final review remain as upstream behavior.
- Help text says `Esc close` for presentation-only contexts and `Esc cancel` for a live blocking picker.

## Tool transcript rendering

- Non-blocking creation renders a compact pending receipt with request ID/topic and urgency.
- Blocking resolution renders the selected answers as today.
- Withdrawal and escalation render compact state transitions.
- Tool cards remain transcript-safe and width bounded.
- Do not display the footer badge data again in a persistent chat card.

## Responsive behavior

- Every rendered line must fit the width Pi supplies.
- At narrow widths drop age, then delivery label, then urgency text while preserving a semantic glyph and truncated topic.
- Use ANSI-aware Pi TUI width/truncation helpers.
- Badge is compact enough to fit normal footer layouts; if the footer truncates statuses, `/questions` remains available.

## Accessibility semantics

- Urgency is conveyed by text/glyph as well as color.
- Cursor movement is not selection.
- Draft checkbox state is not submission.
- Closing the inbox or an inbox-selected picker is not domain cancellation; `Esc cancel` in a live blocking picker is explicit domain cancellation.
