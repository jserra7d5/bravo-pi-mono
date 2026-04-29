# Tango Coordination Board and Inbox

Date: 2026-04-29
Status: Draft

## Problem

Tango can start, inspect, message, and stop agents, but coordination still requires stitching together too many primitives. Leads and humans need one place to answer:

- What agents are active?
- Which are blocked, stalled, or offline?
- Which results are ready but unread?
- Which child asked a question?
- What changed since the last turn?
- What should I do next?

This is mostly an async/interactive-agent problem. The agents work; the parent/lead coordination surface is too fragmented.

## Goal

Add a server-first coordination layer with two concepts:

1. **Board** — current operational state.
2. **Inbox** — durable unread/handled coordination items.

The board answers: **what is happening?**

The inbox answers: **what needs to be read or handled?**

## Non-goals

- Do not replace Tango's tmux/runtime model.
- Do not require cloud hosting.
- Do not encourage uncontrolled peer-to-peer worker chatter.
- Do not preserve old attention/subscription semantics if they complicate the model.
- Do not add compatibility shims for older local Tango data.

## Design Position

This is a hard cutover design for a personal tool. The implementation may break existing local Tango state and commands if that makes the coordination model simpler.

Recommended simplification:

- Replace current attention records with inbox records.
- Replace parent wake-up subscriptions with inbox delivery/read state.
- Keep run metadata, metrics, results, and normalized events.
- Make server APIs the primary path for live coordination.
- Keep file-backed storage as persistence/recovery, not a separate public protocol.

## Core Model

### Status

Status is current machine state. It is small, overwriteable, and board-oriented.

States:

- `created`
- `running`
- `blocked`
- `waiting_for_input`
- `stalled`
- `offline`
- `done`
- `error`
- `stopped`

Status fields:

```json
{
  "state": "blocked",
  "summary": "Waiting for reviewer result",
  "needs": "child-result",
  "lastSeenAt": "...",
  "lastActivityAt": "...",
  "updatedAt": "..."
}
```

### Message

Message is communication. It is append-only, addressed, and inbox-oriented.

Types:

- `instruction` — parent/lead tells an agent what to do.
- `ask` — an agent needs input or a decision.
- `update` — progress note.
- `result` — result is ready or attached.
- `state-change` — notable status transition.
- `broadcast` — instruction/update sent to multiple agents.

Message fields:

```json
{
  "messageId": "msg_...",
  "type": "ask",
  "fromRunId": "run_worker",
  "toRunId": "run_lead",
  "rootSessionId": "sess_...",
  "workstreamId": "ws_...",
  "body": "Should I preserve the old CLI flag?",
  "urgent": false,
  "attachments": [],
  "createdAt": "...",
  "readAt": null,
  "handledAt": null
}
```

Some events update both status and inbox. Example: a child needing a decision becomes `blocked` and creates an `ask` inbox item.

## Board

The board is a derived projection for a root session, workstream, parent run, or project.

Sections:

- `active`
- `blocked`
- `stalled`
- `offline`
- `unreadResults`
- `recentCompletions`
- `recentErrors`

Each item includes:

- agent name, role, harness, mode;
- `runId` / `runDir`;
- parent/child relationship;
- status;
- active tool or last activity;
- last seen / last activity age;
- result readiness and unread state;
- summary / needs;
- suggested next action.

Example:

```json
{
  "schemaVersion": 1,
  "scope": { "workstreamId": "ws_..." },
  "counts": { "active": 2, "blocked": 1, "unread": 3 },
  "active": [
    {
      "name": "worker-auth",
      "role": "worker",
      "runId": "run_...",
      "status": "running",
      "activity": "edit 42s ago",
      "next": "activity"
    }
  ],
  "blocked": [
    {
      "name": "planner-db",
      "runId": "run_...",
      "needs": "decision",
      "summary": "Needs migration strategy",
      "next": "inbox"
    }
  ],
  "unreadResults": [
    {
      "name": "scout-ui",
      "runId": "run_...",
      "resultReady": true,
      "unread": true,
      "next": "result"
    }
  ]
}
```

## Inbox

The inbox is persisted because read/handled state matters.

Inbox item types:

- `ask`
- `update`
- `result`
- `blocked`
- `stalled`
- `offline`
- `broadcast`

States:

- `unread`
- `read`
- `handled`
- `dismissed`

No `seen` state. `seen` is ambiguous; either an item was read or it was not.

Canonical inbox item:

```json
{
  "schemaVersion": 1,
  "inboxId": "in_...",
  "type": "result",
  "state": "unread",
  "recipient": {
    "rootSessionId": "sess_...",
    "workstreamId": "ws_...",
    "runId": "run_parent"
  },
  "source": {
    "runId": "run_child",
    "runDir": "/...",
    "agentName": "scout-ui"
  },
  "summary": "Result ready",
  "body": "scout-ui completed and result is ready.",
  "result": {
    "ready": true,
    "path": "/.../result.md",
    "finalizedAt": "..."
  },
  "createdAt": "...",
  "updatedAt": "...",
  "readAt": null,
  "handledAt": null
}
```

Result inbox items become handled when `tango result` or `tango collect-results` reads the result.

## Server Integration

The server is the preferred live coordination hub.

APIs:

- `GET /api/v1/board`
- `GET /api/v1/inbox`
- `POST /api/v1/inbox/:id/read`
- `POST /api/v1/inbox/:id/handled`
- `POST /api/v1/inbox/:id/dismiss`
- `POST /api/v1/messages`
- `GET /api/v1/workstreams/:id/board`
- `GET /api/v1/workstreams/:id/inbox`

Server responsibilities:

1. Maintain canonical live run state while running.
2. Persist normalized run events, state snapshots, inbox records, metrics, and results.
3. Derive board projections from run state + inbox state.
4. Emit SSE updates for board/inbox changes.
5. Route structured messages to runs.
6. Mark result inbox items handled when results are read.

The CLI should auto-start/use the local server for normal operation. Degraded file-only operation is allowed only for explicit recovery/debug commands, not as an equal compatibility path.

## Storage

Use simple local JSONL stores under `TANGO_HOME`.

Recommended files:

```text
server/root-sessions/*.json
runs/<project>/<agent>/metadata.json
runs/<project>/<agent>/state.snapshot.json
runs/<project>/<agent>/events.jsonl
runs/<project>/<agent>/result.md
runs/<project>/<agent>/metrics.json
inbox.jsonl
messages.jsonl
```

Inbox and messages can be append-only JSONL with last-record-wins compaction by ID. No migration from existing `attention.jsonl` or `subscriptions.jsonl` is required.

## CLI and Pi Tools

Add lead-friendly commands:

- `tango board --json`
- `tango inbox --json`
- `tango inbox read <inbox-id>`
- `tango inbox handled <inbox-id>`
- `tango inbox dismiss <inbox-id>`
- `tango collect-results --json`
- `tango message <target> --type instruction|ask|update|broadcast <body>`

Add Pi tools:

- `tango_board`
- `tango_inbox`
- `tango_collect_results`
- structured `tango_message`

Low-level tools may remain, but lead prompts should prefer board/inbox.

## Dashboard and TUI

Dashboard mapping:

- Operations page becomes the visual board.
- Attention panel becomes inbox.
- Agent tree remains lineage.
- Timeline remains event history.

Pi TUI additions:

- `/tango-board` overlay.
- Optional compact widget when active children, blocked agents, stalled/offline agents, or unread results exist.
- Footer summary: `Tango: 2 running · 1 blocked · 3 unread`.

## Inactivity and Stall Detection

Use Scion's dual-timestamp model, adapted for tmux/CLI agents.

Timestamps:

- `lastSeenAt`: process/tmux heartbeat.
- `lastActivityAt`: meaningful progress signal.

Derived states:

- `offline`: expected process/tmux heartbeat is gone.
- `stalled`: agent is alive but has no meaningful activity past threshold.

Default thresholds:

- offline after 2 minutes without liveness.
- stalled after 5 minutes without meaningful activity while still alive.

Sticky states suppress false stall alerts:

- `blocked`
- `waiting_for_input`
- `done`
- `error`
- `stopped`

Activity signals:

- Pi tool metrics and `tango report` are high confidence.
- Result/report/status events are high confidence.
- stdout/stderr append, tmux pane hash changes, and pane capture changes are fallback signals for non-Pi agents.

When an agent enters `stalled` or `offline`, create an inbox item unless one unresolved item of the same type already exists for that run.

## Delegation Policy

Default coordination is orchestrator-mediated:

- one lead owns a workstream;
- workers report to the lead;
- workers do not freely message each other unless explicitly allowed;
- recursive delegation is role-gated, typically `lead` only by default.

Role policy continues to control allowed child roles.

## Lightweight Task Records

Each delegated run should have a small task record tying runtime state to orchestration intent:

```json
{
  "taskId": "task_...",
  "runId": "run_...",
  "parentRunId": "run_parent",
  "purpose": "Review auth refactor",
  "expectedDeliverable": "review findings",
  "dependencies": [],
  "status": "running",
  "resultInboxId": null
}
```

This helps leads recover workstream state without rereading logs.

## Wake-up Semantics

Parent wake-ups should be driven by inbox items, not separate subscriptions.

Wake-up-worthy inbox items:

- `ask`
- `blocked`
- `stalled`
- `offline`
- `result`
- urgent `update`

The Pi extension should poll or subscribe to inbox changes for the current root/workstream and send a concise follow-up message only for new unread wake-up-worthy items.

## Resolved Ambiguities

- **Inbox storage:** one append-only `inbox.jsonl` under `TANGO_HOME`, last-record-wins by `inboxId`.
- **Result handling:** `tango result` and `tango collect-results` mark matching result inbox items handled by default.
- **Stall thresholds:** default 2m offline, 5m stalled; configurable later, not required for first cut.
- **Wake-up defaults:** asks, blocked, stalled, offline, result-ready, and urgent updates wake the parent.
- **Board cache:** derive on request initially; add cache only if performance demands it.
- **Compatibility:** no migration from old attention/subscription records.

## Rollout Plan

1. Define inbox/message/task/board types.
2. Replace attention/subscription usage in coordination paths with inbox records.
3. Implement board projection from run state, metrics, result readiness, and inbox records.
4. Add server APIs for board, inbox, and messages.
5. Add CLI commands: `board`, `inbox`, `collect-results`, structured `message`.
6. Add Pi tools/renderers and `/tango-board` overlay.
7. Add stall/offline derivation and inbox emission.
8. Update dashboard operations/attention panels to use board/inbox.
9. Update Tango orchestration prompts to teach leads board/inbox first.
