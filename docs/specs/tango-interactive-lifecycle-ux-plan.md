# Tango Interactive-Agent Lifecycle and UX Plan

Date: 2026-05-01  
Status: proposed plan  
Scope: Tango core/server/CLI/Pi extension/dashboard. Planning only; no implementation in this change.


## Source update incorporated

This revision explicitly incorporates the retask debugger report at `.tango-interactive-retask-debugger-report.md`. The strategic target is **true reusable, multi-task interactive sessions with task-turn lifecycle semantics**. Near-term fixes below are mitigations only; they should not be treated as the final product direction or as merely documenting today's terminal `done` behavior.

Retask debugger backlog items carried into this plan:

- false/overeager stalled notifications;
- poor checkpoint surfacing;
- ambiguity of interactive `done`;
- misleading message-to-terminal behavior;
- status/result/activity mismatch;
- board/inbox wake-up noise.

## 1. Objective and scope

Improve Tango's interactive-agent lifecycle semantics and UX around retasking, stalled notifications, checkpoints, message delivery, and result/activity consistency, with reusable interactive sessions and task-turn lifecycles as the strategic target.

Observed problems this plan addresses:

1. Interactive agents that report `done` become terminal and immutable, even when their tmux/Pi session is still alive and users expect them to remain reusable.
2. The larger desired model is a true reusable interactive lifecycle: live session + distinct task turns + explicit idle/awaiting-task state, rather than a single run-level `done` meaning both task completion and permanent finalization.
3. `agent stalled` notifications can be false or overeager while an agent is alive, drafting, running tools, or has written useful checkpoint/progress files.
4. Checkpoint/progress content is not first-class; useful interim output is buried in tmux logs or arbitrary files, while `metadata.summary`/`tango_activity` show only a short summary.
5. `tango message` to terminal interactive runs is ambiguous: tmux delivery may succeed, but Tango lifecycle/result state cannot resume.
6. Control-plane surfaces conflate or mismatch process liveness, run terminality, current task progress, result readiness, and activity.

Out of scope for the first implementation pass:

- Replacing tmux/runtime harnesses.
- Cloud/remote multi-user coordination.
- Automatically inferring task success from arbitrary transcript text.
- Scanning entire project worktrees for activity by default.
- Preserving every historical local Tango data shape with shims. Use explicit migration/defaulting where needed.

## 2. Current implementation evidence

Relevant current code/docs inspected:

| Area | Current behavior / issue |
| --- | --- |
| `packages/tango/src/types.ts` | `AgentStatus = created | running | done | error | blocked | stopped | unknown`; no idle/awaiting-task/task-turn statuses. `RunState` is run-level with agent/result/activity sections only. |
| `packages/tango/src/lifecycle.ts` | `isTerminalStatus()` makes `done`, `error`, `stopped` terminal. Reconciliation returns terminal statuses unchanged. Interactive reconciliation only checks tmux liveness for `running`. |
| `packages/tango/src/metadata.ts` | `transitionStatus()` rejects transitions away from terminal status and rejects terminal summary/needs changes. This makes `done -> running` impossible by design. |
| `packages/tango/src/controlPlane.ts` | `reportRun()` finalizes `done` at run level. `messageRun()` only checks `mode === interactive`, not terminal status. `buildRunState()` can show `agent.state=done` and `process.state=running` for live tmux terminal runs. `readActivity()` reads tmux/log/result sources but has no checkpoint model. |
| `packages/tango/src/inbox.ts` | `derivedAttentionState()` marks `running`/`created` as `stalled` after 5 minutes using `metrics.updatedAt ?? lastReportAt ?? updatedAt`. It creates inbox items for stalled/offline with warning-level parent wakeups. |
| `packages/tango/src/board.ts` | Board moves derived stalled/offline agents out of active and into attention-like sections. |
| `packages/tango/src/result.ts` | Result assessment is run-level; no turn-level result distinction. It distinguishes summary-only/candidate/available/failed but not checkpoints. |
| `packages/tango/src/server.ts` | Structured message records are appended before delivery; `serverMessageRun()` and `serverStructuredMessage()` call `messageRun()` without terminal semantics. Activity/result APIs return run-level state. |
| `packages/tango/src/cli.ts` | `report` allows a `--checkpoint` flag syntactically but `cmdReport()` does not implement checkpoint semantics. It also contains a duplicate local `buildRunState()` that differs from the canonical control-plane projection. |
| `packages/tango/extensions/pi/index.ts` | Pi tools wrap Tango CLI. `tango_report` supports only `running/blocked/done/error/stopped`; `tango_message` always reports “message sent” on success. Inbox poller treats `stalled` as warning wakeup. `tango_activity` truncates output and compactly summarizes activity, often hiding useful body text. |
| `packages/tango/extensions/pi/metrics.ts` | Metrics update only on session/tool/message/turn events. A long drafting interval without tool/result events can exceed the 5 minute stalled heuristic. |
| `packages/tango/src/rootSessions.ts` and dashboard | Root/session dashboards classify `running/created` as active and `blocked/error/needs` as attention. They do not model idle reusable sessions or heuristic health separately. |
| `.tango-interactive-retask-debugger-report.md` | Detailed retask debugger report incorporated; it recommends true reusable interactive sessions with task turns rather than documenting current `done` behavior. |
| Retask debugger behavioral probe | Generic interactive tmux session remained process-live after `report done`; `tango message` still delivered at tmux level, but `report running` failed because `done` is sticky. This validates the session-liveness vs task/run-terminality split. |

## 3. Recommended direction and tradeoffs

### Direction

Separate **interactive session lifecycle** from **task-turn lifecycle** while preserving existing `done` as a terminal run/session state.

This is intentionally stronger than a documentation-only fix: current terminal `done` behavior should be clarified in the short term, but the design target is a model where an interactive worker can finish a task, surface a result/checkpoint, enter `idle`/awaiting-task, and then accept another tracked task without creating a new Tango run.

Recommended long-term model:

1. **Session/process lifecycle** answers: is the underlying tmux/model session alive and reusable?
2. **Current task turn** answers: what assigned unit of work is active, waiting, checkpointed, complete, failed, or canceled?
3. **Result lifecycle** attaches a final deliverable to a task turn, not only to the whole run.
4. **Checkpoint lifecycle** records interim progress/body content without finalizing the task or session.
5. **Run/session finalization** (`done`, `stopped`, `error`) means the reusable session is no longer intended for normal retasking.

### Tradeoffs

| Option | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| Keep `done` terminal and document “start new run” | Small, preserves current behavior | Fails user expectation; wastes interactive context; does not solve retasking | Only as short-term mitigation language |
| Make interactive `done` non-terminal | Simple mental model for users | Breaks existing terminal immutability/result semantics; ambiguous for oneshot/legacy; risky migration | Avoid |
| Add `idle`/task turns while keeping run-level `done` terminal | Clear semantics; preserves result immutability; supports retasking | Requires schema/API/UI work | Preferred target |
| Suppress all stalled notifications | Removes false positives | Loses useful offline/stuck detection | No; downgrade and add confidence instead |
| Scan full worktree to detect progress | May catch arbitrary checkpoint files | Privacy/perf/noise risk | Avoid by default; use runDir/checkpoint/metrics/tmux signals first |

## 4. Target lifecycle design

### 4.1 Concepts

```text
Interactive Run / Session
  - durable identity: runId/runDir/name/rootSession/workstream
  - backing process: tmux session, pid/supervisor when known
  - reusable while session is live and run status is non-terminal

Task Turn
  - one assigned unit of work within an interactive session
  - has its own task text, status, summary, checkpoints, result, timestamps
  - current turn is referenced from run metadata

Result
  - final deliverable for a turn (or for a oneshot/legacy run)
  - creates result inbox item and marks the turn complete

Checkpoint
  - interim progress or partial findings for a turn/session
  - durable and surfaced, but not a final result and not terminal
```

### 4.2 Run/session states

Extend `AgentStatus` in a phased way:

| State | Terminal? | Meaning |
| --- | --- | --- |
| `created` | no | Run accepted, not yet live. |
| `running` | no | Session/process live and actively working on current task/turn. |
| `blocked` | no | Current task needs parent action/input; explicit attention. |
| `idle` | no | Interactive session is live and reusable, no active task turn. UI may label as “awaiting task”. |
| `done` | yes | Run/session finalized; no normal retasking. For oneshot: process completed successfully. For interactive: session intentionally closed/finalized. |
| `error` | yes | Run/session failed terminally unless recovered by explicit future recovery command. |
| `stopped` | yes | Session/process stopped/canceled. |
| `unknown` | avoid | Legacy/diagnostic only. |

Notes:

- Treat `awaiting-task` as a UX label or optional future alias for `idle`. Prefer one wire status (`idle`) to avoid duplicate semantics.
- Do not make `stalled`/`offline` primary statuses in metadata in the near term; keep them derived health states with confidence/reasons.
- If the team strongly wants a terminal word less confusing than `done` for interactive sessions, add a future `closed` command/label while mapping or migrating to terminal `done` internally. Do not introduce both `done` and `closed` as separate terminal states without a clear migration.

### 4.3 Task-turn states

Add per-interactive-run task-turn records. Proposed storage:

```text
<runDir>/turns.jsonl
<runDir>/turns/<turnId>/task.md
<runDir>/turns/<turnId>/result.md
<runDir>/turns/<turnId>/checkpoint-<n>.md
```

Canonical turn schema:

```ts
interface TaskTurnRecord {
  schemaVersion: 1;
  turnId: string;
  runId?: string;
  runDir: string;
  parentMessageId?: string;
  task: string;
  status: "assigned" | "running" | "awaiting-input" | "checkpointed" | "complete" | "failed" | "canceled";
  summary?: string;
  needs?: string;
  resultFile?: string;
  resultFinalizedAt?: string;
  resultIssue?: string;
  checkpointCount?: number;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}
```

Run metadata additions:

```ts
interface AgentMetadata {
  currentTurnId?: string;
  reusable?: boolean;          // default true for interactive, false/undefined for oneshot
  idleSince?: string;
  lastCheckpointAt?: string;
}
```

### 4.4 Transitions

#### On start

- Oneshot: unchanged (`created -> running -> done/error/stopped`).
- Interactive legacy one-task start:
  - create initial turn from `meta.task`.
  - set `currentTurnId`.
  - `created -> running`.

#### On checkpoint

- Command: `tango report running --checkpoint "short summary"` or `--checkpoint-file <path>`.
- Turn: `running -> checkpointed` or stays `running` with checkpoint appended; exact UI can show latest checkpoint.
- Run: remains `running` unless it was `blocked` and the checkpoint clears needs.
- Inbox: create low-noise `checkpoint`/`update` item for parent, not warning attention.

#### On blocked/input needed

- Command: `tango report blocked "summary" --needs <input|decision|review|credentials|...>`.
- Turn: `awaiting-input`.
- Run: `blocked`.
- Inbox: explicit `blocked`/`ask` item; warning attention is appropriate.

#### On task complete but session reusable

Preferred new command surface:

```bash
tango turn complete --result-file <path> "short summary"
# or a transitional alias:
tango report idle --result-file <path> "short summary"
```

Effects:

- Validate/copy result to `<runDir>/turns/<turnId>/result.md`.
- Mark current turn `complete`.
- Create result inbox item tied to `turnId`.
- Set run `status = idle`, clear `needs`, set `idleSince`, clear `currentTurnId` or keep last completed turn separately.
- Do **not** mark run `done` and do **not** terminalize the session.

#### On retask

Command/API options:

```bash
tango task start <agent> "new task text"
tango message <agent> --new-task "new task text"
```

Effects:

- Require interactive, non-terminal, tmux-live run.
- If run is `idle`, create a new turn and transition `idle -> running`.
- If run is `blocked`, either treat as response to current turn or require `--new-task --cancel-current` to avoid ambiguity.
- Send a structured message containing `turnId`, task text, and reporting instructions.

#### On final session completion

Command:

```bash
tango report done --close-session --result-file <path> "summary"
# or future clearer command:
tango session close <agent> [--result-file <path>] "summary"
```

Effects:

- Terminal run-level `done`; no normal retasking.
- For interactive agents, require explicit close-session semantics once task turns exist.
- Retain debug force path only for raw tmux operations.

### 4.5 Semantics of `done`

- `done` remains terminal and immutable at the run/session level.
- `done` is **not** the normal way a reusable interactive worker says “current task is complete”. Use turn completion / `idle`.
- Short-term before task turns ship: update prompts and errors to say: “Do not report `done` if this interactive agent should accept more work; report `running` with a checkpoint or `blocked` waiting for input.”
- Long-term: interactive `tango report done` without `--close-session` should fail with a targeted message suggesting `tango turn complete` or `tango report idle`.

### 4.6 Result vs checkpoint distinction

| Attribute | Checkpoint | Result |
| --- | --- | --- |
| Purpose | Interim progress, partial findings, “here is what I have so far” | Final deliverable for a task turn/run |
| Terminal? | No | Completes a turn or run depending command |
| Stored as | `checkpoints.jsonl` + optional copied checkpoint file/body | `result.md` under turn/run |
| Inbox type | `checkpoint`/`update`, low-noise | `result`, unread until consumed |
| Validation | Redact/size-limit; no “report-like” completeness requirement | Existing result validation plus turn/run metadata |
| Consumption | `tango activity`, `tango checkpoint`, dashboard/Pi previews | `tango result`, result inbox handling |

## 5. UX fixes by problem area

### 5.1 Message-to-terminal behavior

Near-term fix:

- `messageRun()` should reject terminal runs by default:
  - `409 terminal_run` from server.
  - CLI text: `Run is terminal (done); messages are not retasks. Start a new run or use a reusable interactive idle/task-turn session.`
- Add explicit debug escape hatch if needed:
  - CLI: `tango message --force-terminal` or `--raw-tmux`.
  - API: `{ forceTerminal: true }`.
  - Pi tool should not expose this by default.
- Validate deliverability before appending structured message records, or append with `deliveryState: failed` so failed delivery is not silently recorded as sent.

Long-term:

- `tango message --new-task` is the normal retasking path for `idle` interactive sessions.
- Terminal/closed sessions remain rejected unless force/debug.

### 5.2 Stalled detection and wakeups

Replace current single 5-minute age heuristic with health assessment:

```ts
type HealthState = "ok" | "quiet" | "stalled" | "offline";
interface HealthAssessment {
  state: HealthState;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  lastActivityAt?: string;
  lastHeartbeatAt?: string;
}
```

Signals to consider, in priority order:

1. Explicit status: terminal, blocked, error, stopped override health wakeups.
2. Runtime liveness: tmux session for interactive, pid/supervisor for oneshot where reliable.
3. Metrics: `metrics.updatedAt`, `activeToolCalls`, `lastTool`.
4. Report/checkpoint: `lastReportAt`, `lastCheckpointAt`, checkpoint file/record mtimes.
5. Run-owned logs: `tmux.log`, `final-pane.log`, `events.jsonl`, `output.log` for plain-output oneshots, and `stderr.log` mtimes.
6. Recent parent message/new task time.

Near-term policy:

- For live interactive tmux sessions, do not create warning wakeups at 5 minutes merely because metrics are quiet.
- Add start/message grace period (for example 10 minutes) before even passive quiet labeling.
- Use `quiet` as passive board-only after a threshold; promote to `stalled` only after repeated observations and no recent run-owned activity.
- Downgrade stalled Pi wakeups from warning messages to passive board/live-widget status until confidence is medium/high.
- Keep `offline` urgent when tmux/pid liveness is definitely gone for non-terminal agents.

### 5.3 Checkpoint surfacing

Implement first-class checkpoint/update records:

```ts
interface CheckpointRecord {
  schemaVersion: 1;
  checkpointId: string;
  runId?: string;
  runDir: string;
  turnId?: string;
  summary: string;
  body?: string;
  path?: string;
  source: "inline" | "file" | "artifact";
  createdAt: string;
  sizeBytes: number;
}
```

Storage:

```text
<runDir>/checkpoints.jsonl
<runDir>/checkpoints/<checkpointId>.md
```

CLI/API/UI:

- Add `tango report running --checkpoint "summary" [--checkpoint-file <path>]`.
- Add `tango checkpoint <target> [--latest|--all] [--json]` or include latest checkpoints in `tango activity`.
- `GET /api/v1/runs/activity` should include `checkpoints` metadata and preview bodies.
- Inbox item type: add `checkpoint` or use `update` with `checkpoint` payload. Prefer `checkpoint` for clarity if API churn is acceptable.
- Pi `tango_activity` renderer should show latest checkpoint bodies before raw/tmux tail.
- Dashboard agent detail/activity panels should show latest checkpoint cards.

### 5.4 Activity/result/status consistency

Canonicalize projections:

- Remove or stop using duplicate CLI-local `buildRunState()`; all CLI/server/Pi surfaces should use `controlPlane.buildRunState()`.
- Extend `RunState` to separate:

```ts
run: { state, terminal, summary, needs }
session: { live, state: "starting"|"live"|"idle"|"offline"|"stopped"|"closed", messageable, reusable }
turn: { currentTurnId?, state?, task?, summary?, needs?, resultReady? }
result: { scope: "run"|"turn", state, ready, safeToRead, path, turnId? }
checkpoints: { latest?, count }
activity: { latestSource, updatedAt, health? }
```

- Text UIs should avoid a single ambiguous label when two things differ:
  - Example: `done · session live (terminal run; raw tmux only)`.
  - Example: `idle · session live · awaiting task`.
  - Example: `running · quiet 14m (tmux live, no recent metrics)`.
- `nextAction()` should recommend `task start/message --new-task` for `idle`, `result` for unread ready results, `message` for blocked, `activity/checkpoint` for quiet/stalled.

## 6. Phased implementation plan

### Phase framing

Phases 0-1 are mitigation and UX safety work. They should make current behavior less misleading while the larger redesign is built. Phase 2 is the strategic lifecycle redesign: reusable interactive sessions, task-turn records, idle/awaiting-task semantics, and per-turn results. Phase 3 completes the UX rollout across Pi, dashboard, board, and inbox.


### Phase 0 — No-regret safety/clarity fixes (small, near-term)

1. **Terminal message guard**
   - Files: `packages/tango/src/controlPlane.ts`, `packages/tango/src/server.ts`, `packages/tango/src/cli.ts`, `packages/tango/extensions/pi/index.ts`.
   - Add `forceTerminal`/`--force-terminal` only as debug escape hatch.
   - Validate before structured message append or record failed delivery explicitly.
   - Tests: terminal interactive message rejects; force path succeeds; non-terminal interactive unchanged; oneshot still rejects.

2. **Improve wording around interactive `done`**
   - Files: `packages/tango/includes/status-protocol.md`, `packages/tango/extensions/pi/index.ts`, role docs/prompts, CLI help.
   - State plainly: `done` terminalizes the run; do not use it if the interactive agent should be retasked.
   - Pi `tango_report` description should warn for `state=done` on interactive.

3. **Reduce false stalled wakeups immediately**
   - Files: `packages/tango/src/inbox.ts`, `packages/tango/src/board.ts`, `packages/tango/extensions/pi/index.ts`.
   - Increase/parameterize threshold for live interactive sessions; require tmux liveness check and repeated stale observations before unread warning inbox item.
   - Treat low-confidence stale as passive board `quiet`, not inbox wakeup.

4. **RunState consistency cleanup**
   - Files: `packages/tango/src/cli.ts`, `packages/tango/src/controlPlane.ts`.
   - Remove/avoid duplicate CLI `buildRunState()` drift; use canonical server/control-plane state.
   - Update inspect output to show both `agent.terminal` and `process/session live`.

Acceptance criteria:

- A terminal interactive run cannot appear “successfully retasked” by default.
- Parent no longer receives warning-level stalled wakeups after only 5 quiet minutes from a live interactive session.
- Docs and tool descriptions make `done` terminal semantics explicit.

### Phase 1 — First-class checkpoints and better activity surfacing

1. **Checkpoint data model and writers**
   - Files: `packages/tango/src/types.ts`, new `packages/tango/src/checkpoints.ts`, `packages/tango/src/controlPlane.ts`, `packages/tango/src/cli.ts`, `packages/tango/src/server.ts`.
   - Add `CheckpointRecord`, `checkpoints.jsonl`, checkpoint body/file handling, size limits, and redaction considerations.
   - Implement `--checkpoint` and `--checkpoint-file` for non-terminal reports.

2. **Checkpoint inbox/activity projection**
   - Files: `packages/tango/src/inbox.ts`, `packages/tango/src/board.ts`, `packages/tango/src/controlPlane.ts`, `packages/tango/extensions/pi/index.ts`, dashboard activity components.
   - Add low-noise `checkpoint`/`update` items.
   - Include latest checkpoint in `tango activity --json` and Pi renderer.

3. **Checkpoint commands**
   - Add `tango checkpoint <target> --latest|--all [--json]` if activity output becomes too crowded.
   - Ensure `tango_activity` result content surfaces checkpoint body before tmux log tail.

Acceptance criteria:

- An agent can write a durable checkpoint body and a parent can read it through `tango activity`/Pi without attaching to tmux or hunting files.
- Checkpoints update activity freshness and suppress false stalled classification.
- Checkpoints do not mark a result ready and do not terminalize the run.

### Phase 2 — Reusable interactive session/task-turn foundation

1. **Schema and storage**
   - Files: `packages/tango/src/types.ts`, new `packages/tango/src/turns.ts`, `packages/tango/src/result.ts`.
   - Add `idle` to `AgentStatus`.
   - Add turn records and metadata pointers (`currentTurnId`, `idleSince`, `reusable`).
   - Migrate/default existing interactive runs: if no turn records, treat `meta.task` as a legacy single initial turn for display only.

2. **Turn lifecycle commands/APIs**
   - Files: `packages/tango/src/cli.ts`, `packages/tango/src/server.ts`, `packages/tango/src/controlPlane.ts`.
   - Add `tango task start` or `tango turn start` for retasking idle sessions.
   - Add `tango turn complete --result-file` and/or transitional `tango report idle --result-file`.
   - Make interactive `tango report done` require `--close-session` once these commands exist.

3. **Result per turn**
   - Files: `packages/tango/src/result.ts`, `packages/tango/src/inbox.ts`, `packages/tango/src/board.ts`, CLI/Pi result tools.
   - Teach result assessment to read latest/current turn result for interactive reusable sessions.
   - Result inbox items carry `turnId` and result path.
   - `tango result` supports latest turn, specific `--turn-id`, unread inbox, and legacy run-level results.

4. **Retasking behavior**
   - `tango message --new-task` creates a turn and transitions `idle -> running`.
   - `tango message` without `--new-task` to `idle` should ask for explicit `--new-task` to avoid sending an untracked assignment.
   - Message to `blocked` remains response to current turn.

Acceptance criteria:

- A reusable interactive agent can complete a task, produce a result, enter `idle`, receive a new task, and produce a second result without creating a new Tango run or violating terminal immutability.
- `done` still means terminal run/session finalization.
- Existing oneshot and legacy done/result flows continue to work.

### Phase 3 — Dashboard/Pi/board UX polish and rollout

1. **Pi tool updates**
   - Files: `packages/tango/extensions/pi/index.ts`, `packages/tango/includes/*.md`.
   - Add `idle` rendering, `tango_task_start`/`tango_turn_complete` or update `tango_message`/`tango_report` schemas.
   - Live widget shows idle/reusable sessions separately from active and attention.
   - Inbox wakeups distinguish explicit asks/results from passive quiet/stalled health.

2. **Dashboard updates**
   - Files: `packages/tango/dashboard/src/types.ts`, `components/AgentTree.tsx`, `OperationsDashboard.tsx`, `TimelinePanel.tsx`, `StatusChip.tsx`, likely new activity/checkpoint detail panel.
   - Show session state, current turn, latest checkpoint, health reasons, and result readiness distinctly.

3. **Board/inbox refinements**
   - Files: `packages/tango/src/board.ts`, `packages/tango/src/rootSessions.ts`, `packages/tango/src/dashboard-api.ts`.
   - Add idle count/section or include idle under active-but-not-busy.
   - Make heuristic health non-attention unless high-confidence.

4. **Docs and examples**
   - Update Tango README/docs, role prompts, status protocol, orchestration includes.
   - Add examples for reusable worker: start -> checkpoint -> turn complete -> idle -> new task -> final close.

Acceptance criteria:

- Human/Pi/dashboard surfaces consistently answer: “Is the session alive?”, “What turn is active?”, “Is a result/checkpoint available?”, “Can I retask this agent?”
- No warning-level wakeups for low-confidence quiet/stalled states.

## 7. Files/areas likely to change

Core:

- `packages/tango/src/types.ts` — statuses, RunState, turn/checkpoint schemas.
- `packages/tango/src/lifecycle.ts` — terminal status and reconciliation with `idle`/session liveness.
- `packages/tango/src/metadata.ts` — transitions involving `idle`, terminal immutability rules, possibly close-session handling.
- `packages/tango/src/controlPlane.ts` — report/message/activity/result/follow/wait state semantics.
- `packages/tango/src/result.ts` — run-vs-turn result assessment.
- New `packages/tango/src/turns.ts` — task-turn persistence helpers.
- New `packages/tango/src/checkpoints.ts` — checkpoint persistence helpers.
- `packages/tango/src/inbox.ts` — checkpoint/update item type, health assessment, result turn IDs.
- `packages/tango/src/board.ts` — idle/health/checkpoint projection.
- `packages/tango/src/server.ts` — API endpoints, message deliverability, activity/result payloads.
- `packages/tango/src/cli.ts` — commands/flags/help, duplicate projection removal.
- `packages/tango/src/events.ts` — optional turn/checkpoint/status event payloads.

Pi extension:

- `packages/tango/extensions/pi/index.ts` — tool schemas/descriptions/renderers, inbox wakeup policy, live widget.
- `packages/tango/extensions/pi/metrics.ts` — optional heartbeat/turn/checkpoint signal integration.
- `packages/tango/includes/status-protocol.md` and orchestration includes.

Dashboard:

- `packages/tango/dashboard/src/types.ts`.
- `packages/tango/dashboard/src/components/*` especially `StatusChip`, `AgentTree`, `OperationsDashboard`, `TimelinePanel`, `ArtifactPanel`/activity detail.

Tests:

- `packages/tango/src/*.test.ts` especially lifecycle, hardening, inbox, result, dashboard-api, server, target resolver as command behavior changes.

Docs/specs:

- This plan plus a follow-up detailed task-turn schema spec before Phase 2 implementation.

## 8. Interface/API/schema notes

### CLI additions or changes

Near-term:

```bash
tango message <target> "..." --force-terminal       # debug only
tango report running --checkpoint "summary" [--checkpoint-file file]
tango checkpoint <target> [--latest|--all] [--json]
```

Long-term:

```bash
tango task start <target> "new task"
tango turn complete --result-file file "summary"
tango result <target> --turn-id <id>
tango report done --close-session --result-file file "summary"
```

Potential transitional alias:

```bash
tango report idle --result-file file "summary"
```

### Server/API additions

- `GET /api/v1/runs/state` returns expanded session/turn/checkpoint fields.
- `GET /api/v1/runs/activity` includes latest checkpoints and health assessment.
- `POST /api/v1/runs/message` supports `newTask`, `forceTerminal`, and clear delivery result.
- `POST /api/v1/runs/turns/start`, `POST /api/v1/runs/turns/complete` or equivalent under existing runs API.
- Inbox result/checkpoint payloads include `turnId` where applicable.

### Data migration/compatibility

- Existing runs remain readable.
- Existing terminal `done/error/stopped` remain terminal.
- Existing interactive runs with no turn records are treated as legacy single-turn for display; do not attempt to rewrite all old runDirs.
- Existing result.md remains run-level; new turn result paths are preferred for reusable sessions.
- `idle` status is additive; older clients may display it as unknown. Update Pi/dashboard in same rollout as core.

## 9. Observability and rollout

- Emit normal status events for status transitions (`running -> idle`, `idle -> running`, `running -> done`).
- Consider new event types only after status event consumers are audited:
  - `agent.checkpoint`
  - `agent.turn`
  - `agent.health`
- Avoid high-volume durable health events. Health can be derived on read/board refresh.
- Add `reason/confidence` to health JSON so false positives can be debugged without reading tmux logs.
- Roll out in feature-sized PRs: terminal guard/docs, checkpoint model, health changes, then task turns.
- During rollout, update Pi extension and core package together to avoid tools offering states the server rejects.

## 10. Security and privacy risks

| Risk | Mitigation |
| --- | --- |
| Checkpoint/result files may contain secrets | Reuse existing activity redaction for display; store files under runDir with private permissions where possible; do not broadcast full content to notifications. |
| Worktree scanning for activity leaks or is expensive | Do not scan project worktree by default. Use runDir logs/checkpoints/metrics/tmux signals first. If future configurable paths are added, make them opt-in. |
| Force-terminal messages can mutate supposedly finalized sessions | Hide from Pi normal tools; label debug-only; audit/log `forceTerminal` use. |
| Structured messages appended before failed delivery mislead audit trail | Validate deliverability first or store `deliveryState: failed` with error. |
| Turn/checkpoint filenames path traversal | Copy from resolved user paths into controlled runDir paths; validate containment for served artifacts. |
| Dashboard/API exposing checkpoint bodies | Respect existing local-token server security; truncate previews; require explicit result/checkpoint read for full bodies if needed. |

## 11. Validation strategy

### Unit tests

- `lifecycle.test.ts`: terminal immutability, `idle` non-terminal, interactive tmux stopped from idle/running, no false stalled for live tmux with recent checkpoint.
- `metadata.test.ts` or existing hardening tests: allowed transitions `running -> idle -> running`, forbidden `done -> running`, terminal summary immutability preserved.
- `controlPlane.test.ts`: report checkpoint, turn complete, message terminal rejection/force, retask from idle.
- `result.test.ts`: turn-level result assessment, legacy run-level result fallback, checkpoint is not result.
- `inbox.test.ts`: checkpoint/update item lifecycle, result items with `turnId`, stalled confidence/dedupe.
- `server.test.ts`: API error codes for terminal message, turn endpoints, activity includes checkpoints.

### CLI/integration smoke tests

1. Start generic/pi interactive agent.
2. Report checkpoint with body file; verify `tango activity` and `tango checkpoint` show it.
3. Report turn complete/result; verify run becomes `idle`, result inbox is unread, `tango result` reads result.
4. Send new task; verify `idle -> running`, new turn created.
5. Complete second turn; verify two separate results are retrievable.
6. Report done/close; verify default `tango message` rejects and `--force-terminal` behavior is explicit.
7. Simulate quiet live tmux over threshold; verify passive quiet/no warning wakeup until confidence threshold.
8. Simulate dead tmux/pid; verify offline/stopped attention remains visible.

### UX acceptance checks

- Pi renderer for `tango_activity` shows checkpoint content without requiring raw tmux logs.
- Board/dashboard separate active, idle, explicit attention, heuristic health, and unread results.
- `tango inspect` clearly displays session live/messageable/reusable vs run terminal/result status.
- User-facing errors include actionable next commands.

## 12. Acceptance criteria by problem

| Problem | Acceptance criteria |
| --- | --- |
| Done terminal surprise | Interactive task completion path does not use run-level `done`; `done` is documented/guarded as final session close. |
| Retasking | A live idle interactive agent can accept a new tracked task turn and later produce a distinct result. |
| False stalled wakeups | Live interactive sessions are not warning-woken by a lone 5-minute metrics gap; health includes confidence/reasons. |
| Checkpoint surfacing | Checkpoint body/file is durable, visible in activity/Pi/dashboard, and updates freshness. |
| Message to terminal | Default message to terminal run returns clear conflict; debug force path is explicit. |
| Activity/result mismatch | RunState exposes session, turn, result, checkpoints, and health separately; surfaces avoid misleading single status wording. |

## 13. Bug backlog table

| ID | Priority | Bug / UX issue | Recommended phase | Main code areas | Acceptance signal |
| --- | --- | --- | --- | --- | --- |
| TANGO-LIFE-001 | P0 | `tango message` returns success for terminal interactive runs, implying retaskability | Phase 0 | `controlPlane.ts`, `server.ts`, `cli.ts`, Pi tool | Terminal message rejected with actionable 409 unless explicit force/debug |
| TANGO-LIFE-002 | P0 | Interactive `done` semantics conflict with reusable-agent expectation | Phase 0 docs; Phase 2 model | `types.ts`, `metadata.ts`, `controlPlane.ts`, docs/includes | Agents use idle/turn complete for task completion; `done` reserved for final close |
| TANGO-STALL-001 | P0 | 5-minute stale heuristic creates false stalled wakeups while live/drafting | Phase 0/1 | `inbox.ts`, `board.ts`, Pi inbox poller, metrics | No warning wakeup for low-confidence quiet live sessions |
| TANGO-CHK-001 | P1 | `--checkpoint` flag accepted but not implemented/surfaced | Phase 1 | `cli.ts`, `controlPlane.ts`, new `checkpoints.ts`, `server.ts` | Checkpoint file/body readable via `tango activity`/Pi |
| TANGO-ACT-001 | P1 | Useful activity buried in tmux logs or arbitrary files | Phase 1 | `controlPlane.ts`, Pi renderer, dashboard activity | Activity payload prioritizes checkpoints and structured summaries |
| TANGO-STATE-001 | P1 | RunState/control surfaces conflate process live, run terminal, result readiness | Phase 0/2 | `controlPlane.ts`, `cli.ts`, dashboard/Pi | Inspect/dashboard display separate session/turn/result fields |
| TANGO-RES-001 | P1 | Result is run-level only; reusable sessions need per-turn results | Phase 2 | `result.ts`, new `turns.ts`, `inbox.ts`, CLI result | Multiple turn results retrievable independently |
| TANGO-BOARD-001 | P2 | Board/inbox treats heuristic `stalled` like explicit blocked/error attention | Phase 0/3 | `inbox.ts`, `board.ts`, Pi live widget | Heuristic health is passive unless high-confidence/urgent |
| TANGO-DASH-001 | P2 | Dashboard lacks idle/current-turn/checkpoint concepts | Phase 3 | dashboard components, `dashboard-api.ts`, `rootSessions.ts` | Dashboard answers “can retask?” and shows latest checkpoint/result |
| TANGO-DOC-001 | P2 | Status protocol wording encourages `done` for interactive final reports | Phase 0/3 | includes, README, roles, Pi tool descriptions | Prompts steer reusable agents to checkpoint/idle/turn complete |

## 14. Assumptions, blockers, and open questions

### Assumptions

- Existing terminal immutability for `done/error/stopped` is valuable and should remain for run/session finalization.
- Most desired retasking applies to interactive tmux-backed sessions, not oneshot agents.
- Local file-backed runDir storage is acceptable for turn/checkpoint records.
- Pi extension and Tango core can be released together in this monorepo.

### Blockers / decisions needed

1. Choose canonical CLI naming: `task` vs `turn`. Recommendation: use user-facing `task` for assignment (`tango task start`) and internal/schema `turnId`; use `turn complete` only if precise lifecycle language is preferred.
2. Decide whether to add wire status `idle` only, or both `idle` and `awaiting-task`. Recommendation: add `idle` only; display “awaiting task”.
3. Decide if interactive `report done` should immediately require `--close-session` when Phase 2 ships, or warn for one release first. Recommendation: hard fail after Phase 2 to avoid repeated data loss/retask confusion.
4. Decide whether checkpoint inbox type is a new `checkpoint` type or encoded as `update`. Recommendation: new `checkpoint` type if API churn is acceptable; otherwise `update` with checkpoint payload.
5. Determine whether dashboard needs full checkpoint body or preview-only. Recommendation: preview in dashboards, full via explicit activity/checkpoint/result read.

### Unknowns

- Exact Pi extension event hooks available for “assistant is currently drafting” beyond metrics/message/turn events; current metrics may not heartbeat during long generation.
- Whether any current users rely on raw tmux messages to terminal `done` sessions. Provide force/debug to reduce breakage.
- Best threshold values for quiet/stalled confidence; should be tuned from local usage after Phase 0 telemetry/reasons are visible.
- Whether turn records should be compacted/snapshotted for long-lived sessions after many tasks.
