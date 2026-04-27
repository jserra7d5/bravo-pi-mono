# Generic Monitor Tool V1 — Implementation-Ready Plan

Date: 2026-04-27
Status: implementation-ready draft
Scope: generic Pi/agent monitor package; not Tango-specific

## Objective

Build a reusable monitor subsystem that lets agents and users create durable background monitors, manipulate them later, retrieve results, and see active monitor status in the Pi terminal UI.

The monitor core must be generic:

- no Tango imports;
- no Tango ownership fields;
- external systems may correlate through opaque `labels` and `metadata` only;
- usable as a standalone Pi package/extension.

## V1 product acceptance

V1 is acceptable when:

1. A user/agent can create a durable timer or file monitor with `monitor_start`.
2. The monitor survives process/session restart via local durable state.
3. The user/agent can list, inspect, update, pause, resume, stop, get results, and ack it by monitor id.
4. A scheduler runs due monitors and records results.
5. Triggered/failed monitors are visible in the Pi UI.
6. The footer/status area shows active monitor state, e.g.:

   ```txt
   Monitors: 2 active · next 12s
   Monitors: 4 active · 1 triggered
   Monitors: 3 active · 1 failed
   ```

7. `/monitors` opens a simple monitor panel or provides useful text subcommands.
8. Tests cover schema/store/tool/scheduler/TUI formatting basics.
9. No product-specific client is coupled into monitor core.

## Proposed package layout

Create a workspace package:

```txt
packages/monitor/
  package.json
  tsconfig.json
  src/
    index.ts
    extension.ts
    ids.ts
    time.ts
    errors.ts
    validation.ts
    schema/
      types.ts
      tool-schemas.ts
    store/
      index.ts
      jsonl-store.ts
      state-path.ts
      lock.ts
    scheduler/
      scheduler.ts
      leases.ts
      backoff.ts
      retention.ts
    checks/
      index.ts
      timer.ts
      file.ts
      http.ts       # later phase
      process.ts    # later phase
      command.ts    # later phase
    conditions/
      evaluator.ts
    tools/
      index.ts
      start.ts
      list.ts
      look.ts
      update.ts
      pause.ts
      resume.ts
      stop.ts
      result.ts
      ack.ts
    attention/
      events.ts
      publisher.ts
    tui/
      status.ts
      command.ts
      panel.ts
      format.ts
  test/
    validation.test.ts
    store.test.ts
    tools.test.ts
    scheduler.test.ts
    conditions.test.ts
    tui-status.test.ts
```

Recommended package skeleton:

```json
{
  "name": "@bravo/monitor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Generic durable monitor tools and Pi extension.",
  "keywords": ["pi-package"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && node --test dist/test/*.test.js"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest"
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./src/extension.ts"]
  }
}
```

## Public tool API

Register with `pi.registerTool()`:

```txt
monitor_start
monitor_list
monitor_look
monitor_update
monitor_pause
monitor_resume
monitor_stop
monitor_result
monitor_ack
```

### `monitor_start`

```ts
type MonitorStartInput = {
  name?: string;
  description?: string;
  scope?: "session" | "root_session" | "workspace";
  check: CheckSpec;
  schedule: ScheduleSpec;
  condition?: ConditionSpec;
  attention?: AttentionSpec;
  retention?: RetentionSpec;
  labels?: Record<string, string>;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
};
```

Returns:

```ts
{ monitor_id: string; state: MonitorState; next_run_at?: string }
```

### Other tools

- `monitor_list`: filter by state/scope/labels, include archived, limit.
- `monitor_look`: full monitor config plus optional recent results.
- `monitor_update`: mutable fields only; optimistic `expected_version` optional.
- `monitor_pause` / `monitor_resume`: non-destructive state transitions.
- `monitor_stop`: terminal stop/cancel; preserve result history.
- `monitor_result`: latest/historical results.
- `monitor_ack`: acknowledge latest/all triggered or failed results.

Ack input should require exactly one of `monitor_id`, `result_id`, or `all`.

## Core schemas

```ts
type MonitorState =
  | "created"
  | "running"
  | "paused"
  | "triggered"
  | "succeeded"
  | "failed"
  | "stopped"
  | "canceled"
  | "expired"
  | "archived";
```

```ts
type MonitorOwner = {
  actor_id: string;
  actor_type: "agent" | "user" | "system" | "tool";
  session_id?: string;
  root_session_id?: string;
  workspace_id?: string;
};
```

```ts
type MonitorRecord = {
  monitor_id: string;
  version: number;
  owner: MonitorOwner;
  scope: "session" | "root_session" | "workspace";
  name?: string;
  description?: string;
  state: MonitorState;
  check: CheckSpec;
  schedule: ScheduleSpec;
  condition?: ConditionSpec;
  attention: AttentionSpec;
  retention: RetentionSpec;
  labels: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
  next_run_at?: string;
  last_triggered_at?: string;
  failure_count: number;
  consecutive_failure_count: number;
};
```

V1 check types:

```ts
type CheckSpec = TimerCheckSpec | FileCheckSpec;

type TimerCheckSpec = { type: "timer" };

type FileCheckSpec = {
  type: "file";
  path: string;
  mode: "exists" | "missing" | "modified_since_start" | "contains";
  pattern?: string;
  encoding?: "utf8";
};
```

Later check types: HTTP, process, command.

```ts
type ScheduleSpec = {
  start_at?: string;
  delay_ms?: number;
  interval_ms?: number;
  deadline_at?: string;
  max_runs?: number;
  timeout_ms?: number;
  backoff?: {
    strategy: "none" | "linear" | "exponential";
    initial_ms?: number;
    max_ms?: number;
  };
};
```

V1 schedule rules:

- require one of `delay_ms`, `interval_ms`, or `start_at`;
- enforce finite positive values;
- enforce minimum interval, e.g. 1s;
- default timeout, e.g. 10s.

```ts
type ConditionSpec =
  | { type: "always" }
  | { type: "observation_status"; equals: "matched" | "not_matched" | "error" | "timeout" }
  | { type: "text_contains"; path: string; text: string; case_sensitive?: boolean }
  | { type: "and"; conditions: ConditionSpec[] }
  | { type: "or"; conditions: ConditionSpec[] }
  | { type: "not"; condition: ConditionSpec };
```

Default condition: matched observation.

## Storage design

V1 recommendation: JSONL + snapshot to avoid new runtime dependencies.

```txt
<state-root>/monitor/
  monitors.snapshot.json
  monitors.events.jsonl
  locks/
```

State root resolution:

1. `PI_MONITOR_HOME`
2. `~/.pi/monitor`
3. test-only temporary directory override

Store interface:

```ts
interface MonitorStore {
  init(): Promise<void>;
  create(record: MonitorRecord): Promise<MonitorRecord>;
  get(monitorId: string): Promise<MonitorRecord | undefined>;
  list(filter: MonitorListFilter): Promise<MonitorRecord[]>;
  update(monitorId: string, expectedVersion: number | undefined, patch: MonitorPatch): Promise<MonitorRecord>;
  appendResult(result: MonitorResult): Promise<void>;
  listResults(monitorId: string, options: ResultQuery): Promise<MonitorResult[]>;
  appendEvent(event: MonitorEvent): Promise<void>;
  listEvents(filter: EventFilter): Promise<MonitorEvent[]>;
  claimDue(now: Date, lease: LeaseSpec): Promise<MonitorRecord[]>;
  releaseLease(monitorId: string, leaseId: string, nextRunAt?: string): Promise<void>;
  prune(now: Date): Promise<PruneSummary>;
}
```

If multiple Pi processes need to run schedulers concurrently in V1, switch to SQLite before implementation.

## Scheduler design

Start on `session_start`; stop on `session_shutdown`.

```ts
class MonitorScheduler {
  start(ctx: ExtensionContext): void;
  stop(): Promise<void>;
  tick(reason: "timer" | "tool" | "startup"): Promise<void>;
}
```

Tick flow:

1. query due running monitors;
2. claim lease;
3. execute check with timeout;
4. evaluate condition;
5. append result/event;
6. update monitor state/counters;
7. publish generic attention when triggered/failed;
8. compute next run or terminal state;
9. release lease;
10. recompute TUI status.

V1 scheduler defaults:

```ts
{ maxConcurrentRuns: 4, tickIntervalMs: 1000, leaseTtlMs: 30000 }
```

## Pi extension integration

```ts
export default function(pi: ExtensionAPI) {
  const runtime = createMonitorRuntime(pi);

  pi.on("session_start", async (_event, ctx) => {
    await runtime.start(ctx);
  });

  pi.on("session_shutdown", async () => {
    await runtime.stop();
  });

  registerMonitorTools(pi, runtime);
  registerMonitorCommands(pi, runtime);
}
```

Use documented Pi APIs:

- `pi.registerTool()`;
- `pi.registerCommand("monitors", ...)`;
- `ctx.ui.setStatus("monitors", text)`;
- `ctx.ui.custom()` for panel;
- guard UI calls when no UI is available;
- `truncateToWidth()` for panel rendering;
- `matchesKey()` / `Key.*` for keyboard input.

## TUI status design

Footer/status indicator is a V1 requirement.

```ts
function renderMonitorStatus(summary: MonitorStatusSummary, theme: Theme): string | undefined {
  if (summary.active === 0 && summary.triggered === 0 && summary.failed === 0) {
    return theme.fg("dim", "Monitors: idle");
  }

  const parts = [`${summary.active} active`];
  if (summary.triggered) parts.push(`${summary.triggered} triggered`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.nextRunIn) parts.push(`next ${summary.nextRunIn}`);

  const color = summary.failed ? "error" : summary.triggered ? "warning" : "dim";
  return theme.fg(color, `Monitors: ${parts.join(" · ")}`);
}
```

Refresh status on:

- session start;
- scheduler tick;
- monitor tool mutation;
- result append;
- ack/stop/pause/resume.

## `/monitors` command

Commands:

```txt
/monitors
/monitors list
/monitors pause <id>
/monitors resume <id>
/monitors stop <id>
/monitors ack <id|all>
```

No-arg `/monitors` should open a custom TUI panel:

```txt
Monitors
> ● build output       running    next 8s      file exists dist/app.js
  ! child complete     triggered  2m ago      timer
  ⏸ slow poll          paused     —           file contains "ready"

Enter: details  p: pause/resume  a: ack  s: stop  r: refresh  Esc: close
```

Destructive actions should confirm if practical. In non-interactive mode, return text output or no-op gracefully.

## Generic attention integration

On trigger/failure:

1. append durable `MonitorEvent`;
2. call `ctx.ui.notify(summary, level)` if UI exists and `attention.notify !== false`;
3. optionally wake the agent only if `attention.wake_agent === true`.

```ts
type AttentionSpec = {
  notify?: boolean;
  wake_agent?: boolean;
  message?: string;
  throttle_ms?: number;
};
```

Default:

```ts
{ notify: true, wake_agent: false, throttle_ms: 30000 }
```

Wake-up messages must be generic monitor events, not Tango-specific instructions.

## Implementation phases

### Phase 0 — package skeleton

Tasks:

- create `packages/monitor`;
- add package/tsconfig/build/check/test scripts;
- add empty extension runtime;
- confirm Pi can load via explicit `-e` or package metadata.

Validation:

```bash
npm run check --workspace @bravo/monitor
npm run build --workspace @bravo/monitor
```

Stop if state-root or dependency decision is unresolved.

### Phase 1 — schemas and store

Tasks:

- define types and TypeBox schemas;
- implement validation;
- implement JSONL/snapshot store;
- implement versions, result/event append/query, restart reconstruction.

Acceptance:

- create/list/look persists across restart;
- invalid specs fail clearly;
- version conflicts are detected.

### Phase 2 — tools without scheduler

Tasks:

- register all monitor tools;
- implement CRUD/lifecycle/result/ack operations;
- add bounded, readable tool outputs.

Acceptance:

- monitors are manipulable by id;
- ack state persists;
- tools have clear errors.

### Phase 3 — scheduler, timer, file checks

Tasks:

- implement scheduler loop;
- due query and lease model;
- timer check;
- file check;
- condition evaluator;
- result recording and next-run calculation.

Acceptance:

- timer triggers after delay;
- file monitor triggers when file appears;
- paused/stopped monitors do not run;
- restart recovery works.

### Phase 4 — TUI visibility and `/monitors`

Tasks:

- footer status summary;
- `/monitors` command;
- interactive panel/detail view;
- notifications for triggered/failed monitors.

Acceptance:

- starting a monitor updates footer immediately;
- triggered/failed/unacked monitors are visible;
- pause/resume/stop/ack works from panel;
- rendered lines respect terminal width.

### Phase 5 — HTTP/process/command checks

Defer until timer/file are stable.

Acceptance:

- HTTP readiness monitor works with SSRF protections;
- command checks are argv-only by default;
- unsafe paths/URLs/env/output are rejected or truncated.

### Phase 6 — retention/pruning

Tasks:

- retention defaults;
- prune old results/events;
- archive terminal monitors.

Acceptance:

- no unbounded result growth;
- recent triggered/failed results remain inspectable.

### Phase 7 — external consumers

Future client packages may create monitors with labels such as `{ client: "tango" }`, but monitor core must remain independent.

## Validation commands

```bash
npm run check --workspace @bravo/monitor
npm run build --workspace @bravo/monitor
npm test --workspace @bravo/monitor
```

Manual Pi validation:

```bash
pi -e packages/monitor/src/extension.ts
```

Then verify:

- footer status appears after monitor creation;
- `/monitors` opens/prints monitor state;
- timer monitor triggers;
- file monitor triggers;
- ack clears triggered indicator.

## Risks

- JSONL store concurrency may be insufficient if multiple Pi processes run schedulers simultaneously.
- Wake-up behavior can become noisy; default `wake_agent` should be false.
- File checks can leak or read unintended files; restrict paths to cwd/workspace by default.
- TUI status can become distracting; keep it compact and hide/dim when idle.
- Command/process/http checks have larger security surfaces and should be deferred until V1 core works.

## Loom recommendation

Create a separate Loom workstream for this feature before coding. Suggested root proposal:

```txt
Generic Pi monitor tool and TUI status indicator
```

Initial child tasks:

1. package skeleton;
2. schema/store;
3. tool surface;
4. scheduler + timer/file checks;
5. TUI status + `/monitors` panel;
6. security review;
7. integration/manual validation.
