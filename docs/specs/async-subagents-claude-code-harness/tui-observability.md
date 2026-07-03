# TUI and Observability

Pi TUI remains a projection over async-subagents run files. Claude does not introduce a separate manager state.

## Status/result/launch metadata

Extend `status.json`, `result.json`, and `logs/launch.json` with harness metadata useful for recovery and review.

Core fields:

```json
{
  "harness": "claude",
  "launchHarness": "claude-tmux-interactive",
  "mode": "interactive",
  "model": "claude-sonnet-5",
  "effort": "high",
  "executionMode": "dangerous-auth",
  "memoryIsolation": "best-effort-non-bare",
  "claudeHome": "<runDir>/home",
  "shellHome": "<runDir>/shell-home",
  "resultParser": "mcp-terminal"
}
```

Transport fields:

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

Liveness fields are defined in [`control-lifecycle.md`](./control-lifecycle.md).

Skill fields are defined in [`skills.md`](./skills.md).

Launch logs include unsupported-field decisions and non-inherited Pi fields. For Claude, normal state is fail-closed for explicit incompatible fields and recorded `notInheritedAcrossHarness` for base/default Pi-only fields.

## TUI visible states

Rows/cards/widgets should distinguish:

- `claude starting`;
- `claude running`;
- `claude idle 3m`;
- `claude waiting_for_input`;
- `claude ack pending`;
- `claude ack failed` (derived attention from message delivery `failed`, not a separate liveness state);
- `claude rate-limited until 14:32`;
- `claude comatose`;
- `claude stale tmux`;
- `claude orphaned`;
- `claude paused`;
- terminal states: completed/failed/cancelled/expired.

Expanded details should show:

- last terminal output time;
- terminal output byte count;
- last MCP call time;
- last injected message id;
- pending ack ids and deadlines;
- tmux socket/session/pane;
- MCP helper PIDs;
- Claude home and shell home paths;
- launch log path;
- cleanup warnings;
- resolved skills and execution mode.

## Wakeup envelopes

Wakeups remain control-plane runtime text marked `NOT USER INPUT`.

Attention example:

```text
[ASYNC SUBAGENT ATTENTION — NOT USER INPUT]

Subagent: @Mira (worker/claude)
Harness: claude
State: comatose
Last output: 7m ago
Pending message: msg_123 injected, not handled
Summary: Parent message not acknowledged after nudge probe
```

Terminal example:

```text
[ASYNC SUBAGENT RESULT READY — NOT USER INPUT]

Subagent: @Mira (worker/claude)
Harness: claude
State: completed
Summary: Implemented bounded task
```

Terminal wakeups may include result body according to existing cap policy. Raw Claude terminal transcript must never be injected as if it were user input; use `subagent_result` or log paths for transcript/debug details.

## Renderer rules

Follow the repository TUI design rules:

- use existing async-subagents renderer helpers and identity palette;
- use container chrome for lifecycle cards;
- set `renderShell: "self"` on tool renderers;
- use Pi-provided render width/factory components, not `process.stdout.columns`;
- keep width-stable fixed fields where possible;
- drop/truncate lower-priority fields before wrapping chrome;
- avoid green-box wrapper artifacts for failure cards;
- include width-boundary tests for new row/card fields.

## Required wakeup/read-model tests

Renderer snapshots alone are insufficient. Add a real Pi extension wakeup boundary test:

- register `asyncSubagentsPiExtension` in a fake Pi extension context;
- create Claude status/events/results through real run-store files;
- trigger the real polling/session-start path;
- assert sent message content includes `NOT USER INPUT`, `Harness: claude`, run identity, state/liveness, and recommended action when relevant;
- assert sent message content does not include raw terminal transcript or secrets;
- assert details preserve canonical event/result metadata;
- assert duplicate terminal events deliver once;
- assert terminal result suppresses older attention events not yet delivered.

## Required TUI width tests

- live widget at widths around 120, 80, 60, and 44 columns;
- result/attention cards with long display name, long variant name, long tmux path, and long skill name;
- failure cards for schema/skill/transport errors;
- rate-limit/comatose/ack-failed badges;
- ensure cards stay one coherent component and do not rely on `process.stdout.columns`.
