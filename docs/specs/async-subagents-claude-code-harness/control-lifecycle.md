# Control Plane, Messaging, Liveness, and Lifecycle

This module defines the operational contract for Claude interactive sessions.

## Claude MCP child-control server

Claude cannot load Pi's child-control extension. The Claude harness therefore starts a package-owned MCP server through generated strict MCP config:

```sh
async-subagents claude-child-mcp --run-dir <runDir>
```

The server is a real JSON-RPC stdio MCP process. Claude Code 2.1.197 hand-tests showed newline-delimited JSON-RPC over stdio (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`). The server must support that framing. Content-Length framing may also be supported for portability, but line-delimited JSON-RPC is required. Fake Claude tests must speak MCP JSON-RPC and must not mutate async-subagents run files directly.

### MCP trust boundary and containment

V1 uses stdio process ownership as the MCP trust boundary. The MCP server is launched only by the generated strict MCP config for a specific run. Do not claim per-call JSON-RPC authentication unless a concrete MCP-compatible auth mechanism is added later.

This is not a same-OS-user security sandbox: a child with unrestricted Bash can still attempt to edit run files directly. V1 therefore records a trusted-dangerous execution mode and relies on contract checks, redaction, and explicit operator posture rather than pretending Claude permissions are a hard boundary.

The MCP server must:

- canonicalize `runDir` and verify it is inside the configured async-subagents run root;
- reject symlink traversal and non-canonical run paths;
- verify `status.runId`, parent/root lineage, and launch metadata match the selected run;
- verify the MCP server process was launched for the same run id recorded in the generated launch metadata when such metadata is available;
- reject terminal runs for non-terminal mutations;
- reject attempts to complete twice.

### MCP tools

- `subagent_event(type, summary, body?, wake?, data?)`
  - appends to `events.jsonl`;
  - updates `status.json` for progress/question/blocked/artifact/liveness;
  - uses existing wakeup delivery logic.
- `subagent_read_inbox(cursor?)`
  - returns pending messages from `inbox.jsonl`;
  - records `message.received` events and delivery state for each returned message;
  - does not mean the message has been handled.
- `subagent_ack_inbox(messageId, disposition, summary?)`
  - records `message.handled` or `message.rejected`;
  - advances delivery state to `handled` when disposition is successful;
  - is the default success condition for parent `requiresAck` on Claude.
- `subagent_complete(summary, body?, outcome?)`
  - writes terminal `result.json` through the same idempotent finalizer used by supervisor terminal handling;
  - transitions status to a terminal state;
  - emits terminal event;
  - triggers cleanup.
- `subagent_block(reason, checkpoint?)`
  - convenience over `subagent_event(type="blocked")` plus status update.
- `subagent_liveness(state?, details?)`
  - optional explicit signal for Claude to report waiting, rate limit, compression, or self-detected stall.

## Per-run mutation serialization

All MCP and supervisor mutations for one run must execute through a single per-run mutation gate/file lock.

Serialized operations include:

- reading status then appending event;
- appending event then updating status;
- reading inbox then marking messages received;
- acknowledging messages;
- writing terminal result;
- pause/continue/cancel transitions;
- process-exit finalization;
- timeout finalization.

Properties:

- event sequence numbers remain unique and monotonic;
- terminal result is written at most once;
- terminal events are emitted at most once;
- pause/cancel/timeout cannot overwrite an already committed terminal result;
- supervisor process-close finalization observes existing MCP result and only performs cleanup.

## Parent-to-Claude messaging

`subagent_message` appends full message bodies to `inbox.jsonl`. For live Claude interactive children, the supervisor also injects a minimal terminal nudge. Tmux hand-tests confirmed Tango-style paste reaches Claude TUI, but adversarial wording can be treated as prompt injection. Keep the nudge clearly framed as runtime/control-plane notification, not task instruction:

```text
[async-subagents runtime notice]
A parent message is available in the async_subagents MCP inbox. Call async_subagents.subagent_read_inbox now. After you handle each returned message, call async_subagents.subagent_ack_inbox for that message id.
```

The nudge is only a wake signal. The durable message body remains in `inbox.jsonl` and is only considered delivered according to the delivery state machine below.

### Delivery state machine

Track per-message state in append-only events or a durable derived `inbox-state.json`.

States:

- `queued` — message appended to `inbox.jsonl`.
- `injected` — terminal nudge successfully written to tmux/transport.
- `received` — child called `subagent_read_inbox` and was given the message id/body.
- `handled` — child called `subagent_ack_inbox(messageId, disposition="handled")`.
- `failed` — injection, receive, handle, or lifecycle deadline failed.

Fields:

```json
{
  "messageId": "msg_...",
  "queuedAt": "...",
  "injectedAt": "...",
  "injectionAttempts": 1,
  "receivedAt": "...",
  "handledAt": "...",
  "failedAt": null,
  "failureReason": null,
  "ackLevel": "handled",
  "ackDeadlineAt": "..."
}
```

Rules:

- `requiresAck=true` defaults to `ackLevel="handled"` for Claude interactive.
- A caller may explicitly request `ackLevel="received"` only when fetch confirmation is sufficient.
- `ackTimeoutSeconds` defaults to 30 for Claude interactive and is capped at 120 unless config allows otherwise.
- Ack timers start after successful terminal injection. For `subagent_continue`, timers start after successful resume and injection.
- A late ack after tool-call timeout updates run state/events but does not retroactively change the earlier tool result.
- Timeout warning messages use this same delivery state machine; they are not direct append-only inbox writes.
- Injection cursor advances only after successful terminal injection.
- Handled cursor advances only after matching `messageId` acknowledgement.

## Interactive liveness state machine

PID existence is not enough. Persist and display liveness for Claude interactive runs.

States:

- `starting` — launch command issued, no confirmed terminal/MCP activity yet.
- `running` — recent terminal output or MCP call.
- `idle` — no output/MCP for `idleAfterMs`, no pending parent input, transport healthy.
- `waiting_for_input` — child asked a question or blocked for parent decision.
- `ack_pending` — parent message injected and awaiting `received`/`handled` ack.
- `rate_limited` — terminal output or MCP liveness reports known rate-limit/reset pattern.
- `comatose` — nudge/probe injected, but no terminal output and no MCP call within `ackProbeMs`.
- `stale_transport` — tmux socket/session/pane missing or unreadable while run is non-terminal.
- `orphaned_process` — child/helper/tmux alive but supervisor/run ownership no longer matches.
- `paused` — process group/session intentionally stopped.
- terminal: `completed`, `failed`, `cancelled`, `expired`.

Persist fields in `status.json`:

```json
{
  "livenessState": "running",
  "lastTerminalOutputAt": "...",
  "terminalOutputBytes": 12345,
  "lastMcpCallAt": "...",
  "lastNudgeAt": "...",
  "lastProbeAt": "...",
  "outputBytesSinceNudge": 42,
  "rateLimitResumeAt": null,
  "pendingAckMessageIds": [],
  "livenessReason": null
}
```

Detection rules:

- terminal output or MCP call moves state to `running` unless a stronger waiting/paused/terminal state applies;
- child question/block moves to `waiting_for_input`;
- pending handled ack moves to `ack_pending`;
- no output/MCP after `idleAfterMs` moves to `idle` if no pending input;
- a probe nudge with no output/MCP after `ackProbeMs` moves to `comatose` and emits an attention wakeup;
- rate-limit patterns move to `rate_limited` with parsed `rateLimitResumeAt` when available;
- missing/unreadable tmux resources move to `stale_transport` and emit attention wakeup;
- orphaned resources move to `orphaned_process` and expose recovery actions.

## Transport ownership and reconciliation

Persist transport ownership in `status.json` and `logs/launch.json`:

```json
{
  "supervisorPid": 123,
  "childPid": 456,
  "processGroupId": 456,
  "tmuxSocket": "<runDir>/tmux.sock",
  "tmuxSession": "async-subagents-<runId>",
  "tmuxPane": "%3",
  "mcpHelperPids": [789],
  "transportLeaseOwner": "supervisor:<pid>",
  "lastTransportCheckAt": "...",
  "cleanupWarnings": []
}
```

Reconciliation rules:

- active run + missing tmux session/socket/pane ⇒ `stale_transport`, attention wakeup, suggested cancel/recover action;
- terminal run + tmux session/helper alive ⇒ bounded cleanup, then record `cleanupWarning` if kill fails;
- supervisor dead + child/tmux alive ⇒ `orphaned_process`, attention wakeup, expose attach/cancel details;
- MCP helper alive for terminal/invalid run ⇒ kill and log;
- process group missing before terminal result ⇒ `failed` unless a terminal result raced and won;
- stale transport must not be hidden as generic `idle`.

`subagent_status` recovery checks must inspect tmux/helper liveness for Claude interactive runs, not only a recorded PID.

## Pause, continue, cancel, and budget

Durable budget fields:

```json
{
  "activeElapsedMs": 120000,
  "pausedAt": null,
  "budgetRemainingMs": 60000,
  "budgetGeneration": 3,
  "pauseReason": null
}
```

Pause target for tmux mode:

- pause/continue targets the Claude child process group where possible;
- tmux session remains addressable for status/attach and should not continue running user commands while child is stopped;
- MCP helper behavior is explicit: either pause with child process group or remain able to reject/record lifecycle calls without mutating terminal state. Pick one implementation and test it.

Budget expiry:

1. send warning message through normal delivery state machine;
2. inject nudge when possible;
3. after warning deadline, pause process group if no terminal result exists;
4. emit `paused`/attention wakeup with continue/cancel instructions.

Race rules:

- `subagent_complete` wins over timeout pause if terminal result commits first;
- terminal result triggers cleanup even if budget timer fires concurrently;
- pause/continue/cancel are idempotent and cannot overwrite terminal result;
- continue increments `budgetGeneration`; stale timers from older generations cannot pause the run;
- ack timers for messages sent through continue start only after resume and nudge injection.

Cancel:

- send `SIGTERM` to process group;
- after bounded grace, send `SIGKILL`;
- kill tmux session and MCP helpers;
- write terminal `cancelled` result if no terminal result exists;
- record cleanup warnings if resources survive.

## Wakeup ordering and dedupe

Wakeup delivery remains runtime control-plane text, never user input.

Rules:

- terminal-result dominance: once a terminal result exists, older non-terminal attention events for that run are suppressed if not already delivered;
- if result and attention event become visible in the same poll, deliver result only;
- duplicate terminal events and result file produce one terminal wakeup;
- stale delivery lease expiry may retry the same semantic wakeup, but dedupe key must prevent duplicate terminal wakeups after successful delivery;
- `ack_failed` is not a liveness state; it is an attention event derived from per-message delivery `failed` where the failure reason is an acknowledgement deadline or mismatch;
- `ack_failed`, `comatose`, `stale_transport`, and `orphaned_process` are attention wakeups unless suppressed by terminal result;
- wakeup envelope includes harness and liveness state when relevant.

Tests must exercise question-then-completion-before-poll, blocked-then-failed, duplicate terminal event plus result, stale lease retry, and result-body cap behavior.
