# Tango Coordination Board and Inbox Implementation Plan

Date: 2026-04-29
Status: Draft

## Implementation stance

This is a hard cutover. No legacy compatibility shims, migrations, or dual-path rollout are required.

Acceptable breaking changes:

- replacing attention records with inbox records;
- replacing parent wake-up subscriptions with inbox-driven wake-ups;
- changing CLI output shapes for new coordination commands;
- updating Pi tool guidance to prefer board/inbox;
- ignoring old local `attention.jsonl` and `subscriptions.jsonl` data.

## Phase 1 — Core types and stores

### Work

- Add shared types for:
  - `InboxItem`
  - `MessageRecord`
  - `BoardView`
  - `BoardItem`
  - `TaskRecord`
- Add local JSONL stores:
  - `inbox.jsonl`
  - `messages.jsonl`
  - optional `tasks.jsonl`
- Implement last-record-wins readers/writers by ID.
- Add helpers:
  - create inbox item
  - mark read
  - mark handled
  - dismiss
  - list by root/workstream/parent/run

### Validation

- Unit tests for JSONL append/read/update semantics.
- Unit tests for no ambiguous `seen` state.
- Unit tests that repeated result/block/stall events dedupe into one unresolved inbox item per run/type.

### Hand testing

- Manually create synthetic inbox records with a small Node script or CLI helper.
- Verify `inbox.jsonl` appends records and last-record-wins state is returned.
- Corrupt one line manually and verify reader skips it without crashing.

## Phase 2 — Board projection

### Work

- Implement board builder from:
  - run metadata / run state
  - metrics
  - result readiness
  - inbox unresolved items
  - lineage/root/workstream filters
- Board sections:
  - active
  - blocked
  - stalled
  - offline
  - unreadResults
  - recentCompletions
  - recentErrors
- Add suggested next action per item.

### Validation

- Unit tests for grouping agents into board sections.
- Unit tests for result-ready + unread inbox item appearing in `unreadResults`.
- Unit tests for blocked/stalled/offline prioritization.

### Hand testing

- Start a few real Tango agents:
  - one running interactive agent;
  - one oneshot scout that completes;
  - one agent manually reported blocked.
- Run board projection and confirm sections match reality.
- Read the completed result and confirm it disappears from `unreadResults` after handling.

## Phase 3 — Server APIs

### Work

Add server endpoints:

- `GET /api/v1/board`
- `GET /api/v1/inbox`
- `POST /api/v1/inbox/:id/read`
- `POST /api/v1/inbox/:id/handled`
- `POST /api/v1/inbox/:id/dismiss`
- `POST /api/v1/messages`
- `GET /api/v1/workstreams/:id/board`
- `GET /api/v1/workstreams/:id/inbox`

Emit SSE events for inbox/board-relevant changes.

### Validation

- Server tests for each endpoint.
- Tests for auth behavior matching existing server routes.
- Tests for workstream-scoped filtering.

### Hand testing

- Start `tango server --port 0`.
- Use `curl` or `node fetch` against:
  - `/api/v1/board`
  - `/api/v1/inbox`
  - read/handled endpoints.
- Open dashboard and verify SSE still connects.
- Watch server logs while creating inbox items and confirm SSE emits updates.

## Phase 4 — CLI commands

### Work

Add commands:

- `tango board --json`
- `tango inbox --json`
- `tango inbox read <id>`
- `tango inbox handled <id>`
- `tango inbox dismiss <id>`
- `tango collect-results --json`
- extend `tango message` with structured type fields:
  - `--type instruction|ask|update|broadcast`
  - `--urgent`
  - `--attachment <path>`

Make `tango result` mark matching result inbox items handled by default.

### Validation

- CLI tests for command parsing and JSON output.
- Test `collect-results` reads all unread ready results and marks handled.
- Test `message --type ask` creates message/inbox records as appropriate.

### Hand testing

- Run `tango board --json` before any agents exist.
- Start a scout; verify it appears active.
- Wait for completion; verify `tango inbox --json` shows result item.
- Run `tango collect-results --json`; verify result returned and inbox handled.
- Send a structured message to an interactive agent and inspect delivered text.

## Phase 5 — Pi tools and TUI

### Work

Add Pi tools:

- `tango_board`
- `tango_inbox`
- `tango_collect_results`

Update `tango_message` schema to expose structured message fields.

Add:

- `/tango-board` overlay;
- compact widget when board has active/blocked/stalled/offline/unread items;
- footer summary from board counts.

### Validation

- Type-check Pi extension.
- Unit-level renderer tests where practical.
- Existing Tango Pi tools should still build.

### Hand testing

- Launch Pi in this repo with Tango extension.
- Start two child agents from Pi.
- Confirm footer/widget updates while agents run.
- Open `/tango-board` and inspect active/unread/blocked sections.
- Have a child report blocked; verify parent receives inbox-driven wake-up.
- Read result through Pi tool; verify inbox item handled.

## Phase 6 — Stall/offline detection

### Work

- Add `lastSeenAt` and `lastActivityAt` derivation.
- For Pi agents:
  - metrics/report events update activity.
- For tmux/CLI agents:
  - process/tmux liveness updates `lastSeenAt`;
  - output/pane changes update fallback `lastActivityAt`.
- Derive:
  - `offline` after 2m without liveness;
  - `stalled` after 5m without activity while alive.
- Emit inbox items for stalled/offline transitions.
- Suppress stall/offline inbox spam while an unresolved item exists.

### Validation

- Unit tests with fake timestamps.
- Tests that sticky states suppress stall:
  - blocked
  - waiting_for_input
  - done
  - error
  - stopped
- Tests that recovery clears board stalled/offline classification when activity resumes.

### Hand testing

- Start an interactive tmux-backed agent and leave it idle.
- Temporarily lower thresholds in code/config for manual test if needed.
- Confirm it becomes stalled, not offline, while tmux is alive.
- Stop/kill tmux or process and confirm offline is detected.
- Report blocked before waiting and confirm no stalled item is emitted.

## Phase 7 — Dashboard update

### Work

- Update operations dashboard to consume board projection.
- Replace attention panel with inbox panel.
- Add inbox actions:
  - read
  - handled
  - dismiss
- Keep timeline as event history.
- Keep agent tree as lineage.

### Validation

- Dashboard type-check.
- Dashboard API tests updated for board/inbox.
- Component tests if existing patterns support it.

### Hand testing

- Start server and open dashboard.
- Start/complete/block agents and confirm dashboard updates live.
- Mark inbox item handled from dashboard and confirm CLI sees handled state.
- Confirm board counts match CLI `tango board --json`.

## Phase 8 — Prompt/docs update

### Work

- Update Tango orchestration includes:
  - use `tango_board` before broad status checking;
  - use `tango_inbox` for pending child asks/results;
  - use `tango_collect_results` for ready child outputs;
  - use status for state and messages for communication.
- Update README command references.
- Update server/dashboard docs.

### Validation

- Review prompt includes for clarity and lack of legacy guidance.
- Build package.

### Hand testing

- Start a lead agent and ask it to manage two children.
- Observe whether it uses board/inbox rather than repeatedly polling individual agents.
- Confirm multi-turn reuse: after a fresh parent turn, the lead can recover state from board/inbox.

## Final validation commands

Run from repo root:

```bash
npm run check --workspace @bravo/tango
npm test --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

If dashboard code changes are substantial, also run:

```bash
cd packages/tango/dashboard && npx tsc --noEmit && npx vite build
```

## End-to-end hand test script

Perform this manually before considering the work complete:

1. Start server:
   - `tango server --port 0`
2. Start a oneshot child:
   - `tango start scout-test --role scout "Summarize packages/tango README" --json`
3. Check board:
   - `tango board --json`
   - verify active item.
4. Wait for completion:
   - `tango follow scout-test --until result-resolved --json`
5. Check inbox:
   - `tango inbox --json`
   - verify unread result item.
6. Collect results:
   - `tango collect-results --json`
   - verify result included and inbox item handled.
7. Start interactive child:
   - `tango start worker-test --role worker --mode interactive "Wait for follow-up instructions" --json`
8. Send structured instruction:
   - `tango message worker-test --type instruction "Report blocked waiting for input" --json`
9. Have/force child report blocked:
   - `tango report blocked "Waiting for input" --needs input --run-dir <worker-run-dir> --json`
10. Check board and inbox:
   - verify blocked section and blocked/ask inbox behavior.
11. Mark handled:
   - `tango inbox handled <id>`
12. Open dashboard:
   - verify board/inbox match CLI.
13. Test stall/offline with reduced thresholds or controlled idle/kill.
14. In Pi, start a child with `tango_start`, then verify `tango_board`, `tango_inbox`, widget/overlay, and result handling.

## Completion criteria

The feature is complete when:

- a lead can recover current workstream state from `tango_board` alone;
- all unread child asks/results are visible in `tango_inbox`;
- reading/collecting results marks inbox items handled;
- stalled/offline agents appear on board and create inbox items;
- dashboard and CLI show the same board/inbox truth;
- Pi lead agents have tools that make board/inbox the default coordination path.
