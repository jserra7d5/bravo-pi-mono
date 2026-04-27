# Tango Server-First Control Plane Implementation Plan

Date: 2026-04-27
Status: implementation-ready draft, revised after review
Design: `docs/specs/tango-server-first-control-plane/design.md`

## Objective

Replace Tango's file-backed command semantics with an interactive-first, server-first control plane.

This is a **breaking migration**. Do not preserve old active protocol behavior through aliases, shims, or dual paths.

Target command vocabulary:

```text
tango ps             # compact multi-agent state
tango inspect        # full non-blocking RunState
tango activity       # cleaned current/recent activity
tango follow         # condition-based observation
tango result         # deliverable/result access
tango message        # server-mediated message delivery
tango report         # subagent self-reporting state/checkpoints/results
tango stop           # stop/cancel a run
tango recover        # explicit offline/degraded old-run recovery only
```

Removed active protocol vocabulary:

```text
tango status         # replaced by report / inspect
tango look           # replaced by activity
tango list           # replaced by ps
bare tango wait      # replaced by follow --until <condition>
```

Old command stubs may exist only to fail fast with direct replacement guidance. They must not execute compatibility behavior.

## Go/no-go criteria

Do not begin implementation until these plan constraints are accepted:

1. **No split migration window:** new CLI verbs, Pi tools, non-Pi adapters, prompts, roles, docs, tests, and old-command fail-fast behavior land together in one branch/merge train.
2. **No command before semantics:** `activity`, `follow`, `report`, `message`, `stop`, and `result` must be backed by the server/control-plane contracts they imply before they are exposed as active protocol.
3. **No active file mutation fallback:** if the server is unavailable, active commands fail. Only explicit `tango recover` may inspect old/degraded files.
4. **No Pi assumption:** root sessions and recipients are runtime-agnostic.
5. **No raw default activity:** `activity` default output must be cleaned/normalized from day one.
6. **No empty interactive done result:** `report done` without `--result-file` must create a candidate/failed/invalid result state, never silent emptiness.

## Guiding invariants

1. **Server owns live semantics.** Files are persistence, recovery, and forensics.
2. **Interactive agents are the primary product shape.** One-shot agents are batch-mode variants of the same activity/result pipeline.
3. **Observation is non-blocking by default.** Use `inspect`/`ps` to understand state; use `follow` only for explicit conditions.
4. **Agent state is not result state.** `agent.terminal` does not imply `result.ready`.
5. **Reports are state signals, not full deliverables.** Interactive `report done` without `--result-file` triggers transcript result-candidate extraction.
6. **No stale wakeups.** A parent that consumes terminal/result events via `follow` or `result` must not later receive duplicate proactive notifications for the same events.
7. **No legacy shims.** Migrate prompts, tools, docs, tests, and commands atomically.

## Target architecture

```text
CLI / Pi tools / Claude Code / Gemini CLI / generic harnesses / dashboard / SDK clients
        │
        ▼
Tango local server: runtime-agnostic root sessions + canonical RunState + events + delivery acks
        │
        ├─ host runners / tmux / harness supervisors
        ├─ normalized activity stream
        ├─ report/message/follow/result APIs
        └─ durable persistence
              ├─ state.snapshot.json
              ├─ events.jsonl
              ├─ delivery.jsonl or equivalent ack store
              ├─ transcript.jsonl
              ├─ activity.log
              ├─ result.candidate.md
              ├─ result.json
              ├─ result.md
              └─ raw forensic logs
```

## Runtime-agnostic root sessions

The main/root session agent does **not** have to be Pi. Pi is one adapter over the protocol.

Supported root origins:

- Pi root sessions;
- Claude Code root sessions;
- Gemini CLI root sessions;
- generic shell/harness agents;
- human CLI sessions;
- dashboard workflows;
- future SDK clients.

Root-session identity:

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

Recipient identity for attention/delivery must also be runtime-agnostic. A recipient may be:

- a Tango child run;
- a non-Tango root session agent;
- a dashboard session;
- a human CLI caller;
- an SDK client.

No server API, RunState field, delivery rule, or command semantic may require Pi-specific identity. Pi tools are thin adapters over the same server protocol used by every other harness.

## Canonical schemas

### RunState

Use one canonical nested schema. Top-level convenience fields may exist in human command JSON only as projections, not as source-of-truth fields.

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
    attentionRequired?: boolean;
    summary?: string;
    needs?: string;
    lastReportAt?: string;
    updatedAt: string;
  };
  result: {
    state: "none" | "capturing" | "candidate" | "available" | "invalid" | "failed" | "summary-only";
    ready: boolean;        // full deliverable available
    safeToRead: boolean;   // result command may return something useful/non-blocking
    deliverable: boolean;  // false for summary-only/recovery-only output
    source?: "result-file" | "interactive-transcript" | "oneshot-final-event" | "recovered-log";
    path?: string;
    candidatePath?: string;
    finalizedAt?: string;
    issue?: string;
    warning?: string;
    provenance?: ResultProvenance;
  };
  activity: ActivitySummary;
  attention: AttentionSummary;
  metrics?: AgentMetricsSummary;
  next: NextAction;
}
```

### ResultProvenance

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

### Activity tiers

```text
activity              cleaned human/agent summary only
activity --events     normalized structured events
activity --raw        raw tmux/harness logs, forensic/debug only
```

Default activity must not include raw harness JSON, hidden/encrypted reasoning payloads, unredacted tool arguments, auth material, or raw environment data.

### Summary-only semantics

`summary-only` is a resolved result state but not a deliverable.

Recommended contract:

- `result.state = "summary-only"`
- `result.ready = true` because result resolution is complete;
- `result.deliverable = false`;
- `result.safeToRead = true`;
- `tango result` returns the summary and exits zero unless the run required a deliverable;
- required-result workflows reject summary-only unless explicitly allowed by run policy;
- reading summary-only acks result-resolution attention, not deliverable-ready attention.

## Server API contracts

### Root session APIs

```http
POST /api/v1/root-sessions
GET  /api/v1/root-sessions
GET  /api/v1/root-sessions/:rootSessionId
POST /api/v1/root-sessions/:rootSessionId/resume
```

`POST /api/v1/root-sessions` accepts `RootSessionIdentity` fields and returns stable `rootSessionId`, `workstreamId`, token/session metadata, and protocol version.

### Run state APIs

```http
GET /api/v1/runs
GET /api/v1/runs/:runId
GET /api/v1/runs/:runId/state
GET /api/v1/runs/:runId/activity
GET /api/v1/runs/:runId/result
```

### Mutation/control APIs

```http
POST /api/v1/runs/:runId/report
POST /api/v1/runs/:runId/message
POST /api/v1/runs/:runId/stop
POST /api/v1/runs/:runId/follow
POST /api/v1/runs/:runId/attention/:eventId/ack
```

### Subscriptions

```http
GET /api/v1/subscribe?rootSessionId=...&cursor=...
GET /api/v1/subscribe?runId=...&cursor=...
```

### Discovery/health

```http
GET /api/v1/health
```

Returns:

```json
{
  "ok": true,
  "schemaVersion": 1,
  "protocolVersion": 1,
  "serverVersion": "...",
  "pid": 1234,
  "startedAt": "..."
}
```

## Implementation slices

The slices below are intended as branch-private implementation increments. The first public merge should include Slices 1–4 together, so there is no broken window where new commands exist without server semantics, prompts point to missing behavior, or old commands still work.

### Slice 1 — foundational protocol and durable semantic log

**Goal:** establish canonical state, runtime-agnostic identity, and durable event/delivery infrastructure before exposing new commands.

Files likely touched:

- `packages/tango/src/types.ts`
- new `packages/tango/src/run-state.ts`
- new `packages/tango/src/persistence.ts`
- `packages/tango/src/events.ts`
- `packages/tango/src/attention.ts`
- `packages/tango/src/rootSessions.ts`
- `packages/tango/src/lifecycle.ts`
- `packages/tango/src/result.ts`

Tasks:

1. Add `RootSessionIdentity`, `RunState`, `ResultProvenance`, `ActivityEvent`, `DeliveryState`, and related summary types.
2. Add monotonic per-run event sequence numbers and globally unique event IDs.
3. Add atomic persistence helpers for:
   - normalized events;
   - delivery/ack state;
   - state snapshots;
   - result files/provenance.
4. Implement `buildRunState(target, options)` using the canonical schema.
5. Project interactive `blocked` as non-terminal attention:
   ```text
   agent.state = blocked
   agent.terminal = false
   agent.attentionRequired = true
   ```
6. Implement minimal restart replay for terminal/result/handled events.
7. Detect partial `result.md` / `result.json` writes.
8. Reject direct file mutation as active protocol input; reserve file inspection for explicit recovery.

Acceptance criteria:

- RunState does not assume Pi.
- Event IDs and delivery state persist durably.
- Restart replay does not duplicate terminal/result handled events.
- `blocked` interactive state is resumable in RunState.

Tests:

- RunState for Pi, Claude/Gemini/generic-shaped roots.
- running interactive agent.
- blocked interactive live tmux.
- blocked interactive dead tmux.
- done with result available.
- done with result capturing.
- summary-only contract.
- restart after result handled does not duplicate attention.

Validation:

```bash
npm test --workspace @bravo/tango -- run-state
npm test --workspace @bravo/tango -- events
npm test --workspace @bravo/tango -- attention
npm run check --workspace @bravo/tango
```

---

### Slice 2 — server authority APIs and root-session registration

**Goal:** make the local server the authority for state, reports, results, messages, stop, follow, root sessions, and delivery.

Files likely touched:

- `packages/tango/src/server.ts`
- `packages/tango/src/dashboard-api.ts`
- `packages/tango/src/rootSessions.ts`
- `packages/tango/src/events.ts`
- `packages/tango/src/attention.ts`
- `packages/tango/src/runtime/tmux.ts`
- tests under `server.test.ts`, `dashboard-api.test.ts`

Tasks:

1. Implement root session register/resume APIs.
2. Add server discovery/protocol version checks.
3. Add state APIs:
   - runs list;
   - run state;
   - activity;
   - result.
4. Add mutation APIs:
   - report;
   - message;
   - stop;
   - follow;
   - attention ack.
5. Implement `message` delivery via host runner/tmux where applicable:
   - durable outbound message event;
   - delivery status;
   - normalized activity event.
6. Implement `stop` as server-owned control:
   - idempotent;
   - updates process/agent state;
   - does not rely on file mutation fallback.
7. Implement bounded `follow`:
   - explicit `until` required;
   - timeout required or server-capped;
   - returns latest RunState on timeout;
   - disconnect does not ack;
   - ack only after successful completion delivery.
8. Implement scoped subscriptions with cursors.

Acceptance criteria:

- Non-Pi root sessions can register/resume and receive state/delivery identity.
- `report`, `message`, `stop`, and `follow` are server-backed.
- `follow` timeout is safe and non-consumptive.
- `message` can resume a blocked interactive agent workflow.

Tests:

- root register/resume for Pi/Claude/Gemini/generic/CLI/dashboard origins.
- report blocked/running/done through server API.
- message delivery event persists.
- blocked interactive -> message delivered -> report running -> report done.
- stop idempotency.
- follow terminal success.
- follow result-resolved success.
- follow timeout latest state.
- follow disconnect no ack.
- cursor resume returns missed events.

Validation:

```bash
npm test --workspace @bravo/tango -- server
npm test --workspace @bravo/tango -- dashboard-api
npm test --workspace @bravo/tango -- events
npm run check --workspace @bravo/tango
```

---

### Slice 3 — interactive activity and result pipeline

**Goal:** ensure commands/prompts can rely on `activity` and `report done` behavior from day one of the vocabulary migration.

Files likely touched:

- new `packages/tango/src/activity.ts`
- new `packages/tango/src/result-extractor.ts`
- `packages/tango/src/result.ts`
- `packages/tango/src/server.ts`
- `packages/tango/src/start.ts`
- `packages/tango/src/runtime/tmux.ts`
- tests for activity/result extraction

Tasks:

1. Define and persist normalized `ActivityEvent` stream:
   - `agent.output`
   - `tool.started`
   - `tool.finished`
   - `tool.failed`
   - `message.sent`
   - `message.received`
   - `report.submitted`
   - `checkpoint`
   - `result.candidate`
   - `result.finalized`
2. Write:
   - `transcript.jsonl`
   - `activity.log`
   - raw forensic pane/harness logs only behind raw access.
3. Implement default cleaned activity renderer.
4. Implement `report done --result-file` finalization.
5. Implement interactive `report done` without result file:
   - extract candidate from normalized transcript/activity;
   - write `result.candidate.md`;
   - write `result.json` provenance;
   - set `candidate`, `invalid`, or `failed`;
   - never silently create empty result.
6. Implement one-shot normalization as batch-mode variant of the same pipeline.
7. Implement `result --recover` as explicit best-effort path.

Safe extraction order:

1. explicit `--result-file`;
2. trusted harness final assistant event;
3. explicit final-report delimiter;
4. recent assistant output after last tool result;
5. recovery-only raw extraction.

Acceptance criteria:

- `activity` default can be implemented without raw pane/harness leakage.
- `report done` without a result file creates candidate/invalid/failed state.
- Low-confidence recovery is never marked as finalized deliverable.
- Required-result workflows can reject summary-only or missing explicit deliverables.

Tests:

- interactive checkpoint appears in activity.
- sent message appears in activity.
- report blocked/done appears in activity.
- terminal-written final report becomes candidate.
- low-confidence transcript extraction becomes failed/candidate with `safeToRead=false`.
- explicit result file finalizes.
- placeholder result invalid.
- one-shot raw stream normalizes into activity and result candidate.
- default activity redacts raw JSON/tool payloads.

Validation:

```bash
npm test --workspace @bravo/tango -- activity
npm test --workspace @bravo/tango -- result
npm run check --workspace @bravo/tango
```

---

### Slice 4 — atomic vocabulary, tool, prompt, and docs migration

**Goal:** expose the new protocol and remove the old protocol in one package-level migration.

Files likely touched:

- `packages/tango/src/cli.ts`
- `packages/tango/extensions/pi/index.ts`
- non-Pi harness integration files under `packages/tango/src/harnesses/*`
- `packages/tango/includes/*.md`
- `packages/tango/roles*`
- `packages/tango/examples/*`
- package README/docs
- CLI/Pi tool tests

Tasks:

1. Add CLI commands:
   - `ps`
   - `inspect`
   - `activity`
   - `follow`
   - `report`
   - server-backed `message`
   - server-backed `stop`
   - updated `result`
   - `recover`
2. Remove active behavior for:
   - `status`
   - `look`
   - `list`
   - bare `wait`
3. If old command stubs remain, make them fail fast with replacement guidance only.
4. Replace Pi tools:
   - add `tango_report`
   - add `tango_ps`
   - add `tango_inspect`
   - add `tango_activity`
   - add `tango_follow`
   - update `tango_result`, `tango_message`, `tango_stop`, `tango_start` as needed;
   - remove old active wrappers.
5. Update prompt includes:
   - parent agents use inspect/follow/activity/result;
   - subagents use report;
   - no use of status/look/list/wait.
6. Update roles/examples/docs.
7. Update non-Pi harness docs/adapters so Claude/Gemini/generic roots use the same protocol.

Acceptance criteria:

- Active prompts/tools do not mention old commands.
- New commands are server-backed and semantically complete.
- Old commands do not mutate or read active state.
- Pi and non-Pi root sessions use the same protocol.

Tests:

- `ps --json` compact states.
- `inspect --json` full RunState.
- `activity` cleaned by default.
- `activity --raw` forensic logs.
- `follow --until result-resolved` condition behavior.
- `follow` timeout includes latest state.
- `report` self-reporting accepted.
- `message` server-backed delivery.
- `stop` server-backed idempotency.
- old commands fail and do not mutate state.

Validation:

```bash
npm test --workspace @bravo/tango -- cli
npm test --workspace @bravo/tango -- hardening
npm run build --workspace @bravo/tango
npm run check --workspace @bravo/tango
rg -n "tango_status|tango status|tango_look|tango look|tango_list|tango list|tango_wait|tango wait" \
  packages/tango/includes packages/tango/roles packages/tango/examples packages/tango/extensions/pi packages/tango/README.md
```

The grep must be clean for active prompts/tools/docs. Mentions in migration specs and fail-fast tests are allowed only through explicit allowlisting.

---

### Slice 5 — dashboard and operations UI

**Goal:** make dashboard consume the same RunState, activity, result, and attention model as CLI/tools.

Files likely touched:

- `packages/tango/dashboard/src/App.tsx`
- `packages/tango/dashboard/src/api.ts`
- `packages/tango/dashboard/src/types.ts`
- `packages/tango/src/dashboard-api.ts`

Tasks:

1. Replace dashboard projections with RunState-backed API responses.
2. Show root/workstream trees with:
   - agent state;
   - process state;
   - result state;
   - active activity summary;
   - attention state.
3. Add activity panel from normalized activity stream.
4. Add result panel for available/candidate/invalid/failed/summary-only.
5. Add message panel for interactive agents.
6. Add explicit ack controls where appropriate.
7. Remove status-derived attention projection.
8. Ensure dashboard observation does not ack parent-agent notifications unless explicit.

Acceptance criteria:

- Dashboard and CLI show the same state for the same run.
- Dashboard attention uses durable delivery/attention state.
- Dashboard default activity does not show raw logs.

Validation:

```bash
npm run build --workspace @bravo/tango
npm run check --workspace @bravo/tango
```

Manual scenario:

1. start interactive agent;
2. message it;
3. observe activity;
4. report blocked;
5. message it again;
6. report running;
7. report done with terminal-written report;
8. verify candidate/result state;
9. verify dashboard and CLI agree.

---

### Slice 6 — recovery hardening and old-run tooling

**Goal:** support explicit old-run/degraded recovery without keeping legacy active semantics.

Files likely touched:

- `packages/tango/src/cli.ts`
- new/updated `packages/tango/src/recover.ts`
- `packages/tango/src/persistence.ts`
- tests for recovery

Tasks:

1. Implement `tango recover --run-dir <dir>`:
   - reads old files;
   - projects degraded state;
   - never acks attention;
   - never mutates active state;
   - marks output `degraded=true`.
2. Harden restart replay:
   - partial result file detection;
   - corrupted event handling;
   - delivery-state replay;
   - stale server discovery.
3. Add allowlisted final grep audit.
4. Document degraded recovery limitations.

Acceptance criteria:

- Old run directories remain inspectable by explicit recovery command.
- Active commands never use degraded file recovery implicitly.
- Recovery output is visibly degraded and non-ackable.

Tests:

- old metadata/status recovery projection.
- old result.md without provenance is degraded.
- corrupted event log reports issue.
- active command fails when server unavailable.
- explicit recover works when server unavailable.

Validation:

```bash
npm test --workspace @bravo/tango -- recovery
npm test --workspace @bravo/tango -- server
npm run check --workspace @bravo/tango
```

---

### Slice 7 — final hard-removal audit

**Goal:** verify no old active protocol remains.

Tasks:

1. Search active docs/prompts/tools:
   ```bash
   rg -n "tango status|tango look|tango list|tango wait|tango_status|tango_look|tango_list|tango_wait" \
     packages/tango/includes packages/tango/roles packages/tango/examples packages/tango/extensions/pi packages/tango/README.md
   ```
2. Search source for old command implementations and ensure any matches are fail-fast stubs or tests only.
3. Confirm no old Pi tools remain.
4. Confirm old commands do not execute active protocol operations.
5. Confirm no server API endpoint requires Pi root identity.
6. Confirm all active commands require/auto-start server and do not mutate files directly.

Acceptance criteria:

- No active prompt/tool/doc instructs old commands.
- No compatibility behavior remains.
- Old command names fail fast or are absent.
- Server-first protocol supports non-Pi root sessions.

Validation:

```bash
npm test --workspace @bravo/tango
npm run build --workspace @bravo/tango
npm run check --workspace @bravo/tango
```

## End-to-end acceptance scenarios

### Scenario 1 — timeout-safe follow

1. Start interactive agent.
2. Run `tango follow <agent> --until result-resolved --timeout 1`.
3. Command times out with latest RunState and `result.safeToRead=false`.
4. Parent/tool wrapper does not call `result`.

### Scenario 2 — no stale wakeup after result consumption

1. Start child.
2. Child reports done and finalizes/produces result candidate.
3. Parent runs `follow --until result-resolved`.
4. Parent runs `result`.
5. Parent receives no later duplicate done/result wakeup.

### Scenario 3 — interactive blocked/resume flow

1. Interactive child reports blocked with needs.
2. Parent receives attention.
3. Parent sends `message`.
4. Child reports running.
5. Child reports done.
6. Result candidate/final result available.

### Scenario 4 — non-Pi root session

1. Register root session with origin `claude`, `gemini`, `generic`, or `cli`.
2. Start child under that root.
3. Follow/result/attention semantics work.
4. No Pi-specific identity required.

### Scenario 5 — terminal-written report

1. Interactive child writes full final report to terminal/activity.
2. Child runs `tango report done --summary "done"` without result file.
3. Server extracts candidate from transcript/activity.
4. `result.state=candidate` or `available` according to validation policy.
5. No empty `result.md` is silently treated as success.

### Scenario 6 — server restart

1. Child reaches result-ready.
2. Parent consumes result.
3. Restart server.
4. Replay state.
5. No duplicate result-ready wakeup emitted.

### Scenario 7 — old command failure

1. Run `tango status done`.
2. Command fails with direct guidance to `tango report done`.
3. No state mutation occurs.

## Command/API response examples

### Follow timeout

```json
{
  "ok": false,
  "timeout": true,
  "condition": "result-resolved",
  "state": {},
  "next": {
    "recommended": "activity"
  }
}
```

### Result not ready

```json
{
  "ok": false,
  "state": {},
  "result": {
    "state": "capturing",
    "ready": false,
    "safeToRead": false,
    "deliverable": false,
    "issue": "Agent is terminal but result is still capturing."
  },
  "next": {
    "recommended": "follow",
    "until": "result-resolved"
  }
}
```

### Report done without explicit result file

```json
{
  "ok": true,
  "state": {},
  "report": {
    "agentState": "done"
  },
  "result": {
    "state": "candidate",
    "ready": false,
    "safeToRead": true,
    "deliverable": false,
    "candidatePath": ".../result.candidate.md",
    "provenance": {
      "source": "interactive-transcript",
      "confidence": "medium",
      "sourceEventIds": []
    }
  }
}
```

## Server availability contract

Normal active commands require or auto-start the local server:

- `ps`
- `inspect`
- `activity`
- `follow`
- `result`
- `message`
- `report`
- `stop`

If server startup/health check fails:

- active commands fail;
- they do not mutate files directly;
- they do not ack notifications;
- user may explicitly run `tango recover` for degraded old-run inspection.

## Risks and mitigations

### Risk: broad breaking migration

Mitigation:

- dedicated branch;
- first public merge includes Slices 1–4 together;
- prompts/tools/docs/tests updated atomically;
- old commands fail loudly and do not mutate state.

### Risk: transcript extraction produces bad results

Mitigation:

- candidate vs available separation;
- provenance/confidence;
- validation;
- required-result workflows can demand explicit files/finalization.

### Risk: server restart duplicates wakeups

Mitigation:

- durable delivery state;
- idempotent event replay;
- tests for handled result/terminal replay.

### Risk: default activity leaks raw details

Mitigation:

- strict output tiers;
- redaction;
- default activity only from normalized events.

### Risk: runtime-agnostic support becomes type-only

Mitigation:

- root session register/resume APIs;
- non-Pi recipient tests;
- no Pi-specific required fields in RunState/delivery/attention.

## Suggested branch execution order

Inside the implementation branch:

1. Slice 1: foundational protocol and durable semantic log.
2. Slice 2: server authority APIs and root-session registration.
3. Slice 3: interactive activity and result pipeline.
4. Slice 4: atomic vocabulary/tool/prompt/docs migration.
5. First public merge checkpoint after Slices 1–4 pass together.
6. Slice 5: dashboard.
7. Slice 6: recovery hardening.
8. Slice 7: final audit.

This order avoids shipping new names without their semantics, avoids prompts/tools pointing to missing commands, and avoids maintaining legacy protocol behavior.
