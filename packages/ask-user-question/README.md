# @bravo/ask-user-question

A Pi extension for branch-scoped, session-durable structured user questions. `ask_user_question` creates one bundle of 1–4 questions with blocking (default) or non-blocking delivery and low/normal/high urgency. `wait_for_user_question` promotes an existing request to the current blocking point; `withdraw_user_question` removes an obsolete pending request.

Pending requests appear in one footer badge. Open the inbox with `/questions` or `ctrl+shift+u` (the command remains available if the shortcut conflicts). Escape closes the inbox or an inbox-selected picker without changing request state. In a live blocking picker, Escape is labeled cancel: it withdraws the request, removes it from the badge/inbox, and releases the tool call. Explicit Submit resolves a request.

Non-interactive invocation reports that UI is required and disables all three tools for that session. State is reconstructed from the active Pi session branch. Drafts and live blocking waiters are process-local: after restart, an unresolved blocking tool call is not resumed, though its request remains pending. Unconsumed answers are delivered as follow-ups. Delivery is once-only in a live runtime and after a persisted delivery marker; a crash after Pi accepts a follow-up but before that marker is persisted can replay it once.

## Install locally in Pi

```bash
pi install ./packages/ask-user-question
```

## Development

```bash
npm run check --workspace @bravo/ask-user-question
npm test --workspace @bravo/ask-user-question
```

## Upstream and license attribution

The picker implementation and its original tests were adapted from [ghoseb/pi-askuserquestion](https://github.com/ghoseb/pi-askuserquestion) at commit [`e58609c`](https://github.com/ghoseb/pi-askuserquestion/commit/e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578). The upstream README declares the project MIT licensed.
