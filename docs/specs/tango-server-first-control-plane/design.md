# Tango Server-First Control Plane Design

Date: 2026-04-27
Status: draft

## Problem

Tango is currently a file-backed orchestration system with a CLI and optional server/dashboard layered on top. The filesystem is the real protocol: `metadata.json`, `events.jsonl`, `result.md`, tmux logs, one-shot stdout logs, attention files, and metrics snapshots are scanned and interpreted by short-lived CLI processes, Pi extensions, and dashboard projections.

That model was useful for bootstrapping, but it is now creating systemic agent-management bugs and poor ergonomics:

- `tango wait` can time out, after which a coordinator still tries to read a result even though the run is not terminal and no result is safe to consume.
- `tango wait` can observe terminal state, then `tango result` can read the result, and the parent may still later receive a stale proactive completion wake-up for the same child.
- interactive agents are the primary mode Tango should optimize for, but current visibility still depends on tmux pane capture/log files rather than a first-class activity/message/result protocol.
- `tango look` for one-shot agents often shows raw harness JSON, tool calls, and reasoning stream fragments instead of useful activity.
- subagents often write their full report to the normal terminal/output stream, not to a special status/report function, so completion reporting and deliverable extraction are currently coupled incorrectly.
- one-shot agents, while still important, should be treated as a batch/special case of the same server activity/result pipeline rather than as the design center.
- `list`, `wait`, `look`, `result`, dashboard views, and proactive notifications do not all use the same reconciliation, result-readiness, and attention-consumption semantics.
- the server/dashboard are mostly projections over local files, not an authoritative control plane.

The root issue is not one command bug. Tango lacks a single authoritative run-state and event-consumption model.

## Architectural smell

Tango has two half-authorities:

```text
Filesystem = actual durable source of truth and current protocol
Server      = optional projection/dashboard/control-plane shell
```

This means every command has to reconstruct truth from files, and different commands reconstruct different truth at different times. The result is racey coordination semantics:

```text
process lifecycle != agent status != result readiness != attention delivery != what `look` can show
```

The cleaner design is:

```text
Server is the runtime source of truth.
Files are persistence, recovery, and forensics.
CLI/dashboard/tools are clients.
```

## Recommendation

Reframe Tango as a **server-first local agent control plane with durable file persistence**.

Do not remove files as durable storage. Do remove file-backed behavior as the public/control-plane semantics.

The server should own live semantics for any root-session harness. The top-level/main session agent does not have to be Pi; it may be Pi, Claude Code, Gemini CLI, a generic shell agent, a human CLI session, or a dashboard-originated session.

The server should own live semantics:

- run registry;
- process/lifecycle state;
- agent reports (`running`, `blocked`, `done`, `error`, etc.);
- result state and extraction provenance;
- wait conditions;
- attention/event delivery and acknowledgement;
- message routing;
- stop/cancel requests;
- dashboard/API projections.

Files should become an implementation detail:

- append-only event and raw stream logs;
- periodic state snapshots;
- finalized result files;
- recovery data after server restart;
- forensic debugging when the server is unavailable or corrupted.

## Goals

- Make agent-to-agent management predictable and race-resistant.
- Give every run one canonical state object shared by CLI, dashboard, Pi tools, and parent agents.
- Replace ambiguous `wait`/`look`/`status` semantics with explicit `follow`/`activity`/`report` semantics.
- Prevent duplicate/stale parent wake-ups after a parent has explicitly waited for or read a child result.
- Optimize first for interactive agents: live activity, messaging, blocking, checkpoints, terminal reporting, and result finalization should be first-class.
- Make one-shot results easy to consume without raw JSON spelunking as a secondary batch-mode case.
- Preserve local durability, inspectability, and offline recovery.
- Keep CLI usage viable, but make the CLI a thin client of the server in the normal path.

## Non-goals

- Do not require cloud hosting or a remote multi-user service.
- Do not remove durable run files in the first migration.
- Do not require agents to run inside the server process.
- Do not degrade interactive agents into detached batch jobs; live interaction remains the primary product shape.
- Do not require Docker or a system-level daemon as the only runtime model.
- Do not make raw logs unavailable; raw logs remain available behind explicit debug commands.
- Do not solve distributed multi-machine orchestration in this spec.

## Runtime-agnostic root sessions

The server-first design must not assume the main/root session is a Pi runtime. Pi is one client and harness, not the control-plane identity model.

A root session may be created or resumed by:

- Pi root session;
- Claude Code root session;
- Gemini CLI root session;
- generic shell/harness agent;
- human `tango` CLI invocation;
- dashboard-originated workflow;
- future SDK/client integrations.

Root-session identity should therefore be runtime-agnostic:

```ts
interface RootSessionIdentity {
  rootSessionId: string;
  workstreamId?: string;
  origin: "pi" | "claude" | "gemini" | "generic" | "cli" | "dashboard" | "sdk";
  cwd?: string;
  title?: string;
  ownerProcess?: {
    pid?: number;
    command?: string;
    harness?: string;
  };
}
```

Recipient and delivery semantics must also be runtime-agnostic. A parent recipient can be:

- a Tango child run;
- a non-Tango root session agent;
- a dashboard session;
- a human CLI caller;
- an SDK client.

The server should expose the same `ps`, `inspect`, `activity`, `follow`, `result`, `message`, and `report` semantics to all clients. Pi-specific tools are adapters over this protocol, not the protocol itself.

## Core authority model

### Server authority

The server owns the canonical live state machine for every run it knows about.

It answers:

```text
What is this run?
Which root session and harness owns or observes it?
Is the backing process alive?
What did the agent report about its state?
Is the agent terminal?
Is a result available, invalid, failed, summary-only, or still capturing?
What should a parent do next?
Has this parent already handled the terminal/result event?
What useful activity should be shown to humans/agents?
```

### File authority

Files are durable storage and recovery artifacts, not the runtime protocol.

The server writes and reads files, but clients should not independently derive semantics from them unless operating in explicit degraded/recovery mode.

Recommended durable files per run:

```text
runs/<runId>/state.snapshot.json       # latest server state snapshot
runs/<runId>/events.jsonl              # normalized run events
runs/<runId>/activity.log              # human-readable activity stream
runs/<runId>/transcript.jsonl           # normalized interactive transcript/activity events
runs/<runId>/pane.raw.log               # optional raw tmux/pane capture for forensics
runs/<runId>/stdout.raw.jsonl           # exact harness stdout stream for one-shot/json harnesses
runs/<runId>/stderr.log                # stderr
runs/<runId>/result.candidate.md       # best extracted result before validation/finalization
runs/<runId>/result.md                 # finalized accepted deliverable
runs/<runId>/result.json               # provenance, validation, source event IDs
runs/<runId>/command.redacted.json      # inspectable launch command
runs/<runId>/command.runtime.json       # private runtime command, if still needed
```

## Canonical run state

Every command and dashboard view should be backed by one canonical `RunState` model.

Conceptual shape:

```ts
interface RunState {
  schemaVersion: 1;
  identity: {
    runId: string;
    runDir: string;
    name: string;
    role?: string;
    mode: "oneshot" | "interactive";
    harness: string;
    parentRunId?: string;
    rootSessionId?: string;
    workstreamId?: string;
    cwd: string;
    task: string;
  };
  process: {
    state: "starting" | "running" | "exited" | "lost" | "stopped" | "unknown";
    pid?: number;
    supervisorPid?: number;
    tmuxSocket?: string;
    tmuxSession?: string;
    interactive?: {
      attached: boolean;
      lastPaneCaptureAt?: string;
      inputMode?: "tmux" | "server-mediated";
    };
    exitCode?: number | null;
    signal?: string | null;
    observedAt: string;
    issue?: string;
  };
  agent: {
    state: "created" | "running" | "blocked" | "done" | "error" | "stopped";
    terminal: boolean;
    summary?: string;
    needs?: string;
    lastReportAt?: string;
    updatedAt: string;
  };
  result: {
    state: "none" | "capturing" | "candidate" | "available" | "invalid" | "failed" | "summary-only";
    ready: boolean;
    safeToRead: boolean;
    source?: "result.md" | "captured-final" | "output-log" | "pane-log" | "manual" | "recovered";
    path?: string;
    candidatePath?: string;
    finalizedAt?: string;
    issue?: string;
    warning?: string;
    provenance?: ResultProvenance;
  };
  attention: {
    pending: AttentionItem[];
    handledByCurrentRecipient?: string[];
  };
  metrics?: {
    toolCalls?: number;
    activeToolCalls?: number;
    lastTool?: string;
    tokens?: number;
    contextPercent?: number;
    cost?: number;
  };
  next: {
    recommended?: "observe-later" | "follow" | "result" | "activity" | "message" | "none";
    until?: "terminal" | "result-ready" | "result-resolved" | "attention" | "activity" | "idle";
    afterMs?: number;
    commands?: Record<string, string>;
  };
}
```

Important invariant:

```text
agent.terminal does not imply result.ready.
```

A run can be terminal while the result is still capturing, invalid, failed, or summary-only. Commands must expose this explicitly.

## Interactive-first product model

Tango should optimize for interactive agents first. One-shot agents are useful for quick scouts and batch work, but the core orchestration experience should assume long-lived child agents that can be observed, messaged, checkpointed, blocked/unblocked, and finalized with a result.

Interactive-first means:

- the parent can ask “what is this agent doing?” without attaching to tmux or reading raw logs;
- the parent can send messages through a server-mediated channel;
- the agent can report `blocked`, `done`, or `error` separately from writing its full terminal output;
- the server continuously records normalized activity from the interactive session;
- result extraction/finalization can use the interactive transcript when the agent writes its final report to the terminal instead of a result file;
- tmux remains a useful host UI/runtime boundary, but not the semantic source of truth.

### Interactive agent lifecycle

Recommended interactive states are the same canonical agent states, but the activity model matters more:

```text
created -> running -> blocked -> running -> done/error/stopped
```

`blocked` should be treated as an attention state that can be resumed, not necessarily as an irreversible terminal state. A blocked interactive agent may later receive a message and report `running` again.

Terminal states:

- `done`
- `error`
- `stopped`

Attention states:

- `blocked`
- `needs` on any non-terminal state
- result invalid/failed after terminal completion

### Interactive activity stream

For interactive agents, the server should maintain a normalized activity stream independent of raw tmux capture:

```ts
interface ActivityEvent {
  id: string;
  runId: string;
  time: string;
  kind:
    | "agent.output"
    | "agent.thought-summary"
    | "tool.started"
    | "tool.finished"
    | "tool.failed"
    | "message.sent"
    | "message.received"
    | "report.submitted"
    | "checkpoint"
    | "result.candidate"
    | "result.finalized";
  text?: string;
  toolName?: string;
  messageId?: string;
  resultCandidateId?: string;
  rawRef?: string;
}
```

The dashboard, `tango activity`, and parent-agent tools should read this normalized stream. Raw tmux pane output remains available for debugging only.

### Messaging interactive agents

Interactive messaging should be a server concept, not only a tmux keystroke helper.

Recommended command/API shape:

```bash
tango message <agent> "Please validate only the parser tests and report back."
```

Server responsibilities:

- record the outbound message as a durable event;
- deliver it to the host runner/tmux session;
- record delivery status;
- correlate any subsequent report/checkpoint/result with the message when possible.

This makes it possible for the dashboard and parent agents to know what was asked, whether it was delivered, and whether the child responded.

### Interactive reports vs interactive results

`report` is a state signal from the child. It is not the full deliverable unless it includes or points to one.

Examples:

```bash
tango report blocked --needs input "Need a decision on API naming."

tango report running "Initial code integrated; starting targeted validation."

tango report done --summary "Implementation complete; result is in the transcript."
```

Because interactive subagents often write the full report to the terminal, `report done` without `--result-file` should trigger transcript/result-candidate capture instead of silently producing an empty or summary-only result.

Recommended `done` behavior for interactive agents:

1. agent reports `done` with summary;
2. server marks `agent.state = done` and `result.state = candidate` or `capturing`;
3. server extracts the likely final report from recent normalized transcript/activity;
4. if extraction is confident, write `result.candidate.md` and mark `result.state = candidate`;
5. parent can accept/finalize, or the agent can provide an explicit file/path;
6. if extraction fails, result state becomes `failed` with clear next actions: `activity`, `result --recover`, or message the child before stopping.

For tasks requiring a durable deliverable, agents should still prefer explicit result finalization:

```bash
tango report done --result-file result.md --summary "Done"
```

But the system should not break when an interactive agent naturally writes its complete answer in the terminal transcript.

### Interactive checkpoints

Interactive implementation agents should be able to report checkpoints without changing terminal state:

```bash
tango report running --checkpoint "Code integrated; next: npm test --workspace @bravo/tango"
```

This should emit a checkpoint/activity event and update the run summary, but not create result-ready attention.

### Attach remains useful but not required

Humans may still attach to tmux:

```bash
tango attach <agent>
```

But parent agents and dashboards should not need tmux attachment to understand state. `inspect`, `activity`, `message`, `follow`, and `result` should cover normal management.

## Command semantics

Tango should be **observe-first**, not wait-first.

Most parent-agent decisions are immediate state checks:

```text
Is the child still running?
What is it doing?
Is it blocked?
Is it terminal?
Is a result ready or safe to read?
Should I keep watching, inspect activity, message it, or report back?
```

That is an observation problem, not primarily a blocking wait problem. A blocking wait should be a conditional follow/subscription operation, not the default way to understand a child.

Recommended CLI vocabulary:

```bash
tango ps                    # compact status table for relevant agents
tango inspect <agent>       # full non-blocking RunState snapshot
tango activity <agent>      # human-readable recent/current activity
tango follow <agent> ...    # condition-based blocking/streaming observation
tango result <agent>        # deliverable-only result read
tango report ...            # subagent self-reporting state: blocked/done/error/running
```

The new semantics should be centered on `ps`, `inspect`, `activity`, and `follow`; the old verbs should be removed rather than aliased.

### `tango ps`

`ps` is the compact multi-agent status view. It should replace `list` as the primary human/agent way to answer “what agents exist and what are they doing?”

```bash
tango ps
```

Example human output:

```text
NAME                 STATE      RESULT       ACTIVITY              UPDATED
tango-cli-audit      running    none         active: read          4s ago
worker-1             running    candidate    active: bash          12s ago
reviewer             done       ready        result available      2m ago
```

JSON should include enough state for parent agents to decide next action without calling `look` or `result` blindly:

```json
{
  "agents": [
    {
      "name": "worker-1",
      "runId": "run_abc",
      "lifecycle": "running",
      "agentState": "running",
      "terminal": false,
      "resultState": "candidate",
      "resultReady": false,
      "safeToReadResult": false,
      "activitySummary": "active tool: bash",
      "updatedAt": "..."
    }
  ]
}
```

### `tango inspect`

`inspect` is the canonical non-blocking run-state snapshot.

```bash
tango inspect <agent>
```

It should never block. It returns the latest canonical `RunState`, including process, agent, result, attention, activity summary, metrics, and recommended next action.

Example:

```json
{
  "identity": {
    "runId": "run_abc",
    "name": "worker-1"
  },
  "process": {
    "state": "running",
    "pid": 1234
  },
  "agent": {
    "state": "running",
    "terminal": false
  },
  "result": {
    "state": "none",
    "ready": false,
    "safeToRead": false
  },
  "activity": {
    "activeTool": "bash",
    "lastTool": "read",
    "lastOutput": "Found packages/tango/src/cli.ts",
    "lastAssistantText": "I’m checking result handling now."
  },
  "next": {
    "recommended": "follow",
    "until": "result-resolved",
    "commands": {
      "follow": "tango follow --run-id run_abc --until result-resolved --timeout 300",
      "activity": "tango activity --run-id run_abc"
    }
  }
}
```

Parent-agent rule:

```text
Use inspect/ps to decide what is safe. Do not infer status from raw logs.
```

### `tango activity`

`activity` is observational and human-readable. It replaces `look` as the default way to see what an agent is doing.

```bash
tango activity <agent>
```

Default output should show useful current/recent activity, not raw harness streams:

- current lifecycle and result state;
- active tool call, if any;
- recent tool calls/results;
- last assistant text or activity summary;
- relevant metrics;
- runtime or result issue if present.

For one-shot agents, default activity should be derived from normalized activity events / `activity.log`, not raw JSON. Raw output requires an explicit flag:

```bash
tango activity <agent> --raw
```

Other useful modes:

```bash
tango activity <agent> --events

tango activity <agent> --raw --lines 500
```

`look` should be removed. Raw behavior belongs behind `activity --raw`.

### `tango follow`

`follow` is the condition-based replacement for ambiguous `wait`.

```bash
tango follow <agent> --until result-resolved --timeout 300
```

Supported conditions should be explicit:

- `started`
- `terminal`
- `done`
- `blocked`
- `error`
- `result-ready`
- `result-resolved` (`available`, `invalid`, `failed`, or `summary-only`)
- `attention`
- `activity` (next activity event)
- `idle` (no active tool/activity for a specified duration)

A successful follow returns the final state plus observed events:

```json
{
  "ok": true,
  "condition": "result-resolved",
  "state": { "...": "RunState" },
  "eventsObserved": ["agent.terminal", "result.ready"],
  "attentionHandled": ["agent.terminal", "result.ready"]
}
```

Timeout must return the latest state, not just a timeout error:

```json
{
  "ok": false,
  "timeout": true,
  "condition": "result-resolved",
  "state": { "...": "RunState" },
  "resultReady": false,
  "safeToReadResult": false,
  "next": {
    "recommended": "activity"
  }
}
```

Coordinator rule:

```text
After a follow timeout, do not call `tango result` unless the returned state says `result.ready` or `result.safeToRead`.
```

When `follow` observes terminal or result-resolution events, it should mark those events handled for the caller/parent recipient unless `--no-ack` is passed.

### Remove `tango wait`

`wait` should be removed rather than retained as an alias. It carries the wrong mental model and has historically meant different things to different callers.

Use explicit condition-based follow instead:

```bash
tango follow <agent> --until terminal
tango follow <agent> --until result-resolved
tango follow <agent> --until attention
```

A command stub may fail fast with replacement guidance, but should not execute compatibility behavior.

### `tango result`

`result` is deliverable-centric and idempotent. It should not be used to discover whether a child is running; use `inspect`/`ps` for that.

If result is ready:

```json
{
  "ok": true,
  "resultReady": true,
  "resultState": "available",
  "source": "result.md",
  "result": "...",
  "attentionHandled": ["result.ready"]
}
```

If result is not ready:

```json
{
  "ok": false,
  "resultReady": false,
  "resultState": "capturing",
  "safeToReadResult": false,
  "issue": "Agent is terminal but result is still capturing.",
  "next": {
    "recommended": "follow",
    "until": "result-resolved"
  }
}
```

A successful `result` read should mark result-related attention handled for the requesting parent/recipient. This prevents stale proactive wake-ups for a result that has already been consumed.

### `tango result --recover`

Recovery is explicitly best-effort and must not be confused with a finalized deliverable.

Recovery chain:

1. finalized `result.md` / `result.json`;
2. server result candidate;
3. final normalized assistant event;
4. clean assistant-only extraction from raw one-shot output;
5. interactive final pane transcript;
6. raw logs as last resort with low confidence.

Return provenance:

```json
{
  "ok": true,
  "resultReady": false,
  "recovered": true,
  "source": "output-log",
  "confidence": "medium",
  "issue": "No finalized result.md; recovered assistant text from raw output.",
  "result": "..."
}
```

### `tango report`

Hard migration target: remove `tango status` as an agent-management verb. `status` is too ambiguous: users expect it to query another agent, while subagents need a verb for saying “I am blocked” or “I am done.”

Use `report` for subagent self-reporting:

```bash
tango inspect <agent>         # parent/user queries current state

tango report blocked ...      # subagent reports it is blocked
tango report done ...         # subagent reports it is done
tango report error ...        # subagent reports it hit an error
```

There should not be both `report` and `status` in the CLI. This is a breaking migration: remove `status`, update agents/prompts/tools, and fail fast if old command names are used.

Self-reporting should not ambiguously imply result availability unless a result is finalized atomically.

Recommended behavior:

```bash
tango report done --result-file report.md --summary "done"
```

Atomically sets:

```text
agent.state = done
result.state = available
result.ready = true
```

Summary-only completion:

```bash
tango report done --summary-only --summary "done"
```

Sets:

```text
agent.state = done
result.state = summary-only
result.ready = false
result.safeToRead = true
```

For one-shot captured output, the server/supervisor may set:

```text
agent.state = done
result.state = capturing
```

and later transition result state to `available`, `invalid`, or `failed` after extraction/validation.

## Hard migration without compatibility shims

The target design intentionally removes ambiguous vocabulary. This should be a clean breaking migration, not a compatibility-layered rollout.

Target steady state:

```text
tango report ...      # self-report mutation by the current agent
tango inspect ...     # state query for another/current agent
tango ps             # compact state query for many agents
tango activity ...    # cleaned activity view
tango follow ...      # condition-based observation
tango result ...      # deliverable/result access
```

Removed steady-state commands/semantics:

```text
tango status          # remove; replaced by report for self-reporting and inspect/ps for querying
tango look            # remove; replaced by activity
tango list            # remove; replaced by ps
bare tango wait       # remove; replaced by follow --until <condition>
```

There should be no long-lived aliases, shims, dual paths, or hidden fallback behavior. Old commands may fail with clear errors that name the replacement command, but they should not continue to execute the old behavior.

Migration should be atomic at the package level:

1. implement the new commands and server API contracts;
2. update Pi tools to expose the new verbs (`tango_report`, `tango_inspect`, `tango_activity`, `tango_follow`, etc.);
3. update prompt includes, roles, docs, examples, and tests in the same change set;
4. remove old command implementations and old Pi tool wrappers;
5. fail fast on old commands with direct replacement guidance, if command stubs are retained at all.

This intentionally favors semantic clarity over preserving old workflows. Existing run directories can still be recovered through explicit recovery tooling, but the active command protocol should not carry legacy behavior forward.

## Legacy state migration

The new model changes some status semantics, especially `blocked`.

Old on-disk model:

```text
blocked is terminal in lifecycle reconciliation
```

Target model for interactive agents:

```text
agent.state = blocked
agent.terminal = false
attentionRequired = true
```

A blocked interactive agent can receive a message, report `running`, and later report `done` or `error`.

Projection rules during migration:

- Old run directories with `metadata.status = blocked` should project as `agent.state=blocked` and `attentionRequired=true` in explicit recovery tooling.
- If an old run has no live process/tmux session, project `process.state=stopped/lost` separately rather than treating blocked as terminal truth.
- One-shot blocked runs may remain effectively terminal unless a resumable process exists; this distinction should be explicit in `RunState.process`.
- `follow --until terminal` must not return merely because an interactive run is blocked.
- `follow --until attention` should return for blocked/needs states.

Required tests:

```text
interactive blocked -> message delivered -> running -> done
interactive blocked with dead tmux -> stopped/lost plus attention
old metadata.status=blocked recovery projection
one-shot blocked projection
```

## Attention and wake-up semantics

Tango needs explicit event-consumption semantics.

A parent/coordinator should not receive a proactive wake-up for a child terminal/result event it already observed through `follow --until result-resolved`, `inspect`, or `result`.

Recommended model:

```ts
interface RunEvent {
  id: string;
  runId: string;
  kind:
    | "agent.started"
    | "agent.report"
    | "agent.terminal"
    | "result.capturing"
    | "result.ready"
    | "result.invalid"
    | "result.failed"
    | "attention.requested";
  version: number;
  createdAt: string;
}

interface DeliveryState {
  eventId: string;
  recipientRunId: string;
  deliveredAt?: string;
  handledAt?: string;
  handledByCommand?: "follow" | "inspect" | "result" | "ack" | "dashboard";
}
```

Rules:

- `follow --until terminal` that observes terminal lifecycle may handle `agent.terminal` for that recipient.
- `follow --until result-resolved` that observes a resolved result may handle both `agent.terminal` and result-resolution events.
- `inspect` may mark purely informational running-state notifications observed, but should not consume result-ready attention unless explicitly requested.
- `result` that reads a ready result handles `result.ready` for that recipient.
- proactive parent wake-ups are emitted only for unhandled delivery records.
- wake-ups should be batched per parent/root session when possible.
- dashboard attention should use the same durable attention/delivery state, not recompute attention only from current status.

This directly fixes stale flows such as:

```text
parent follows until result-resolved -> parent reads result -> parent still receives "child is done" wake-up
```

## Result finalization and transcript extraction safety

Interactive transcript-derived results are necessary because subagents often write their full report to the normal terminal. They are also risky. The server must distinguish candidate extraction from durable finalization.

Rules:

- `report done --result-file <path>` can finalize immediately if validation passes.
- `report done` without `--result-file` must not silently create an empty result.
- `report done` without `--result-file` should trigger transcript extraction and set one of:
  - `result.state = candidate` when a plausible final report is extracted;
  - `result.state = failed` when no plausible final report can be extracted;
  - `result.state = invalid` when a candidate exists but validation rejects it.
- Transcript extraction should not mark `result.state = available` unless confidence and validation are high enough for the run's result policy.
- Required-result workflows may require either explicit `--result-file` or explicit parent/human finalization of a candidate.

Minimum candidate provenance:

```ts
interface ResultProvenance {
  source: "result-file" | "interactive-transcript" | "oneshot-final-event" | "recovered-log";
  sourceEventIds: string[];
  transcriptWindow?: { fromEventId: string; toEventId: string };
  confidence: "high" | "medium" | "low";
  extractor: string;
  validation: {
    ok: boolean;
    issue?: string;
    warning?: string;
  };
}
```

Safe extraction heuristics should prefer, in order:

1. explicit result file passed to `report done`;
2. trusted harness final assistant message event;
3. explicit transcript delimiter emitted by the agent, e.g. a final-report block;
4. recent assistant terminal output after the last tool result;
5. recovery-only raw transcript extraction with low confidence.

Default `activity` and `result` outputs must not include raw reasoning payloads, encrypted thinking blobs, raw tool-call JSON, or unrelated terminal noise unless `--raw` or `--recover --raw` is explicitly requested.

## Activity output tiers

Activity output must be tiered to avoid recreating the current `look` problem under a new name.

```text
activity              cleaned human/agent summary only
activity --events     normalized structured events
activity --raw        raw tmux/harness logs, forensic/debug only
```

Default `activity` may include:

- lifecycle/result state;
- active tool name and coarse arguments if safe;
- recent tool names/results summarized;
- recent assistant-visible text;
- checkpoint/report summaries;
- validation/runtime issues.

Default `activity` must not include:

- raw harness JSON;
- encrypted or hidden reasoning payloads;
- full raw tool-call arguments containing secrets or large blobs;
- unredacted environment/auth material.

## One-shot result pipeline

One-shot agents are the batch-mode variant of the same server activity/result pipeline. They should be reliable, but they are not the primary design center.

Current issue: the harness JSON stream is simultaneously used as live output, forensic log, and result-extraction source. That causes raw JSON/tool/reasoning leakage into activity views, and brittle post-hoc result recovery.

Recommended pipeline:

```text
harness stdout/stderr
      │
      ├─ raw stream log                         -> stdout.raw.jsonl / stderr.log
      │
      ├─ normalizer                             -> normalized events.jsonl
      │       ├─ assistant text events
      │       ├─ tool start/end events
      │       ├─ metrics events
      │       └─ lifecycle observations
      │
      ├─ activity renderer                      -> activity.log
      │
      └─ result extractor / validator
              ├─ result.candidate.md
              ├─ result.json
              └─ result.md when finalized
```

Extraction and validation should be separate states:

```text
candidate extracted -> validation warning/issue -> finalized or invalid
```

A captured but invalid result should remain inspectable and recoverable, with provenance, instead of disappearing behind a generic failure.

## Recovery and reconciliation

Server-first must not recreate the old dual-authority problem. Files are durable persistence, but the server owns semantic reconstruction.

Recovery contract:

- Every run event receives a monotonic per-run sequence number and globally unique event ID.
- `state.snapshot.json` is an optimization; replayable normalized events are the durable semantic log.
- On restart, the server loads the latest snapshot, replays later events, then revalidates host process/tmux liveness.
- Event replay must be idempotent. Replaying `report done`, `result.ready`, or attention-handled events must not duplicate wake-ups.
- `DeliveryState` / acknowledgement records are durable events or durable state with versioning, not memory-only flags.
- Partially written `result.md` / `result.json` must be detected with atomic-write conventions or ignored in favor of the last valid result event.
- Direct file mutations outside the server protocol should be rejected for active runs; old run directories are handled only by explicit recovery tooling.
- Server discovery should include PID, token, start time, and protocol version. Stale or incompatible discovery forces restart or degraded mode.

If the server cannot reconstruct a confident semantic state, it should project degraded state explicitly:

```json
{
  "degraded": true,
  "issue": "Recovered from files; delivery acknowledgements may be incomplete."
}
```

## Follow transport semantics

`follow` is a condition-based observation operation. The API must avoid leaking resources or acknowledging events that were not successfully delivered.

Recommended transport:

- CLI `follow` uses a scoped event subscription/SSE stream when available.
- `POST /api/v1/runs/:runId/follow` may be implemented as bounded long-poll for simple clients.
- All follow requests must specify `until` and a timeout; server may enforce a maximum timeout.
- Client disconnect cancels the follow and must not ack terminal/result events unless the response/event was already delivered with acknowledgement semantics.
- Acknowledgement should occur after the server successfully sends the terminal response/event to the caller, or through an explicit follow completion ack.
- Follow responses include the latest `RunState`, observed event IDs, and acked event IDs.
- Cursor-based subscriptions are required for missed events and reconnection.

## Server/backend API shape

Initial server endpoints should expose run state directly.

```http
GET  /api/v1/runs
GET  /api/v1/runs/:runId
GET  /api/v1/runs/:runId/state
GET  /api/v1/runs/:runId/result
GET  /api/v1/runs/:runId/activity
GET  /api/v1/runs/:runId/events?cursor=...
POST /api/v1/runs/:runId/follow
POST /api/v1/runs/:runId/message
POST /api/v1/runs/:runId/report
POST /api/v1/runs/:runId/stop
POST /api/v1/runs/:runId/attention/:eventId/ack
```

Root/workstream endpoints:

```http
GET /api/v1/root-sessions
GET /api/v1/root-sessions/:rootSessionId
GET /api/v1/root-sessions/:rootSessionId/runs
GET /api/v1/root-sessions/:rootSessionId/attention
GET /api/v1/root-sessions/:rootSessionId/events?cursor=...
```

SSE/WebSocket subscriptions should be scoped and cursor-based:

```http
GET /api/v1/subscribe?rootSessionId=...&cursor=...
GET /api/v1/subscribe?runId=...&cursor=...
```

Avoid broadcasting all events to all clients and relying on clients to reconstruct relevance.

## CLI behavior with server-first architecture

Normal path:

```text
CLI -> server API -> canonical RunState / command result
```

Fallback path when server is unavailable:

```text
CLI -> local recovery reader -> degraded RunState approximation
```

Fallback output must be explicit:

```text
Tango server unavailable; using degraded file recovery view.
Follow/attention/message semantics may be incomplete.
```

This prevents degraded file parsing from masquerading as the primary control plane.

## Server lifecycle

Any root session client or top-level Tango command should ensure a local server exists. This includes Pi, Claude Code, Gemini CLI, generic harnesses, dashboard workflows, SDK clients, and human CLI sessions.

Recommended behavior:

1. check discovery file / env for server URL;
2. health-check server;
3. if missing/stale, start a local server process;
4. write discovery file with URL/token/PID;
5. continue commands against server.

The server should be local by default, token-protected, and host-native. It does not need to host agent processes itself.

## Migration plan

### Phase 1a: stop unsafe consumption

Keep current commands mostly intact, but fix the highest-impact races.

- Add `resultState`, `safeToReadResult`, and `next` to state-bearing JSON responses.
- Teach parent/tool wrappers not to call `result` after a timeout unless safe.
- Make `result` mark result-ready attention handled.
- Suppress proactive wake-ups for handled result/terminal events.
- Add tests for timeout-safe behavior and stale wake-up suppression.

### Phase 1b: replace with observe-first verbs

Introduce the new vocabulary and remove the old one in the same package-level migration.

- Add `tango ps`, `tango inspect`, `tango activity`, and condition-based `tango follow`.
- Remove `list`, `look`, and bare `wait` from the active command protocol.
- If old command stubs remain, they fail fast with replacement guidance only.
- Ensure `ps`, `inspect`, `activity`, `follow`, `result`, `children`, and dashboard state use the same RunState projection.

### Phase 1c: report migration

Hard-migrate self-reporting from `status` to `report`.

- Add `tango report` and `tango_report` tooling.
- Update prompt includes, roles, docs, and examples to use `report`.
- Remove `status` from the active command protocol.
- If a `status` command stub remains, it fails fast with replacement guidance only.
- Add tests proving old `status` usage fails and directs callers to `report`/`inspect` as appropriate.

### Phase 1d: cleaned activity and interactive candidate capture

- Make `activity` default to cleaned interactive/one-shot activity.
- Require `--raw` for raw pane or harness logs.
- Add transcript-derived candidate capture for interactive `report done` without `--result-file`.
- Persist candidate provenance and validation outcome.

### Phase 2: canonical state projection

- Introduce `RunState` builder in Tango core.
- Use the same builder in CLI and server/dashboard APIs.
- Persist `state.snapshot.json` and `result.json`.
- Split result extraction from validation.
- Add `result --recover` with provenance.

### Phase 3: server-first read path

- Start local server automatically for root sessions/top-level commands.
- Make CLI prefer server APIs for `ps`, `inspect`, `activity`, `follow`, `result`, `message`, `report`, and `stop`.
- Keep file-backed fallback as explicit degraded mode.
- Add scoped event subscriptions and cursors.

### Phase 4: server-owned runtime state

- Supervisors report process started/exited and harness events directly to server.
- Agents submit reports to the server API instead of mutating local metadata through `tango status`.
- Server writes durable files as persistence.
- Server owns event delivery, attention, and acknowledgement state.

### Phase 5: cleanup and recovery hardening

- Remove duplicated file-scanning semantics from CLI paths that have server equivalents.
- Keep `tango recover --run-dir ...` for offline forensic recovery.
- Document degraded-mode limitations.
- Add migration tooling for old run directories if needed.

## Testing strategy

High-value tests should focus on state-machine invariants and race cases.

Required scenarios:

- `inspect` returns current state for a running interactive agent without reading raw pane logs.
- `follow` timeout returns `safeToReadResult: false`; tool wrapper does not call `result`.
- `follow --until terminal` with result still capturing returns `terminal: true`, `resultReady: false`.
- `follow --until result-resolved` returns only when result is available/invalid/failed/summary-only.
- reading `result` marks result-ready attention handled.
- after `follow --until result-resolved` + `result`, no stale proactive wake-up is emitted for the same parent.
- interactive `report done` without `--result-file` creates or attempts a result candidate from recent transcript/activity rather than silently producing an empty deliverable.
- one-shot raw stream with tool calls produces clean `activity.log` and clean result candidate.
- invalid/placeholder one-shot result is persisted as candidate with validation issue and provenance.
- server restart reconstructs run state from snapshots/events without duplicating handled wake-ups.
- server unavailable path clearly reports degraded behavior.

## Open questions

- Should the local server be mandatory for all normal `tango start` operations, or only auto-started when a command needs control-plane semantics?
- What is the exact recipient identity for a root session parent that is not itself a Tango child run, including Pi, Claude Code, Gemini CLI, generic shell, dashboard, or human CLI roots?
- What recipient identities exist for parent Tango run, root session, dashboard user/session, and external CLI caller?
- Should attention handling be per parent run, per root session, per dashboard user, or some combination?
- Does `inspect` ever acknowledge attention by default, or only with an explicit `--ack`?
- How long should handled event/delivery records be retained?
- Can `summary-only` be consumed through `tango result`, and what exit code should that command return?
- What are the exact extraction heuristics for interactive `report done` when the full report was written to the terminal transcript?
- How much interactive transcript should the server retain in normalized form before compaction?
- Should result validation failures set `agent.state = error`, or keep agent state `done` while `result.state = invalid`?
- Should interactive agents eventually stream pane activity to the server, or should tmux remain the live activity source with server snapshots?
- Which server APIs are stable public contracts versus local/internal implementation details?
- What rollback path should the CLI use if the auto-started local server is incompatible or fails health checks?

## Decision summary

Adopt interactive-first, server-first Tango as the target architecture:

```text
Interactive agents = primary product shape.
Server             = source of truth for live control-plane semantics.
Files              = durable persistence, recovery, and forensic logs.
CLI                = thin client plus explicit degraded recovery mode.
```

Hard-migrate the vocabulary toward:

```text
ps / inspect / activity / follow / result / message / report
```

and away from ambiguous `status`, `look`, and bare `wait` semantics.

This should reduce Tango's current jank by replacing ad-hoc file reconstruction with one coherent run-state, result-state, interactive activity, and attention-consumption protocol.
