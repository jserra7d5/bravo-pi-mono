# Tango Status Events and Parent Delivery Design

Date: 2026-04-26
Status: v1 implementation

## Problem

Tango child agents can finish, block, or error without the parent coordinator seeing anything until it manually polls. This breaks recursive/team-lead workflows and is also poor for human tmux/shell coordination.

## Goals

- Emit durable Tango-owned status events on real status transitions.
- Let non-Pi runtimes observe events through a CLI watcher.
- Let Pi coordinator sessions receive terminal child-agent updates as follow-up messages and UI notifications.
- Avoid coupling Tango core to Pi or tmux-specific delivery.
- Avoid duplicate terminal notifications when an agent both calls `tango status done` and later exits.

## Architecture

### 1. Centralized status transitions

Status changes should go through a central transition helper rather than ad hoc metadata writes.

Responsibilities:

- read current metadata;
- compare previous status to next status;
- update metadata;
- emit an event only when the status actually changed;
- treat terminal process-close updates as idempotent if the agent already reported `done`, `blocked`, `error`, or `stopped`.

Terminal/actionable statuses for delivery:

```text
done, blocked, error
```

### 2. Durable global event log

Tango writes append-only JSONL events to:

```text
$TANGO_HOME/events.jsonl
```

Event schema:

```json
{
  "schemaVersion": 1,
  "eventId": "te_...",
  "type": "agent.status",
  "time": "2026-04-26T00:00:00.000Z",
  "agent": "reviewer-a",
  "role": "reviewer",
  "status": "done",
  "previousStatus": "running",
  "summary": "Review complete",
  "cwd": "/path/to/workspace",
  "projectSlug": "workspace-1234abcd",
  "runDir": "/home/user/.tango/runs/.../reviewer-a",
  "parentRunDir": "/home/user/.tango/runs/.../team-lead"
}
```

`projectSlug` is the stable routing key for current-project filtering. Raw cwd equality is not sufficient because agents may be launched from equivalent or nested paths.

### 3. `tango watch`

`tango watch` tails the event log.

Flags:

- `--json`: emit raw JSON event lines.
- `--all`: do not filter by current project.
- `--from-start`: replay existing events before tailing.

Default scope is current project, filtered by `projectSlug`.

Implementation notes:

- Tail by byte offset, not string index.
- Carry partial line buffers between reads.
- Reset offset on truncation/rotation.
- Surface malformed lines in non-json mode instead of silently swallowing all parse failures.

### 4. Pi delivery adapter

The Tango Pi extension starts a watcher during `session_start`.

Routing rules:

- If running inside a Tango parent agent (`TANGO_RUN_DIR` is set), watch all events but deliver only events with `event.parentRunDir === TANGO_RUN_DIR`.
- If running as a root/non-Tango Pi session, watch only current-project events.
- Deliver only `done`, `blocked`, and `error`.
- Dedupe by `eventId` per session.

Delivery behavior:

- `ctx.ui.notify(...)` when UI is available.
- `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` so the coordinator receives the update at the next safe tool/turn boundary.

Example message:

```text
Tango agent reviewer-a is done: Review complete

Inspect with tango_result/tango_look or `tango result reviewer-a`.
```

### 5. Non-Pi runtime behavior

Non-Pi parents are supported through the durable event log and `tango watch`. V1 does not inject messages into Claude Code, generic shell, or arbitrary tmux parent sessions. Those integrations can be added later as delivery adapters.

## Interaction with home/tooling split

The event design assumes Tango agents set:

```text
TANGO_RUN_DIR
TANGO_PARENT_RUN_DIR
TANGO_HOME
```

independently from any `HOME` isolation. This lets status/event routing continue to work while harnesses split isolated runtime home from real developer-tool home.

## Future work

- `tango watch --terminal-only`.
- Persistent delivered cursors for replay-after-restart.
- Loom inbox/subscription adapter.
- tmux status/pane delivery adapter.
- Workstream-level routing across multiple project slugs.
