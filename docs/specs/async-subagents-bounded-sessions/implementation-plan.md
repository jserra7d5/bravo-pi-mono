# Async Subagents Bounded Sessions Implementation Plan

Date: 2026-05-17
Status: Historical implementation plan, amended by async wakeups/timeouts

> Amendment: this bounded-session plan predates the wakeup-first tool cleanup. Current async-subagents no longer exposes model-facing `subagent_wait` or sync start/continue modes, and public runtime budgets are `maxRunSeconds` / `defaultMaxRunSeconds`. Timeout expiry is a resumable pause with bounded `subagent_continue({ additionalRunSeconds })`; see `docs/specs/async-subagents-async-wakeups-timeouts/design.md` and `packages/async-subagents/README.md`.

## Objective

Ship async-subagents as a bounded, session-backed Pi subagent system with durable run files, Pi-native session traces, explicit lifecycle controls, and full TUI integration.

This is not a cleanup pass and not a half-step. The target is a shippable implementation where:

- bounded oneshot agents remain the default;
- bounded children use real Pi sessions by default, not `--no-session`;
- `context: fork` means a real branched Pi session, not prompt replay;
- `piSessionPath` is the authoritative Pi session file path; fixed `pi-session/session.jsonl` is only the default fresh-session path;
- parent controls have clean tool boundaries;
- the TUI renders durable state and never owns coordination state;
- wake-ups are lease-guarded and deduped;
- observability is good enough to debug a failed child run after the parent UI restarts.

## Source Of Truth

Primary design:

- `docs/specs/async-subagents-bounded-sessions/design.md`

Prior v1 foundation:

- `docs/specs/async-subagents-v1/design.md`
- `docs/specs/async-subagents-v1/plan.md`

Useful local reference implementation:

- `/home/joe/Documents/misc/pi-subagents`
- `/home/joe/Documents/misc/pi-mono`

Use `pi-subagents` as design input only. Do not copy its broad orchestration surface, compatibility layers, chain templates, intercom bridge, worktree manager, slash bridge, sharing features, or data formats.

## Current State

The existing `packages/async-subagents` package already has substantial v1 foundations:

- durable run directories;
- root session identity;
- leases;
- child-control extension;
- parent Pi tools;
- wake-up polling;
- renderers, status line, and live widget;
- `subagent_interrupt`;
- `subagent_continue`;
- terminal idempotence for parent cancellation;
- passing async-subagents tests.

The bounded-session design is not implemented yet. The critical gap is that child Pi launches still default to `--no-session`, and the data model does not yet have explicit `context`, `session`, or `piSessionPath` fields.

## Non-Negotiable Release Gates

The implementation is not shippable if any of these remain true:

- Default bounded child launch still uses `--no-session`.
- `context: fork` silently falls back to `fresh`.
- `context: fork` is implemented by summary replay or prompt copying instead of Pi session branching.
- `context: fork` is implemented with Pi CLI `--fork`; that copies a whole session and is not branch-from-current-leaf semantics.
- `context: fork` assumes the branch can be written directly to `pi-session/session.jsonl`; Pi currently generates the branched filename.
- Live parent-to-child messaging is claimed without child acknowledgement.
- Terminal `result` and terminal lifecycle event produce duplicate wake-ups.
- TUI state becomes a source of truth.
- Pause, cancel, or resume are hidden inside `subagent_message`.
- Top-level Pi parents lack durable root session identity.
- Child prompt isolation inherits global Pi append prompts, prompt templates, ambient skills, ambient extensions, or ambient context files.
- Result/status terminal writes are not idempotent.
- A real Pi smoke test cannot prove `pi-session/session.jsonl` exists for a bounded default child.

## Architecture Decisions

### Bounded First

Default policy:

```yaml
mode: oneshot
context: fresh
session: record
```

`session: none` is an explicit opt-out. It must be visible in status, result, and launch logs. It is not the default for any built-in agent.

Interactive agents remain explicit and exceptional. They are not required to ship bounded session-backed oneshots, but the state machine must be coherent enough to add them without rewriting core contracts.

### Two Durability Layers

Every recorded run uses this layout:

```text
.subagents/runs/<runId>/
  status.json
  events.jsonl
  inbox.jsonl
  result.json
  artifacts/
  logs/
  pi-session/
    session.jsonl        # default fresh-session path only
    <generated>.jsonl    # possible forked-session path returned by Pi
```

The async-subagents layer owns orchestration state. The Pi session layer owns the actual Pi conversation trace.

`requestedPiSessionPath` records the desired stable path for fresh recorded children. `piSessionPath` records the actual file passed to Pi. For fresh recorded runs those paths should usually match. For forked runs, `piSessionPath` is the generated branch file returned by Pi and must not be assumed to equal `session.jsonl`.

### Fork Means Branch

`context: fork` must:

1. discover the parent Pi session file from `ctx.sessionManager.getSessionFile()`;
2. discover the current parent leaf/message id from `ctx.sessionManager.getLeafId()`;
3. import `SessionManager` from Pi and call `SessionManager.open(parentFile, runPiSessionDir).createBranchedSession(leafId)`;
4. launch the child with that session file;
5. include a fork preamble telling the child that inherited context is reference material, not a live continuation.

If the branch cannot be created, the run fails clearly unless the caller explicitly requested `allowFreshFallback: true`.

Do not use Pi CLI `--fork` for this. It cannot target a leaf id and cannot combine with `--session`, so it is the wrong primitive.

### Tool Boundaries

Parent tools:

- `subagent_start`: create and launch a child run.
- `subagent_wait`: wait for interesting events or terminal results.
- `subagent_status`: inspect current and recent child state.
- `subagent_result`: read terminal results and mark result delivery handled.
- `subagent_message`: send normal parent input only.
- `subagent_interrupt`: pause or cancel.
- `subagent_continue`: resume a paused child and optionally send normal input.

`subagent_message` must only accept:

- `instruction`;
- `answer`;
- `context`.

Lifecycle control belongs in lifecycle tools, not chat messages.

## Architectural Smells To Resolve Before Hardening

### Cancel Writer Ownership

The prior v1 plan says the parent should not write child lifecycle status/result after spawn, but the bounded design and current `subagent_interrupt` implementation let parent cancellation write terminal `cancelled` status/result.

Resolution:

- Parent-owned cancellation is allowed as an explicit lifecycle exception.
- `subagent_interrupt(action: "cancel")` may write terminal `cancelled` result/status/events.
- Supervisor process-close handling must never overwrite a terminal result/status and must emit only reconciliation events.
- This exception must be documented in code comments and tested directly.

### Runtime Tool Allowlist Exception

The plan says an empty user tool allowlist disables tools, but child-control may require `subagent_event` even when the agent has no user tools.

Resolution:

- Split `userBuiltinTools`, `runtimeBuiltinTools`, and `runtimeExtensionPaths`.
- `runtimeBuiltinTools` contains required transport tool names such as `subagent_event` when they are filtered by Pi's `--tools` allowlist.
- `runtimeExtensionPaths` contains required extension paths such as child-control.
- Pi launch uses `--tools <userBuiltinTools + runtimeBuiltinTools>` and explicit `-e <runtimeExtensionPath>` entries.
- Status and launch logs record all three arrays separately.
- Tests must prove a no-user-tools child still gets required runtime tools and does not get unrelated Pi tools.

### Terminal Wake-Up Key

Current wake-ups mostly coalesce terminal delivery, but the key contract needs to be explicit.

Resolution:

- Require terminal results to have `createdAt`.
- Use one terminal delivery key shape: `terminal:<runId>:<result.createdAt>`.
- `completed`, `failed`, `cancelled`, and `expired` terminal events all coalesce behind the terminal result.
- `subagent_wait` and `subagent_result` mark that key handled.
- Tests must prove one terminal follow-up per terminal result.

### Fork Session Path Ownership

Pi's branch API returns a generated session file. Assuming a fixed fork target path is bullshit.

Resolution:

- `requestedPiSessionPath` is a desired path, used for fresh recorded runs.
- `piSessionPath` is the actual session file passed to Pi and persisted everywhere.
- Forked runs record `forkSourceSessionFile`, `forkSourceLeafId`, and generated `piSessionPath`.
- Do not copy, rename, or symlink forked session files into `session.jsonl` unless Phase 0 proves that is safe.

### Parent Pi Session Bridge

Fork is not implementable unless the parent extension captures Pi session metadata.

Resolution:

- Define `ParentPiSessionRef = { sessionFile: string; leafId: string }`.
- Populate it from `ctx.sessionManager.getSessionFile()` and `ctx.sessionManager.getLeafId()`.
- Pass it through `ToolRuntime` and `StartSubagentInput`.
- Persist it in launch metadata for forked runs.
- If it is missing, `context: fork` fails before launch unless `allowFreshFallback: true`.

## Phase 0: Verify Pi Session And Launch Contract

Purpose: confirm the runtime facts before coding against assumptions.

Inspect or smoke test local Pi behavior for:

- `--session <file>`;
- `--session-dir <dir>`;
- `--no-session`;
- `--system-prompt <file-or-text>`;
- `--append-system-prompt ""` as the required way to suppress global/project append prompts;
- `--no-context-files`;
- `--no-prompt-templates`;
- task file passing with `-p @<taskPath>`;
- `--tools` allowlist semantics;
- behavior when `--tools` is combined with required extension tools;
- extension loading with the child-control extension;
- session manager access from Pi extension context, specifically `ctx.sessionManager.getSessionFile()`;
- current leaf/message id discovery, specifically `ctx.sessionManager.getLeafId()`;
- importing `SessionManager` from Pi extension code;
- branch API `SessionManager.open(parentFile, runPiSessionDir).createBranchedSession(leafId)`;
- parent follow-up injection APIs `sendUserMessage(content, { deliverAs: "followUp" })` and `sendMessage(custom, { triggerTurn: true, deliverAs: "followUp" })`;
- TUI APIs `ctx.ui.setStatus()` and `ctx.ui.setWidget()`, including no-UI behavior through `ctx.hasUI`.

Files likely touched:

- `packages/async-subagents/src/piHarness.ts`
- `packages/async-subagents/src/piSession.ts` as a new module
- `packages/async-subagents/test/piHarness.test.ts`
- `packages/async-subagents/test/piSession.test.ts`
- `packages/async-subagents/README.md`

Acceptance gates:

- A test or local note records the exact supported Pi argv shape.
- The plan for `context: fork` names the exact Pi API used for branching.
- The plan records that Pi CLI `--fork` is not used for branch-from-current-leaf semantics.
- If branch support is not available, `context: fork` remains a clear structured failure and is not marketed as complete.

## Phase 1: Data Model And Run Layout

Purpose: give the runtime an authoritative place for session policy and Pi session paths.

Implement:

- `ContextPolicy = "fresh" | "fork"`;
- `SessionPolicy = "record" | "none"`;
- `RunState` includes `idle`;
- `RunStatus` includes:
  - `contextPolicy`;
  - `sessionPolicy`;
  - `piSessionPath`;
  - `requestedPiSessionPath`;
  - `forkSourceSessionFile`;
  - `forkSourceLeafId`;
  - `userBuiltinTools`;
  - `runtimeBuiltinTools`;
  - `runtimeExtensionPaths`;
  - `rootSessionId`;
  - `parentSessionId`;
  - `parentRunId`;
  - `pid`;
  - `processHealth`;
  - `launchLogPath`;
  - `inboxPath`;
  - `resultReady`;
  - `deliveryState`;
- `RunResult` includes:
  - `contextPolicy`;
  - `sessionPolicy`;
  - `piSessionPath`;
  - `requestedPiSessionPath`;
  - `forkSourceSessionFile`;
  - `forkSourceLeafId`;
  - `createdAt`;
  - terminal metadata;
- `RunIndexRecord` includes session/context metadata;
- `SubagentStartResult` returns `piSessionPath`;
- `RunPaths` includes:
  - `piSessionDir`;
  - `requestedPiSessionPath`;
  - `piSessionPath`.

Files likely touched:

- `packages/async-subagents/src/types.ts`
- `packages/async-subagents/src/schemas.ts`
- `packages/async-subagents/src/runStore.ts`
- `packages/async-subagents/src/status.ts`
- `packages/async-subagents/src/result.ts`
- `packages/async-subagents/test/runStore.test.ts`
- `packages/async-subagents/test/coreRuntime.test.ts`

Acceptance gates:

- `createRunDirectory` creates `pi-session/`.
- Fresh recorded run `requestedPiSessionPath` and `piSessionPath` are stable: `<runDir>/pi-session/session.jsonl`.
- Forked run `piSessionPath` may be a Pi-generated file under `piSessionDir`; the actual path is persisted everywhere.
- `status.json`, run index, and `result.json` preserve session/context policy.
- `idle` is accepted by schemas and rendered coherently.
- Existing tests still pass.

## Phase 2: Agent Definition And Start Schema Policy

Purpose: expose policy through markdown definitions and parent tools without implicit behavior.

Add frontmatter fields:

```yaml
context: fresh | fork
session: record | none
```

Defaults:

- `context: fresh`;
- `session: record`.

Add `subagent_start` parameters:

- `context?: "fresh" | "fork"`;
- `session?: "record" | "none"`;
- `allowFreshFallback?: boolean`.

Validation:

- `context: fork` requires `session: record`.
- `session: none` with `context: fork` is rejected.
- Caller tool params override agent defaults.
- Agent defaults override package defaults.
- Built-in agents stay bounded and recorded unless intentionally changed.

Files likely touched:

- `packages/async-subagents/src/agentDefinitions.ts`
- `packages/async-subagents/src/frontmatter.ts`
- `packages/async-subagents/src/start.ts`
- `packages/async-subagents/extensions/pi/schema.ts`
- `packages/async-subagents/extensions/pi/tools.ts`
- `packages/async-subagents/agents/scout.md`
- `packages/async-subagents/agents/reviewer.md`
- `packages/async-subagents/agents/worker.md`
- `packages/async-subagents/test/agentDefinitions.test.ts`
- `packages/async-subagents/test/piTools.test.ts`

Acceptance gates:

- Agent definitions parse and default `context`/`session`.
- Invalid policy combinations fail before launch.
- `subagent_start` forwards policy fields into `startSubagent`.
- Built-in agents resolve to `mode: oneshot`, `context: fresh`, `session: record`.

## Phase 3: Session-Backed Bounded Launch

Purpose: replace default `--no-session` with a per-run Pi session file.

Implementation:

- Centralize Pi argv construction in `buildPiCommand`.
- Require `buildPiCommand({ sessionPolicy, piSessionPath, userBuiltinTools, runtimeBuiltinTools, runtimeExtensionPaths })`.
- Create `piSessionDir` and resolve `piSessionPath` before prompt assembly and before branching.
- For `session: record`, pass:

```bash
--session <piSessionPath>
```

For fresh recorded runs, `<piSessionPath>` is `<runDir>/pi-session/session.jsonl`.

- For `session: none`, pass:

```bash
--no-session
```

- Persist a redacted `logs/launch.json` with:
  - argv;
  - cwd;
  - model;
  - user built-in tools;
  - runtime built-in tools;
  - runtime extension paths;
  - extensions;
  - skills;
  - context policy;
  - session policy;
  - requested Pi session path;
  - Pi session path;
  - parent/root ids.

Required launch properties:

- `--no-context-files`;
- `--no-skills` except explicit declared skills;
- `--no-prompt-templates`;
- `--append-system-prompt ""` to suppress global/project append prompts;
- `--no-extensions` except explicit declared extensions plus child-control;
- `--system-prompt <runDir>/artifacts/system.md`;
- effective tool allowlist is `userBuiltinTools + runtimeBuiltinTools`;
- child-control and any required runtime extension paths are loaded through explicit `-e <path>` entries;
- task prompt comes from `artifacts/task.md` using the Phase 0-confirmed Pi contract.

Files likely touched:

- `packages/async-subagents/src/piHarness.ts`
- `packages/async-subagents/src/start.ts`
- `packages/async-subagents/src/promptAssembly.ts`
- `packages/async-subagents/src/supervisor.ts`
- `packages/async-subagents/test/piHarness.test.ts`
- `packages/async-subagents/test/promptAssembly.test.ts`
- `packages/async-subagents/test/coreRuntime.test.ts`

Acceptance gates:

- Default bounded launch test asserts `--session <.../pi-session/session.jsonl>`.
- Opt-out launch test asserts `session: none` uses `--no-session`.
- No default bounded test expects `--no-session`.
- Launch command includes `--append-system-prompt ""`.
- Launch log records redacted session/context/tool metadata.
- Real Pi smoke test creates a non-empty or Pi-recognized `pi-session/session.jsonl` for a default child.

## Phase 4: Fork Context

Purpose: implement real Pi-native fork semantics.

Implementation:

- Add `src/piSession.ts`.
- Define `ParentPiSessionRef = { sessionFile: string; leafId: string }`.
- Define a small adapter boundary:
  - `readParentPiSessionRef(ctx): ParentPiSessionRef | null`;
  - `branchSession(parentSessionFile, leafId, piSessionDir): string`;
- Implement branching with `SessionManager.open(parentSessionFile, piSessionDir).createBranchedSession(leafId)`.
- From the Pi extension, capture parent session metadata at `session_start` and before `subagent_start`.
- Pass `ParentPiSessionRef` through `ToolRuntime` and `StartSubagentInput`.
- For `context: fresh`, create/use the run session path without branching.
- For `context: fork`, branch before child launch and use the returned generated path as `piSessionPath`.
- Do not use Pi CLI `--fork`.
- Add a fork task preamble:

```text
You are running in a branched child Pi session. The inherited conversation is reference context only. Do not continue the parent thread or answer old user turns. Execute only the delegated task below and report the requested result.
```

- If branch fails:
  - fail the start with structured error by default;
  - only run fresh when `allowFreshFallback: true`;
  - record fallback explicitly in status/result/launch log.
- Persist fork metadata:
  - `forkSourceSessionFile`;
  - `forkSourceLeafId`;
  - generated `piSessionPath`;
  - fallback decision if any.

Files likely touched:

- `packages/async-subagents/src/piSession.ts`
- `packages/async-subagents/src/start.ts`
- `packages/async-subagents/src/promptAssembly.ts`
- `packages/async-subagents/extensions/pi/index.ts`
- `packages/async-subagents/extensions/pi/tools.ts`
- `packages/async-subagents/test/piSession.test.ts`
- `packages/async-subagents/test/coreRuntime.test.ts`
- `packages/async-subagents/test/piTools.test.ts`

Acceptance gates:

- Unit test proves fork calls the branch adapter with parent session file, leaf id, and `piSessionDir`.
- Unit test proves the returned branch path is the actual `piSessionPath` passed to Pi.
- Unit test proves fork failure does not silently run fresh.
- Unit test proves `allowFreshFallback: true` records fallback explicitly.
- Real Pi smoke test proves a forked child sees prior parent context as reference and receives the fork preamble.

## Phase 5: Lifecycle State Machine And Process Reconciliation

Purpose: make lifecycle semantics precise and recoverable.

Implementation:

- Add a shared terminal helper such as `finalizeTerminalRun` and reconciliation helper such as `reconcileTerminalState`.
- Use the helper from supervisor completion, launcher failure, parent cancellation, status inspection, and watcher paths.
- Stop hardcoding terminal `lastEventId`; derive it from the appended terminal event.
- Ensure launcher failure writes a terminal failed event, not just failed status/result.

States:

- `created`;
- `queued`;
- `running`;
- `idle`;
- `waiting_for_input`;
- `paused`;
- `blocked`;
- `stalled`;
- `completed`;
- `failed`;
- `cancelled`;
- `expired`.

Terminal states:

- `completed`;
- `failed`;
- `cancelled`;
- `expired`.

Rules:

- `result.json` is written before terminal status is visible.
- Terminal result/status are immutable except for additive delivery metadata.
- Supervisor close handling never overwrites an existing terminal result.
- Parent cancellation may write terminal `cancelled` as the explicit lifecycle exception.
- Reconciliation emits events for mismatches instead of silently rewriting history.

Reconciliation cases:

- status says `running` but PID is gone;
- status says `paused` but PID is gone;
- status says `cancelled` but PID is alive;
- result exists but status is non-terminal;
- terminal status exists but result is missing.

Files likely touched:

- `packages/async-subagents/src/types.ts`
- `packages/async-subagents/src/schemas.ts`
- `packages/async-subagents/src/supervisor.ts`
- `packages/async-subagents/src/status.ts`
- `packages/async-subagents/extensions/pi/tools.ts`
- `packages/async-subagents/extensions/child-control/index.ts`
- `packages/async-subagents/test/coreRuntime.test.ts`
- `packages/async-subagents/test/piTools.test.ts`

Acceptance gates:

- Cancellation writes one terminal `cancelled` result.
- Later child process exit does not overwrite cancellation.
- Launcher failure writes failed result, failed status, and failed event through the shared helper.
- Pause writes `paused`; continue writes `running`.
- Dead PID reconciliation emits an event.
- Missing result/status mismatch is reported by `subagent_status`.

## Phase 6: Parent Tool Surface Hardening

Purpose: make the parent controls obvious and hard to misuse.

`subagent_message`:

- accepts only `instruction`, `answer`, `context`;
- rejects `pause`, `cancel`, `resume`, `continue`, and any lifecycle alias;
- returns an error that names `subagent_interrupt` or `subagent_continue`.

`subagent_interrupt`:

- runner/supervisor installs explicit signal handlers for lifecycle actions;
- `pause`: use real process control where available and write `paused`;
- `cancel`: terminate process where available and write terminal `cancelled`;
- record signal attempted and signal result.

`subagent_continue`:

- for paused process, send `SIGCONT` where available and write `running`;
- optionally append normal parent message;
- reject completed/failed/cancelled/expired runs.
- if there is no real paused process to continue, fail clearly instead of faking resume through an inbox message.

`subagent_status`:

- show run id, state, agent, cwd, parent/root ids, pid/process health, session policy, context policy, Pi session path, last activity, current tool, result readiness.

`subagent_result`:

- include result body plus pointers to Pi session, logs, artifacts, launch metadata, and output tail.

Files likely touched:

- `packages/async-subagents/extensions/pi/schema.ts`
- `packages/async-subagents/extensions/pi/tools.ts`
- `packages/async-subagents/src/message.ts`
- `packages/async-subagents/src/result.ts`
- `packages/async-subagents/src/wait.ts`
- `packages/async-subagents/test/piTools.test.ts`

Acceptance gates:

- Lifecycle types are rejected by `subagent_message`.
- Paused child can be continued.
- Terminal child cannot be continued.
- `subagent_status` exposes Pi session metadata.
- `subagent_result` marks terminal delivery handled.

## Phase 7: Live Messaging Acknowledgement

Purpose: prevent fake interactive behavior from shipping.

Implementation:

- Child-control extension observes `inbox.jsonl`.
- Child-control emits acknowledgement event for every consumed parent message:
  - `message.received`;
  - message id;
  - parent message type;
  - timestamp.
- Parent tools may wait for acknowledgement when `requiresAck` is true.
- Define the default acknowledgement precisely as "child-control extension consumed the inbox message."
- If Pi exposes stronger model-delivery acknowledgement, record that as a separate stronger ack level.
- If live message delivery cannot be proven for a child, `subagent_message` and message-bearing `subagent_continue` fail clearly instead of pretending delivery worked when `requiresAck` is true.
- Replace tests that accept unsupported required-ack delivery as non-error with tests that require a structured delivery failure.

Files likely touched:

- `packages/async-subagents/extensions/child-control/index.ts`
- `packages/async-subagents/src/message.ts`
- `packages/async-subagents/extensions/pi/tools.ts`
- `packages/async-subagents/test/childControl.test.ts`
- `packages/async-subagents/test/piTools.test.ts`

Acceptance gates:

- Fake child integration proves acknowledgement path.
- Parent tool with `requiresAck` waits for and reports ack.
- Ack result states whether it proves extension consumption or model receipt.
- Timeout waiting for ack returns a structured non-delivery warning.
- Non-cancel live messaging is not documented as complete until this passes against real Pi.

## Phase 8: Wake-Ups, Watchers, And Delivery Dedupe

Purpose: make background completion reliable without duplicate follow-ups.

Implementation:

- Keep wake-up delivery lease-scoped to the current root session owner.
- Use terminal key `terminal:<runId>:<result.createdAt>`.
- Replace the delivery key contract in `resultDeliveryKey`, `subagent_wait`, `subagent_result`, and wake-up tests with the `terminal:` key shape.
- Coalesce terminal event and terminal result behind the same key.
- Prime result watcher on extension startup so completions that happened while the UI was gone are visible.
- Coalesce noisy fs events.
- Use polling recovery because `fs.watch` is not enough by itself.
- Filter by current root session id and cwd.
- `subagent_wait` and `subagent_result` mark relevant deliveries handled.
- Watcher consumption marks durable delivery metadata only. It never deletes `result.json` or terminal events.
- Parent follow-ups use `sendUserMessage(content, { deliverAs: "followUp" })` or `sendMessage(custom, { triggerTurn: true, deliverAs: "followUp" })`; custom messages without `triggerTurn` are not valid wake-ups.

Files likely touched:

- `packages/async-subagents/extensions/pi/wakeups.ts`
- `packages/async-subagents/src/watcher.ts`
- `packages/async-subagents/src/leases.ts`
- `packages/async-subagents/src/wait.ts`
- `packages/async-subagents/src/result.ts`
- `packages/async-subagents/test/wakeups.test.ts`
- `packages/async-subagents/test/leases.test.ts`
- `packages/async-subagents/test/coreRuntime.test.ts` for wait coverage, or a new `packages/async-subagents/test/wait.test.ts` if wait coverage is split out deliberately

Acceptance gates:

- Two parent Pi sessions in one repo do not both deliver the same wake-up.
- Terminal result produces one follow-up.
- Restarted watcher discovers existing unhandled terminal results.
- Race wait returns first interesting event while other children continue running.
- Result watcher never removes terminal result files.
- Lost delivery metadata may cause bounded duplicate notices, never lost durable results.

## Phase 9: TUI Projection And Expanded Details

Purpose: make the Pi terminal integration useful without making it authoritative.

Status line:

```text
subagents: 2 running, 1 waiting, 1 result
```

Live widget rows:

```text
~ scout running      run_abc  reading package graph
? reviewer waiting   run_def  needs parent answer
| worker paused      run_ghi  paused by parent
* reviewer result    run_jkl  3 findings
```

Expanded detail must show:

- run id;
- run dir;
- parent/root ids;
- agent definition and source;
- state and process health;
- session policy;
- context policy;
- Pi session path;
- launch metadata path;
- stdout/stderr tail;
- recent events;
- recent inbox;
- result summary/body;
- artifacts;
- suggested next actions.

Implementation:

- Keep status formatting independent from TUI components.
- Add a shared `readRunDetails` or `readRunDiagnostics` helper instead of scattering tail reads through renderers and tools.
- Add mtime/size caches for status and bounded output tails.
- Tail output by size, not whole-file reads.
- Render `idle`.
- Render session path in details, not necessarily every compact row.
- Use Pi `ctx.ui.setStatus()` for footer/status text and `ctx.ui.setWidget()` for live widgets.
- Gate richer rendering with `ctx.hasUI`; no-UI mode must remain functional through tools and durable files.

Files likely touched:

- `packages/async-subagents/extensions/pi/liveWidget.ts`
- `packages/async-subagents/extensions/pi/statusLine.ts`
- `packages/async-subagents/extensions/pi/renderers.ts`
- `packages/async-subagents/src/watcher.ts`
- `packages/async-subagents/src/status.ts`
- `packages/async-subagents/test/renderers.test.ts`
- `packages/async-subagents/test/wakeups.test.ts`

Acceptance gates:

- Widget/status line derive only from durable files.
- Expanded result/status includes Pi session path and log/artifact pointers.
- Large logs do not freeze the widget.
- UI restart can reconstruct active/recent child state from files.
- No-UI mode still supports status/result/wait tools.

## Phase 10: Interactive And Idle Policy

Purpose: prepare interactive support without infecting bounded defaults.

Rules:

- Idle notices apply only to real interactive children.
- Bounded oneshots do not produce stale idle notices unless they exceed timeout/health policy.
- Idle notices are batched and deduped.
- Interactive children need explicit heartbeat/status events before this is considered complete.

Implementation:

- Child-control emits heartbeat/idle/waiting events only for interactive mode.
- Watcher derives `idle` from activity timestamps and mode.
- Parent notice suggests:
  - `subagent_status`;
  - `subagent_continue`;
  - `subagent_interrupt`.

Files likely touched:

- `packages/async-subagents/extensions/child-control/index.ts`
- `packages/async-subagents/src/watcher.ts`
- `packages/async-subagents/extensions/pi/wakeups.ts`
- `packages/async-subagents/test/childControl.test.ts`
- `packages/async-subagents/test/wakeups.test.ts`

Acceptance gates:

- Idle batching only triggers for interactive children.
- Bounded oneshot child running under max runtime does not get idle spam.
- Paused child does not get repeated stale idle notices.

## Phase 11: Observability And Diagnostics

Purpose: make failures debuggable from disk.

Persist per run:

- redacted launch command;
- Pi session path;
- requested Pi session path;
- fork source session file and leaf id when applicable;
- child pid;
- model;
- user built-in tools;
- runtime built-in tools;
- runtime extension paths;
- skills;
- extensions;
- context policy;
- session policy;
- parent/root ids;
- stdout/stderr logs;
- structured events;
- inbox;
- final result;
- usage metrics if Pi exposes them;
- reconciliation events;
- `logs/launch.json` written before spawn with runner-level configuration;
- `logs/child-argv.json` per child attempt if retries or fallback attempts are ever added.

Add diagnostic commands or status surfaces for:

- run directory path;
- launch log path;
- child argv path;
- session file path;
- output tail;
- event tail;
- process health;
- last activity age;
- delivery state.

Files likely touched:

- `packages/async-subagents/src/status.ts`
- `packages/async-subagents/src/result.ts`
- `packages/async-subagents/src/watcher.ts`
- `packages/async-subagents/extensions/pi/tools.ts`
- `packages/async-subagents/extensions/pi/renderers.ts`
- `packages/async-subagents/README.md`

Acceptance gates:

- A failed child can be diagnosed from files without live parent memory.
- `subagent_status` is useful after extension reload.
- Launch logs redact secrets and do not dump full environment.

## Phase 12: Real Pi Smoke Suite

Purpose: prove the shipped behavior against Pi, not just fake harnesses.

Smoke scenarios:

1. Default bounded child:
   - start built-in `scout`;
   - verify `pi-session/session.jsonl`;
   - verify the launch uses `--session <runDir>/pi-session/session.jsonl`;
   - verify isolated prompt;
   - verify result.

2. Parent keeps working:
   - start long-running child;
   - parent runs another tool;
   - wait returns child completion later.

3. Race wait:
   - start two children;
   - one emits question or result first;
   - wait returns first interesting event;
   - other child continues.

4. Terminal wake-up:
   - child completes while parent is idle;
   - follow-up appears once;
   - `subagent_result` marks handled.

5. Pause/cancel/continue:
   - pause running child;
   - verify status;
   - continue it;
   - cancel another child;
   - verify terminal idempotence.

6. Fork context:
   - parent establishes a small fact;
   - forked child receives it as reference context through `SessionManager.open(...).createBranchedSession(leafId)`;
   - verify launch uses `--session <generated fork path>`;
   - verify `piSessionPath` records that generated fork path;
   - child obeys delegated task, not old parent intent.

7. TUI:
   - status line counts active/result children;
   - live widget shows rows;
   - expanded detail shows session path, logs, events, inbox, result.

Acceptance gates:

- All smoke scenarios pass on a clean install of the package.
- Failures produce actionable logs.
- No smoke scenario requires Tango or Loom.

## Rollout Sequence

1. Land data model and run layout changes.
2. Land agent definition and tool schema policy.
3. Change bounded launch default to `--session`.
4. Persist/expose `piSessionPath`.
5. Resolve lifecycle ownership and terminal key contracts.
6. Implement fork adapter with clear failure behavior.
7. Harden parent tools.
8. Prove live message acknowledgement.
9. Harden wake-up dedupe and result watcher recovery.
10. Complete TUI details and caches.
11. Add interactive idle policy.
12. Run unit tests, integration tests, and real Pi smoke suite.
13. Update README and docs.
14. Confirm Tango/Loom are not installed as default Pi extensions and async-subagents is.

## Validation Commands

Run during implementation:

```bash
npm run check --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
```

Run before release:

```bash
npm run check
npm run build
npm test --workspace @bravo/async-subagents
pi list
```

Manual Pi smoke tests are required before calling this shipped.

## Done Definition

This work is done when:

- default built-in bounded agents create Pi session files;
- run files and Pi session files are enough to inspect and debug runs after parent restart;
- `fresh`, `fork`, `record`, and `none` policies behave exactly as documented;
- `subagent_message`, `subagent_interrupt`, and `subagent_continue` have crisp responsibilities;
- wake-ups are deduped and lease-scoped;
- TUI status, widget, and expanded details are file-backed projections;
- all async-subagents tests pass;
- real Pi smoke tests pass;
- README explains current install and usage;
- no Tango/Loom extension path is part of the default setup.
