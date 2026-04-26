# Tango Agent Metrics TUI Design

Date: 2026-04-26
Status: draft v2 after design review

## Problem

Tango parent sessions can start and observe child agents, but the parent TUI currently shows only coarse child state: name, role, harness, mode, and status. When multiple child agents are running, the coordinator cannot quickly see which agents are active, tool-heavy, token-heavy, stale, or near context pressure without manually inspecting each agent.

For Pi-harness Tango children, the child runtime already has direct access to tool execution events, token usage after assistant responses, context usage, and UI status APIs. Tango should use that runtime-local signal for tool/token/context counters instead of scraping tmux panes or parsing arbitrary terminal output.

## Goals

- Show useful live-ish child-agent metrics in Tango parent TUI surfaces.
- Track runtime, tool-call count, active tools, last tool, token usage, context usage, and cost where available.
- Let child Pi agents show their own Tango metrics in their footer/status line.
- Persist a safe metrics snapshot so CLI and parent TUI can read coherent latest-known data.
- Avoid races between high-frequency metrics updates and core Tango lifecycle/status metadata.
- Keep status notifications (`done`, `blocked`, `error`) separate from metrics updates.

## Non-goals

- Do not scrape tmux panes for metrics.
- Do not require agents to manually report tool counts or token counts.
- Do not make token usage exact during streaming. Token totals are accurate only after provider usage is available, normally at assistant-message completion.
- Do not add a silence/staleness watchdog as part of this spec.
- Do not require non-Pi harnesses to report the same metrics in v1.
- Do not make metrics updates a user-visible follow-up-message mechanism.

## Key design decision: separate metrics snapshot from lifecycle metadata

Metrics are higher-frequency and best-effort. Core `metadata.json` is lifecycle-critical: status, summary, `needs`, pid/exit information, result file, parent routing, and run identity must not be overwritten by observability updates.

Therefore v1 should store metrics in a separate per-run snapshot file:

```text
<runDir>/metrics.json
```

`metadata.json` remains the source of truth for lifecycle/status. `metrics.json` is the latest-known child-reported metrics snapshot.

Rationale:

- avoids read/modify/write races between `tango status` and frequent metrics writes;
- keeps status transitions and event emission simple;
- lets metrics writes fail or be skipped without risking terminal status/result data;
- allows different retention/update policies for observability data.

If a future implementation chooses to embed metrics in `AgentMetadata`, all metadata writers must first be moved behind one process-safe per-run lock. That is explicitly not the v1 recommendation.

## User Experience

### Parent footer/status

The parent Pi extension can summarize project or child activity:

```text
Tango: 2 running · 19 tools · 143k tok · max 18m
```

The footer should remain compact. It should prefer the most useful aggregate values:

- running child count;
- completed child count;
- total child tool calls;
- total child tokens, when known;
- max runtime among running children.

When inside a Tango parent agent, aggregate direct/relevant children using `parentRunDir` routing. In a root Pi session, aggregate current-project agents.

### Expanded `tango_list` / `tango children`

Expanded TUI renderers should show per-agent metrics:

```text
⏳ worker-a          worker     interactive/pi running   7 tools · 1 active · bash · 48k tok · ctx 32% · 6m
✓ scout-b           scout      oneshot/pi      done      2 tools · 11k tok · 1m
◐ reviewer-c        reviewer   oneshot/pi      blocked   0 tools · 4k tok · needs review · 42s
```

If metrics are unavailable, render the existing simple row rather than showing noisy placeholders.

If an agent is terminal or its metrics snapshot is stale, active tool counts should be grayed out or suppressed rather than presented as authoritative.

### Child footer/status

A Tango child Pi session may show its own local metrics:

```text
Tango: worker-a · 7 tools · 48k tok · ctx 32% · 6m
```

This is primarily useful when attaching to a child tmux session or when a child is run interactively.

## Architecture

### 1. Child metrics extension

Add a Pi extension loaded into Tango Pi children, for example:

```text
packages/tango/extensions/pi/metrics.ts
```

The Pi harness should inject this extension for every Tango Pi child, independent of recursive/orchestration-tool policy. The existing orchestration tools extension remains conditional; metrics is observability and should apply to scouts/workers/reviewers too.

The extension records metrics from verified Pi extension APIs:

- `session_start`: initialize start time and local footer/status.
- `tool_call`: increment `toolCalls`, increment `activeToolCalls`, record `lastTool`.
- `tool_result`: increment `toolResults`, decrement `activeToolCalls`, update error counters if useful.
- `message_end` or `turn_end`: inspect assistant usage and context usage, then update token/context snapshots.
- `session_shutdown`: final best-effort metrics flush.
- `ctx.getContextUsage()`: retrieve context-window usage when available.
- `ctx.sessionManager.getBranch()`: compute aggregate assistant usage if full session stats are not exposed.
- `ctx.ui.setStatus(...)`: show child-local footer/status when UI is available.

Important Pi event caveats:

- `message_end` fires for multiple message roles; token aggregation must filter assistant messages only.
- `tool_call` happens before tool execution and extension errors can block the tool. Metrics code must never throw from this handler.
- Parallel tool execution means `activeToolCalls` can be greater than one.
- `ctx.getContextUsage()` can return unknown/null context usage, especially after compaction and before the next assistant response.

### 2. Best-effort non-blocking extension behavior

Metrics must never interrupt agent work.

The extension should:

- update in-memory counters synchronously;
- debounce persistence asynchronously;
- wrap every handler in `try/catch`, especially `tool_call`;
- never await an unbounded child process from `tool_call`;
- use short timeouts for CLI persistence;
- ignore persistence failures by default;
- optionally log failures only behind a debug flag.

The `tool_call` handler should not return a blocking/transforming result. This extension observes; it does not gate tools.

### 3. Metrics snapshot schema

Store the latest snapshot in `<runDir>/metrics.json`:

```ts
interface AgentMetricsSnapshot {
  schemaVersion: 1;
  runDir: string;
  agent: string;
  startedAt: string;
  updatedAt: string;
  toolCalls: number;
  toolResults: number;
  activeToolCalls: number;
  toolErrors?: number;
  lastTool?: string;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  context?: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
  };
  cost?: {
    total: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}
```

Do not treat the snapshot as authoritative lifecycle state. It is a child-reported latest-known observation.

Runtime should be displayed by deriving from Tango lifecycle metadata (`createdAt`) or `metrics.startedAt`, not by trusting a persisted `runtimeMs`. Renderers can compute runtime at display time so timers continue advancing even if metrics updates are throttled.

### 4. Metrics update command

Add an internal CLI surface for the child extension to update its metrics snapshot:

```bash
tango metrics update --run-dir "$TANGO_RUN_DIR" --payload '{...}'
```

The command should:

- validate/coerce the payload;
- write `<runDir>/metrics.json` atomically;
- never mutate `metadata.json`;
- optionally update only observability fields such as snapshot `updatedAt`;
- reject malformed payloads without modifying existing valid snapshots.

Because extension code may invoke this frequently, centralize Tango CLI invocation helpers used by Pi extensions rather than duplicating path resolution, JSON parsing, timeout handling, and failure swallowing in each extension.

### 5. Parent UI seeding from snapshots

Parent Pi sessions should not wait for the next metrics event to show current data.

On parent session start and after `tango_start`, the parent extension should:

1. call `tango list --json` or `tango children --json` according to routing context;
2. load/receive each agent's latest metrics snapshot;
3. seed an in-memory metrics cache keyed by `runDir`;
4. render footer/list from this cache plus current lifecycle metadata.

This requires `tango list --json` and `tango children --json` to include `metrics` when `<runDir>/metrics.json` exists. Human text output can remain simple.

### 6. Metrics events: optional v2, not required for v1

The reviewed design originally proposed frequent durable `agent.metrics` events. That is risky as a v1 requirement because Tango's current event log is a single append-only `$TANGO_HOME/events.jsonl`, and parent watchers currently use `--from-start` for reliable status replay.

V1 should work without durable metrics events:

- child writes debounced latest snapshots;
- parent seeds from snapshots on startup/list/start;
- parent can refresh snapshots opportunistically after status events and tool calls that invoke Tango tools.

If live parent updates without polling are needed after v1, add metrics events only with an explicit filtering/replay contract:

- `tango watch --types agent.status,agent.metrics` or `--status-only`;
- human `tango watch` hides metrics by default unless requested;
- parent status-notification watcher remains status-only or filters metrics away from `pi.sendMessage`;
- metrics events are throttled and may be non-durable or compacted;
- parent metrics cache is keyed by `runDir`, not agent name;
- metrics event IDs are not persisted in the status-notification dedupe set.

Metrics events must never trigger follow-up messages. They can only refresh UI.

### 7. Hybrid ownership contract

Use a hybrid source-of-truth model:

Child Pi extension reports:

- tool counts;
- active tool count;
- last tool;
- tool error count;
- token totals;
- context usage;
- cost.

Tango parent/readers derive:

- status from `metadata.json`;
- runtime from `metadata.createdAt` / `metrics.startedAt`;
- terminal/stopped semantics from core status;
- staleness from `metrics.updatedAt`;
- whether `activeToolCalls` should be trusted.

Renderers should clear, gray, or annotate active-tool data when:

- agent status is terminal (`done`, `blocked`, `error`, `stopped`);
- tmux/process is no longer alive;
- metrics `updatedAt` is older than a freshness threshold.

This avoids misleading parent UI after crashes, kills, or missed `session_shutdown` events.

## Token usage details

Pi session statistics are available in the runtime, but extension context exposes `ctx.sessionManager` as a read-only session manager rather than the full `AgentSession.getSessionStats()` API. The metrics extension can compute totals from `ctx.sessionManager.getBranch()` by walking assistant messages and summing `message.usage`:

- `usage.input`
- `usage.output`
- `usage.cacheRead`
- `usage.cacheWrite`
- `usage.cost.total`

This mirrors Pi's own session stats logic.

Context usage should use `ctx.getContextUsage()` when available. Context usage may be unknown after compaction until a later assistant response; represent this as `tokens: null`, `percent: null` rather than guessing.

## Harness support

### Pi harness v1

Full support:

- tool counts from extension events;
- token/context/cost from Pi session state;
- child local footer;
- parent footer/list via metrics snapshots;
- no durable metrics events required.

### Claude/generic harnesses

Out of scope for v1. Possible later approaches:

- Claude Code hooks/log parsing if a stable structured source exists;
- wrapper-based runtime-only metrics;
- manual `tango metrics update` from scripts.

Until implemented, non-Pi agents simply have no metrics snapshot.

## Failure behavior

Metrics are best-effort observability. Failures must not interrupt agent work.

- If `tango metrics update` fails, the extension silently keeps in-memory metrics and retries on the next debounced flush.
- Corrupt metrics payloads are rejected and the previous snapshot remains intact.
- Parent UI tolerates missing/stale metrics.
- Event log growth is unaffected in v1 because metrics events are not required.
- Killed/stopped children may have stale snapshots; renderers must interpret snapshots with lifecycle metadata.

## Implementation sequence

1. Add an `AgentMetricsSnapshot` type and metrics read/write helpers separate from `metadata.json`.
2. Add `tango metrics update --run-dir ... --json ...` as an internal command that atomically writes `<runDir>/metrics.json`.
3. Add snapshot loading to `tango list --json` and `tango children --json` output.
4. Add `packages/tango/extensions/pi/metrics.ts` with in-memory counters, child footer, debounced best-effort snapshot persistence, and hardened handler error isolation.
5. Inject the metrics extension from `packages/tango/src/harnesses/pi.ts` for every Pi-harness Tango child.
6. Update parent Pi extension to seed metrics cache from list/children JSON and render compact aggregate footer/status.
7. Extend `renderListResult()` and children renderers to show compact per-agent metrics when available.
8. Only after snapshot-based UX works, decide whether `agent.metrics` events and `tango watch --types` are worth adding.

## Validation plan

- `npm run check --workspace @bravo/tango`
- `npm run build --workspace @bravo/tango`
- Dry-run Pi command includes metrics extension for all Pi agents.
- Dry-run Pi command still includes orchestration extension only when role policy requires it.
- `tango metrics update` writes valid `metrics.json` without mutating `metadata.json`.
- Malformed metrics payload is rejected and existing snapshot remains valid.
- Concurrent `tango status done` and `tango metrics update` cannot lose terminal status because they write different files.
- Metrics extension errors in `tool_call` do not block the actual tool.
- `tango list --json` and `tango children --json` include metrics snapshots when available.
- Parent TUI seeds metrics from snapshots on startup/start/list.
- Parent metrics path never calls `pi.sendMessage`.
- Killed/stopped child does not display permanently authoritative active tools.
- Live Pi child smoke test shows tool count/runtime/tokens in parent TUI.

## Open questions

- Should `tango metrics show <agent>` exist for human diagnostics, or is `tango list --json` sufficient?
- What debounce interval gives the best balance between responsiveness and write churn?
- Should child-local footer be enabled for all children or only interactive children with visible UI?
- If metrics events are added later, should they be durable, non-durable, or compacted into a separate metrics stream?
