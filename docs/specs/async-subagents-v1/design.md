# Async Subagents v1 Design

Date: 2026-05-14
Status: Superseded historical draft

> Superseded: this v1 draft describes the original wait-capable model. The current async-subagents contract is wakeup-first: `subagent_wait`, sync start/continue modes, and public `maxRunMs` budgets were removed by `docs/specs/async-subagents-async-wakeups-timeouts/design.md`. Use that spec and `packages/async-subagents/README.md` for current tool and timeout semantics.

## Problem

Agent runtimes need a small, reliable way for a parent agent to start child agents, keep working while they run, receive wake-ups, and collect results. Existing orchestration systems can do this, but they often pull in too much coordination machinery: chains, workflows, dashboards, worktree policy, peer intercom, prompt bridges, global boards, server coupling, and scheduler semantics.

This design defines a simpler async-first subagent primitive. It borrows useful ideas from `pi-subagents` and Tango, but it is intentionally not a full orchestration framework.

The primitive should answer a narrow set of questions:

- How does a parent start a child agent?
- How does the parent wait without blocking all progress forever?
- How does a child ask for attention or return a result?
- How does the runtime surface child completion automatically?
- What durable files make the run inspectable and recoverable?
- What UI conveniences can sit on top without becoming the source of truth?

## Goals

- Make async subagents the default model.
- Provide synchronous subagents as sugar over `start` plus `wait`.
- Support blocking and non-blocking parent behavior.
- Automatically surface child completion and notable child events to the parent.
- Provide a solid `wait` tool with race-style default semantics.
- Support parent-to-child messaging for async agents.
- Support child-to-parent messaging through structured events.
- Keep all communication parent-child only in v1.
- Use markdown agent definitions with frontmatter for reusable agent profiles.
- Persist every run in a small, inspectable file layout.
- Make terminal/TUI status pleasant: live rows, spinners, result cards, detail views, and next-action affordances.
- Keep UI as a projection over run files and event protocol, not a separate coordination contract.

## Non-goals

- Do not build chains, saved workflows, or general DAG orchestration.
- Do not add arbitrary agent-to-agent intercom.
- Do not add worktree management in v1.
- Do not add a slash/TUI agent manager as a required control plane.
- Do not implement prompt-template bridges.
- Do not require forked parent context by default.
- Do not add model fallback policy.
- Do not depend on a server for correctness.
- Do not preserve compatibility with Tango or `pi-subagents` internal data formats.
- Do not import code from `pi-subagents`; it is design input only.

## Design Position

This is a hard simplification around one primitive:

> A parent starts child runs. Child runs emit structured events. The parent can wait for interesting events or receive them automatically when they happen.

Everything else is a projection:

- Synchronous calls are `start` followed by `wait`.
- Status widgets read `status.json` and `events.jsonl`.
- Result cards read `result.json` and terminal events.
- Parent wake-ups are derived from child events and subscriptions created at start time.

There is no v1 global work graph, no peer messaging, no workflow planner, and no independent UI state store.

## Review Amendments

Cross-review against the local Pi SDK/runtime makes these constraints binding:

- Child prompt isolation uses Pi `--system-prompt`, not `--append-system-prompt`.
- Child Pi launches disable tools when the resolved allowlist is empty and use Pi's confirmed `--tools` allowlist behavior when tools are declared.
- Live parent-to-child messaging requires a proven builtin child-control extension inside the child Pi session. Until that extension can acknowledge `inbox.jsonl` messages and emit structured events, non-cancel live messages are not considered implemented.
- Child-to-parent structured events require an explicit transport: the builtin child-control extension exposes a child-facing event tool or emits supervisor-parseable structured markers.
- A top-level Pi parent session gets a durable root identity on session start. Child `parentRunId` must not default to `null` for ordinary root sessions.
- Terminal result/completion wake-ups coalesce into one delivery keyed by terminal result readiness.
- Automatic wake-up delivery requires a session owner lease or equivalent atomic delivery claim so two Pi sessions do not both send the same follow-up.

## Core Concepts

### Agent Definition

An agent definition is a markdown file with frontmatter and a body prompt. This follows the useful part of Tango and `pi-subagents` without adopting their orchestration models.

Example:

```md
---
name: scout
description: Read-only repository reconnaissance
model: gpt-5.4-mini
tools: [read, grep, ls]
mode: oneshot
maxRunMs: 600000
maxSubagentDepth: 0
---

You are a focused reconnaissance agent.

Read only the assigned scope and report concise findings with file references.
```

Recommended v1 fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | no | Stable agent definition name; defaults to the filename stem. |
| `description` | yes | Selection/help text. |
| `model` | no | Runtime-specific model identifier. |
| `tools` | no | Allowed tool names or tool groups. |
| `mode` | no | `oneshot` or `interactive`; default `oneshot`. |
| `maxRunMs` | no | Runtime timeout. |
| `maxSubagentDepth` | no | Maximum child delegation depth from this agent. |
| `cwdPolicy` | no | `inherit`, `explicit`, or `sandbox`; default `inherit`. |
| `resultFormat` | no | `text`, `json`, or `files`; default `text`. |

Agent discovery precedence:

1. project definitions,
2. user definitions,
3. builtin definitions.

Name collisions use the highest-precedence definition. The chosen source is recorded in `status.json`.

Project-local definitions may define prompts and builtin Pi tool names. They may not load arbitrary path-based skills/extensions by default; path-based executable capabilities require builtin/user roots or explicit per-run approval.

### Run

A run is one child agent process or harness invocation. Runs are always durable and have one parent, except root runs created by humans or tests.

Run states:

- `created`
- `queued`
- `running`
- `waiting_for_input`
- `blocked`
- `stalled`
- `completed`
- `failed`
- `cancelled`
- `expired`

Terminal states:

- `completed`
- `failed`
- `cancelled`
- `expired`

### Event

An event is an append-only child-to-parent record. Events are the durable communication contract.

Events are not chat messages from child to user. A child writes events; the parent runtime decides whether to render, wake, summarize, ignore, or wait on them.

### Inbox Message

An inbox message is parent-to-child input. It is append-only and addressed only to that child run.

No v1 child may write to another child inbox. If a child needs another agent, it must ask or delegate through its own parent according to the runtime's recursion policy.

## Durable Layout

Minimal v1 layout:

```txt
runs/
  <runId>/
    inbox.jsonl
    events.jsonl
    status.json
    result.json
    artifacts/
    logs/
```

Required files:

| File | Writer | Meaning |
| --- | --- | --- |
| `inbox.jsonl` | parent runtime | Parent-to-child messages. |
| `events.jsonl` | child runtime | Child-to-parent events. |
| `status.json` | child/runtime supervisor | Current overwriteable run snapshot. |
| `result.json` | child/runtime supervisor | Terminal result, written atomically at completion. |

Optional directories:

| Path | Meaning |
| --- | --- |
| `artifacts/` | Large child outputs, structured files, attachments, traces. |
| `logs/` | Harness stdout/stderr, terminal transcripts, debug logs. |

All JSON files should use `schemaVersion: 1`. Writers should use atomic write semantics for `status.json` and `result.json`: write a temp file in the same directory, then rename.

Append-only files use one JSON object per line. Readers must tolerate partial last lines and continue from the last valid offset.

## File Schemas

### `status.json`

```json
{
  "schemaVersion": 1,
  "runId": "run_01HX...",
  "parentRunId": "run_parent",
  "agent": {
    "name": "scout",
    "source": "project",
    "definitionPath": "/repo/.agents/scout.md",
    "mode": "oneshot"
  },
  "state": "running",
  "pid": 12345,
  "cwd": "/repo",
  "createdAt": "2026-05-14T18:30:00.000Z",
  "startedAt": "2026-05-14T18:30:01.000Z",
  "updatedAt": "2026-05-14T18:31:22.000Z",
  "lastActivityAt": "2026-05-14T18:31:20.000Z",
  "lastEventId": "evt_000042",
  "summary": "Reading API boundary files",
  "needs": null,
  "currentTool": {
    "name": "rg",
    "startedAt": "2026-05-14T18:31:19.000Z"
  },
  "metrics": {
    "tokens": { "input": 12000, "output": 1800, "total": 13800 },
    "toolCalls": 8
  },
  "resultReady": false,
  "error": null
}
```

`status.json` is optimized for polling and compact UI rows. It is not a complete history.

### `events.jsonl`

Every event has common fields:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_000042",
  "runId": "run_01HX...",
  "parentRunId": "run_parent",
  "type": "progress",
  "level": "info",
  "createdAt": "2026-05-14T18:31:20.000Z",
  "summary": "Mapped auth entrypoints",
  "body": "Found API handlers in packages/server/src/auth.",
  "wake": false,
  "data": {}
}
```

Event types:

| Type | Wake by default | Meaning |
| --- | --- | --- |
| `started` | no | Child process/harness started. |
| `progress` | no | Useful progress update. |
| `status` | maybe | State changed without a specific question/result. |
| `message.received` | no | Child accepted a parent inbox message. |
| `question` | yes | Child needs parent input. |
| `blocked` | yes | Child cannot proceed without a condition/decision. |
| `artifact` | no | Child produced or updated an artifact. |
| `result` | yes | Final or checkpoint result is ready. |
| `completed` | yes | Run completed successfully. |
| `failed` | yes | Run failed. |
| `cancelled` | yes | Run was cancelled. |
| `expired` | yes | Run timed out or exceeded runtime policy. |
| `heartbeat` | no | Liveness signal for long-running interactive agents. |

`wake` allows a child/runtime to request parent attention. The parent runtime may still suppress duplicate or stale wake-ups using delivery keys.

### `inbox.jsonl`

```json
{
  "schemaVersion": 1,
  "messageId": "msg_01HX...",
  "toRunId": "run_child",
  "fromRunId": "run_parent",
  "type": "instruction",
  "createdAt": "2026-05-14T18:35:00.000Z",
  "body": "Also inspect the CLI entrypoint.",
  "attachments": [],
  "requiresAck": true
}
```

Message types:

| Type | Meaning |
| --- | --- |
| `instruction` | New task guidance or scope change. |
| `answer` | Parent answer to a child question. |
| `cancel` | Request graceful stop. |
| `pause` | Request pause/checkpoint. |
| `resume` | Resume after pause or question. |
| `context` | Additional files, facts, or constraints. |

Interactive agents should tail or poll their inbox. On handling a message, they should emit `message.received` or a stronger event such as `progress`, `question`, or `completed`.

For Pi v1, this behavior is implemented by the builtin child-control extension running inside the child Pi session. The supervisor alone cannot inject a new user turn into a live Pi child. If the child-control extension is unavailable or not acknowledged by the target run, `subagent_message` must fail clearly for non-cancel live messages rather than pretending delivery occurred.

### `result.json`

```json
{
  "schemaVersion": 1,
  "runId": "run_01HX...",
  "parentRunId": "run_parent",
  "agentName": "scout",
  "state": "completed",
  "success": true,
  "createdAt": "2026-05-14T18:40:00.000Z",
  "durationMs": 599000,
  "summary": "Auth API entrypoints are in packages/server/src/auth and packages/api/src/session.",
  "body": "Full text result or concise structured result.",
  "artifacts": [
    {
      "artifactId": "art_01HX...",
      "kind": "markdown",
      "path": "artifacts/report.md",
      "mime": "text/markdown",
      "bytes": 4932
    }
  ],
  "metrics": {
    "tokens": { "input": 21000, "output": 3400, "total": 24400 },
    "toolCalls": 21
  },
  "error": null
}
```

`result.json` is written once when the run reaches a terminal state. If a crash prevents it, recovery tools may synthesize a failed result from `status.json`, logs, and process state, with `error.recovered: true`.

## Tool API

The primitive exposes five required tools and one optional cancellation convenience tool.

### `subagent_start`

Starts a child run. Async is the default.

```ts
type SubagentStartInput = {
  agent: string;
  task: string;
  name?: string;
  mode?: "async" | "sync";
  wait?: WaitMode;
  cwd?: string;
  files?: string[];
  attachments?: AttachmentRef[];
  timeoutMs?: number;
  notifyOn?: EventType[];
  maxSubagentDepth?: number;
};

type WaitMode =
  | "none"
  | "interesting"
  | "terminal"
  | "result";
```

Default behavior:

- `mode` defaults to `async`.
- `wait` defaults to `none` for direct `subagent_start`.
- A synchronous helper uses `wait: "result"` unless specified.
- `notifyOn` defaults to `["question", "blocked", "result", "completed", "failed", "cancelled"]`.

Return shape:

```json
{
  "runId": "run_01HX...",
  "runDir": "/repo/.subagents/runs/run_01HX...",
  "agentName": "scout",
  "state": "running",
  "started": true,
  "waited": false,
  "next": [
    { "tool": "subagent_wait", "args": { "runIds": ["run_01HX..."] } },
    { "tool": "subagent_message", "args": { "runId": "run_01HX..." } }
  ]
}
```

If `wait` is not `none`, `subagent_start` internally calls `subagent_wait` after the run is created and returns the wait result together with run metadata.

### `subagent_wait`

Waits for child events or terminal results.

```ts
type SubagentWaitInput = {
  runIds?: string[];
  runDirs?: string[];
  parentRunId?: string;
  mode?: "race" | "all" | "each";
  until?: "interesting" | "terminal" | "result" | "event";
  eventTypes?: EventType[];
  since?: Record<string, WaitCursor>;
  timeoutMs?: number;
  includeStatus?: boolean;
  includeResult?: boolean;
  maxEvents?: number;
};
```

Defaults:

- `runIds` defaults to active direct children of the current parent.
- `mode` defaults to `race`.
- `until` defaults to `interesting`.
- `timeoutMs` defaults to a short interactive wait, e.g. 300000ms.
- `includeStatus` defaults to true.
- `includeResult` defaults to true for terminal events.
- `maxEvents` defaults to a small bounded number, e.g. 20.

Race semantics:

- When waiting on multiple runs, return as soon as any run has an interesting event or completion.
- Do not stop, cancel, or detach remaining runs.
- Return cursors for every watched run so the parent can call `subagent_wait` again without re-reading old events.
- If multiple events are already ready, return a compact batch ordered by event time.

`all` semantics:

- Return when every watched run reaches the requested condition or the timeout elapses.
- Intended for explicit synchronization, not the default parent workflow.

`each` semantics:

- Stream or incrementally return one ready run at a time when the host tool API supports partial updates.
- May be omitted in runtimes that only support ordinary request/response tools.

Wait result:

```json
{
  "state": "ready",
  "mode": "race",
  "readyRunIds": ["run_child_a"],
  "events": [
    {
      "runId": "run_child_a",
      "eventId": "evt_000018",
      "type": "question",
      "summary": "Needs decision about old CLI flag",
      "body": "Should I remove --legacy-mode entirely?",
      "createdAt": "2026-05-14T18:45:00.000Z"
    }
  ],
  "results": [],
  "statuses": [
    {
      "runId": "run_child_a",
      "state": "waiting_for_input",
      "summary": "Needs decision about old CLI flag"
    },
    {
      "runId": "run_child_b",
      "state": "running",
      "summary": "Running tests"
    }
  ],
  "cursors": {
    "run_child_a": { "eventOffset": 8482, "lastEventId": "evt_000018" },
    "run_child_b": { "eventOffset": 5021, "lastEventId": "evt_000010" }
  },
  "remainingRunIds": ["run_child_b"],
  "timedOut": false,
  "next": [
    { "tool": "subagent_message", "args": { "runId": "run_child_a", "type": "answer" } },
    { "tool": "subagent_wait", "args": { "runIds": ["run_child_b"] } }
  ]
}
```

Interesting events:

- terminal events,
- `result`,
- `question`,
- `blocked`,
- `failed`,
- `cancelled`,
- `status` events where `wake: true`,
- any caller-requested `eventTypes`.

Progress-only events should not unblock default waits unless explicitly requested.

### `subagent_message`

Appends a parent-to-child message.

```ts
type SubagentMessageInput = {
  runId: string;
  type?: "instruction" | "answer" | "cancel" | "pause" | "resume" | "context";
  body: string;
  attachments?: AttachmentRef[];
  requiresAck?: boolean;
};
```

Defaults:

- `type` defaults to `instruction`.
- `requiresAck` defaults to true for interactive agents and false for already-terminal runs.

The tool returns the appended `messageId`, current child status, and suggested next action. Messaging a terminal run fails unless the type is a read-only annotation supported by the host.

### `subagent_result`

Reads a terminal result. This is a convenience over opening `result.json` plus artifacts.

```ts
type SubagentResultInput = {
  runId: string;
  includeBody?: boolean;
  includeArtifacts?: boolean;
  maxBytes?: number;
};
```

Reading a result should mark the corresponding parent wake-up as handled in host runtimes that maintain delivery state.

### `subagent_status`

Required v1 read-only recovery/status surface. Returns compact status for direct children or selected runs. This is not a manager or editor; it is the way to recover run IDs/results after UI restart or lost tool output.

### Optional: `subagent_cancel`

Sends a `cancel` inbox message and optionally escalates to process termination after a grace period.

## Automatic Completion Surfacing

Explicit wait is not the only delivery path. When a child emits a wake-worthy event, especially terminal completion, the parent runtime should surface it automatically.

Minimum behavior:

1. `subagent_start` records a parent subscription to the exact child `runId`.
2. A lightweight watcher or poller observes subscribed run directories and first verifies it owns the current parent-session delivery lease.
3. When a wake-worthy event appears, the runtime creates a parent wake-up.
4. The wake-up includes `runId`, event summary, result readiness, and suggested next tool.
5. Duplicate wake-ups are suppressed using a delivery key.

Delivery key examples:

- `event:<runId>:<eventId>`
- `terminal:<runId>:<result.createdAt>`
- `status:<runId>:blocked:<status.updatedAt>`

`result` and `completed` events for the same terminal result use the same logical terminal delivery key. A normal successful completion must produce one parent follow-up, not one for `result` and another for `completed`.

Automatic surfacing must not consume or delete events. It only records delivery state in runtime-local metadata if the host needs dedupe.

If the parent is actively inside `subagent_wait`, the wait result can be the surfacing mechanism. If the parent is not waiting, the host may produce a user-visible or agent-visible wake-up message, depending on its capabilities.

## Sync Sugar

Synchronous subagents are a convenience, not a separate runtime.

```ts
async function subagent_sync(input) {
  const started = await subagent_start({ ...input, mode: "async", wait: "none" });
  return subagent_wait({
    runIds: [started.runId],
    until: "result",
    mode: "all",
    timeoutMs: input.timeoutMs
  });
}
```

The synchronous helper should still create normal run files, events, and result artifacts. A sync child can therefore be inspected after the call just like an async child.

## Parent-Child Messaging Semantics

### Parent to Child

Parent-to-child messages append to `inbox.jsonl`. The child runtime is responsible for presenting those messages to the child agent.

For interactive agents:

- inbox polling should be low-latency enough for conversational use;
- messages are delivered in append order;
- the child should acknowledge or respond through `events.jsonl`;
- repeated parent messages are allowed and retain separate IDs.

For oneshot agents:

- inbox messages may be ignored if the agent has already exited;
- cancellation should still be supported by the supervisor where possible;
- non-cancel messages after terminal state should fail clearly.

### Child to Parent

Child-to-parent communication uses structured events only. The child does not directly write to the user transcript.

In Pi v1, structured events come from one of two explicit transports:

- the builtin child-control extension's child-facing event tool; or
- supervisor-parsed structured markers from child output, if that fallback is deliberately implemented and tested.

Plain natural-language child output is not enough to create reliable `question`, `blocked`, or `message.received` events.

The runtime may render child events as:

- compact status widget updates;
- wait tool results;
- wake-up messages to the parent agent;
- detailed event views;
- result cards.

The parent decides what to tell the user.

### No Peer Intercom

In v1, a child cannot address another child. This avoids global routing, permissions, stale lineage, and delivery ambiguity.

If child A needs information from child B, child A emits a `question` or `blocked` event to the parent. The parent may then message B or start another child.

## Blocking and Non-blocking Behavior

The primitive must support three parent workflows:

1. Fire-and-continue:
   - `subagent_start({ wait: "none" })`
   - Parent continues its own work.
   - Completion surfaces automatically.

2. Race wait:
   - Parent starts several children.
   - Parent calls `subagent_wait({ runIds: [...] })`.
   - First interesting event returns.
   - Other children continue and can be waited on later.

3. Synchronous call:
   - Parent uses sync sugar.
   - Tool blocks until result, failure, or timeout.
   - Same run files are produced.

Timeouts do not imply cancellation. A timed-out wait returns `timedOut: true` and current statuses. The child keeps running unless the caller explicitly cancels it.

## Recursion Policy

Subagents may be allowed to start their own children, but recursion must be explicit and bounded.

Rules:

- Every run records `parentRunId`, `rootRunId`, and `depth`.
- A top-level Pi parent session creates a durable root identity on session start and uses that as the parent for direct children.
- Default `maxSubagentDepth` is `0` for child agents unless their definition opts in.
- A parent may lower but not raise a child's effective depth limit beyond runtime policy.
- When depth is exhausted, `subagent_start` fails with a structured error.
- UI compact views show direct children by default and summarize descendants as counts.

Example status fields:

```json
{
  "rootRunId": "run_root",
  "parentRunId": "run_parent",
  "depth": 1,
  "maxSubagentDepth": 2
}
```

This keeps recursion possible without making recursive orchestration the default behavior.

## UI Projection

The UI is intentionally a projection over run files and events.

### Live Status Widget

A terminal/TUI host should provide a compact live widget for active direct children:

```text
● Subagents  2 active · 1 ready
├─ ⠹ scout repo-map       running · rg 12s · 1m34s
├─ ? planner migration    waiting · needs decision
└─ ✓ reviewer api         result ready · subagent_result(run_...)
```

Rows should include:

- status glyph or spinner;
- agent name and optional run name;
- state;
- elapsed runtime;
- last activity age or current tool;
- result/question/blocking hint;
- descendant aggregate when non-zero;
- next action when useful.

Default compact widget scope:

- direct children of the current parent run;
- active or blocked descendants summarized under their direct parent;
- recent ready results until handled or aged out.

### Pretty Wait and Wake-up Rendering

Wait results and automatic wake-ups should render as cards, not raw JSON:

```text
Subagent question  planner migration
Needs decision about old CLI flag
next: subagent_message(runId: run_..., type: answer)
```

Completion card:

```text
Subagent result  scout repo-map
Completed in 4m12s · 18k tokens
next: subagent_result(runId: run_...)
```

Expanded cards should expose:

- run ID and run dir;
- parent/root IDs;
- event ID and delivery key;
- status snapshot;
- result path;
- artifacts;
- recent events;
- suggested command/tool call.

### Detail View

A host may provide a detail view over the same files:

- active children;
- recent terminal runs;
- event timeline;
- inbox messages;
- artifacts;
- logs;
- raw JSON paths for debugging.

No detail view state is authoritative. If the UI disappears, the runs remain recoverable from files.

## Artifact Policy

Artifacts live under `runs/<runId>/artifacts/` by default.

Guidelines:

- Large outputs should be written as artifacts and referenced from `result.json`.
- Text results should include a concise `summary` and may include a bounded `body`.
- Tool transcripts and verbose logs belong under `logs/`, not `result.json`.
- Artifacts use relative paths in JSON when they are inside the run directory.
- External artifact paths must be absolute and marked as external.

Cleanup:

- Terminal runs may be eligible for cleanup after a configurable retention period.
- Default retention should favor debuggability, e.g. 7 to 30 days for local tools.
- Cleanup must not delete active, blocked, or unhandled-result runs.
- Cleanup should remove whole run directories, not individual files that break references.
- Hosts may keep pinned runs indefinitely.

## Failure Behavior

Start failures:

- No run directory created: return a tool error with no `runId`.
- Run directory created but process spawn failed: write `status.json`, `events.jsonl`, and `result.json` with `state: "failed"`.

Runtime failures:

- Child non-zero exit becomes `failed`.
- Timeout policy can either emit `blocked`/`stalled` or cancel to `expired`, depending on runtime configuration.
- Crashes should be detected by supervisor polling where possible and converted to `failed`.

Partial writes:

- JSONL readers ignore incomplete final lines.
- Snapshot readers retry atomic writes when a temp file is visible.
- Missing `result.json` for a terminal-looking run is an inconsistent state; recovery may synthesize a failed result.

Parent exits:

- Children continue if started async.
- Subscriptions remain durable enough for the same parent session/runtime to recover recent wake-ups.
- If no parent returns, cleanup policy eventually handles terminal runs.

Cancellation:

- Prefer graceful cancel through `inbox.jsonl`.
- Escalate to process signal only through explicit cancel policy.
- Always emit `cancelled` or `failed` with cancellation context.

## Observability

Minimum observability surfaces:

- `status.json` for current state;
- `events.jsonl` for history;
- `result.json` for terminal output;
- logs for raw harness output;
- optional host-level delivery metadata for wake-up dedupe.

Every tool result should include:

- `runId`;
- `runDir`;
- current state;
- next suggested tool/action;
- error classification when relevant.

Event and status timestamps should use ISO 8601 strings. Durations may be duplicated as milliseconds in result/status records for convenience.

## Implementation Notes

Recommended package shape if this becomes code later:

```txt
packages/
  async-subagents/
    src/
      agents.ts
      frontmatter.ts
      run-store.ts
      start.ts
      wait.ts
      message.ts
      result.ts
      watcher.ts
      render.ts
```

Start with file-backed storage and polling. Add filesystem watchers only as a latency optimization; correctness should come from reading the durable files.

The first implementation should avoid:

- a daemon dependency;
- global event buses;
- workflow definitions;
- peer routing;
- worktree setup;
- chain syntax;
- model fallback.

## Open Questions

- Should the default run root be project-local, user-global, or host-provided?
- Which host runtimes can support automatic parent wake-ups without an explicit `wait` call?
- Should `result` events be separate from `completed`, or should `completed` always carry result metadata?
- How much of markdown agent discovery belongs in this primitive versus a host package?
- What is the smallest delivery metadata needed for dedupe across parent restarts?

## Acceptance Criteria

An implementation of this spec is viable when:

- a parent can start one async child and keep working;
- a parent can start multiple async children and race-wait for the first interesting event;
- a terminal child result automatically surfaces without requiring explicit wait;
- the parent can send an answer/instruction to a running child;
- the child can ask a structured question without talking directly to the user;
- all run state is recoverable from the four core files;
- the UI can render useful compact status from `status.json` and `events.jsonl`;
- no v1 behavior requires chains, workflows, peer intercom, worktree management, or a server.
