# Tango Pi Live TUI Design

Status: draft  
Date: 2026-04-29  
Scope: `packages/tango/extensions/pi/` TUI integration over the existing Tango CLI/server/board/inbox runtime.

## Problem

Tango now has a durable board/inbox coordination layer, but the Pi UI still feels too static:

- `tango_start`, `tango_follow`, and similar tool cards render a point-in-time snapshot; elapsed runtime does not tick unless the tool result is re-rendered.
- Inbox wake-ups can be routed correctly, but they need to appear as first-class UI cards/widgets rather than raw structured text.
- Active work is not visible unless the user runs `tango ps`, `tango board`, or sees a wake-up.
- Multiple concurrent agents are hard to scan: active, blocked, stalled, result-ready, and recent completion states are spread across separate tool results/messages.
- Cross-harness use exposed a scoping issue: this Pi session must show only relevant child/inbox events, not unrelated Claude Code Tango activity from the same global Tango home.

The goal is to make Tango in Pi feel closer to the useful parts of `pi-subagents`: live status cards, a persistent active-jobs widget, nicer result/wake-up rendering, and an optional detail overlay.

## Goals

1. **Live active-agent visibility**
   - Show a persistent compact widget for active/recent Tango agents.
   - Runtime and activity ages update every 1–2 seconds while visible.

2. **Beautiful inbox wake-ups**
   - Render Tango inbox notifications as custom Pi messages/cards, not raw `---BEGIN TANGO MESSAGE---` text.
   - Preserve machine-readable details in message metadata.

3. **Useful action affordances**
   - Every card should suggest the next action: `tango_result`, `tango_activity`, `tango_message`, `tango_inbox handled`, etc.
   - The UI should make blocked/error/result-ready states visually distinct.

4. **Strict session scoping**
   - Default UI surfaces show only agents started by this Pi session or direct children of the current Tango run.
   - Broader root/workstream views remain available through explicit commands/tools (`tango_board`, `tango_inbox`, future overlay filters).

5. **CLI-first architecture preserved**
   - UI must be a projection over Tango CLI/server/board/inbox state.
   - No Pi-only source of truth.

6. **Low noise**
   - Handled/dismissed inbox items stop reappearing.
   - Completed/handled agents age out of the live widget.
   - Stalled/offline warnings should not spam repeated messages.

## Non-goals

- Replace Tango's tmux/run-state runtime.
- Recreate all dashboard functionality inside Pi.
- Add uncontrolled peer-to-peer agent chat UI.
- Show every Tango process in `~/.tango` by default.
- Depend on the Tango server being alive; the extension can use CLI JSON and should work serverless.

## Design principles

- **Board is status, inbox is attention.** The live widget reads board-like state; wake-up cards are inbox-backed.
- **Rendered UI is not protocol.** Pi UI messages can have concise fallback text plus rich `details`; agent-directed/non-Pi delivery can use textual envelopes.
- **Stable identity first.** Cards and actions prefer `runId`/`runDir` over names.
- **Session local by default.** The extension maintains a local set of started run IDs/dirs for UI wake-ups; explicit broad tools can still inspect the full board.
- **Live components own their timers.** Tool result cards are snapshots; live widgets/components must use `setInterval`, invalidate, and request render.

## Current building blocks

### Tango state

- `tango board --json`
  - Derived status projection: active, blocked, stalled, offline, unread results, recent completions/errors.
- `tango inbox --json`
  - Durable attention items with states: `unread`, `read`, `handled`, `dismissed`.
- `tango ps/inspect/activity/result/message`
  - Existing CLI control operations.
- Pi extension local memory
  - `localWakeRunIds`, `localWakeRunDirs` for runs started by this Pi session.

### Pi TUI APIs

- `ctx.ui.setWidget(key, componentOrLines, { placement })`
  - Best fit for persistent live active-agent widget.
- `pi.registerMessageRenderer(customType, renderer)` + `pi.sendMessage({ customType, details })`
  - Best fit for inbox wake-up cards.
- `ctx.ui.custom(component, { overlay: true })`
  - Best fit for a keyboard-navigable Tango status/detail overlay.
- `renderCall` / `renderResult` on tools
  - Snapshot cards for individual tool calls.
- `ctx.ui.setStatus(key, text)`
  - Footer summary: active/blocked/unread counts.

## Proposed UI surfaces

### 1. Persistent live widget: `tango-live`

A compact widget above the editor showing the immediate agents delegated by this Pi session/main agent. The widget is intentionally one recursion level deep by default: it shows direct children as rows and summarizes any descendants they manage as aggregate counts on that row.

Example collapsed rendering:

```text
◆ Tango  2 active · 1 blocked · 1 result
  ⠹ scout repo-map            running  1m12s  last rg 3s ago
  ⚠ lead retrieval-plan       blocked  needs input  managing 4: 2 active · 1 ready · 1 blocked
  ✓ reviewer api-review       result ready  tango_result(runId: ...)
```

Agents managing zero descendants should not display any `managing 0` label; omit the managing segment entirely. Default placement: above editor. If the user finds it too prominent, add config/command support for below editor or disabled.

#### Data source

Initial implementation:

- Poll `tango board --json` or `tango inbox --json` every 2s.
- Filter to local UI scope:
  - source run is in `localWakeRunIds` / `localWakeRunDirs`, or
  - item recipient is current `TANGO_RUN_ID` / `TANGO_RUN_DIR`, or
  - explicit future setting: `scope=root-session|workstream|local`.

Preferred implementation after board filtering matures:

- `tango board --json --run-id <current>` when inside a Tango run.
- `tango board --json --root-session-id <root> --workstream-id <workstream>` plus local source filtering in Pi root sessions.

#### Widget rows

Rows should include:

- status icon/spinner
- role + agent name
- agent execution type, compactly (`interactive` vs `oneshot`)
- status (`running`, `blocked`, `stalled`, `offline`, `done`, `error`, `stopped`)
- live elapsed runtime
- last activity age
- current/last tool if metrics provides it
- concise summary/needs/result-ready hint
- descendant aggregate only when descendant count is greater than zero

Interactive vs oneshot should be visible but not noisy. Recommended compact markers:

| Mode | Marker | Meaning |
| --- | --- | --- |
| interactive | `i` or `↔` | long-lived agent that can receive `tango_message` |
| oneshot | `1` or `→` | fire-and-complete task agent |

A row may render as:

```text
⠹ ↔ lead retrieval-plan   running  2m14s  managing 4: 2 active · 1 blocked · 1 ready
✓ → scout repo-map        result ready
```

If icons feel too cryptic, use short text in expanded/overlay views: `interactive` / `oneshot`.

Status styles:

| State | Icon | Color |
| --- | --- | --- |
| running | spinner | warning/accent |
| blocked | `⚠` | warning |
| stalled | `…` or `⧖` | warning |
| offline | `✕` | error |
| error | `✗` | error |
| result ready | `✓` | success |
| stopped | `■` | muted |

#### Recursion and row limits

Default widget recursion policy:

- Show direct children of the current Pi root/main Tango run only.
- Do not inline grandchildren or deeper descendants.
- For each direct child, compute descendant aggregate counts across its subtree.
- Show the descendant aggregate only if the child manages one or more descendants.
- Surface urgent descendant health through the parent's aggregate (`managing 4: 1 blocked`) and through inbox cards when appropriate.
- Use `/tango-status` detail/tree view to drill into descendants.

Aging policy:

- Show all active/blocked/error/stalled/offline direct children.
- Show up to 3 recent result-ready/completed direct children.
- Hide handled/dismissed result items after next refresh.
- Hide old done/stopped items after e.g. 10 minutes unless unread.

#### Timer behavior

The widget component owns a `setInterval`:

- `refreshMs`: 2000ms for state polling.
- `animationMs`: 80–150ms only if a spinner is visible.
- On every tick: reload state, recompute elapsed labels, call `tui.requestRender()`.
- Clear timers on session shutdown or widget disable.

This fixes the static runtime issue: elapsed time is rendered by a live component, not by a stale tool result snapshot.

### 2. Inbox wake-up cards: `tango-message`

Inbox wake-ups should be custom Pi messages with structured metadata.

Fallback content should be short and readable:

```text
Tango result: design-review — Completed retrieve-tool design review
Next: tango_result(runId: run_...)
```

The renderer should show a richer card:

```text
◆ Tango inbox result  design-review
  Completed retrieve-tool design review
  next: tango_result(runId: run_...)
```

Expanded rendering should show:

- inbox ID and state
- run ID/run dir
- root session/workstream
- result path/finalized time if present
- body text
- explicit suggested handling command

#### Important protocol split

- Pi UI wake-ups: custom `tango-message` with concise fallback content and rich `details`.
- Agent-directed/non-Pi text delivery: `---BEGIN TANGO MESSAGE---` / `---END TANGO MESSAGE---` envelope.

This avoids raw protocol text in the TUI while keeping structured text delivery for harnesses that only have tmux/stdin.

### 3. Tool cards with live-ish partial updates

Tool result cards remain useful for individual operations, but they should not be treated as the main live status surface.

For long-running tools:

- `tango_follow` should emit periodic `onUpdate` partial result summaries while waiting.
- `tango_start` can return immediately but should register the run in the live widget.
- `tango_ps`/`tango_board` remain snapshot tools.

Suggested `tango_follow` pending card:

```text
⏳ Follow design-review  result-resolved
   running · 1m42s · last activity 4s ago · tool read
```

When complete, the final tool result becomes a stable snapshot; live status moves to the widget/inbox.

### 4. Tango status footer

Use `ctx.ui.setStatus("tango", ...)` for compact global status:

```text
Tango: 2 active · 1 blocked · 1 unread
```

Footer should update on the same 2s widget refresh cycle. If no relevant local agents/inbox items exist:

```text
Tango: ready
```

### 5. Optional overlay: `/tango-status`

A keyboard-navigable overlay inspired by `pi-subagents` `SubagentsStatusComponent`.

Command:

```text
/tango-status
```

Overlay list view:

```text
Tango agents — local session

Active
> ui-wakeup-smoke-ok  running  scout  1m42s  last read 2s ago
  inbox-cutover       blocked  worker needs input

Recent
  design-review       done     result ready

↑↓ select · enter details · r result · a activity · h handled · q/esc close
```

Detail view:

```text
ui-wakeup-smoke-ok  running
run: run_...
role/mode/harness: scout / oneshot / pi
runtime: 1m42s
last activity: 2s ago
last tool: read
summary: ...

Recent activity
  read packages/...
  read docs/...

Actions
  r: read result if ready
  a: show activity
  s: stop
  h: mark inbox handled
```

#### Overlay interactions

Minimum viable keys:

- `↑/↓`: move selection
- `enter`: detail/list toggle
- `a`: inject or run `tango_activity` for selected run
- `r`: inject or run `tango_result` for selected result-ready run
- `h`: mark selected inbox item handled
- `d`: dismiss selected inbox item
- `s`: stop selected running agent, with confirmation
- `q`/`esc`: close

Implementation should prefer safe actions:

- Destructive actions (`stop`, `dismiss`) ask confirmation.
- Read actions can either call Tango directly and display in overlay or insert a follow-up/user-visible command; first implementation can call existing Pi tools indirectly via CLI wrapper.

## State model inside the Pi extension

Add a small UI model, not a new persistent store:

```ts
interface TangoUiRun {
  runId?: string;
  runDir: string;
  name: string;
  role?: string;
  mode?: string;
  harness?: string;
  status: string;
  startedAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  lastTool?: string;
  summary?: string;
  needs?: string;
  resultReady?: boolean;
  inbox?: TangoUiInboxItem[];
  local: boolean;
}

interface TangoUiState {
  runs: TangoUiRun[];
  inbox: TangoUiInboxItem[];
  counts: {
    active: number;
    blocked: number;
    stalled: number;
    offline: number;
    unread: number;
    results: number;
    errors: number;
  };
  refreshedAt: number;
  error?: string;
}
```

The state is rebuilt from CLI/server projections. It should not become authoritative.

## Scoping model

### Default local scope

The live widget and automatic wake-up cards should include only:

1. Direct runs started by this Pi session through `tango_start` or `tango_cli start`.
2. Direct children whose `parentRunId/parentRunDir` points at the current Tango run, when this Pi session is itself a Tango agent.
3. Explicit user-pinned runs in a future `/tango-watch <run>` command.

Descendants of direct children are not rendered as widget rows by default. They are counted under the owning direct child so recursive delegation remains visible without overwhelming the root TUI.

### Explicit broad scope

The user can still inspect broader state with:

- `tango_board(rootSessionId/workstreamId)`
- `tango_inbox(rootSessionId/workstreamId)`
- future `/tango-status --scope workstream`

This prevents unrelated Claude Code or other harness agents from leaking into the current Pi session while preserving orchestration visibility when requested.

## Refresh and performance

- Default board/inbox poll interval: 2s.
- Avoid global scans where possible by passing root/workstream/run scope.
- Cache last rendered lines by width and state version.
- Avoid reading large activity logs in the widget; only detail overlay should tail logs.
- Overlay detail tail limits:
  - recent events: 8
  - activity output: 20 lines
  - max file bytes: 64KB
- Timers must call `unref?.()` and be cleared on `session_shutdown`.

## Error handling

If `tango board` / `tango inbox` fails:

- Footer: `Tango: unavailable`
- Widget: show one muted/error line, not a stack trace.
- Keep last known good state for a short grace period if useful.
- Do not wake the LLM repeatedly for polling failures.

## Relationship to dashboard/server

This design does not replace the dashboard. The Pi UI is optimized for an active coding session:

- persistent local widget
- inbox wake-up cards
- quick overlay
- tool result renderers

The dashboard remains better for broad multi-workstream views, artifacts, and historical operations.

## Implementation plan

### Phase 1 — Live local widget

- Add `TangoLiveWidget` component under `packages/tango/extensions/pi/`.
- Track local runs started by Pi tools.
- Poll `tango board --json` / `tango inbox --json` and filter locally.
- Render active/attention/recent rows with live elapsed time.
- Update footer status from same state.
- Validate with a running interactive agent and a completed result agent.

### Phase 2 — Robust inbox message cards

- Finalize `tango-message` renderer.
- Ensure fallback `content` is concise, not raw envelope text.
- Expanded card exposes metadata and next actions.
- Verify handled/dismissed suppress repeat cards.

### Phase 3 — Follow/start partial updates

- Use `onUpdate` in `tango_follow` to emit periodic pending state.
- Optionally add one initial `onUpdate` in `tango_start` after registration.
- Keep final tool cards as snapshots.

### Phase 4 — `/tango-status` overlay

- Implement list/detail overlay with keyboard navigation.
- Start read-only: show active/recent/inbox details.
- Add safe actions (`activity`, `result`, `handled`) after read-only overlay is stable.
- Add confirmation for `stop`/`dismiss`.

### Phase 5 — Configuration

Add optional settings/commands:

- `/tango-ui on|off`
- `/tango-ui placement above|below|footer-only`
- `/tango-ui scope local|workstream|root`
- `/tango-watch <run-id>` / `/tango-unwatch <run-id>`

## Validation checklist

- Start a oneshot agent that produces a valid result.
  - Widget shows running with ticking elapsed time.
  - On completion, result-ready card appears once.
  - `tango_collect_results` or `tango_result` clears unread state.
- Start an interactive agent that reports blocked.
  - Widget shows blocked with warning color.
  - Inbox card appears once.
  - Mark handled; widget/card no longer repeats.
- Run unrelated Tango agent from Claude Code in same `TANGO_HOME`.
  - It does not appear in local Pi widget/wake-up cards by default.
- Open `/tango-status` while agents run.
  - Runtime ticks.
  - Selection remains stable across refresh.
  - Detail view shows bounded activity tail.
- Simulate server unavailable.
  - CLI fallback still works or UI degrades gracefully.
- Run `npm run check --workspace @bravo/tango`.

## Open questions

1. Should the default widget be above editor, below editor, or footer-only?
2. Should automatic wake-up cards trigger an LLM turn, or only display visually by default?
3. Should `/tango-status` actions execute immediately or insert suggested tool calls/messages?
4. How long should recent completed rows remain visible after result handling?
5. Should the widget include cost/token metrics, or keep that for the overlay/detail view?

## Recommended defaults

- Widget enabled by default, above editor, max 5 rows.
- Local scope by default.
- Poll every 2s.
- Wake-up cards display visually and trigger a follow-up turn only for urgent/blocking/result items that are local.
- Recent completed rows expire after 10 minutes or immediately after handled if the widget is crowded.
- Overlay is read-only in the first implementation pass.
