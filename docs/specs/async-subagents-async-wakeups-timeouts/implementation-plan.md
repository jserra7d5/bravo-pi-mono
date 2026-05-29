# Async Subagents Async Wakeups and Graceful Timeouts Implementation Plan

Date: 2026-05-28
Status: Draft — reviewer-updated
Design: `docs/specs/async-subagents-async-wakeups-timeouts/design.md`

## Summary

Implement async-first subagents by removing model-facing wait/sync paths, switching public runtime budgets to `maxRunSeconds`, making wakeups safe and rich, and introducing graceful timeout pause/resume in small phases.

Reviewer feedback tightened the plan around process-group control, supervisor ownership, wakeup redaction, budget defaults, and timeout event delivery. The key implementation rule is now:

> The parent tools request lifecycle changes; the supervisor owns child process signaling, timeout timers, and lifecycle status transitions while the child process is alive.

## Design Decisions

- **No model-facing `subagent_wait`.** Wakeups are the collection trigger; `subagent_result` is the result collection tool and `subagent_status` is a one-shot inspection/recovery tool, not a polling loop.
- **No sync start/continue mode.** Parent tool calls should return promptly.
- **Public budget unit is seconds.** Runtime converts to milliseconds internally.
- **Every child has an explicit effective budget.** Use per-agent/per-variant `maxRunSeconds`, otherwise package config `defaultMaxRunSeconds`. Built-ins must launch without requiring users to hand-write config.
- **Timeout is graceful pause first, terminal expiry second.** Preserve in-flight child process/context when possible.
- **Supervisor owns live process lifecycle.** Parent tools write control commands; supervisor applies signals, timers, and status transitions.
- **Wakeup content is runtime-envelope metadata, not raw child output.** Full child body is pulled with `subagent_result` only.
- **TUI wake cards are rich and consistent.** Every async event should show display name, role, run ID, state, summary/need, and suggested next action.

## Reviewer-Driven Corrections Incorporated

1. Child Pi process must run in its own process group before process-group pause/resume/kill is safe.
2. Resume/extend/cancel must use a durable supervisor control protocol; avoid split-brain between parent tools and supervisor.
3. Timeout-paused wakeups must use an actionable event type or update wakeup filtering/subscriptions.
4. Built-in/default budget policy must be resolved before making budgets required.
5. Top-level `maxRunMs` migration must be explicit; silent ignore is unacceptable.
6. Wakeup redaction tests must inspect the full `sendMessage` payload, not only rendered card/content.
7. Internal wait helpers must be isolated so they are not accidentally re-exposed.

## Phase 0 — Preflight and Inventory

Goal: establish exact current API/test baseline before mutation.

Tasks:

1. Search and record references:
   - `subagent_wait`
   - `mode: "sync"`
   - `waitUntil` / `waitTimeoutMs`
   - `maxRunMs`
   - wakeup `body` / `result.body`
   - `SIGTERM`, `SIGSTOP`, `SIGCONT`, `process.kill`
2. Confirm current package checks pass or record baseline failures:

```bash
timeout 120s npm run check --workspace @bravo/async-subagents
timeout 180s npm test --workspace @bravo/async-subagents
```

Expected files to inspect:

- `packages/async-subagents/extensions/pi/tools.ts`
- `packages/async-subagents/extensions/pi/schema.ts`
- `packages/async-subagents/extensions/pi/renderers.ts`
- `packages/async-subagents/extensions/pi/wakeups.ts`
- `packages/async-subagents/extensions/pi/index.ts`
- `packages/async-subagents/src/start.ts`
- `packages/async-subagents/src/supervisor.ts`
- `packages/async-subagents/src/agentDefinitions.ts`
- `packages/async-subagents/src/types.ts`
- `packages/async-subagents/src/promptAssembly.ts`
- `packages/async-subagents/src/config.ts`

## Phase 1 — Remove Model-Facing Wait Surface

Goal: stop lead agents from blocking on foreground wait tool calls.

### Code changes

#### `extensions/pi/schema.ts`

- Remove `subagentWaitSchema` export.
- Remove from `subagentStartSchema`:
  - `mode`
  - `wait`
  - wait-oriented `timeoutMs`
- Remove from `subagentContinueSchema`:
  - `mode`
  - `wait`
  - wait-oriented `timeoutMs`
- Add to `subagentContinueSchema`:
  - `additionalRunSeconds?: number`

Compatibility decision:

- Do not advertise wait/sync knobs in the schema or prompt.
- If a non-model API compatibility shim is required later, implement it outside the Pi model-facing schema and mark it debug/internal.

#### `extensions/pi/tools.ts`

- Remove `subagent_wait` tool registration block from `buildSubagentTools()`.
- Remove imports used only by model-facing wait:
  - `subagentWaitSchema`
  - wait result content helpers if unused
- In `subagent_start` execute:
  - stop parsing `mode`, `wait`, `timeoutMs`
  - call `startSubagent` async-only
  - keep delivery subscription setup
- In terminal continuation path:
  - stop parsing `mode`, `wait`, `timeoutMs`
  - start continuation async-only
  - for paused-timeout live runs, write a supervisor control command rather than directly owning lifecycle state
- Remove `markWaitResultCollected` use from start/continue if no wait result can be returned.

#### `src/start.ts`

- Remove model-facing wait behavior from `startSubagent` or make it internal/test-only.
- Remove `startMode`, `waitUntil`, and `waitTimeoutMs` from the tool-facing path.
- Remove `waited` / `waitResult` from model-facing result details if practical; otherwise keep only as internal fields not surfaced in schemas/docs.
- Change returned `next`:
  - terminal: `subagent_result`
  - non-terminal: no follow-up tool; continue non-overlapping work or go idle until async wakeup
- If `src/wait.ts` remains, ensure start results never suggest it.

#### `src/wait.ts`

- Either remove the file after tests are migrated, or keep as internal runtime utility only.
- If kept, remove model-oriented `next: subagent_wait` suggestions.
- Consider renaming exported helpers or moving tests to make internal status explicit.

#### `extensions/pi/renderers.ts`

- Remove `"subagent_wait"` from `SubagentToolName`.
- Remove wait-specific card branch.
- Remove wait-title special case.
- Remove `summarizeWaitResult` and nested wait body rendering if unused.

#### `extensions/pi/promptModule.ts`

- Remove guidance to wait at collection points or use wait tools.
- Add guidance:
  - start children async;
  - rely on wakeups;
  - use `subagent_status` only for one-shot inspection/recovery/pre-finalization accounting;
  - use `subagent_result` for terminal results;
  - use `subagent_message` for questions/blocked runs.

#### `extensions/pi/compactionReminder.ts`

- Remove active-run next actions that tell the model to track/poll with `subagent_status`; normal active runs should say no action is needed until an async wakeup arrives. Post-compaction reminders may allow one `subagent_status` call for orientation, explicitly not a loop.

#### `README.md`

- Remove `subagent_wait` from parent tool list.
- Remove sync/wait examples.
- Document async wakeup flow.

### Tests

Update/remove:

- `test/piTools.test.ts`
  - remove direct `subagent_wait` tests;
  - add registered-tool assertion that wait is absent;
  - add schema/tool-catalog snapshot asserting no wait knobs are exposed;
  - assert start result does not suggest a status/polling follow-up for running runs.
- `test/coreRuntime.test.ts`
  - keep `waitSubagents` tests only if `src/wait.ts` remains internal;
  - remove start wait-mode expectations.
- `test/renderers.test.ts`
  - remove wait card and wait summary tests.
- `test/compactionReminder.test.ts`
  - update expected guidance string.
- `test/promptModule.test.ts`
  - assert prompt module does not mention `subagent_wait`.

## Phase 2 — Rename Runtime Budget API to Seconds

Goal: make public configuration human-readable while preserving millisecond internals.

### Budget defaults

Resolve defaults in this phase, not later.

Recommended initial defaults:

- built-in/user scout default: 1800 seconds
- built-in/user reviewer default: 1800 seconds
- built-in/user worker default: 3600 seconds
- global config `defaultMaxRunSeconds`: optional fallback, default 1800 seconds if not configured

Implementation may choose per-agent frontmatter defaults or a package-level role default map. The important contract: existing built-in agents must still launch after budgets become required.

### Code changes

#### `src/agentDefinitions.ts`

Rename public fields:

- `AgentDefinitionVariant.maxRunMs` → `maxRunSeconds`
- `MarkdownAgentDefinition.maxRunMs` → `maxRunSeconds`
- `ResolvedAgentDefinition.maxRunMs` → `maxRunSeconds`

Update parsing:

- `parseAgentVariant`: parse `variants.<name>.maxRunSeconds`
- `applyAgentVariant`: merge `maxRunSeconds`
- `parseAgentDefinitionFile`: parse `maxRunSeconds`

Migration handling:

- Hard reject `maxRunMs` in top-level and variant frontmatter with a clear error: `maxRunMs was renamed to maxRunSeconds`.
- Do not silently ignore `maxRunMs`.
- If a one-release deprecation is later required, it must emit an explicit diagnostic and convert units; no silent fallback.

#### `src/config.ts`

Add config field:

```ts
defaultMaxRunSeconds?: number
```

Validation:

- positive finite number;
- preferably integer seconds for user-authored config;
- launch fallback uses this field or role defaults.

#### `src/start.ts`

Compute effective budget:

```ts
const maxRunSeconds = definition.maxRunSeconds ?? config.defaultMaxRunSeconds ?? roleDefaultSeconds(definition.name);
if (!maxRunSeconds) failBeforeLaunch("MAX_RUN_SECONDS_REQUIRED", ...);
const effectiveMaxRunMs = Math.ceil(maxRunSeconds * 1000);
```

Record metadata in:

- initial status
- start result details
- launch log metadata
- supervisor input

#### `src/types.ts`

Add/rename budget fields where needed:

- `RunStatus.maxRunSeconds?`
- `RunStatus.effectiveMaxRunMs?`
- `RunStatus.budgetSource?: "agent" | "variant" | "config" | "role-default"`
- `RunResult.maxRunSeconds?`
- `RunResult.effectiveMaxRunMs?`
- `RunResult.budgetSource?`
- supervisor input `effectiveMaxRunMs`

Avoid exposing `maxRunMs` as authored/public config.

#### `src/promptAssembly.ts`

- Return `maxRunSeconds`, not `maxRunMs`.
- Add assigned budget to task metadata.
- Add runtime contract guidance for checkpointing before timeout.

#### Agent definitions and fixtures

Update built-in/user examples and tests:

- `agents/*.md`
- test fixtures with `maxRunMs`
- README examples

### Tests

- `agentDefinitions.test.ts`: parses `maxRunSeconds`.
- `agentDefinitions.test.ts`: rejects top-level and variant `maxRunMs` with migration error.
- `frontmatter.test.ts`: update `maxRunMs` fixture to `maxRunSeconds`.
- `config.test.ts`: validates `defaultMaxRunSeconds`.
- start test: config default / role default is applied and recorded.
- start test: explicit invalid budget fails clearly.
- built-in agents still launch in fake/immediate tests with an effective budget.

## Phase 3 — Safe Wakeup Payloads and Rich Cards

Goal: make wakeups the primary completion path without confusing child output for user input.

### Code changes

#### `extensions/pi/wakeups.ts`

Update `WakeupMessage` construction:

- Terminal `resultDelivery()` should include:
  - `runId`
  - `state`
  - `agentName`
  - `displayName`
  - `summary`
  - `error` metadata if any
  - `next: [{ tool: "subagent_result", args: { runId } }]`
- Do not copy full `result.body` into `message.body`.
- Do not place an unredacted `RunResult` with `body` inside `message.result`.
- If retaining `message.result`, create a sanitized clone:

```ts
const { body: _body, ...safeResult } = result;
```

- Add a marker or field such as `bodyAvailable: Boolean(result.body)` so the TUI can say “result available; use subagent_result”.
- Add paused-timeout wakeup delivery support using the same compact metadata.

#### `extensions/pi/index.ts`

Replace current `sendWakeup()` content construction.

Current problem:

```ts
content: wakeup.summary ?? wakeup.title
```

Target envelope:

```md
[ASYNC SUBAGENT EVENT — NOT USER INPUT]

Subagent: @Name (agent/variant)
Run ID: run_x
State: completed
Summary: ...

Next: call subagent_result({ runId: "run_x" }) if this result is relevant.
```

Rules:

- Never use raw child summary/body as the whole content.
- Always include `NOT USER INPUT` marker.
- Keep content compact.
- Ensure no serialized `sendMessage` payload contains full result body unless intentionally collecting through `subagent_result`.

#### `extensions/pi/renderers.ts`

Update `WakeupMessage` / `WakeCardInput` to support:

- display name
- role / agent name
- run ID
- state
- summary or need
- next action
- budget/timeout reason when present

Render consistent cards for:

- completed/result-ready
- failed
- cancelled
- expired fallback
- paused timeout
- question/waiting_for_input
- blocked
- artifact/status if delivered to UI

Required paused mappings:

- `deriveWakeKind("paused")`
- `deriveWakeBadge("paused")` → e.g. `timed out` or `paused`
- `describeAffordances("paused")` → `continue`, `cancel`

Follow TUI constraints:

- container chrome for lifecycle cards;
- identity palette and `idMention` / `idBar`;
- ANSI-aware width helpers;
- responsive cutoffs;
- no full result body in terminal wake card.

### Tests

- `piWakeupDelivery.test.ts`
  - terminal wakeup content starts with runtime envelope;
  - includes run ID, state, display/agent;
  - deep-serialized payload does not include full child result body in `content`, `details.body`, `details.result.body`, nested fields, or renderer input;
  - still uses `{ triggerTurn: true, deliverAs: "steer" }`.
- `wakeups.test.ts`
  - terminal dedupe still works;
  - question/blocked remap still works;
  - paused timeout wakeup is actionable.
- `renderers.test.ts`
  - wake cards include display name, role, run ID, state, summary;
  - cards fit widths 72/56/44/32;
  - paused card shows continue/cancel affordances;
  - no full body is rendered for terminal result-ready card.

## Phase 4 — Supervisor Control Protocol

Goal: define and implement a durable single-owner lifecycle protocol before adding pause/resume timeout behavior.

### Ownership rule

- Supervisor owns live child process signaling and lifecycle status transitions while the child process is alive.
- Parent tools write commands to a durable control file/queue.
- Supervisor reads commands, applies signals, updates status, and appends events.

### Control file path

Use a per-run JSONL control file:

```text
<runDir>/control.jsonl
```

Command shape:

```ts
interface SupervisorControlCommand {
  schemaVersion: 1;
  commandId: string;
  runId: string;
  type: "resume" | "cancel" | "pause" | "extendBudget";
  createdAt: string;
  requestedBy: "parent-runtime";
  reason?: string;
  additionalRunSeconds?: number;
  signal?: "SIGTERM" | "SIGKILL";
}
```

Supervisor ack event shape:

```ts
interface SupervisorControlAck {
  commandId: string;
  ok: boolean;
  error?: string;
}
```

Ack can be appended as a normal `status` event with `data.controlAck`.

### Idempotency and locking

- Commands are append-only.
- Supervisor tracks last processed byte offset in memory and may write `<runDir>/control-state.json` for recovery.
- Duplicate command IDs are ignored after first ack.
- Parent tools should return after appending command and optionally wait briefly for ack only when useful.

### Orphan recovery

Add `supervisorPid` and `supervisorHeartbeatAt` to `RunStatus`.

- Supervisor updates heartbeat while running/paused.
- `subagent_status` can detect stale supervisor heartbeat.
- If supervisor is dead while child is alive, status reports diagnostic; do not silently assume safe control.

## Phase 5 — Process Group and Signal Safety

Goal: make pause/resume/cancel affect the whole child tree without freezing the supervisor.

### Code changes

#### `src/supervisor.ts`

- Spawn child Pi process as a separate process group on POSIX:

```ts
spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] })
```

- Persist both:
  - `pid: child.pid`
  - `pgid: child.pid` on POSIX detached spawn
- Add helper:

```ts
function signalChildGroup(pgid: number, signal: NodeJS.Signals): SignalResult
```

- Use negative PID (`-pgid`) for POSIX group signaling.
- Provide fallback single-PID signaling for platforms where process groups are unavailable.
- Ensure the supervisor itself is not in the child group.

#### `src/types.ts`

Add status fields:

- `pgid?: number`
- `supervisorPid?: number`
- `supervisorHeartbeatAt?: string`

#### `extensions/pi/tools.ts`

- Replace direct `trySignal(status.pid, ...)` lifecycle ownership for live child processes with control commands.
- For emergency fallback where supervisor is dead, use explicit diagnostics and require safe process-group signaling.

### Cancel stopped-process rule

If a process group is stopped and cancel is requested:

Preferred:

1. send `SIGTERM` to process group;
2. send `SIGCONT` to process group so pending SIGTERM can be handled;
3. after short grace, send `SIGKILL` to process group if still alive.

For `signal: "SIGKILL"`, send `SIGKILL` directly to process group.

### Tests

- child process group is distinct from supervisor group.
- pausing child does not pause supervisor.
- child that spawns a grandchild has both child and grandchild paused/resumed/killed.
- cancel paused process terminates rather than leaving stopped process behind.

## Phase 6 — Graceful Timeout Lifecycle

Goal: replace hard kill timeout with checkpoint warning and resumable pause.

### Code changes

#### `src/supervisor.ts`

Rename supervisor input field:

- `maxRunMs` → `effectiveMaxRunMs`

Add running-time accounting:

- track cumulative active running time;
- exclude time spent paused;
- clear/reinstall timers around pause/resume.

Add timers:

1. Soft warning timer:
   - warning offset: `min(60_000, effectiveMaxRunMs * 0.2)` with lower bound for short tests;
   - append inbox message asking child to finish or emit checkpoint;
   - append runtime `status` event with reason `TIME_BUDGET_WARNING` if useful.

2. Hard deadline timer:
   - try to pause child process group with `SIGSTOP`;
   - if pause succeeds:
     - write status `state: "paused"`;
     - set `needs` / summary: budget expired before completion;
     - append actionable wake event as `blocked` with `data.reason = "TIME_BUDGET_EXPIRED"`;
     - keep supervisor alive awaiting control commands;
   - if pause fails or process already dead:
     - finalize terminal `expired`;
     - use error code `MAX_RUN_SECONDS_EXPIRED`.

Timeout event contract:

- Use `blocked` for hard timeout pause so existing `modelFollowUpOnly` wakeup filtering delivers it.
- Event data includes:
  - `reason: "TIME_BUDGET_EXPIRED"`
  - `maxRunSeconds`
  - `effectiveMaxRunMs`
  - `next: "continue_or_cancel"`

#### `extensions/child-control/index.ts`

- Ensure soft-warning inbox messages are delivered promptly.
- Ensure child can acknowledge and emit `blocked` checkpoint.

#### `src/promptAssembly.ts`

Add child runtime contract text:

- watch for time-budget warning inbox messages;
- on warning, finish quickly if possible;
- otherwise emit a `blocked` checkpoint with progress, remaining work, requested extra time, and justification.

#### `extensions/pi/tools.ts`

Update `subagent_continue` for paused timeout:

- accepts `additionalRunSeconds`;
- appends continuation instruction to inbox;
- appends supervisor control command `resume` with `additionalRunSeconds`;
- does not directly write `running` or signal when supervisor is alive;
- reports ack if observed briefly, otherwise reports command queued.

Update `subagent_interrupt`:

- cancel paused timeout runs by appending supervisor control command `cancel`;
- keep terminal `cancelled` fallback only for cases where supervisor is unavailable and process is already dead or safely controlled.

#### `src/lifecycle.ts`

- Ensure fallback expiry result includes budget metadata and error code.
- Keep terminal writes idempotent.

### Tests

Runtime tests should use fake children where possible:

- child completes before budget → `completed`.
- soft warning is appended before deadline.
- child emits checkpoint `blocked` before deadline → parent wakeup delivered.
- hard deadline pause succeeds → status `paused`, no `result.json`, wake delivered.
- `subagent_continue({ additionalRunSeconds })` resumes paused child and reinstalls budget timer.
- manual pause excludes paused duration from timeout accounting.
- pause failure fallback → terminal `expired` result.
- cancel paused timeout terminates process group and writes `cancelled`.

## Phase 7 — Documentation and Prompt Cleanup

### Docs

Update `packages/async-subagents/README.md`:

- async-first parent flow;
- no `subagent_wait`;
- `maxRunSeconds` and config/role defaults;
- timeout checkpoint/pause/continue semantics;
- safe wakeup envelope and `subagent_result` collection.

Update `docs/specs/async-subagents-async-wakeups-timeouts/design.md` if implementation decisions differ.

### Prompt modules

Update async-subagents prompt module to teach:

- start async;
- do not wait in foreground;
- account for wakeups as runtime events, not user input;
- collect relevant results with `subagent_result`;
- continue timed-out paused children only when their result is still needed.

## Phase 8 — Final Validation

Run:

```bash
timeout 120s npm run check --workspace @bravo/async-subagents
timeout 120s npm run build --workspace @bravo/async-subagents
timeout 180s npm test --workspace @bravo/async-subagents
```

Then repo-level if package passes:

```bash
timeout 300s npm run check
timeout 300s npm run build
```

Manual/TUI checks:

- Start a scout and let it complete via wakeup.
- Confirm wake card shows display name, role, run ID, state, summary.
- Confirm model-facing wakeup is a runtime envelope, not raw child prose.
- Confirm `subagent_wait` is absent from the available tool catalog.
- Run a tiny-budget child and confirm timeout pause card and continue path.
- Continue the tiny-budget child with `additionalRunSeconds` and confirm resumed budget enforcement.
- Cancel a paused timeout child and confirm no stopped process remains.

## Rollout / Compatibility

This is a breaking model-facing API cleanup. Recommended rollout:

1. Implement in package and tests.
2. Update active user agent instructions/catalog generation.
3. Remove prompt references to `subagent_wait`.
4. Do not add a model-facing compatibility shim.

If compatibility is required for non-model scripts, keep it outside the Pi tool schema and document it as debug/internal.

## Risks

- POSIX process-group signaling requires careful spawn setup; incorrect signaling can pause the supervisor or leak grandchildren.
- Keeping supervisor alive while paused introduces lifecycle complexity and orphan risk.
- Removing wait/sync modes may break external scripts if they call Pi tools directly.
- If wakeup `details` are included in model context by Pi internals, full result body must be redacted before send.
- Timeout checkpoints are best-effort; a busy child may not process the warning before deadline.
- Supervisor control protocol adds new durability files that must be pruned with run retention.

## Open Questions

- Should top-level `maxRunMs` be hard rejected immediately, or accepted for one release with explicit warning and unit conversion?
- What exact role defaults should ship for user-defined `generalist` / `planner` roles outside package built-ins?
- Should `additionalRunSeconds` be required for continuing a time-paused child, or may it use the role default again?
- What retention policy should clean up indefinitely paused children?
- Should timeout pause use process group signaling on all POSIX platforms and fail closed elsewhere?
