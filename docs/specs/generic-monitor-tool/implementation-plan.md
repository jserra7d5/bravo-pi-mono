# Generic Monitor Tool Implementation Plan

Date: 2026-04-27
Status: draft implementation plan
Scope: generalized Pi/agent monitor subsystem, not Tango-specific

## Goal

Build a durable, manipulable background monitor subsystem for Pi/agent workflows. Agents should be able to start monitors, inspect/update/pause/resume/stop them later, retrieve results, and receive wake-up/attention events when conditions trigger.

The monitor system must remain generic. Tango/server can consume monitor events via labels, metadata, and generic attention hooks, but monitor core must not know Tango internals.

## Product requirement: visible active monitor status

A monitor should never feel invisible. When monitors are active in an interactive Pi session, the terminal UI should show a persistent, low-noise indicator near the bottom/status area, for example:

```txt
Monitors: 3 active · 1 triggered · next 42s
```

Suggested behavior:

- Use `ctx.ui.setStatus("monitors", text)` for a compact footer/status-line indicator if available.
- Optionally use `ctx.ui.setWidget("monitors", lines)` or a custom TUI overlay for richer inspection.
- Indicator should update on monitor lifecycle/result events and on periodic scheduler ticks.
- Hide or gray out when there are zero active monitors.
- Show warning/error severity when triggered or failed monitors require attention.
- Provide a `/monitors` command to open a richer interactive monitor panel.

## Architecture

### Components

1. **Monitor extension/package entrypoint**
   - Registers monitor tools.
   - Starts/stops scheduler on session lifecycle.
   - Registers `/monitors` command.
   - Owns TUI status indicator.

2. **Monitor store**
   - Durable SQLite or JSONL-backed storage under Pi state.
   - Stores monitor records, results, events, idempotency keys, ack state, and leases.
   - V1 preference: SQLite if Pi has no existing state abstraction; otherwise use Pi-native durable state.

3. **Scheduler**
   - Finds due running monitors.
   - Claims monitor runs with a lease.
   - Enforces concurrency, interval, timeout, deadlines, and backoff.
   - Recovers after Pi/session restart.

4. **Check runners**
   - `timer`
   - `file`
   - `http`
   - `process`
   - `command`

5. **Condition evaluator**
   - Converts observations into `matched` / `not_matched` / `error` / `timeout` results.
   - Supports basic boolean composition.

6. **Attention publisher**
   - Emits generic monitor attention events.
   - Does not depend on Tango.
   - Supports ack/seen state.

7. **TUI/status surface**
   - Compact footer/status indicator.
   - `/monitors` panel for list/look/pause/resume/stop/ack.

## Tool surface

V1 tools:

- `monitor_start`
- `monitor_list`
- `monitor_look`
- `monitor_update`
- `monitor_pause`
- `monitor_resume`
- `monitor_stop`
- `monitor_result`
- `monitor_ack`

All monitors are addressable by `monitor_id`; tools must work across later turns in the same session/root-session when authorized.

## CLI/command surface

Pi extension commands:

- `/monitors` — open interactive monitor panel.
- `/monitors list` — compact text list.
- `/monitors pause <id>`
- `/monitors resume <id>`
- `/monitors stop <id>`
- `/monitors ack <id|all>`

If a standalone CLI is useful later, add `pi-monitor` or `monitor` commands, but V1 can be extension/tool-first.

## TUI design

### Footer/status indicator

Use `ctx.ui.setStatus("monitors", statusText)` from extension lifecycle/scheduler updates.

Examples:

```txt
Monitors: idle
Monitors: 2 active · next 12s
Monitors: 4 active · 1 triggered
Monitors: 3 active · 1 failed
```

Status text rules:

- `idle`: no running/triggered/unacked monitors.
- `active`: count of running monitors.
- `triggered`: unacked triggered results.
- `failed`: failed monitors or failed checks requiring attention.
- `next`: soonest `next_run_at` rounded to seconds/minutes.

### Rich panel

`/monitors` opens a custom TUI overlay or widget using `ctx.ui.custom()`.

V1 panel:

```txt
Monitors
> ● build output       running    next 8s      file exists dist/app.js
  ! child complete     triggered  2m ago      command exited 0
  ⏸ slow poll          paused     —           http GET /health

Enter: details  p: pause/resume  a: ack  s: stop  r: refresh  Esc: close
```

Details view:

- monitor id/name/state
- check type and schedule
- last result summary
- next run time
- recent result history
- actions: pause/resume/stop/ack

Implementation notes:

- Lines must not exceed terminal width.
- Keep keyboard shortcuts simple.
- Overlay should be read-mostly; destructive actions require confirmation.
- No full-screen dashboard required for V1.

## Data model

### Monitor record

```ts
type MonitorRecord = {
  monitor_id: string;
  version: number;
  owner: MonitorOwner;
  scope: "session" | "root_session" | "workspace";
  name?: string;
  description?: string;
  state: "created" | "running" | "paused" | "triggered" | "succeeded" | "failed" | "stopped" | "canceled" | "expired" | "archived";
  check: CheckSpec;
  schedule: ScheduleSpec;
  condition?: ConditionSpec;
  attention?: AttentionSpec;
  retention: RetentionSpec;
  safety: EffectiveSafetyPolicy;
  labels?: Record<string, string>;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
  next_run_at?: string;
  last_triggered_at?: string;
  failure_count: number;
  consecutive_failure_count: number;
};
```

### Owner model

```ts
type MonitorOwner = {
  actor_id: string;
  actor_type: "agent" | "user" | "system" | "tool";
  root_session_id?: string;
  session_id?: string;
  workspace_id?: string;
};
```

Do not store Tango IDs as first-class ownership fields. Use opaque labels/metadata for clients.

## Implementation phases

### Phase 0 — Repo/package decision

Decide packaging location.

Recommended for this monorepo:

```txt
packages/monitor/                  # reusable monitor library + Pi extension package
packages/monitor/src/store.ts
packages/monitor/src/scheduler.ts
packages/monitor/src/checks/*
packages/monitor/src/conditions.ts
packages/monitor/src/tools.ts
packages/monitor/src/tui/*
packages/monitor/extension/index.ts
```

Alternative: start inside a Pi extension example/prototype, then extract. Prefer package-first if this should become reusable.

Deliverable:

- Package skeleton and build/check scripts.

### Phase 1 — Store and schema

Implement durable store and validation.

Deliverables:

- Monitor schemas/types.
- SQLite/JSONL store.
- CRUD operations.
- Result/event append and query.
- Optimistic version checks for update.
- Unit tests for validation and state transitions.

Acceptance:

- `monitor_start` can persist a record.
- `monitor_list` and `monitor_look` can retrieve it after process restart.

### Phase 2 — Tool surface without scheduler

Register tools and implement manual state operations.

Deliverables:

- `monitor_start`
- `monitor_list`
- `monitor_look`
- `monitor_update`
- `monitor_pause`
- `monitor_resume`
- `monitor_stop`
- `monitor_result`
- `monitor_ack`

Acceptance:

- Agents can create and manipulate monitors by id.
- Invalid/unsafe specs are rejected clearly.
- Ack state persists.

### Phase 3 — Scheduler and timer/file checks

Implement scheduler loop with the lowest-risk checks.

Deliverables:

- Due monitor query.
- Lease/claim model.
- Timer check.
- File exists/modified/content match checks.
- Condition evaluator basics.
- Result recording.
- Triggered/succeeded/expired transitions.

Acceptance:

- Timer monitor wakes after delay.
- File monitor triggers when file appears.
- Scheduler recovers after restart.

### Phase 4 — TUI status indicator and `/monitors`

Implement visibility so active monitors are obvious.

Deliverables:

- `ctx.ui.setStatus("monitors", ...)` footer indicator.
- Periodic status recomputation.
- `/monitors` command with list/details/actions.
- Optional `ctx.ui.notify()` on triggered/failed monitors.

Acceptance:

- Starting a monitor immediately updates footer/status.
- Triggered/failed/unacked monitors are visible.
- User can pause/resume/stop/ack from panel.
- Indicator disappears or says idle when no active monitors remain.

### Phase 5 — HTTP/process/command checks with safety

Add riskier checks behind strict policies.

Deliverables:

- HTTP check with SSRF protections and body/header limits.
- Process check with PID start-time validation where possible.
- Command poll and launch-once checks with argv-only execution, cwd allowlist, timeout, output limits, env policy, and process-group kill.

Acceptance:

- Local HTTP readiness monitor works.
- Command monitor cannot use shell strings by default.
- Unsafe paths/URLs/env/output are rejected or redacted.

### Phase 6 — Generic attention integration

Add generic attention/wake-up events.

Deliverables:

- Attention event model.
- Emit events on trigger/failure/completion/state change.
- Ack integration.
- Retention/pruning.

Acceptance:

- Triggered monitors generate durable attention events.
- Acknowledged results are not repeatedly surfaced as new.
- Tango can consume via labels/metadata without monitor-core dependency on Tango.

### Phase 7 — Tango/server consumer integration

Keep this outside monitor core.

Deliverables:

- Tango/server can create monitor records with labels such as `{ client: "tango" }`.
- Tango/server can subscribe/query generic monitor attention.
- Dashboard can show active monitor counts per root session/workstream if desired.

Acceptance:

- No monitor package imports Tango internals.
- Tango monitor use is optional and client-side.

## Validation strategy

### Unit tests

- Schema validation.
- State transitions.
- Condition evaluator.
- Ack behavior.
- Retention pruning.
- Safety rejection rules.

### Integration tests

- Start/list/look/update/pause/resume/stop/result/ack.
- Timer trigger.
- File trigger.
- HTTP local test server readiness.
- Command timeout/output truncation.
- Scheduler restart recovery.
- Lease expiry/reclaim.

### TUI/manual tests

- Start monitor and verify footer/status indicator.
- Trigger monitor and verify status severity/notification.
- Open `/monitors`, navigate list, inspect details.
- Pause/resume/stop/ack from panel.
- Resize terminal; verify line truncation.

## Security defaults

- Commands use argv arrays, not shell strings.
- `cwd` required for command checks.
- Restrict file/command paths to workspace or allowed roots.
- Limit output/body sizes.
- Redact secret-looking env/output.
- HTTP blocks metadata IPs and validates redirects.
- Process termination only for owned/launched processes.
- No unbounded result retention.

## Open questions

1. Should this live as `packages/monitor` or as a Pi extension package under another name?
2. What is the canonical Pi state directory API/path?
3. Is there an existing Pi job/process abstraction to reuse for command/process checks?
4. What is the canonical root-session/session/workspace identity outside Tango?
5. Should V1 include command checks immediately, or defer until timer/file/http are stable?
6. Should the footer indicator be always visible or only when active/triggered monitors exist?

## Recommended immediate next step

Create a new implementation Loom/spec workstream for `generic-monitor-tool`, then start with Phase 0–2:

1. Package skeleton.
2. Store/schema.
3. Tool CRUD surface.
4. Footer status indicator stub showing active monitor count.

Do not couple this to the Tango server implementation branch. Tango can consume it after the monitor core is usable.
